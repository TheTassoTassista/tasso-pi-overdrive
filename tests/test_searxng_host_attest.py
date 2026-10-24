"""Offline checks for the fixed, read-only SearXNG host attestor."""

import importlib.util
import pathlib
import stat
import types
import unittest


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
            "Config": {"Image": "searxng/searxng@sha256:" + digest, "Env": ["SECRET=not-for-output"]},
            "Mounts": [{"Type": "bind", "Source": str(pathlib.Path(ATTEST.SETTINGS).parent),
                        "Destination": "/etc/searxng", "RW": False}],
            "HostConfig": {"Privileged": False, "CapAdd": None, "SecurityOpt": [],
                           "NetworkMode": "bridge", "PidMode": "", "IpcMode": "",
                           "PortBindings": {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": "8888"}]}},
            "State": {"Running": True},
        }
        image = {"Id": image_id, "RepoDigests": ["searxng/searxng@sha256:" + digest]}
        settings = types.SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=977)
        return container, image, settings

    def test_strict_json_format_recognition(self):
        self.assertTrue(ATTEST.json_format_enabled(b"search:\n  formats:\n    - html\n    - json\n"))
        self.assertFalse(ATTEST.json_format_enabled(b"search:\n  formats:\n    - html\n"))
        self.assertIsNone(ATTEST.json_format_enabled(b"search:\n  formats: &formats [html, json]\n"))

    def test_selected_output_has_no_secret_and_requires_all_gates(self):
        container, image, settings = self.fixture()
        report = ATTEST.assess(container, image, settings, "d" * 64, True, True)
        self.assertEqual(report["HOST_ATTESTATION"], "PASS")
        self.assertNotIn("SECRET", str(report))
        self.assertEqual(report["containerId"], container["Id"])
        self.assertEqual(ATTEST.assess(container, image, settings, "d" * 64, True, False)["HOST_ATTESTATION"], "FAIL")
        self.assertEqual(ATTEST.assess(container, image, settings, "d" * 64, None, True)["HOST_ATTESTATION"], "FAIL")
        container["HostConfig"]["Privileged"] = True
        self.assertEqual(ATTEST.assess(container, image, settings, "d" * 64, True, True)["HOST_ATTESTATION"], "FAIL")

    def test_identity_bind_and_port_spoofing_fail(self):
        container, image, settings = self.fixture()
        container["Name"] = "/other"
        with self.assertRaisesRegex(RuntimeError, "identity_mismatch"):
            ATTEST.assess(container, image, settings, "d" * 64, True, True)
        container["Name"] = "/pi-overdrive-searxng"
        container["Mounts"][0]["RW"] = True
        self.assertEqual(ATTEST.assess(container, image, settings, "d" * 64, True, True)["HOST_ATTESTATION"], "FAIL")
        container["Mounts"][0]["RW"] = False
        container["HostConfig"]["PortBindings"]["8080/tcp"][0]["HostIp"] = "0.0.0.0"
        self.assertEqual(ATTEST.assess(container, image, settings, "d" * 64, True, True)["HOST_ATTESTATION"], "FAIL")


if __name__ == "__main__":
    unittest.main()
