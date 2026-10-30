from __future__ import annotations

import importlib.util
import json
import tempfile
import subprocess
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("omniroute_tls_health_report", ROOT / "scripts" / "omniroute-tls-health-report.py")
REPORT = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = REPORT
SPEC.loader.exec_module(REPORT)


_EXPECTED = object()
EDGE_ID = "a" * 64
NETWORK_ID = "b" * 64
ENDPOINT_ID = "c" * 64


def ports(configured=_EXPECTED, active=_EXPECTED) -> str:
    expected = {"8443/tcp": [{"HostIp": "127.0.0.1", "HostPort": "20129"}]}
    config_value = expected if configured is _EXPECTED else configured
    active_value = expected if active is _EXPECTED else active
    return json.dumps(config_value) + "|" + json.dumps(active_value)


def inner(status=200, phase="http", error=None) -> str:
    return json.dumps({
        "phase": phase,
        "status": status,
        "errorCode": error,
        "timeConnect": 0.001,
        "timeAppconnect": 0.002 if phase == "http" else 0,
        "timeTotal": 0.003,
    })


def edge_snapshots(address="172.19.0.3", *, edge_id=EDGE_ID, network_id=NETWORK_ID, endpoint_id=ENDPOINT_ID):
    edge_networks = {
        "phi-omniroute-egress-candidate-v1": {
            "NetworkID": network_id,
            "EndpointID": endpoint_id,
            "IPAddress": address,
            "GlobalIPv6Address": "",
        }
    }
    ipam = [{"Subnet": "172.19.0.0/16", "Gateway": "172.19.0.1"}]
    return f"{edge_id}|{json.dumps(edge_networks)}", f"{network_id}|{json.dumps(ipam)}"


class OmniRouteTLSHealthReportTests(unittest.TestCase):
    def test_models_endpoint_accepts_only_authenticated_http_200_with_nonempty_openai_catalog(self):
        with tempfile.TemporaryDirectory() as directory:
            body = Path(directory) / "models.json"
            body.write_text(json.dumps({
                "object": "list",
                "data": [{"id": "fixture/provider-model", "object": "model"}],
            }), encoding="utf-8")
            receipt, success = REPORT.models_response_report(0, "200|0.01|0.03|0.04|0.05", str(body))
            self.assertTrue(success)
            self.assertEqual(receipt, "OMNIROUTE_MODELS=PASS curl_exit=0 phase=HTTP_200 http_status=200 json=VALID schema=PASS models=PRESENT count=1")
            self.assertNotIn("fixture/provider-model", receipt)

    def test_models_endpoint_reports_transport_tls_and_http_failures_without_body(self):
        with tempfile.TemporaryDirectory() as directory:
            body = Path(directory) / "body.json"
            body.write_text('{"private":"must-not-print"}', encoding="utf-8")
            cases = (
                (6, "000|0|0|0|1", "DNS_RESOLUTION_FAILED", "000"),
                (7, "000|0|0|0|1", "TCP_CONNECT_FAILED", "000"),
                (28, "000|0|0|0|1", "TCP_CONNECT_TIMEOUT", "000"),
                (60, "000|0.01|0|0|1", "TLS_OR_CA_FAILURE", "000"),
                (0, "401|0.01|0.03|0.04|0.05", "HTTP_401_AUTH", "401"),
                (0, "403|0.01|0.03|0.04|0.05", "HTTP_403_FORBIDDEN", "403"),
                (0, "502|0.01|0.03|0.04|0.05", "HTTP_502_UPSTREAM", "502"),
                (0, "503|0.01|0.03|0.04|0.05", "HTTP_503_BACKEND_NOT_READY", "503"),
            )
            for exit_code, output, phase, status in cases:
                with self.subTest(exit_code=exit_code, status=status):
                    receipt, success = REPORT.models_response_report(exit_code, output, str(body))
                    self.assertFalse(success)
                    self.assertIn(f"curl_exit={exit_code} phase={phase} http_status={status}", receipt)
                    self.assertIn("json=NOT_CHECKED schema=NOT_CHECKED models=UNKNOWN", receipt)
                    self.assertNotIn("must-not-print", receipt)

    def test_models_endpoint_distinguishes_invalid_json_schema_and_empty_catalog(self):
        with tempfile.TemporaryDirectory() as directory:
            body = Path(directory) / "models.json"
            output = "200|0.01|0.03|0.04|0.05"
            cases = (
                ("not-json secret-value", "json=INVALID schema=NOT_CHECKED models=UNKNOWN", False),
                ('{"object":"list","object":"list","data":[]}', "json=INVALID schema=NOT_CHECKED models=UNKNOWN", False),
                ('{"object":"list","data":[{"id":"m"}],"metadata":NaN}', "json=INVALID schema=NOT_CHECKED models=UNKNOWN", False),
                (json.dumps({"object": "wrong", "data": []}), "json=VALID schema=INVALID models=UNKNOWN", False),
                (json.dumps({"object": "list", "data": "not-an-array"}), "json=VALID schema=INVALID models=UNKNOWN", False),
                (json.dumps({"object": "list", "data": [{"id": ""}]}), "json=VALID schema=INVALID models=INVALID", False),
                (json.dumps({"object": "list", "data": []}), "json=VALID schema=PASS models=EMPTY count=0", False),
            )
            for content, expected, expected_success in cases:
                with self.subTest(expected=expected):
                    body.write_text(content, encoding="utf-8")
                    receipt, success = REPORT.models_response_report(0, output, str(body))
                    self.assertEqual(success, expected_success)
                    self.assertIn(expected, receipt)
                    self.assertNotIn("secret-value", receipt)

    def test_models_endpoint_rejects_oversize_missing_and_non_regular_body_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            body = root / "models.json"
            body.write_bytes(b"x" * (REPORT.MAX_MODELS_RESPONSE_BYTES + 1))
            receipt, success = REPORT.models_response_report(0, "200|0|0|0|0.1", str(body))
            self.assertFalse(success)
            self.assertIn("json=OVERSIZE", receipt)
            self.assertNotIn("x" * 20, receipt)
            missing, success = REPORT.models_response_report(0, "200|0|0|0|0.1", str(root / "missing"))
            self.assertFalse(success)
            self.assertIn("json=UNAVAILABLE", missing)
            if hasattr(__import__("os"), "mkfifo"):
                fifo = root / "fifo"
                __import__("os").mkfifo(fifo)
                non_regular, success = REPORT.models_response_report(0, "200|0|0|0|0.1", str(fifo))
                self.assertFalse(success)
                self.assertIn("json=UNAVAILABLE", non_regular)

    def test_models_report_cli_emits_only_classification_and_never_response_content(self):
        with tempfile.TemporaryDirectory() as directory:
            body = Path(directory) / "models.json"
            body.write_text('{"private":"do-not-leak"}', encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(ROOT / "scripts" / "omniroute-tls-health-report.py"), "models",
                 "--curl-exit", "0", "--curl-output", "200|0.01|0.03|0.04|0.05", "--body-file", str(body)],
                capture_output=True, text=True, check=False,
            )
            self.assertEqual(result.returncode, 1)
            self.assertIn("json=VALID schema=INVALID models=UNKNOWN", result.stdout)
            self.assertNotIn("do-not-leak", result.stdout + result.stderr)

    def test_edge_ip_requires_exact_attested_container_network_and_endpoint(self):
        edge, network = edge_snapshots()
        self.assertEqual(
            REPORT.attested_edge_ipv4(
                edge, network, expected_edge_id=EDGE_ID, expected_network_id=NETWORK_ID,
                network_name="phi-omniroute-egress-candidate-v1", expected_subnet="172.19.0.0/16",
            ),
            "172.19.0.3",
        )
        for broken_edge, broken_network, subnet in (
            (f"{EDGE_ID}|{{}}", network, "172.19.0.0/16"),
            (edge_snapshots(endpoint_id="")[0], network, "172.19.0.0/16"),
            (edge_snapshots(network_id="d" * 64)[0], network, "172.19.0.0/16"),
            (edge_snapshots(address="172.20.0.3")[0], network, "172.19.0.0/16"),
            (edge, f"{'d' * 64}|{network.split('|', 1)[1]}", "172.19.0.0/16"),
            (edge, network, "172.18.0.0/16"),
            (edge_snapshots(address="not-an-ip")[0], network, "172.19.0.0/16"),
        ):
            with self.subTest(broken_edge=broken_edge[:80], broken_network=broken_network[:80], subnet=subnet):
                with self.assertRaises(ValueError):
                    REPORT.attested_edge_ipv4(
                        broken_edge, broken_network, expected_edge_id=EDGE_ID,
                        expected_network_id=NETWORK_ID,
                        network_name="phi-omniroute-egress-candidate-v1", expected_subnet=subnet,
                    )

    def test_edge_ip_cli_reports_missing_endpoint_without_leaking_snapshot(self):
        edge, network = edge_snapshots(address="")
        result = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "omniroute-tls-health-report.py"), "edge-ip",
             "--edge-snapshot", edge, "--network-snapshot", network,
             "--expected-edge-id", EDGE_ID, "--expected-network-id", NETWORK_ID,
             "--network-name", "phi-omniroute-egress-candidate-v1", "--expected-subnet", "172.19.0.0/16"],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr.strip(), "OMNIROUTE_EDGE_IP=FAIL phase=ATTESTATION_INVALID")
        self.assertNotIn("172.19.0.3", result.stdout + result.stderr)

    def test_port_binding_compares_configured_and_live_views_exactly(self):
        self.assertEqual(REPORT.port_publication(ports()), (True, True))
        declared_unpublished = {"8443/tcp": [{"HostIp": "127.0.0.1", "HostPort": "20129"}], "443/tcp": None, "443/udp": None}
        self.assertEqual(REPORT.port_publication(ports(active=declared_unpublished)), (True, True))
        extra_published = {**declared_unpublished, "443/tcp": [{"HostIp": "0.0.0.0", "HostPort": "443"}]}
        self.assertEqual(REPORT.port_publication(ports(active=extra_published)), (True, False))
        self.assertEqual(REPORT.port_publication(ports()), (True, True))
        self.assertEqual(REPORT.port_publication('{"8443/tcp": [{"HostIp":"127.0.0.1","HostPort":"20129"}]}|null'), (True, False))
        wrong = {"8443/tcp": [{"HostIp": "0.0.0.0", "HostPort": "20129"}]}
        self.assertEqual(REPORT.port_publication(ports(configured=wrong)), (False, True))
        with self.assertRaises(ValueError):
            REPORT.port_publication("not-json|{}")

    def test_curl_metrics_distinguish_tcp_tls_http_and_bounded_timeout_phases(self):
        def phase(exit_code, status, connect, appconnect, start):
            raw = f"{status}|{connect}|{appconnect}|{start}|3.125"
            return REPORT.parse_curl_probe(exit_code, raw).phase

        self.assertEqual(phase(0, "200", "0.01", "0.03", "0.04"), "HTTP_200")
        self.assertEqual(phase(0, "401", "0.01", "0.03", "0.04"), "HTTP_401_AUTH")
        self.assertEqual(phase(0, "403", "0.01", "0.03", "0.04"), "HTTP_403_FORBIDDEN")
        self.assertEqual(phase(0, "502", "0.01", "0.03", "0.04"), "HTTP_502_UPSTREAM")
        self.assertEqual(phase(0, "503", "0.01", "0.03", "0.04"), "HTTP_503_BACKEND_NOT_READY")
        self.assertEqual(phase(7, "000", "0", "0", "0"), "TCP_CONNECT_FAILED")
        self.assertEqual(phase(28, "000", "0", "0", "0"), "TCP_CONNECT_TIMEOUT")
        self.assertEqual(phase(28, "000", "0.01", "0", "0"), "TLS_HANDSHAKE_TIMEOUT")
        self.assertEqual(phase(28, "000", "0.01", "0.03", "0"), "HTTP_FIRST_BYTE_TIMEOUT")
        self.assertEqual(phase(60, "000", "0.01", "0", "0"), "TLS_OR_CA_FAILURE")
        with self.assertRaises(ValueError):
            REPORT.parse_curl_probe(0, "200|nan|0|0|0")

    def test_backend_and_direct_edge_probe_classify_independently(self):
        self.assertEqual(REPORT._parse_inner(0, inner()), "HTTP_200")
        self.assertEqual(REPORT._parse_inner(0, inner(503)), "HTTP_503")
        self.assertEqual(REPORT._parse_inner(0, inner(None, "connect", "ECONNREFUSED")), "TCP_CONNECT_FAILED")
        self.assertEqual(REPORT._parse_inner(0, inner(None, "tls", "ERR_TLS_CERT_ALTNAME_INVALID")), "TLS_OR_CA_FAILURE")
        self.assertEqual(REPORT._parse_inner(1, ""), "UNAVAILABLE")
        self.assertEqual(REPORT._parse_inner(0, "not-json"), "UNKNOWN")

    def test_failure_classification_uses_internal_health_and_input_drop_delta(self):
        curl = "000|0.000|0.000|0.000|3.000"
        before = json.dumps({"blocked_host_input": 4})
        after = json.dumps({"blocked_host_input": 7})
        auth_ok = "200|0.01|0.03|0.04|0.05"
        self.assertEqual(REPORT.classify_failure(ports(), 28, curl, 0, inner(), 0, inner(401), 0, auth_ok, before, after, 0), "HOST_INPUT_FIREWALL_DROP_CORRELATED")
        self.assertEqual(REPORT.classify_failure(ports(), 28, curl, 0, inner(), 0, inner(401), 0, auth_ok, before, before, 0), "HOST_PUBLISHED_PATH_UNRESOLVED")
        self.assertEqual(REPORT.classify_failure(ports(), 28, curl, 1, "", 0, inner(401), 0, auth_ok, before, after, 0), "BACKEND_UNREACHABLE")
        self.assertEqual(REPORT.classify_failure(ports(), 28, curl, 0, inner(), 0, inner(None, "tls", "CERT_INVALID"), 0, auth_ok, before, after, 0), "DIRECT_EDGE_TLS_OR_CA_FAILURE")
        self.assertEqual(REPORT.classify_failure(ports(), 28, curl, 0, inner(), 1, "", 0, auth_ok, before, after, 0), "CADDY_UNREACHABLE")
        self.assertEqual(REPORT.classify_failure(ports(), 0, "503|0.01|0.03|0.05|3.0", 0, inner(), 0, inner(401), 0, auth_ok, before, after, 0), "HOST_ENDPOINT_BACKEND_NOT_READY")
        self.assertEqual(REPORT.classify_failure(ports(), 28, "000|0.01|0.03|0|3.0", 0, inner(), 0, inner(401), 0, auth_ok, before, before, 0), "HTTP_PROXY_FIRST_BYTE_TIMEOUT")
        self.assertEqual(REPORT.classify_failure(ports(active=None), 28, curl, 0, inner(), 0, inner(401), 0, auth_ok), "DOCKER_RUNTIME_PORT_UNPUBLISHED")
        self.assertEqual(REPORT.classify_failure(ports(configured={}), 28, curl, 0, inner(), 0, inner(401), 0, auth_ok), "DOCKER_PORT_BINDING_MISMATCH")
        self.assertEqual(REPORT.classify_failure(ports(), 28, curl, 0, inner(), 0, inner(401), 0, auth_ok, before, before, 0), "HOST_PUBLISHED_PATH_UNRESOLVED")
        self.assertEqual(REPORT.classify_failure(ports(), 28, curl, 0, inner(), 0, inner(200), 0, auth_ok, before, after, 0), "CADDY_AUTH_GUARD_NOT_ENFORCED")

    def test_health_timeout_remains_classified_and_retains_phase_timings(self):
        report = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "omniroute-tls-health-report.py"), "failure",
             "--port-snapshot", ports(), "--curl-exit", "28",
             "--curl-output", "000|0.010|0.050|0.000|3.000",
             "--backend-exit", "0", "--backend-output", inner(),
             "--edge-exit", "0", "--edge-output", inner(401),
             "--auth-edge-curl-exit", "0", "--auth-edge-curl-output", "200|0.010|0.030|0.040|0.050",
             "--counter-before", json.dumps({"blocked_host_input": 4}),
             "--counter-after", json.dumps({"blocked_host_input": 4}), "--counter-after-exit", "0"],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(report.returncode, 0)
        self.assertIn("phase=HTTP_FIRST_BYTE_TIMEOUT curl_exit=28 http_status=000", report.stdout)
        self.assertIn("time_connect=0.010 time_appconnect=0.050 time_starttransfer=0.000 time_total=3.000", report.stdout)
        self.assertIn("classification=HTTP_PROXY_FIRST_BYTE_TIMEOUT", report.stdout)

    def test_direct_edge_curl_config_keeps_tls_identity_and_secrets_off_argv(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ca_path = root / "ca.crt"
            env_path = root / "caddy.env"
            secret = "a" * 64
            ca_path.write_text("-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n", encoding="ascii")
            env_path.write_text(f"OMNIROUTE_PROXY_TOKEN={secret}\n", encoding="ascii")
            config = REPORT.build_curl_config(str(ca_path), str(env_path), "172.19.0.8")
            self.assertIn(f'cacert = "{ca_path}"', config)
            self.assertIn('connect-to = "127.0.0.1:8443:172.19.0.8:8443"', config)
            self.assertIn('url = "https://127.0.0.1:8443/healthz"', config)
            self.assertIn(f'header = "Authorization: Bearer {secret}"', config)
            self.assertNotIn("insecure", config.lower())
            self.assertNotIn("location", config.lower())
            with self.assertRaises(ValueError):
                REPORT.build_curl_config(str(ca_path), str(env_path), "8.8.8.8")
            env_path.write_text(f"OMNIROUTE_PROXY_TOKEN={secret}\nEXTRA=value\n", encoding="ascii")
            with self.assertRaises(ValueError):
                REPORT.build_curl_config(str(ca_path), str(env_path), "172.19.0.8")

    def test_failure_report_is_sanitized_and_contains_timings(self):
        secret = "fixture-secret-should-never-print"
        address = "172.19.0.8"
        result = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "omniroute-tls-health-report.py"), "failure",
             "--port-snapshot", ports(), "--curl-exit", "28", "--curl-output", "000|0.010|0.050|0.000|3.000",
             "--backend-exit", "0", "--backend-output", inner(), "--edge-exit", "0", "--edge-output", inner(401),
             "--auth-edge-curl-exit", "0", "--auth-edge-curl-output", "200|0.010|0.030|0.040|0.050",
             "--counter-before", json.dumps({"blocked_host_input": 1}),
             "--counter-after", json.dumps({"blocked_host_input": 2}), "--counter-after-exit", "0"],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 0)
        self.assertIn("time_connect=0.010", result.stdout)
        self.assertIn("time_appconnect=0.050", result.stdout)
        self.assertIn("time_starttransfer=0.000", result.stdout)
        self.assertIn("host_input_drop=observed", result.stdout)
        self.assertNotIn(secret, result.stdout + result.stderr)
        self.assertNotIn(address, result.stdout + result.stderr)
        self.assertNotIn("blocked_host_input\": 2", result.stdout)

    def test_runtime_port_receipt_never_echoes_address_or_malformed_input(self):
        good = subprocess.run([sys.executable, str(ROOT / "scripts" / "omniroute-tls-health-report.py"), "ports", "--snapshot", ports()], capture_output=True, text=True, check=False)
        self.assertEqual(good.returncode, 0)
        self.assertEqual(good.stdout.strip(), "OMNIROUTE_TLS_PORTS=PASS config=EXPECTED runtime=ACTIVE")
        self.assertNotIn("127.0.0.1", good.stdout)
        bad = subprocess.run([sys.executable, str(ROOT / "scripts" / "omniroute-tls-health-report.py"), "ports", "--snapshot", "{}|not-json"], capture_output=True, text=True, check=False)
        self.assertEqual(bad.returncode, 1)
        self.assertEqual(bad.stdout.strip(), "OMNIROUTE_TLS_PORTS=UNKNOWN phase=SNAPSHOT_INVALID")


if __name__ == "__main__":
    unittest.main()
