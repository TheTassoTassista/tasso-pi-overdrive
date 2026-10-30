import contextlib
import importlib.util
import io
import json
import pathlib
import subprocess
import sys
import unittest
from unittest.mock import patch


ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "omniroute-health-diagnostic.py"
SPEC = importlib.util.spec_from_file_location("omniroute_health_diagnostic", SCRIPT)
DIAGNOSTIC = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = DIAGNOSTIC
SPEC.loader.exec_module(DIAGNOSTIC)


def completed(args, stdout="", returncode=0, stderr=""):
    return subprocess.CompletedProcess(["docker", *args], returncode, stdout, stderr)


def inspect_document(role):
    is_edge = role == "EDGE"
    container_id = DIAGNOSTIC.EDGE_ID if is_edge else DIAGNOSTIC.BACKEND_ID
    name = DIAGNOSTIC.EDGE_NAME if is_edge else DIAGNOSTIC.BACKEND_NAME
    mode = DIAGNOSTIC.NETWORK if is_edge else f"container:{DIAGNOSTIC.EDGE_ID}"
    return {
        "Id": container_id,
        "Name": f"/{name}",
        "Config": {
            "Labels": {DIAGNOSTIC.LABEL: DIAGNOSTIC.LABEL_VALUE},
            "Env": ["OMNIROUTE_PROXY_TOKEN=do-not-print-this-token"],
        },
        "State": {
            "Status": "exited", "ExitCode": 137 if is_edge else 0,
            "OOMKilled": False, "Error": "connection refused at 172.19.0.9", "Running": False, "Pid": 0,
            "StartedAt": "2026-10-30T10:11:12.000000000Z",
            "FinishedAt": "2026-10-30T10:12:13.000000000Z",
            "Health": {"Status": "unhealthy", "Log": [{"ExitCode": 7, "Output": "connect: connection refused"}]},
        },
        "HostConfig": {
            "NetworkMode": mode,
            "PortBindings": {"8443/tcp": [{"HostIp": "127.0.0.1", "HostPort": "20129"}]} if is_edge else {},
        },
        "NetworkSettings": {
            "Ports": {"8443/tcp": [{"HostIp": "127.0.0.1", "HostPort": "20129"}]} if is_edge else {},
        },
    }


class SanitizationTests(unittest.TestCase):
    def test_redacts_credentials_addresses_and_private_key_blocks(self):
        raw = """2026-10-30T10:11:12.000Z request https://172.19.0.2/healthz Authorization: Bearer bearer-secret
connect to [2001:db8::1] failed
 {"level":"error","message":"password=hunter2 api_key=short-secret jwt=jwt-secret private_key=private-secret","environment":"hidden","request":{"headers":"hidden"}}
-----BEGIN PRIVATE KEY-----
do-not-print-private-key
-----END PRIVATE KEY-----
"""
        result = "\n".join(DIAGNOSTIC.sanitize_logs(raw))
        self.assertIn("2026-10-30T10:11:12.000Z", result)
        self.assertIn("[IP_REDACTED]", result)
        self.assertIn("[REDACTED]", result)
        self.assertIn("[private key block redacted]", result)
        for secret in ("bearer-secret", "hunter2", "short-secret", "jwt-secret", "private-secret", "hidden", "do-not-print-private-key", "172.19.0.2", "2001:db8::1"):
            self.assertNotIn(secret, result)

    def test_structured_logs_keep_only_allowlisted_fields(self):
        result = DIAGNOSTIC.sanitize_logs(json.dumps({
            "level": "error", "message": "connect failed token=secret-value",
            "environment": {"API_KEY": "hidden-value"}, "headers": {"Authorization": "hidden-value"},
            "unknown_sensitive_field": "hidden-value",
        }))
        self.assertEqual(len(result), 1)
        self.assertIn('"level":"error"', result[0])
        self.assertIn("[REDACTED]", result[0])
        self.assertNotIn("hidden-value", result[0])

    def test_structured_log_line_has_a_fixed_output_bound(self):
        result = DIAGNOSTIC.sanitize_logs(json.dumps({key: "x" * 1200 for key in ("message", "stack", "error")}))
        self.assertEqual(len(result), 1)
        self.assertLessEqual(len(result[0]), 2400)

    def test_log_tail_is_bounded_to_requested_limit(self):
        result = DIAGNOSTIC.sanitize_logs("\n".join(str(i) for i in range(200)), limit=120)
        self.assertEqual(len(result), 120)
        self.assertEqual(result[0], "80")
        self.assertEqual(result[-1], "199")


class ContainerSummaryTests(unittest.TestCase):
    def test_summarizes_state_times_network_and_loopback_ports_without_environment(self):
        summary = DIAGNOSTIC.summarize_container(inspect_document("EDGE"), DIAGNOSTIC.EDGE_ID, "EDGE")
        self.assertEqual(summary["identity"], "PASS")
        self.assertEqual(summary["status"], "exited")
        self.assertEqual(summary["exitCode"], 137)
        self.assertFalse(summary["oomKilled"])
        self.assertEqual(summary["dockerError"], "network")
        self.assertEqual(summary["startedAt"], "2026-10-30T10:11:12.000000000Z")
        self.assertEqual(summary["finishedAt"], "2026-10-30T10:12:13.000000000Z")
        self.assertEqual(summary["healthStatus"], "unhealthy")
        self.assertEqual(summary["lastHealthExitCode"], 7)
        self.assertEqual(summary["lastHealthOutputClass"], "network")
        self.assertEqual(summary["networkMode"], "expected")
        self.assertEqual(summary["configuredHostPorts"], ["8443/tcp=loopback:20129"])

    def test_rejects_an_inspect_result_for_a_different_id(self):
        document = inspect_document("EDGE")
        document["Id"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "container_identity_mismatch"):
            DIAGNOSTIC.summarize_container(document, DIAGNOSTIC.EDGE_ID, "EDGE")


class MainReadOnlyTests(unittest.TestCase):
    def _run_main(self, log_output="safe startup log\n", bad_identity=False):
        calls = []

        def fake_run(args):
            calls.append(args)
            if args[:2] == ["context", "show"]:
                return completed(args, "default\n")
            if args[:3] == ["context", "inspect", "default"]:
                return completed(args, "unix:///var/run/docker.sock\n")
            if args[:2] == ["info", "--format"]:
                return completed(args, "01234567-89ab-cdef-0123-456789abcdef\n")
            if args[:1] == ["inspect"]:
                role = "EDGE" if args[1] == DIAGNOSTIC.EDGE_ID else "BACKEND"
                document = inspect_document(role)
                if bad_identity:
                    document["Id"] = "0" * 64
                return completed(args, json.dumps([document]))
            if args[:1] == ["logs"]:
                return completed(args, log_output)
            raise AssertionError(f"unexpected diagnostic command: {args[0]}")

        output = io.StringIO()
        with patch.object(DIAGNOSTIC, "_run_docker", side_effect=fake_run), contextlib.redirect_stdout(output):
            status = DIAGNOSTIC.main()
        return status, output.getvalue(), calls

    def test_reports_both_exact_container_ids_and_never_prints_environment(self):
        status, output, calls = self._run_main(log_output='Authorization: Bearer hidden-bearer\n')
        self.assertEqual(status, 0)
        self.assertIn(f'"id":"{DIAGNOSTIC.EDGE_ID}"', output)
        self.assertIn(f'"id":"{DIAGNOSTIC.BACKEND_ID}"', output)
        self.assertIn('"exitCode":137', output)
        self.assertIn('"oomKilled":false', output)
        self.assertIn("LOGS=EDGE_BEGIN", output)
        self.assertIn("LOGS=BACKEND_BEGIN", output)
        self.assertIn("[REDACTED]", output)
        self.assertNotIn("hidden-bearer", output)
        self.assertNotIn("do-not-print-this-token", output)
        self.assertTrue(all(args[0] in {"context", "info", "inspect", "logs"} for args in calls))
        self.assertFalse(any(args[0] in {"create", "start", "stop", "rm", "network", "exec"} for args in calls))

    def test_wrong_exact_id_fails_closed_and_does_not_fetch_logs(self):
        status, output, calls = self._run_main(bad_identity=True)
        self.assertEqual(status, 1)
        self.assertIn("INSPECT=INVALID_OR_IDENTITY_MISMATCH", output)
        self.assertIn("UNAVAILABLE_EXACT_ID_NOT_ATTESTED", output)
        self.assertFalse(any(args[0] == "logs" for args in calls))


if __name__ == "__main__":
    unittest.main()
