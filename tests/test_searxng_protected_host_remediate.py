"""No-root, no-Docker tests for the one-shot protected SearXNG candidate."""

import contextlib
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import stat
import tempfile
import types
import unittest
from unittest.mock import patch


SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "searxng-protected-host-remediate.py"
SPEC = importlib.util.spec_from_file_location("searxng_protected_host_remediate", SCRIPT)
REMEDY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REMEDY)


class ProtectedRemediationTests(unittest.TestCase):
    def docker_fixture(self):
        image_env = ["SECRET=not-for-output", "__SEARXNG_CONFIG_PATH=/etc/searxng"]
        image = {"Id": REMEDY.IMAGE_ID, "Config": {"Env": image_env[:],
                 "Entrypoint": ["/usr/local/searxng/entrypoint.sh"], "Cmd": None}}
        original = {"Id": REMEDY.ORIGINAL_ID, "Name": "/" + REMEDY.ORIGINAL_NAME,
                    "Image": REMEDY.IMAGE_ID, "State": {"Running": False, "Pid": 0},
                    "Mounts": [{"Type": "bind", "Source": REMEDY.CONFIG_SOURCE,
                                "Destination": "/etc/searxng", "RW": True},
                               {"Type": "bind", "Source": REMEDY.CACHE_SOURCE,
                                "Destination": "/var/cache/searxng", "RW": True}],
                    "HostConfig": {"PortBindings": {"8080/tcp": [
                        {"HostIp": "127.0.0.1", "HostPort": "8888"}]},
                                   "NetworkMode": "bridge", "Privileged": False,
                                   "CapAdd": None, "RestartPolicy": {"Name": "no"}},
                    "Config": {"Env": image_env[:], "Entrypoint": image["Config"]["Entrypoint"],
                               "Cmd": None}}
        return original, image

    def test_source_exact_bytes_and_digest_then_hash_mismatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp) / "config"
            base.mkdir()
            payload = b"search:\n  formats:\n    - json\n"
            settings = base / "settings.yml"
            settings.write_bytes(payload)
            settings.chmod(0o600)
            item = settings.stat()
            with patch.object(REMEDY, "SOURCE_PARTS", base.parts[1:]), \
                 patch.object(REMEDY, "SOURCE_ID", (item.st_dev, item.st_ino)), \
                 patch.object(REMEDY, "SOURCE_UID_GID", (os.getuid(), os.getgid())), \
                 patch.object(REMEDY, "SOURCE_SHA256", hashlib.sha256(payload).hexdigest()):
                self.assertEqual(REMEDY.source_bytes(), payload)
                with patch.object(REMEDY, "SOURCE_SHA256", "0" * 64):
                    with self.assertRaisesRegex(REMEDY.GateError, "source_digest_mismatch"):
                        REMEDY.source_bytes()

    def test_source_symlink_or_replacement_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp) / "config"
            base.mkdir()
            settings = base / "settings.yml"
            settings.symlink_to("/etc/passwd")
            with patch.object(REMEDY, "SOURCE_PARTS", base.parts[1:]):
                with self.assertRaises(OSError):
                    REMEDY.source_bytes()
            with patch.object(REMEDY.os, "stat", side_effect=FileNotFoundError):
                with self.assertRaises(FileNotFoundError):
                    REMEDY.verify_chain([0, 0], ("swapped",))

    def test_cache_changed_or_symlink_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp) / "data"
            base.mkdir()
            item = base.stat()
            with patch.object(REMEDY, "CACHE_PARTS", base.parts[1:]), \
                 patch.object(REMEDY, "CACHE_ID", (item.st_dev, item.st_ino)), \
                 patch.object(REMEDY, "SOURCE_UID_GID", (os.getuid(), os.getgid())):
                REMEDY.check_cache()
                (base / "user-state").write_text("preserve", encoding="utf-8")
                with self.assertRaisesRegex(REMEDY.GateError, "cache_no_longer_empty"):
                    REMEDY.check_cache()
                self.assertEqual((base / "user-state").read_text(encoding="utf-8"), "preserve")

    def test_target_existing_including_symlink_rejects_before_mutation(self):
        with tempfile.TemporaryDirectory() as tmp:
            parent = pathlib.Path(tmp)
            (parent / REMEDY.TARGET).symlink_to("/etc")
            fd = os.open(parent, REMEDY.DIR_FLAGS)
            try:
                with self.assertRaisesRegex(REMEDY.GateError, "target_or_incoming_exists"):
                    REMEDY.stage_copy(fd, b"not-secret")
                self.assertFalse((parent / REMEDY.INCOMING).exists())
            finally:
                os.close(fd)

    def test_native_noreplace_keeps_existing_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            parent = pathlib.Path(tmp)
            (parent / REMEDY.INCOMING).write_bytes(b"new")
            (parent / REMEDY.TARGET).write_bytes(b"user-state")
            fd = os.open(parent, REMEDY.DIR_FLAGS)
            try:
                with self.assertRaisesRegex(REMEDY.GateError, "publication_noreplace_failed"):
                    REMEDY.rename_noreplace(fd, REMEDY.INCOMING, REMEDY.TARGET)
                self.assertEqual((parent / REMEDY.TARGET).read_bytes(), b"user-state")
                self.assertEqual((parent / REMEDY.INCOMING).read_bytes(), b"new")
            finally:
                os.close(fd)

    def test_native_noreplace_publishes_new_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            parent = pathlib.Path(tmp)
            (parent / REMEDY.INCOMING).write_bytes(b"approved")
            fd = os.open(parent, REMEDY.DIR_FLAGS)
            try:
                REMEDY.rename_noreplace(fd, REMEDY.INCOMING, REMEDY.TARGET)
                self.assertFalse((parent / REMEDY.INCOMING).exists())
                self.assertEqual((parent / REMEDY.TARGET).read_bytes(), b"approved")
            finally:
                os.close(fd)

    def test_interrupted_staging_is_manual_and_no_cleanup_occurs(self):
        with tempfile.TemporaryDirectory() as tmp:
            parent = pathlib.Path(tmp)
            fd = os.open(parent, REMEDY.DIR_FLAGS)
            try:
                with patch.object(REMEDY, "PARENT", str(parent)):
                    # Non-root fixture fails after mkdir, before any publication.
                    with self.assertRaisesRegex(REMEDY.GateError, "incoming_untrusted"):
                        REMEDY.stage_copy(fd, b"fixture")
                self.assertTrue((parent / REMEDY.INCOMING).is_dir())
                self.assertFalse((parent / REMEDY.TARGET).exists())
                self.assertEqual(REMEDY.status(fd), "INCOMING_MANUAL")
            finally:
                os.close(fd)

    def test_staging_copies_exact_bytes_and_publishes_one_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            parent = pathlib.Path(tmp)
            fd = os.open(parent, REMEDY.DIR_FLAGS)
            payload = b"search:\n  formats:\n    - json\n"
            def local_rename(parent_fd, old, new):
                self.assertFalse((parent / new).exists())
                os.rename(old, new, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
            try:
                with patch.object(REMEDY, "PARENT", str(parent)), \
                     patch.object(REMEDY, "SOURCE_SHA256", hashlib.sha256(payload).hexdigest()), \
                     patch.object(REMEDY.os, "fstat", return_value=types.SimpleNamespace(
                         st_uid=0, st_gid=0, st_mode=stat.S_IFDIR | 0o700)), \
                     patch.object(REMEDY.os, "fchown"), \
                     patch.object(REMEDY, "acl"), \
                     patch.object(REMEDY, "verify_file"), \
                     patch.object(REMEDY, "rename_noreplace", side_effect=local_rename):
                    REMEDY.stage_copy(fd, payload)
                self.assertFalse((parent / REMEDY.INCOMING).exists())
                self.assertEqual((parent / REMEDY.TARGET / "config" / "settings.yml").read_bytes(), payload)
                self.assertEqual(list((parent / REMEDY.TARGET / "cache").iterdir()), [])
            finally:
                os.close(fd)

    def test_recovery_classifies_empty_published_and_ambiguous(self):
        with tempfile.TemporaryDirectory() as tmp:
            parent = pathlib.Path(tmp)
            fd = os.open(parent, REMEDY.DIR_FLAGS)
            try:
                self.assertEqual(REMEDY.status(fd), "PARENT_EMPTY_MANUAL")
                (parent / REMEDY.TARGET).mkdir()
                with patch.object(REMEDY, "verify_published"), \
                     patch.object(REMEDY, "candidate_state", return_value="ABSENT"):
                    self.assertEqual(REMEDY.status(fd), "PUBLISHED_NO_CANDIDATE")
                (parent / REMEDY.INCOMING).mkdir()
                self.assertEqual(REMEDY.status(fd), "AMBIGUOUS_MANUAL")
            finally:
                os.close(fd)

    def test_original_daemon_container_mount_and_env_mismatch(self):
        original, image = self.docker_fixture()
        original["Config"]["Env"] = original["Config"]["Env"] * 8
        image["Config"]["Env"] = image["Config"]["Env"] * 8
        # A real 16-entry baseline must have unique keys; this fixture builds it.
        original["Config"]["Env"] = [f"KEY_{i}=private-{i}" for i in range(16)]
        image["Config"]["Env"] = original["Config"]["Env"][:]
        socket_item = type("Socket", (), {"st_mode": stat.S_IFSOCK | 0o660, "st_uid": 0})()
        def response(*args, **kwargs):
            return {("info", "--format", "{{json .ID}}"): REMEDY.DAEMON_ID,
                    ("container", "inspect", REMEDY.ORIGINAL_NAME): [original],
                    ("image", "inspect", REMEDY.IMAGE_ID): [image],
                    ("container", "inspect", REMEDY.CANDIDATE): None}[args]
        with patch.object(REMEDY.os, "lstat", return_value=socket_item), \
             patch.object(REMEDY, "docker", side_effect=response):
            REMEDY.fixed_docker_state()
            original["Mounts"].append({"Type": "volume", "Source": "/foreign",
                                       "Destination": "/other", "RW": True})
            with self.assertRaisesRegex(REMEDY.GateError, "original_mounts_changed"):
                REMEDY.fixed_docker_state()
            original["Mounts"].pop()
            original["Config"]["Env"][0] = "KEY_0=changed-private"
            with self.assertRaisesRegex(REMEDY.GateError, "original_image_config_changed"):
                REMEDY.fixed_docker_state()
            original["Config"]["Env"][0] = "KEY_0=private-0"
            original["Id"] = "foreign-container"
            with self.assertRaisesRegex(REMEDY.GateError, "original_identity_or_state_changed"):
                REMEDY.fixed_docker_state()
        with patch.object(REMEDY.os, "lstat", return_value=socket_item), \
             patch.object(REMEDY, "docker", return_value="wrong-daemon"):
            with self.assertRaisesRegex(REMEDY.GateError, "docker_identity_unavailable"):
                REMEDY.fixed_docker_state()

    def test_candidate_create_is_stopped_bounded_and_does_not_use_latest(self):
        args = REMEDY.create_argv()
        self.assertEqual(args[0:2], ("create", "--pull=never"))
        self.assertEqual(args[-1], REMEDY.IMAGE_ID)
        self.assertIn("977:977", args)
        self.assertIn("FORCE_OWNERSHIP=false", args)
        self.assertIn("127.0.0.1:8888:8080/tcp", args)
        self.assertIn("no-new-privileges:true", args)
        self.assertNotIn("latest", str(args))
        self.assertNotIn(REMEDY.CONFIG_SOURCE, str(args))
        self.assertNotIn(REMEDY.CACHE_SOURCE, str(args))

    def test_real_acl_uses_numeric_uid_and_keeps_other_access_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            parent = pathlib.Path(tmp) / "protected"
            parent.mkdir(mode=0o700)
            file = parent / "settings.yml"
            file.write_bytes(b"fixture")
            file.chmod(0o600)
            with patch.object(REMEDY, "PARENT", str(parent)):
                REMEDY.acl(str(parent), "traverse")
                REMEDY.acl(str(file), "read")
                REMEDY.verify_acl(str(parent), "traverse")
                REMEDY.verify_acl(str(file), "read")
            self.assertEqual(stat.S_IMODE(parent.stat().st_mode), 0o710)
            self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o640)

    def test_unapproved_docker_operation_and_error_do_not_leak_secrets(self):
        with patch.object(REMEDY.subprocess, "run", side_effect=AssertionError("invoked")):
            with self.assertRaisesRegex(REMEDY.GateError, "docker_operation_forbidden"):
                REMEDY.docker("start", REMEDY.ORIGINAL_NAME)
        result = type("Result", (), {"returncode": 1, "stdout": b"",
                                     "stderr": b"private-token-must-not-appear"})()
        with patch.object(REMEDY.subprocess, "run", return_value=result):
            with self.assertRaises(REMEDY.GateError) as error:
                REMEDY.docker("info", "--format", "{{json .ID}}")
        self.assertNotIn("private-token", str(error.exception))

    def test_candidate_attestation_rejects_extra_mount_or_privilege(self):
        original, image = self.docker_fixture()
        root = REMEDY.PARENT + "/" + REMEDY.TARGET
        candidate = {"Name": "/" + REMEDY.CANDIDATE, "Image": REMEDY.IMAGE_ID,
                     "State": {"Running": False, "Pid": 0},
                     "Config": {"Labels": {REMEDY.LABEL: REMEDY.LABEL_VALUE}, "User": "977:977",
                                "Entrypoint": image["Config"]["Entrypoint"], "Cmd": None,
                                "Env": image["Config"]["Env"] + ["FORCE_OWNERSHIP=false"]},
                     "Mounts": [{"Type": "bind", "Source": root + "/config",
                                 "Destination": "/etc/searxng", "RW": False},
                                {"Type": "bind", "Source": root + "/cache",
                                 "Destination": "/var/cache/searxng", "RW": True}],
                     "HostConfig": {"NetworkMode": "bridge", "Privileged": False,
                                    "CapDrop": ["ALL"], "SecurityOpt": ["no-new-privileges:true"],
                                    "RestartPolicy": {"Name": "no"},
                                    "PortBindings": {"8080/tcp": [
                                        {"HostIp": "127.0.0.1", "HostPort": "8888"}]}}}
        def response(*args, **kwargs):
            return {("info", "--format", "{{json .ID}}"): REMEDY.DAEMON_ID,
                    ("container", "inspect", REMEDY.CANDIDATE): [candidate],
                    ("image", "inspect", REMEDY.IMAGE_ID): [image]}[args]
        with patch.object(REMEDY, "docker", side_effect=response):
            self.assertEqual(REMEDY.candidate_state(), "STOPPED_ATTESTED")
            candidate["Mounts"].append({"Type": "bind", "Source": "/foreign",
                                         "Destination": "/other", "RW": True})
            with self.assertRaisesRegex(REMEDY.GateError, "candidate_identity_or_contract_changed"):
                REMEDY.candidate_state()
            candidate["Mounts"].pop()
            candidate["HostConfig"]["CapDrop"] = []
            with self.assertRaisesRegex(REMEDY.GateError, "candidate_identity_or_contract_changed"):
                REMEDY.candidate_state()

    def test_protected_copy_hash_check_rejects_modified_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            file = pathlib.Path(tmp) / "settings.yml"
            file.write_bytes(b"fixture-secret-do-not-print")
            fd = os.open(tmp, REMEDY.DIR_FLAGS)
            try:
                with self.assertRaisesRegex(REMEDY.GateError, "protected_file_digest_invalid") as error:
                    REMEDY.verify_file(fd, "settings.yml", "0" * 64, os.getuid(), os.getgid())
                self.assertNotIn("fixture-secret", str(error.exception))
            finally:
                os.close(fd)

    def test_apply_orders_rechecks_publication_and_single_stopped_create(self):
        with tempfile.TemporaryDirectory() as tmp:
            fd = os.open(tmp, REMEDY.DIR_FLAGS)
            output = io.StringIO()
            created = "a" * 64
            def docker_response(*args, **kwargs):
                return created if args[0] == "create" else [{"Id": created}]
            with patch.object(REMEDY, "PARENT", str(pathlib.Path(tmp) / "searxng")), \
                 patch.object(REMEDY.sys, "argv", [str(SCRIPT), "apply"]), \
                 patch.object(REMEDY.os, "geteuid", return_value=0), \
                 patch.object(REMEDY, "protected_opt_fd", return_value=[fd]), \
                 patch.object(REMEDY, "source_bytes", return_value=b"pinned"), \
                 patch.object(REMEDY, "check_cache") as cache, \
                 patch.object(REMEDY, "fixed_docker_state") as original, \
                 patch.object(REMEDY, "acl"), \
                 patch.object(REMEDY, "stage_copy") as stage, \
                 patch.object(REMEDY, "status", side_effect=[
                     "PUBLISHED_NO_CANDIDATE", "PUBLISHED_CANDIDATE_STOPPED"]) as state, \
                 patch.object(REMEDY, "candidate_state", return_value="STOPPED_ATTESTED"), \
                 patch.object(REMEDY, "docker", side_effect=docker_response) as docker, \
                 contextlib.redirect_stdout(output):
                self.assertEqual(REMEDY.main(), 0)
            self.assertEqual(cache.call_count, 2)
            self.assertEqual(original.call_count, 3)
            self.assertEqual(stage.call_count, 1)
            self.assertEqual(state.call_count, 2)
            self.assertEqual([call.args[0] for call in docker.call_args_list].count("create"), 1)
            self.assertEqual(json.loads(output.getvalue())["SEARXNG_HOST_REMEDIATION"],
                             "PUBLISHED_STOPPED_CANDIDATE")


if __name__ == "__main__":
    unittest.main()
