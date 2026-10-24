"""Offline checks for the fixed, read-only SearXNG host attestor."""

import importlib.util
import pathlib
import stat
import types
import unittest
from unittest.mock import patch


SOURCE = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "searxng-host-attest.py"
SPEC = importlib.util.spec_from_file_location("searxng_host_attest", SOURCE)
ATTEST = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ATTEST)


class AttestorTests(unittest.TestCase):
    def fixture(self):
        digest = "a" * 64
        identity = "b" * 64
        image_id = "sha256:" + "c" * 64
        container = {
            "Id": identity,
            "Name": "/pi-overdrive-searxng",
            "Image": image_id,
            "Config": {"Image": "docker.io/searxng/searxng:latest", "Env": ["SECRET=not-for-output"]},
            "Mounts": [{"Type": "bind", "Source": str(pathlib.Path(ATTEST.SETTINGS).parent),
                        "Destination": "/etc/searxng", "RW": False},
                       {"Type": "bind", "Source": ATTEST.DATA, "Destination": "/var/cache/searxng", "RW": True}],
            "HostConfig": {"Privileged": False, "CapAdd": None, "SecurityOpt": [],
                           "NetworkMode": "bridge", "PidMode": "", "IpcMode": "",
                           "PortBindings": {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": "8888"}]}},
            "NetworkSettings": {"Ports": {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": "8888"}]}},
            "State": {"Running": True, "Pid": 1234},
        }
        image = {"Id": image_id, "RepoDigests": ["docker.io/searxng/searxng@sha256:" + digest]}
        settings = types.SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=977)
        return container, image, settings

    def test_strict_json_format_recognition(self):
        self.assertTrue(ATTEST.json_format_enabled(b"search:\n  formats:\n    - html\n    - json\n"))
        self.assertFalse(ATTEST.json_format_enabled(b"search:\n  formats:\n    - html\n"))
        self.assertIsNone(ATTEST.json_format_enabled(b"search:\n  formats: &formats [html, json]\n"))

    def test_unprotected_ancestor_never_opens_root_private_settings(self):
        def fake_lstat(cursor):
            mode = (stat.S_IFREG | 0o600) if cursor == ATTEST.SETTINGS else (stat.S_IFDIR | 0o755)
            owner = 977 if cursor == ATTEST.SETTINGS else (1000 if cursor == str(pathlib.Path(ATTEST.SETTINGS).parent.parent) else 0)
            return types.SimpleNamespace(st_mode=mode, st_uid=owner)

        with patch.object(ATTEST.os, "lstat", side_effect=fake_lstat), patch.object(ATTEST.os, "open", side_effect=AssertionError("root file opened")):
            settings, digest, data, protected = ATTEST.file_identity()
        self.assertEqual(settings.st_uid, 977)
        self.assertIsNone(digest)
        self.assertIsNone(data)
        self.assertFalse(protected)

    def test_symlink_or_writable_ancestor_fails_before_private_open(self):
        ancestor = str(pathlib.Path(ATTEST.SETTINGS).parent.parent)
        for hostile_mode in (stat.S_IFLNK | 0o777, stat.S_IFDIR | 0o777):
            def fake_lstat(cursor):
                mode = hostile_mode if cursor == ancestor else ((stat.S_IFREG | 0o600) if cursor == ATTEST.SETTINGS else (stat.S_IFDIR | 0o755))
                return types.SimpleNamespace(st_mode=mode, st_uid=0)

            with self.subTest(mode=hostile_mode), patch.object(ATTEST.os, "lstat", side_effect=fake_lstat), patch.object(ATTEST.os, "open", side_effect=AssertionError("root file opened")):
                with self.assertRaisesRegex(RuntimeError, "settings_path_untrusted"):
                    ATTEST.file_identity()

    def test_selected_output_has_no_secret_and_requires_all_gates(self):
        container, image, settings = self.fixture()
        report = ATTEST.assess(container, image, settings, "d" * 64, True, True, "sha256:" + "a" * 64)
        self.assertEqual(report["HOST_ATTESTATION"], "PASS")
        self.assertTrue(report["checks"]["settings_bind"])
        self.assertTrue(report["checks"]["cache_writable"])
        self.assertNotIn("SECRET", str(report))
        self.assertEqual(report["containerId"], container["Id"])
        self.assertEqual(ATTEST.assess(container, image, settings, "d" * 64, True, False, "sha256:" + "a" * 64)["HOST_ATTESTATION"], "FAIL")
        self.assertEqual(ATTEST.assess(container, image, settings, "d" * 64, None, True, "sha256:" + "a" * 64)["HOST_ATTESTATION"], "UNKNOWN")
        self.assertFalse(ATTEST.assess(container, image, settings, "d" * 64, True, True)["checks"]["image_provenance"])
        container["HostConfig"]["Privileged"] = True
        self.assertEqual(ATTEST.assess(container, image, settings, "d" * 64, True, True)["HOST_ATTESTATION"], "FAIL")

    def test_identity_bind_and_port_spoofing_fail(self):
        container, image, settings = self.fixture()
        container["Name"] = "/other"
        with self.assertRaisesRegex(RuntimeError, "identity_mismatch"):
            ATTEST.assess(container, image, settings, "d" * 64, True, True)
        container["Name"] = "/pi-overdrive-searxng"
        container["Mounts"][0]["RW"] = True
        self.assertFalse(ATTEST.assess(container, image, settings, "d" * 64, True, True)["checks"]["config_read_only"])
        container["Mounts"][0]["RW"] = False
        container["Mounts"].append({"Type": "bind", "Source": "/tmp/foreign", "Destination": "/mnt", "RW": True})
        self.assertFalse(ATTEST.assess(container, image, settings, "d" * 64, True, True)["checks"]["settings_bind"])
        container["Mounts"].pop()
        container["HostConfig"]["PortBindings"]["8080/tcp"][0]["HostIp"] = "0.0.0.0"
        self.assertFalse(ATTEST.assess(container, image, settings, "d" * 64, True, True)["checks"]["requested_loopback_port"])
        container["HostConfig"]["PortBindings"]["8080/tcp"][0]["HostIp"] = "127.0.0.1"
        container["NetworkSettings"]["Ports"]["8080/tcp"][0]["HostIp"] = "0.0.0.0"
        self.assertFalse(ATTEST.assess(container, image, settings, "d" * 64, True, True)["checks"]["effective_loopback_port"])
        container["NetworkSettings"]["Ports"]["8080/tcp"][0]["HostIp"] = "127.0.0.1"
        container["State"]["Pid"] = 0
        stopped = ATTEST.assess(container, image, settings, "d" * 64, True, True)
        self.assertFalse(stopped["checks"]["running"])
        self.assertIsNone(stopped["checks"]["effective_loopback_port"])

    def test_remediation_inputs_are_bounded_and_do_not_print_secrets(self):
        container, image, _settings = self.fixture()
        container["Config"]["Env"] = ["SECRET=not-for-output", "TOKEN=also-private"]
        container["Mounts"].append({"Type": "volume", "Source": "/var/lib/docker/volumes/searxng-data/_data",
                                     "Destination": "/var/cache/searxng", "Name": "searxng-data", "RW": True})
        selected = ATTEST.remediation_inputs(container, image)
        self.assertEqual(selected["environmentCount"], 2)
        self.assertEqual(selected["mounts"][2]["name"], "searxng-data")
        self.assertEqual(selected["effectivePorts"][0]["hosts"][0]["address"], "127.0.0.1")
        self.assertNotIn("SECRET", str(selected))
        self.assertNotIn("TOKEN", str(selected))
        container["Mounts"].append({"Type": "bind", "Source": "/private/path with spaces",
                                     "Destination": "/etc/other", "RW": False})
        self.assertIsNone(ATTEST.remediation_inputs(container, image)["mounts"][3]["source"])

    def test_stopped_two_mount_host_observation_does_not_claim_live_or_provenance(self):
        container, image, settings = self.fixture()
        container["Mounts"][0]["RW"] = True
        container["State"] = {"Running": False, "Pid": 0}
        container["NetworkSettings"]["Ports"] = {}
        report = ATTEST.assess(container, image, settings, None, None, False)
        self.assertTrue(report["checks"]["image_repository"])
        self.assertFalse(report["checks"]["image_provenance"])
        self.assertTrue(report["checks"]["settings_bind"])
        self.assertFalse(report["checks"]["config_read_only"])
        self.assertTrue(report["checks"]["cache_writable"])
        self.assertTrue(report["checks"]["requested_loopback_port"])
        self.assertIsNone(report["checks"]["effective_loopback_port"])
        self.assertIsNone(report["checks"]["json_format"])
        self.assertFalse(report["checks"]["settings_protected_path"])
        self.assertFalse(report["checks"]["running"])
        self.assertEqual(report["HOST_ATTESTATION"], "FAIL")

    def test_unexpected_image_reference_and_local_digest_cannot_prove_provenance(self):
        container, image, settings = self.fixture()
        container["Config"]["Image"] = "docker.io/foreign/searxng:latest"
        report = ATTEST.assess(container, image, settings, "d" * 64, True, True)
        self.assertFalse(report["checks"]["image_repository"])
        self.assertFalse(report["checks"]["image_provenance"])
        self.assertEqual(report["HOST_ATTESTATION"], "FAIL")
        container["Config"]["Image"] = "docker.io/searxng/searxng:latest"
        image["RepoDigests"] = ["searxng/searxng@sha256:" + "c" * 64]
        report = ATTEST.assess(container, image, settings, "d" * 64, True, True)
        self.assertTrue(report["checks"]["image_repository"])
        self.assertFalse(report["checks"]["image_provenance"])
        self.assertEqual(report["imageProvenance"], "local_docker_metadata_only")


if __name__ == "__main__":
    unittest.main()
