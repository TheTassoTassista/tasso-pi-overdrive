"""No-Docker, no-root regressions for the bounded SearXNG migration preflight."""

import importlib.util
import contextlib
import io
import json
import os
import pathlib
import stat
import tempfile
import unittest
from unittest.mock import patch


SOURCE = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "searxng-remediation-preflight.py"
SPEC = importlib.util.spec_from_file_location("searxng_remediation_preflight", SOURCE)
PREFLIGHT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREFLIGHT)


class RemediationPreflightTests(unittest.TestCase):
    def docker_fixture(self):
        env = ["SECRET=must-not-print", "__SEARXNG_CONFIG_PATH=/etc/searxng"]
        image = {"Id": PREFLIGHT.IMAGE_ID, "Config": {"Env": env[:],
                 "Entrypoint": ["/usr/local/searxng/entrypoint.sh"], "Cmd": None}}
        container = {"Id": PREFLIGHT.CONTAINER_ID, "Name": "/" + PREFLIGHT.ORIGINAL_NAME,
                     "Image": PREFLIGHT.IMAGE_ID,
                     "Config": {"Env": env[:], "Entrypoint": image["Config"]["Entrypoint"], "Cmd": None},
                     "State": {"Running": False, "Pid": 0},
                     "Mounts": [{"Type": "bind", "Source": PREFLIGHT.CONFIG_PATH,
                                 "Destination": "/etc/searxng", "RW": True},
                                {"Type": "bind", "Source": PREFLIGHT.CACHE_PATH,
                                 "Destination": "/var/cache/searxng", "RW": True}],
                     "HostConfig": {"PortBindings": {"8080/tcp": [
                         {"HostIp": "127.0.0.1", "HostPort": "8888"}]},
                                    "NetworkMode": "bridge", "Privileged": False,
                                    "CapAdd": None, "RestartPolicy": {"Name": "no"}}}
        return container, image

    def test_json_classification_requires_explicit_unambiguous_list(self):
        self.assertEqual(PREFLIGHT.json_format_state(
            b"secret_key: private\nsearch:\n  formats:\n    - html\n    - json\n"), "ENABLED")
        self.assertEqual(PREFLIGHT.json_format_state(b"search:\n  formats:\n    - html\n"), "DISABLED")
        for value in (b"search:\n  formats: [html, json]\n",
                      b"search:\n  formats:\n    - json\nsearch:\n  formats:\n    - html\n",
                      b"search:\n  formats:\n    - unknown\n",
                      b"search:\n  formats:\n    - \xff\n"):
            with self.subTest(value=value):
                self.assertEqual(PREFLIGHT.json_format_state(value), "UNKNOWN")

    def test_metadata_classification_is_exact_and_never_returns_env_values(self):
        container, image = self.docker_fixture()
        result = PREFLIGHT.classify_docker(PREFLIGHT.DAEMON_ID, [container], [image])
        self.assertEqual(result["identity"], "PASS")
        self.assertEqual(result["environment"]["recreationClass"], "IMAGE_DEFAULTS")
        self.assertNotIn("must-not-print", str(result))
        container["Config"]["Env"][0] = "SECRET=changed-private-value"
        result = PREFLIGHT.classify_docker(PREFLIGHT.DAEMON_ID, [container], [image])
        self.assertEqual(result["environment"]["recreationClass"], "REVIEW_REQUIRED")
        self.assertEqual(result["environment"]["reviewRequiredCount"], 1)
        self.assertNotIn("changed-private-value", str(result))

    def test_safe_force_ownership_override_and_dangerous_cache_override(self):
        container, image = self.docker_fixture()
        container["Config"]["Env"].append("FORCE_OWNERSHIP=false")
        result = PREFLIGHT.classify_docker(PREFLIGHT.DAEMON_ID, [container], [image])
        self.assertEqual(result["environment"]["recreationClass"], "IMAGE_PLUS_FORCE_OWNERSHIP_FALSE")
        self.assertTrue(result["environment"]["allowedForceOwnershipFalse"])
        container["Config"]["Env"].append("SEARXNG_VALKEY_URL=redis://private-secret/")
        result = PREFLIGHT.classify_docker(PREFLIGHT.DAEMON_ID, [container], [image])
        self.assertEqual(result["environment"]["recreationClass"], "REVIEW_REQUIRED")
        self.assertEqual(result["environment"]["dangerousOverrideCount"], 1)
        self.assertNotIn("redis://", str(result))
        self.assertNotIn("SEARXNG_VALKEY_URL", str(result))

    def test_duplicate_or_invalid_environment_keys_fail_closed(self):
        container, image = self.docker_fixture()
        container["Config"]["Env"].append("SECRET=another-value")
        with self.assertRaisesRegex(PREFLIGHT.PreflightError, "environment_key_ambiguous"):
            PREFLIGHT.classify_docker(PREFLIGHT.DAEMON_ID, [container], [image])
        container["Config"]["Env"][-1] = "INVALID-KEY=value"
        with self.assertRaisesRegex(PREFLIGHT.PreflightError, "environment_key_ambiguous"):
            PREFLIGHT.classify_docker(PREFLIGHT.DAEMON_ID, [container], [image])

    def test_wrong_identity_state_mount_or_public_port_fails_closed(self):
        for change in (lambda c: c.update(Id="other"),
                       lambda c: c["State"].update(Running=True),
                       lambda c: c["Mounts"][0].update(Source="/tmp/foreign"),
                       lambda c: c["HostConfig"]["PortBindings"]["8080/tcp"][0].update(HostIp="0.0.0.0")):
            container, image = self.docker_fixture()
            change(container)
            with self.assertRaises(PREFLIGHT.PreflightError):
                PREFLIGHT.classify_docker(PREFLIGHT.DAEMON_ID, [container], [image])

    def test_unapproved_docker_operation_is_rejected_before_subprocess(self):
        with patch.object(PREFLIGHT.subprocess, "run", side_effect=AssertionError("docker invoked")):
            with self.assertRaisesRegex(PREFLIGHT.PreflightError, "docker_operation_forbidden"):
                PREFLIGHT.docker_json("start", PREFLIGHT.ORIGINAL_NAME)

    def test_readonly_receipt_distinguishes_snapshot_from_transaction_readiness(self):
        container, image = self.docker_fixture()
        socket_item = type("Socket", (), {"st_mode": stat.S_IFSOCK | 0o660, "st_uid": 0})()
        def response(*args):
            return {("info", "--format", "{{json .ID}}"): PREFLIGHT.DAEMON_ID,
                    ("container", "inspect", PREFLIGHT.ORIGINAL_NAME): [container],
                    ("image", "inspect", PREFLIGHT.IMAGE_ID): [image]}[args]
        output = io.StringIO()
        with patch.object(PREFLIGHT.sys, "argv", [str(SOURCE)]), \
             patch.object(PREFLIGHT.os, "geteuid", return_value=0), \
             patch.object(PREFLIGHT.os, "lstat", return_value=socket_item), \
             patch.object(PREFLIGHT, "source_snapshot", return_value=(b"search:\n  formats:\n    - html\n", False)), \
             patch.object(PREFLIGHT, "cache_empty_snapshot", return_value=(True, False)), \
             patch.object(PREFLIGHT, "docker_json", side_effect=response), \
             contextlib.redirect_stdout(output):
            self.assertEqual(PREFLIGHT.main(), 1)
        receipt = json.loads(output.getvalue())
        self.assertEqual(receipt["SEARXNG_REMEDIATION_PREFLIGHT"], "FAIL")
        self.assertEqual(receipt["sourceSnapshot"], "PASS")
        self.assertEqual(receipt["reason"], "replaceable_host_path")
        self.assertEqual(receipt["jsonFormat"], "DISABLED")
        self.assertEqual(receipt["sourcePathTrust"], "FAIL_REPLACEABLE_ANCESTOR")
        self.assertEqual(receipt["cachePathTrust"], "FAIL_REPLACEABLE_ANCESTOR")
        self.assertFalse(receipt["candidateInputsSufficient"])
        self.assertNotIn("must-not-print", output.getvalue())

    def test_protected_snapshot_needs_sufficient_candidate_inputs(self):
        container, image = self.docker_fixture()
        socket_item = type("Socket", (), {"st_mode": stat.S_IFSOCK | 0o660, "st_uid": 0})()
        def response(*args):
            return {("info", "--format", "{{json .ID}}"): PREFLIGHT.DAEMON_ID,
                    ("container", "inspect", PREFLIGHT.ORIGINAL_NAME): [container],
                    ("image", "inspect", PREFLIGHT.IMAGE_ID): [image]}[args]
        for formats, expected_code, expected_status in ((b"    - html\n", 2, "UNKNOWN"),
                                                        (b"    - html\n    - json\n", 0, "PASS")):
            with self.subTest(formats=formats):
                output = io.StringIO()
                with patch.object(PREFLIGHT.sys, "argv", [str(SOURCE)]), \
                     patch.object(PREFLIGHT.os, "geteuid", return_value=0), \
                     patch.object(PREFLIGHT.os, "lstat", return_value=socket_item), \
                     patch.object(PREFLIGHT, "source_snapshot", return_value=(b"search:\n  formats:\n" + formats, True)), \
                     patch.object(PREFLIGHT, "cache_empty_snapshot", return_value=(True, True)), \
                     patch.object(PREFLIGHT, "docker_json", side_effect=response), \
                     contextlib.redirect_stdout(output):
                    self.assertEqual(PREFLIGHT.main(), expected_code)
                self.assertEqual(json.loads(output.getvalue())["SEARXNG_REMEDIATION_PREFLIGHT"], expected_status)

    def test_pinned_source_snapshot_and_symlink_component(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp) / "config"
            base.mkdir()
            settings = base / "settings.yml"
            settings.write_bytes(b"search:\n  formats:\n    - json\n")
            settings.chmod(0o600)
            identity = settings.stat()
            parts = base.parts[1:]
            with patch.object(PREFLIGHT, "SOURCE_PARTS", parts), \
                 patch.object(PREFLIGHT, "SOURCE_DEV_INO", (identity.st_dev, identity.st_ino)), \
                 patch.object(PREFLIGHT, "SOURCE_UID_GID", (os.getuid(), os.getgid())):
                self.assertEqual(PREFLIGHT.source_snapshot(), (settings.read_bytes(), False))
                link = pathlib.Path(tmp) / "linked"
                link.symlink_to(base, target_is_directory=True)
                with patch.object(PREFLIGHT, "SOURCE_PARTS", link.parts[1:]):
                    with self.assertRaises(OSError):
                        PREFLIGHT.source_snapshot()

    def test_cache_snapshot_detects_new_data_without_removal(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp) / "data"
            base.mkdir()
            item = base.stat()
            parts = base.parts[1:]
            with patch.object(PREFLIGHT, "SOURCE_PARTS", parts[:-1] + ("config",)), \
                 patch.object(PREFLIGHT, "CACHE_DEV_INO", (item.st_dev, item.st_ino)), \
                 patch.object(PREFLIGHT, "SOURCE_UID_GID", (os.getuid(), os.getgid())):
                self.assertEqual(PREFLIGHT.cache_empty_snapshot(), (True, False))
                (base / "user-state").write_text("preserve", encoding="utf-8")
                self.assertEqual(PREFLIGHT.cache_empty_snapshot(), (False, False))
                self.assertEqual((base / "user-state").read_text(encoding="utf-8"), "preserve")


if __name__ == "__main__":
    unittest.main()
