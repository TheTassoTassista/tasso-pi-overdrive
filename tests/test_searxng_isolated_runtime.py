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


if __name__ == "__main__":
    unittest.main()
