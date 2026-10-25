"""No-Docker regression checks for the one-shot SearXNG runtime test."""

import importlib.util
import pathlib
import types
import unittest
from unittest.mock import patch


SOURCE = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "searxng-isolated-runtime-test.py"
SPEC = importlib.util.spec_from_file_location("searxng_isolated_runtime", SOURCE)
RUNTIME = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNTIME)


class RuntimePreparationTests(unittest.TestCase):
    def test_create_is_fixed_image_no_pull_no_network_no_original_mounts(self):
        argv = RUNTIME.create_argv("phi-searxng-ro-token", "token", pathlib.Path("/run/test/config"),
                                   pathlib.Path("/run/test/cache"))
        command = " ".join(argv)
        self.assertEqual(argv[0], "create")
        self.assertEqual(argv[-1], RUNTIME.IMAGE_ID)
        for expected in ("--pull=never", "--network none", "--user 977:977", "--cap-drop ALL",
                         "no-new-privileges:true", "FORCE_OWNERSHIP=false", "GRANIAN_HOST=127.0.0.1",
                         "dst=/etc/searxng,readonly", "dst=/var/cache/searxng"):
            self.assertIn(expected, command)
        for forbidden in (RUNTIME.ORIGINAL_NAME, "/home/tasso/.local/share/pi-overdrive/searxng",
                          "--publish", "-p 8888", "--privileged"):
            self.assertNotIn(forbidden, command)

    def test_fixture_is_synthetic_and_enables_json(self):
        with patch.object(RUNTIME.secrets, "token_urlsafe", return_value="synthetic-only-key"):
            fixture = RUNTIME.fixture_text()
        self.assertIn("use_default_settings: true", fixture)
        self.assertIn("    - json", fixture)
        self.assertIn("synthetic-only-key", fixture)
        self.assertNotIn("/home/tasso", fixture)
        for source in (RUNTIME.FILE_PROBE, RUNTIME.NETWORK_PROBE, RUNTIME.HEALTH_PROBE, RUNTIME.JSON_PROBE):
            compile(source, "<container-probe>", "exec")

    def test_unprivileged_execution_fails_before_docker(self):
        with patch.object(RUNTIME.os, "geteuid", return_value=1000), \
             patch.object(RUNTIME, "docker", side_effect=AssertionError("Docker accessed")):
            with self.assertRaisesRegex(RUNTIME.GateFailure, "host_operator_required"):
                RUNTIME.preflight()

    def test_expired_body_deadline_never_launches_docker(self):
        with patch.object(RUNTIME, "BODY_DEADLINE", 0), \
             patch.object(RUNTIME.subprocess, "run", side_effect=AssertionError("Docker launched")):
            with self.assertRaisesRegex(RUNTIME.GateFailure, "overall_test_timeout"):
                RUNTIME.docker("info")

    def test_foreign_container_cannot_be_adopted_for_cleanup(self):
        foreign = {"Name": "/phi-searxng-ro-token", "Image": RUNTIME.IMAGE_ID,
                   "Config": {"Labels": {"phi.searxng.runtime-test": "someone-else"}}}
        response = types.SimpleNamespace(returncode=0, stdout=("[" + __import__("json").dumps(foreign) + "]").encode(),
                                         stderr=b"")
        with patch.object(RUNTIME, "docker", return_value=response) as invoke:
            with self.assertRaisesRegex(RUNTIME.GateFailure, "temporary_container_ownership_mismatch"):
                RUNTIME.cleanup("phi-searxng-ro-token", "token", None, None)
        self.assertEqual(invoke.call_count, 1)
        self.assertEqual(invoke.call_args.args[:2], ("container", "inspect"))

    def test_docker_inspect_error_is_not_treated_as_absence(self):
        unavailable = types.SimpleNamespace(returncode=1, stdout=b"", stderr=b"daemon unavailable")
        with patch.object(RUNTIME, "docker", return_value=unavailable):
            with self.assertRaisesRegex(RUNTIME.GateFailure, "temporary_inspect_unavailable"):
                RUNTIME.owned_container("phi-searxng-ro-token", "token")

    def test_isolation_rejects_rw_config_and_host_network(self):
        config = pathlib.Path("/run/test/config")
        cache = pathlib.Path("/run/test/cache")
        item = {"Config": {"User": "977:977"},
                "HostConfig": {"NetworkMode": "none", "PortBindings": None, "Privileged": False},
                "Mounts": [{"Source": str(config), "Destination": "/etc/searxng", "RW": False},
                           {"Source": str(cache), "Destination": "/var/cache/searxng", "RW": True}]}
        RUNTIME.verify_isolation(item, config, cache)
        item["Mounts"][0]["RW"] = True
        with self.assertRaisesRegex(RUNTIME.GateFailure, "temporary_isolation_mismatch"):
            RUNTIME.verify_isolation(item, config, cache)
        item["Mounts"][0]["RW"] = False
        item["HostConfig"]["NetworkMode"] = "bridge"
        with self.assertRaisesRegex(RUNTIME.GateFailure, "temporary_isolation_mismatch"):
            RUNTIME.verify_isolation(item, config, cache)

    def test_traceback_summary_redacts_message_and_non_image_path(self):
        logs = ("Traceback (most recent call last):\n"
                "  File \"/home/private/config-secret.py\", line 7, in run\n"
                "    access_token = 'secret-value'\n"
                "requests.exceptions.ConnectionError: https://secret.example/?key=secret-value\n"
                "Traceback (most recent call last):\n"
                "  File \"/usr/local/searxng/searx/search.py\", line 42, in run\n"
                "ValueError: secret-value\n")
        signals = RUNTIME.log_signals(logs, "docker_logs_stdout")
        self.assertEqual(signals["detectionOrigin"], "python_header")
        self.assertEqual(signals["summaries"], [
            {"source": "docker_logs_stdout", "origin": "python_traceback",
             "exceptionType": "requests.exceptions.ConnectionError",
             "lastFrame": {"file": "OTHER_PATH_REDACTED", "line": 7}},
            {"source": "docker_logs_stdout", "origin": "python_traceback",
             "exceptionType": "ValueError", "lastFrame": {"file": "searx/search.py", "line": 42}},
        ])
        self.assertNotIn("secret-value", str(signals))
        self.assertNotIn("secret.example", str(signals))
        self.assertNotIn("config-secret.py", str(signals))

    def test_prefixed_multiline_traceback_is_classified(self):
        logs = ("2026-10-24 [error] traceback (most recent call last):\n"
                "2026-10-24 [error]   File \"/usr/local/searxng/searx/search.py\", line 91, in search\n"
                "2026-10-24 [error]     secret_source_line\n"
                "2026-10-24 [error] urllib.error.URLError: secret message\n")
        signals = RUNTIME.log_signals(logs, "docker_logs_stderr")
        self.assertEqual(signals["detectionOrigin"], "python_header")
        self.assertEqual(signals["summaries"], [{
            "source": "docker_logs_stderr", "origin": "python_traceback",
            "exceptionType": "urllib.error.URLError",
            "lastFrame": {"file": "searx/search.py", "line": 91},
        }])
        self.assertNotIn("secret", str(signals))

    def test_incomplete_traceback_stays_unclassified_not_pass(self):
        signals = RUNTIME.log_signals(
            "Traceback (most recent call last):\n  File \"/private/secret.py\", line 2\n",
            "docker_logs_stdout")
        self.assertTrue(signals["tracebackDetected"])
        self.assertEqual(signals["summaries"], [])
        self.assertEqual(signals["unclassifiedReason"], "header_without_recognized_exception_in_window")

    def test_word_only_traceback_stays_unclassified_not_pass(self):
        signals = RUNTIME.log_signals("logger mentions traceback only", "docker_logs_stderr")
        self.assertTrue(signals["tracebackDetected"])
        self.assertEqual(signals["detectionOrigin"], "substring_only")
        self.assertEqual(signals["unclassifiedReason"], "substring_without_python_header")
        self.assertEqual(signals["summaries"], [])
        item = {"Id": "a" * 64, "State": {"ExitCode": 0, "Running": True, "OOMKilled": False}}
        logs = types.SimpleNamespace(returncode=0, stdout=b"", stderr=b"logger mentions traceback only")
        with patch.object(RUNTIME, "owned_container", return_value=item), \
             patch.object(RUNTIME, "docker", return_value=logs):
            result = RUNTIME.diagnostics("name", "marker")
        self.assertTrue(RUNTIME.fatal_runtime_diagnostics(result))
        self.assertEqual(result["tracebackSummaries"], [])

    def test_exception_without_traditional_header_is_classified(self):
        signals = RUNTIME.log_signals("[ERROR] RuntimeError: hidden detail", "docker_logs_stderr")
        self.assertFalse(signals["tracebackDetected"])
        self.assertTrue(signals["exceptionDetected"])
        self.assertEqual(signals["summaries"], [{
            "source": "docker_logs_stderr", "origin": "exception_line_candidate_without_header",
            "exceptionType": "RuntimeError", "lastFrame": None,
        }])
        self.assertNotIn("hidden detail", str(signals))

    def test_log_failure_is_unknown_not_clean_pass(self):
        item = {"Id": "a" * 64, "State": {"ExitCode": 0, "Running": True, "OOMKilled": False}}
        failed = types.SimpleNamespace(returncode=1, stdout=b"", stderr=b"daemon unavailable")
        with patch.object(RUNTIME, "owned_container", return_value=item), \
             patch.object(RUNTIME, "docker", return_value=failed):
            self.assertEqual(RUNTIME.diagnostics("name", "marker"),
                             {"status": "UNKNOWN", "reason": "docker_logs_unavailable"})

    def test_traceback_remains_fatal_diagnostic_after_json_readiness(self):
        item = {"Id": "a" * 64, "State": {"ExitCode": 0, "Running": True, "OOMKilled": False}}
        logs = types.SimpleNamespace(returncode=0, stdout=(
            b"Traceback (most recent call last):\n"
            b"  File \"/usr/local/searxng/searx/search.py\", line 42, in run\n"
            b"RuntimeError: hidden secret in message\n"), stderr=b"")
        with patch.object(RUNTIME, "owned_container", return_value=item), \
             patch.object(RUNTIME, "docker", return_value=logs):
            result = RUNTIME.diagnostics("name", "marker")
        self.assertTrue(result["logTraceback"])
        self.assertTrue(result["runningAtDiagnostics"])
        self.assertEqual(result["tracebackSummaries"][0]["exceptionType"], "RuntimeError")
        self.assertEqual(result["logDetections"][0]["source"], "docker_logs_stdout")
        self.assertTrue(RUNTIME.fatal_runtime_diagnostics(result))
        self.assertNotIn("hidden secret", str(result))

    def test_nontraditional_exception_remains_fatal(self):
        item = {"Id": "a" * 64, "State": {"ExitCode": 0, "Running": True, "OOMKilled": False}}
        logs = types.SimpleNamespace(returncode=0, stdout=b"", stderr=b"[ERROR] RuntimeError: private detail\n")
        with patch.object(RUNTIME, "owned_container", return_value=item), \
             patch.object(RUNTIME, "docker", return_value=logs):
            result = RUNTIME.diagnostics("name", "marker")
        self.assertFalse(result["logTraceback"])
        self.assertTrue(result["logException"])
        self.assertTrue(RUNTIME.fatal_runtime_diagnostics(result))
        self.assertEqual(result["logDetections"][0]["source"], "docker_logs_stderr")
        self.assertNotIn("private detail", str(result))

    def test_invalid_utf8_is_reported_without_raw_log_or_pass(self):
        item = {"Id": "a" * 64, "State": {"ExitCode": 0, "Running": True, "OOMKilled": False}}
        logs = types.SimpleNamespace(returncode=0, stdout=b"traceback \xff private-value", stderr=b"")
        with patch.object(RUNTIME, "owned_container", return_value=item), \
             patch.object(RUNTIME, "docker", return_value=logs):
            result = RUNTIME.diagnostics("name", "marker")
        self.assertTrue(result["logTraceback"])
        self.assertTrue(RUNTIME.fatal_runtime_diagnostics(result))
        self.assertTrue(result["logDetections"][0]["utf8ReplacementObserved"])
        self.assertNotIn("private-value", str(result))

    def test_all_existing_security_log_flags_remain_fatal(self):
        flags = ("logReadOnlyError", "logPermissionError", "logChownError",
                 "logTraceback", "logException", "oomKilled")
        for flag in flags:
            with self.subTest(flag=flag):
                diagnostics = {name: name == flag for name in flags}
                self.assertTrue(RUNTIME.fatal_runtime_diagnostics(diagnostics))
        self.assertFalse(RUNTIME.fatal_runtime_diagnostics({name: False for name in flags}))


if __name__ == "__main__":
    unittest.main()
