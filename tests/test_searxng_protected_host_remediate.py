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
    def incoming_snapshot(self, parent, stage, fd):
        parent_stat = os.fstat(fd)
        stage_stat = os.stat(stage)
        return {"hostParent": "PRESENT", "parent": {
            "protected": True, "dev": parent_stat.st_dev, "ino": parent_stat.st_ino,
            "mtimeNs": parent_stat.st_mtime_ns, "ctimeNs": parent_stat.st_ctime_ns},
            "transactionState": "INCOMING_MANUAL", "knownEntries": {
                REMEDY.INCOMING: {"dev": stage_stat.st_dev, "ino": stage_stat.st_ino}},
            "unexpectedEntryCount": 0, "sourceIntegrity": "PASS",
            "originalCacheIntegrity": "PASS",
            "originalDockerAndCandidateAbsence": "PASS"}

    @contextlib.contextmanager
    def staged_fixture(self):
        with tempfile.TemporaryDirectory() as tmp:
            parent = pathlib.Path(tmp) / "searxng"
            parent.mkdir(mode=0o710)
            stage = parent / REMEDY.INCOMING
            config = stage / "config"
            cache = stage / "cache"
            stage.mkdir(mode=0o710)
            config.mkdir(mode=0o710)
            cache.mkdir(mode=0o700)
            payload = b"search:\n  formats:\n    - json\n"
            digest = hashlib.sha256(payload).hexdigest()
            settings = config / "settings.yml"
            settings.write_bytes(payload)
            settings.chmod(0o640)
            marker = stage / ".phi-candidate.json"
            marker.write_text(json.dumps({"schema": "phi-searxng-candidate-v1",
                "image": REMEDY.IMAGE_ID, "original": REMEDY.ORIGINAL_ID,
                "sourceSha256": digest}, sort_keys=True), encoding="ascii")
            marker.chmod(0o600)
            real_fstat, real_stat = os.fstat, os.stat
            def root_metadata(value):
                fields = {key: getattr(value, key) for key in
                    ("st_dev", "st_ino", "st_mode", "st_uid", "st_gid", "st_size",
                     "st_mtime_ns", "st_ctime_ns", "st_nlink")}
                fields.update(st_uid=0, st_gid=0)
                return types.SimpleNamespace(**fields)
            def spoof_fstat(item):
                value = real_fstat(item)
                path = pathlib.Path(os.readlink(f"/proc/self/fd/{item}"))
                if path.is_relative_to(parent) and "cache" not in path.parts:
                    return root_metadata(value)
                return value
            def spoof_stat(*args, **kwargs):
                value = real_stat(*args, **kwargs)
                path = (pathlib.Path(os.readlink(f"/proc/self/fd/{kwargs['dir_fd']}")) / args[0]
                        if kwargs.get("dir_fd") is not None else pathlib.Path(args[0]))
                if path.is_relative_to(parent) and "cache" not in path.parts:
                    return root_metadata(value)
                return value
            fd = os.open(parent, REMEDY.DIR_FLAGS)
            phi_fd = os.open(tmp, REMEDY.DIR_FLAGS)
            try:
                with patch.object(REMEDY, "PARENT", str(parent)), \
                     patch.object(REMEDY, "RECOVERY_PARENT_ID",
                                  (real_fstat(fd).st_dev, real_fstat(fd).st_ino)), \
                     patch.object(REMEDY, "RECOVERY_INCOMING_ID",
                                  (real_stat(stage).st_dev, real_stat(stage).st_ino)), \
                     patch.object(REMEDY, "SOURCE_SHA256", digest), \
                     patch.object(REMEDY, "SOURCE_UID_GID", (os.getuid(), os.getgid())), \
                     patch.object(REMEDY.os, "fstat", side_effect=spoof_fstat), \
                     patch.object(REMEDY.os, "stat", side_effect=spoof_stat), \
                     patch.object(REMEDY.os, "listxattr", return_value=[]), \
                     patch.object(REMEDY, "mount_id", return_value=40), \
                     patch.object(REMEDY, "verify_acl"):
                    yield parent, stage, settings, marker, fd, phi_fd
            finally:
                os.close(fd)
                os.close(phi_fd)

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
                 patch.object(REMEDY, "SOURCE_INO", item.st_ino), \
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

    def test_source_requires_pinned_inode_and_live_home_mount(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp) / "config"
            base.mkdir()
            payload = b"search:\n  formats:\n    - json\n"
            settings = base / "settings.yml"
            settings.write_bytes(payload)
            settings.chmod(0o600)
            with patch.object(REMEDY, "SOURCE_PARTS", base.parts[1:]), \
                 patch.object(REMEDY, "SOURCE_UID_GID", (os.getuid(), os.getgid())), \
                 patch.object(REMEDY, "SOURCE_SHA256", hashlib.sha256(payload).hexdigest()):
                with patch.object(REMEDY, "SOURCE_INO", settings.stat().st_ino + 1):
                    with self.assertRaisesRegex(REMEDY.GateError, "source_identity_changed"):
                        REMEDY.source_bytes()
                with patch.object(REMEDY, "SOURCE_INO", settings.stat().st_ino), \
                     patch.object(REMEDY, "mount_id", side_effect=lambda fd:
                         41 if os.readlink(f"/proc/self/fd/{fd}") == str(settings) else 40):
                    with self.assertRaisesRegex(REMEDY.GateError, "source_mount_changed"):
                        REMEDY.source_bytes()

    def test_cache_changed_or_symlink_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp) / "data"
            base.mkdir()
            item = base.stat()
            with patch.object(REMEDY, "CACHE_PARTS", base.parts[1:]), \
                 patch.object(REMEDY, "CACHE_INO", item.st_ino), \
                 patch.object(REMEDY, "SOURCE_UID_GID", (os.getuid(), os.getgid())):
                REMEDY.check_cache()
                (base / "user-state").write_text("preserve", encoding="utf-8")
                with self.assertRaisesRegex(REMEDY.GateError, "cache_no_longer_empty"):
                    REMEDY.check_cache()
                self.assertEqual((base / "user-state").read_text(encoding="utf-8"), "preserve")

    def test_cache_requires_pinned_inode_and_live_home_mount(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp) / "data"
            base.mkdir()
            with patch.object(REMEDY, "CACHE_PARTS", base.parts[1:]), \
                 patch.object(REMEDY, "SOURCE_UID_GID", (os.getuid(), os.getgid())):
                with patch.object(REMEDY, "CACHE_INO", base.stat().st_ino + 1):
                    with self.assertRaisesRegex(REMEDY.GateError, "cache_identity_changed"):
                        REMEDY.check_cache()
                with patch.object(REMEDY, "CACHE_INO", base.stat().st_ino), \
                     patch.object(REMEDY, "mount_id", side_effect=lambda fd:
                         41 if os.readlink(f"/proc/self/fd/{fd}") == str(base) else 40):
                    with self.assertRaisesRegex(REMEDY.GateError, "cache_mount_changed"):
                        REMEDY.check_cache()

    def test_source_and_cache_accept_current_mount_device_after_renumber(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            config, cache = root / "config", root / "data"
            config.mkdir()
            cache.mkdir()
            payload = b"search:\n  formats:\n    - json\n"
            settings = config / "settings.yml"
            settings.write_bytes(payload)
            settings.chmod(0o600)
            real_fstat, real_stat = os.fstat, os.stat
            fields = ("st_dev", "st_ino", "st_mode", "st_uid", "st_gid", "st_size",
                      "st_mtime_ns", "st_ctime_ns", "st_nlink")
            def renumber(item):
                values = {key: getattr(item, key) for key in fields}
                values["st_dev"] += 1000
                return types.SimpleNamespace(**values)
            with patch.object(REMEDY, "SOURCE_PARTS", config.parts[1:]), \
                 patch.object(REMEDY, "CACHE_PARTS", cache.parts[1:]), \
                 patch.object(REMEDY, "SOURCE_INO", settings.stat().st_ino), \
                 patch.object(REMEDY, "CACHE_INO", cache.stat().st_ino), \
                 patch.object(REMEDY, "SOURCE_UID_GID", (os.getuid(), os.getgid())), \
                 patch.object(REMEDY, "SOURCE_SHA256", hashlib.sha256(payload).hexdigest()), \
                 patch.object(REMEDY.os, "fstat", side_effect=lambda fd: renumber(real_fstat(fd))), \
                 patch.object(REMEDY.os, "stat", side_effect=lambda *a, **kw:
                     renumber(real_stat(*a, **kw))):
                self.assertEqual(REMEDY.source_bytes(), payload)
                REMEDY.check_cache()

    def test_named_chain_recheck_rejects_same_inode_on_different_mount(self):
        with tempfile.TemporaryDirectory() as tmp:
            parts = pathlib.Path(tmp).parts[1:]
            opened = REMEDY.open_chain(parts)
            try:
                original_mount_id = REMEDY.mount_id
                with patch.object(REMEDY, "mount_id", side_effect=lambda fd:
                     41 if fd not in opened else original_mount_id(fd)):
                    with self.assertRaisesRegex(REMEDY.GateError,
                                                "source_or_cache_path_replaced"):
                        REMEDY.verify_chain(opened, parts)
            finally:
                REMEDY.close_all(opened)

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

    def test_complete_staging_and_published_tree_use_same_verifier(self):
        with self.staged_fixture() as (parent, stage, settings, marker, fd, _phi_fd):
            identity = REMEDY.verify_tree(fd, REMEDY.INCOMING)
            self.assertEqual(identity, (stage.stat().st_dev, stage.stat().st_ino))
            REMEDY.rename_noreplace(fd, REMEDY.INCOMING, REMEDY.TARGET)
            self.assertEqual(REMEDY.verify_tree(fd, REMEDY.TARGET), identity)
            self.assertFalse(stage.exists())
            self.assertTrue((parent / REMEDY.TARGET).is_dir())

    def test_staging_incomplete_marker_hash_and_symlink_fail_closed(self):
        with self.staged_fixture() as (parent, stage, settings, marker, fd, _phi_fd):
            original_marker = marker.read_bytes()
            marker.unlink()
            with self.assertRaises(REMEDY.GateError):
                REMEDY.verify_tree(fd, REMEDY.INCOMING)
            marker.write_bytes(original_marker)
            marker.chmod(0o600)
            marker.write_text('{"schema":"altered"}', encoding="ascii")
            with self.assertRaisesRegex(REMEDY.GateError, "target_marker_mismatch"):
                REMEDY.verify_tree(fd, REMEDY.INCOMING)
            marker.write_bytes(original_marker + b" ")
            with self.assertRaisesRegex(REMEDY.GateError, "target_marker_mismatch"):
                REMEDY.verify_tree(fd, REMEDY.INCOMING)
            marker.write_bytes(original_marker)
            with patch.object(REMEDY, "SOURCE_SHA256", "0" * 64):
                with self.assertRaisesRegex(REMEDY.GateError, "protected_file_digest_invalid"):
                    REMEDY.verify_tree(fd, REMEDY.INCOMING)
            settings.unlink()
            settings.symlink_to("/etc/passwd")
            with self.assertRaises(OSError):
                REMEDY.verify_tree(fd, REMEDY.INCOMING)

    def test_read_only_staging_inspection_rechecks_original_and_rejects_target(self):
        with self.staged_fixture() as (parent, stage, settings, marker, fd, phi_fd):
            parent_stat = os.fstat(fd)
            stage_open = os.open(stage, REMEDY.DIR_FLAGS)
            try:
                stage_stat = os.fstat(stage_open)
            finally:
                os.close(stage_open)
            snapshot = {"hostParent": "PRESENT", "parent": {
                "protected": True, "dev": parent_stat.st_dev, "ino": parent_stat.st_ino,
                "mtimeNs": parent_stat.st_mtime_ns, "ctimeNs": parent_stat.st_ctime_ns},
                "transactionState": "INCOMING_MANUAL", "knownEntries": {
                    REMEDY.INCOMING: {"dev": stage_stat.st_dev, "ino": stage_stat.st_ino}},
                "unexpectedEntryCount": 0, "sourceIntegrity": "PASS",
                "originalCacheIntegrity": "PASS",
                "originalDockerAndCandidateAbsence": "PASS"}
            with patch.object(REMEDY, "inspect_parent", return_value=snapshot), \
                 patch.object(REMEDY, "source_bytes"), \
                 patch.object(REMEDY, "check_cache"), \
                 patch.object(REMEDY, "fixed_docker_state") as docker_state:
                result = REMEDY.inspect_staging(phi_fd)
                self.assertEqual(result["STAGING_INTEGRITY"], "PASS_SNAPSHOT")
                self.assertIs(result["publicationAuthorized"], False)
                self.assertEqual(docker_state.call_count, 1)
                snapshot["parent"]["protected"] = False
                self.assertEqual(REMEDY.inspect_staging(phi_fd)["failedPredicate"],
                                 "host_parent_protected")
                snapshot["parent"]["protected"] = True
                for field, expected in (("sourceIntegrity", "original_source_integrity"),
                                        ("originalCacheIntegrity", "original_cache_integrity"),
                                        ("originalDockerAndCandidateAbsence",
                                         "original_docker_and_candidate_absence")):
                    snapshot[field] = "FAIL_OR_UNKNOWN"
                    self.assertEqual(REMEDY.inspect_staging(phi_fd)["failedPredicate"], expected)
                    snapshot[field] = "PASS"
                snapshot["transactionState"] = "AMBIGUOUS_MANUAL"
                self.assertEqual(REMEDY.inspect_staging(phi_fd)["failedPredicate"],
                                 "incoming_transaction_state")
                snapshot["transactionState"] = "INCOMING_MANUAL"
                (parent / REMEDY.TARGET).mkdir()
                with self.assertRaisesRegex(REMEDY.GateError,
                                            "staging_parent_or_target_changed"):
                    REMEDY.inspect_staging(phi_fd)
                (parent / REMEDY.TARGET).rmdir()
                refreshed = os.fstat(fd)
                snapshot["parent"]["mtimeNs"] = refreshed.st_mtime_ns
                snapshot["parent"]["ctimeNs"] = refreshed.st_ctime_ns
                with patch.object(REMEDY, "verify_tree", return_value=(36, 999999)):
                    with self.assertRaisesRegex(REMEDY.GateError, "staging_identity_changed"):
                        REMEDY.inspect_staging(phi_fd)
                self.assertFalse((parent / REMEDY.TARGET).exists())

    def test_inspect_staging_precondition_failure_exits_nonzero_without_mutation(self):
        with tempfile.TemporaryDirectory() as tmp:
            fd = os.open(tmp, REMEDY.DIR_FLAGS)
            output = io.StringIO()
            try:
                with patch.object(REMEDY.sys, "argv", [str(SCRIPT), "inspect-staging"]), \
                     patch.object(REMEDY.os, "geteuid", return_value=0), \
                     patch.object(REMEDY, "protected_opt_fd", return_value=[fd]), \
                     patch.object(REMEDY, "inspect_staging", return_value={
                         "STAGING_INTEGRITY": "FAIL_CLOSED_MANUAL",
                         "failedPredicate": "original_source_integrity"}), \
                     patch.object(REMEDY, "stage_copy") as stage_copy, \
                     patch.object(REMEDY, "docker") as docker, \
                     contextlib.redirect_stdout(output):
                    self.assertEqual(REMEDY.main(), 1)
                self.assertEqual(json.loads(output.getvalue())["failedPredicate"],
                                 "original_source_integrity")
                stage_copy.assert_not_called()
                docker.assert_not_called()
            finally:
                # main owns and closes descriptors returned by protected_opt_fd.
                with contextlib.suppress(OSError):
                    os.close(fd)

    def test_recover_publishes_only_freshly_attested_staging(self):
        with self.staged_fixture() as (parent, stage, settings, marker, fd, phi_fd):
            snapshot = self.incoming_snapshot(parent, stage, fd)
            original_settings = settings.read_bytes()
            with patch.object(REMEDY, "inspect_parent", return_value=snapshot), \
                 patch.object(REMEDY, "source_bytes", return_value=original_settings) as source, \
                 patch.object(REMEDY, "check_cache") as cache, \
                 patch.object(REMEDY, "fixed_docker_state") as docker_state, \
                 patch.object(REMEDY, "docker") as docker:
                result = REMEDY.recover_staging(phi_fd)
                self.assertEqual(result["SEARXNG_HOST_REMEDIATION"], "PUBLISHED_NO_CANDIDATE")
                self.assertFalse(result["candidateCreated"])
                self.assertFalse(result["serviceStarted"])
                self.assertEqual(result["targetIno"], (parent / REMEDY.TARGET).stat().st_ino)
                self.assertEqual(source.call_count, 2)
                self.assertEqual(cache.call_count, 2)
                self.assertEqual(docker_state.call_count, 3)
                docker.assert_not_called()
            self.assertFalse(stage.exists())
            self.assertEqual((parent / REMEDY.TARGET / "config" / "settings.yml").read_bytes(),
                             original_settings)
            with patch.object(REMEDY, "inspect_parent", return_value=snapshot), \
                 patch.object(REMEDY, "source_bytes"), \
                 patch.object(REMEDY, "check_cache"), \
                 patch.object(REMEDY, "fixed_docker_state"):
                with self.assertRaises(REMEDY.GateError):
                    REMEDY.recover_staging(phi_fd)

    def test_recover_rejects_changed_marker_hash_originals_and_target_before_publish(self):
        for failure in ("marker", "hash", "source", "cache", "docker", "target", "symlink"):
            with self.subTest(failure=failure), self.staged_fixture() as (
                    parent, stage, settings, marker, fd, phi_fd):
                snapshot = self.incoming_snapshot(parent, stage, fd)
                if failure == "marker":
                    marker.write_text("{}", encoding="ascii")
                elif failure == "hash":
                    settings.write_bytes(b"changed-secret")
                elif failure == "target":
                    (parent / REMEDY.TARGET).mkdir()
                elif failure == "symlink":
                    settings.unlink()
                    settings.symlink_to("/etc/passwd")
                source_effect = (REMEDY.GateError("source_digest_mismatch")
                                 if failure == "source" else None)
                cache_effect = (REMEDY.GateError("cache_no_longer_empty")
                                if failure == "cache" else None)
                docker_effect = (REMEDY.GateError("docker_identity_unavailable")
                                 if failure == "docker" else None)
                with patch.object(REMEDY, "inspect_parent", return_value=snapshot), \
                     patch.object(REMEDY, "source_bytes", side_effect=source_effect), \
                     patch.object(REMEDY, "check_cache", side_effect=cache_effect), \
                     patch.object(REMEDY, "fixed_docker_state", side_effect=docker_effect), \
                     patch.object(REMEDY, "rename_noreplace") as rename:
                    with self.assertRaises((REMEDY.GateError, OSError)):
                        REMEDY.recover_staging(phi_fd)
                    rename.assert_not_called()
                self.assertTrue(stage.exists())
                if failure == "target":
                    self.assertTrue((parent / REMEDY.TARGET).exists())
                else:
                    self.assertFalse((parent / REMEDY.TARGET).exists())

    def test_recover_rejects_change_after_snapshot_and_fsync_failure(self):
        for failed_step in ("source", "cache", "docker", "sync"):
            with self.subTest(failed_step=failed_step), self.staged_fixture() as (
                    parent, stage, settings, marker, fd, phi_fd):
                snapshot = {"STAGING_INTEGRITY": "PASS_SNAPSHOT",
                            "parentDev": os.fstat(fd).st_dev,
                            "parentIno": os.fstat(fd).st_ino,
                            "stagingDev": stage.stat().st_dev,
                            "stagingIno": stage.stat().st_ino}
                source_effect = (REMEDY.GateError("source_digest_mismatch")
                                 if failed_step == "source" else None)
                cache_effect = (REMEDY.GateError("cache_identity_changed")
                                if failed_step == "cache" else None)
                docker_effect = (REMEDY.GateError("docker_identity_unavailable")
                                 if failed_step == "docker" else None)
                sync_effect = (REMEDY.GateError("fsync_failed")
                               if failed_step == "sync" else None)
                with patch.object(REMEDY, "inspect_staging", return_value=snapshot), \
                     patch.object(REMEDY, "source_bytes", side_effect=source_effect), \
                     patch.object(REMEDY, "check_cache", side_effect=cache_effect), \
                     patch.object(REMEDY, "fixed_docker_state", side_effect=docker_effect), \
                     patch.object(REMEDY, "sync_staging", side_effect=sync_effect), \
                     patch.object(REMEDY, "rename_noreplace") as rename:
                    with self.assertRaises(REMEDY.GateError):
                        REMEDY.recover_staging(phi_fd)
                    rename.assert_not_called()
                self.assertTrue(stage.exists())
                self.assertFalse((parent / REMEDY.TARGET).exists())

    def test_recover_rejects_mount_mismatch_after_snapshot(self):
        with self.staged_fixture() as (parent, stage, settings, marker, fd, phi_fd):
            snapshot = {"STAGING_INTEGRITY": "PASS_SNAPSHOT",
                        "parentDev": os.fstat(fd).st_dev,
                        "parentIno": os.fstat(fd).st_ino,
                        "stagingDev": stage.stat().st_dev,
                        "stagingIno": stage.stat().st_ino}
            def changed_mount(item):
                return 41 if os.readlink(f"/proc/self/fd/{item}") == str(parent) else 40
            with patch.object(REMEDY, "inspect_staging", return_value=snapshot), \
                 patch.object(REMEDY, "mount_id", side_effect=changed_mount), \
                 patch.object(REMEDY, "rename_noreplace") as rename:
                with self.assertRaisesRegex(REMEDY.GateError, "recovery_parent_changed"):
                    REMEDY.recover_staging(phi_fd)
                rename.assert_not_called()

    def test_recover_precondition_refuses_unknown_without_any_mutation(self):
        with tempfile.TemporaryDirectory() as tmp:
            fd = os.open(tmp, REMEDY.DIR_FLAGS)
            try:
                with patch.object(REMEDY, "inspect_staging", return_value={
                        "STAGING_INTEGRITY": "FAIL_CLOSED_MANUAL",
                        "failedPredicate": "original_source_integrity"}), \
                     patch.object(REMEDY, "rename_noreplace") as rename, \
                     patch.object(REMEDY, "docker") as docker:
                    with self.assertRaisesRegex(REMEDY.GateError,
                                                "recovery_precondition_original_source_integrity"):
                        REMEDY.recover_staging(fd)
                    rename.assert_not_called()
                    docker.assert_not_called()
            finally:
                os.close(fd)

    def test_recover_rejects_changed_approved_parent_or_staging_identity(self):
        with self.staged_fixture() as (parent, stage, settings, marker, fd, phi_fd):
            snapshot = {"STAGING_INTEGRITY": "PASS_SNAPSHOT",
                        "parentDev": os.fstat(fd).st_dev,
                        "parentIno": os.fstat(fd).st_ino,
                        "stagingDev": stage.stat().st_dev,
                        "stagingIno": stage.stat().st_ino}
            with patch.object(REMEDY, "inspect_staging", return_value=snapshot), \
                 patch.object(REMEDY, "RECOVERY_PARENT_ID", (36, 1)), \
                 patch.object(REMEDY, "rename_noreplace") as rename:
                with self.assertRaisesRegex(REMEDY.GateError, "recovery_parent_not_approved"):
                    REMEDY.recover_staging(phi_fd)
                rename.assert_not_called()
            with patch.object(REMEDY, "inspect_staging", return_value=snapshot), \
                 patch.object(REMEDY, "RECOVERY_INCOMING_ID", (36, 1)), \
                 patch.object(REMEDY, "rename_noreplace") as rename:
                with self.assertRaisesRegex(REMEDY.GateError, "recovery_staging_not_approved"):
                    REMEDY.recover_staging(phi_fd)
                rename.assert_not_called()

    def test_recover_cli_dispatches_once_without_apply_or_create(self):
        with tempfile.TemporaryDirectory() as tmp:
            fd = os.open(tmp, REMEDY.DIR_FLAGS)
            output = io.StringIO()
            try:
                with patch.object(REMEDY.sys, "argv", [str(SCRIPT), "recover"]), \
                     patch.object(REMEDY.os, "geteuid", return_value=0), \
                     patch.object(REMEDY, "protected_opt_fd", return_value=[fd]), \
                     patch.object(REMEDY, "recover_staging", return_value={
                         "SEARXNG_HOST_REMEDIATION": "PUBLISHED_NO_CANDIDATE"}) as recover, \
                     patch.object(REMEDY, "stage_copy") as stage, \
                     patch.object(REMEDY, "docker") as docker, \
                     contextlib.redirect_stdout(output):
                    self.assertEqual(REMEDY.main(), 0)
                recover.assert_called_once_with(fd)
                stage.assert_not_called()
                docker.assert_not_called()
                self.assertEqual(json.loads(output.getvalue())["SEARXNG_HOST_REMEDIATION"],
                                 "PUBLISHED_NO_CANDIDATE")
            finally:
                with contextlib.suppress(OSError):
                    os.close(fd)

    def test_recover_refuses_snapshot_mismatch_and_concurrent_noreplace_conflict(self):
        with self.staged_fixture() as (parent, stage, settings, marker, fd, phi_fd):
            snapshot = self.incoming_snapshot(parent, stage, fd)
            snapshot["knownEntries"][REMEDY.INCOMING]["ino"] += 1
            with patch.object(REMEDY, "inspect_parent", return_value=snapshot), \
                 patch.object(REMEDY, "source_bytes"), \
                 patch.object(REMEDY, "check_cache"), \
                 patch.object(REMEDY, "fixed_docker_state"), \
                 patch.object(REMEDY, "rename_noreplace") as rename:
                with self.assertRaisesRegex(REMEDY.GateError, "staging_identity_changed"):
                    REMEDY.recover_staging(phi_fd)
                rename.assert_not_called()
            snapshot["knownEntries"][REMEDY.INCOMING]["ino"] -= 1
            original_rename = REMEDY.rename_noreplace
            def conflict(parent_fd, old, new):
                (parent / new).write_bytes(b"foreign-state")
                original_rename(parent_fd, old, new)
            with patch.object(REMEDY, "inspect_parent", return_value=snapshot), \
                 patch.object(REMEDY, "source_bytes"), \
                 patch.object(REMEDY, "check_cache"), \
                 patch.object(REMEDY, "fixed_docker_state"), \
                 patch.object(REMEDY, "rename_noreplace", side_effect=conflict):
                with self.assertRaisesRegex(REMEDY.GateError, "publication_noreplace_failed"):
                    REMEDY.recover_staging(phi_fd)
            self.assertTrue(stage.exists())
            self.assertEqual((parent / REMEDY.TARGET).read_bytes(), b"foreign-state")

    def test_recover_interruption_after_publish_keeps_classifiable_target(self):
        with self.staged_fixture() as (parent, stage, settings, marker, fd, phi_fd):
            snapshot = self.incoming_snapshot(parent, stage, fd)
            original_fsync = REMEDY.fsync_dir
            def interrupt_after_rename(directory_fd):
                if not stage.exists() and (parent / REMEDY.TARGET).exists():
                    raise REMEDY.GateError("injected_after_publish")
                return original_fsync(directory_fd)
            with patch.object(REMEDY, "inspect_parent", return_value=snapshot), \
                 patch.object(REMEDY, "source_bytes"), \
                 patch.object(REMEDY, "check_cache"), \
                 patch.object(REMEDY, "fixed_docker_state"), \
                 patch.object(REMEDY, "fsync_dir", side_effect=interrupt_after_rename):
                with self.assertRaisesRegex(REMEDY.GateError, "injected_after_publish"):
                    REMEDY.recover_staging(phi_fd)
            self.assertFalse(stage.exists())
            self.assertTrue((parent / REMEDY.TARGET).exists())
            with patch.object(REMEDY, "candidate_state", return_value="ABSENT"):
                self.assertEqual(REMEDY.status(fd), "PUBLISHED_NO_CANDIDATE")
            with patch.object(REMEDY, "inspect_staging", return_value={
                    "STAGING_INTEGRITY": "FAIL_CLOSED_MANUAL",
                    "failedPredicate": "incoming_transaction_state"}), \
                 patch.object(REMEDY, "rename_noreplace") as rename:
                with self.assertRaises(REMEDY.GateError):
                    REMEDY.recover_staging(phi_fd)
                rename.assert_not_called()

    def test_postpublish_reason_only_after_rename_and_fsync(self):
        for changed in ("incoming_recreated", "identity_changed", "extra_entry"):
            with self.subTest(changed=changed), self.staged_fixture() as (
                    parent, stage, settings, marker, fd, phi_fd):
                snapshot = self.incoming_snapshot(parent, stage, fd)
                original_rename = REMEDY.rename_noreplace
                original_verify = REMEDY.verify_tree
                def publish_and_change(parent_fd, old, new):
                    original_rename(parent_fd, old, new)
                    if changed == "incoming_recreated":
                        (parent / REMEDY.INCOMING).mkdir()
                    elif changed == "extra_entry":
                        (parent / "foreign-entry").write_bytes(b"preserve")
                def verify_with_changed_identity(parent_fd, name):
                    actual = original_verify(parent_fd, name)
                    if changed == "identity_changed" and name == REMEDY.TARGET:
                        return (actual[0], actual[1] + 1)
                    return actual
                with patch.object(REMEDY, "inspect_parent", return_value=snapshot), \
                     patch.object(REMEDY, "source_bytes"), \
                     patch.object(REMEDY, "check_cache"), \
                     patch.object(REMEDY, "fixed_docker_state"), \
                     patch.object(REMEDY, "rename_noreplace",
                                  side_effect=publish_and_change), \
                     patch.object(REMEDY, "verify_tree",
                                  side_effect=verify_with_changed_identity):
                    with self.assertRaisesRegex(REMEDY.GateError,
                                                "recovery_postpublish_invalid"):
                        REMEDY.recover_staging(phi_fd)
                self.assertEqual(stage.exists(), changed == "incoming_recreated")
                self.assertTrue((parent / REMEDY.TARGET).exists())

    def test_read_only_parent_inspection_reports_postpublish_predicate_safely(self):
        with self.staged_fixture() as (parent, stage, settings, marker, fd, phi_fd):
            REMEDY.rename_noreplace(fd, REMEDY.INCOMING, REMEDY.TARGET)
            with patch.object(REMEDY, "source_bytes"), \
                 patch.object(REMEDY, "check_cache"), \
                 patch.object(REMEDY, "fixed_docker_state"), \
                 patch.object(REMEDY, "candidate_state", return_value="ABSENT"):
                report = REMEDY.inspect_parent(phi_fd)
                self.assertEqual(report["transactionState"], "PUBLISHED_NO_CANDIDATE")
                self.assertTrue(all(report["postPublishChecks"].values()))
            with patch.object(REMEDY, "source_bytes"), \
                 patch.object(REMEDY, "check_cache"), \
                 patch.object(REMEDY, "fixed_docker_state"), \
                 patch.object(REMEDY, "status",
                              side_effect=REMEDY.GateError("target_marker_mismatch")):
                report = REMEDY.inspect_parent(phi_fd)
                self.assertEqual(report["transactionReason"], "target_marker_mismatch")
                self.assertFalse(report["postPublishChecks"]["targetVerifiedNoCandidate"])
            with patch.object(REMEDY, "source_bytes"), \
                 patch.object(REMEDY, "check_cache"), \
                 patch.object(REMEDY, "fixed_docker_state"), \
                 patch.object(REMEDY, "status", side_effect=OSError("secret-value")):
                report = REMEDY.inspect_parent(phi_fd)
                self.assertEqual(report["transactionReason"], "read_or_inspect_unavailable")
                self.assertNotIn("secret-value", json.dumps(report))

    def test_inspect_cli_dispatch_remains_read_only_on_nonempty_parent(self):
        with tempfile.TemporaryDirectory() as tmp:
            fd = os.open(tmp, REMEDY.DIR_FLAGS)
            output = io.StringIO()
            try:
                report = {"HOST_PARENT_INSPECTION": "FAIL_CLOSED_MANUAL",
                          "postPublishChecks": {"targetPresent": True}}
                with patch.object(REMEDY.sys, "argv", [str(SCRIPT), "inspect"]), \
                     patch.object(REMEDY.os, "geteuid", return_value=0), \
                     patch.object(REMEDY, "protected_opt_fd", return_value=[fd]), \
                     patch.object(REMEDY, "inspect_parent", return_value=report), \
                     patch.object(REMEDY, "recover_staging") as recover, \
                     patch.object(REMEDY, "stage_copy") as stage, \
                     patch.object(REMEDY, "docker") as docker, \
                     contextlib.redirect_stdout(output):
                    self.assertEqual(REMEDY.main(), 1)
                self.assertEqual(json.loads(output.getvalue()), report)
                recover.assert_not_called()
                stage.assert_not_called()
                docker.assert_not_called()
            finally:
                with contextlib.suppress(OSError):
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

    def test_parent_inspection_absent_and_trusted_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            phi = pathlib.Path(tmp)
            fd = os.open(phi, REMEDY.DIR_FLAGS)
            try:
                self.assertEqual(REMEDY.inspect_parent(fd)["HOST_PARENT_INSPECTION"], "FAIL")
                parent = phi / "searxng"
                parent.mkdir()
                fake = {"mode": 0o710, "uid": 0, "gid": 0, "swap": False}
                real_fstat = os.fstat
                def protected_stat(item):
                    value = real_fstat(item)
                    if pathlib.Path(os.readlink(f"/proc/self/fd/{item}")) != parent:
                        return value
                    return types.SimpleNamespace(**{key: getattr(value, key) for key in
                        ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")},
                        st_mode=stat.S_IFDIR | fake["mode"],
                        st_uid=fake["uid"], st_gid=fake["gid"])
                real_stat = os.stat
                named_calls = [0]
                def protected_named(*args, **kwargs):
                    value = real_stat(*args, **kwargs)
                    if args[0] != "searxng":
                        return value
                    named_calls[0] += 1
                    return types.SimpleNamespace(**{key: getattr(value, key) for key in
                        ("st_dev", "st_size", "st_mtime_ns", "st_ctime_ns")},
                        st_ino=value.st_ino + (1 if fake["swap"] and named_calls[0] % 2 == 0 else 0),
                        st_mode=stat.S_IFDIR | fake["mode"],
                        st_uid=fake["uid"], st_gid=fake["gid"])
                with patch.object(REMEDY.os, "fstat", side_effect=protected_stat), \
                     patch.object(REMEDY.os, "stat", side_effect=protected_named), \
                     patch.object(REMEDY.os, "listxattr", return_value=["system.posix_acl_access"]), \
                     patch.object(REMEDY, "verify_acl"), \
                     patch.object(REMEDY, "mount_id", return_value=40), \
                     patch.object(REMEDY, "source_bytes"), \
                     patch.object(REMEDY, "check_cache"), \
                     patch.object(REMEDY, "fixed_docker_state"), \
                     patch.object(REMEDY, "status", return_value="PARENT_EMPTY_MANUAL"):
                    self.assertEqual(REMEDY.inspect_parent(fd)["HOST_PARENT_INSPECTION"],
                                     "TRUSTED_EMPTY_SNAPSHOT")
                    fake["swap"] = True
                    self.assertEqual(REMEDY.inspect_parent(fd)["HOST_PARENT_INSPECTION"],
                                     "FAIL_CLOSED_MANUAL")
                    fake["swap"] = False
                    fake["uid"] = 1000
                    untrusted = REMEDY.inspect_parent(fd)
                    self.assertEqual(untrusted["HOST_PARENT_INSPECTION"], "FAIL_CLOSED_MANUAL")
                    self.assertIs(untrusted["parent"]["checks"]["rootOwnership"], False)
                    fake["uid"] = 0
                    fake["mode"] = 0o777
                    self.assertEqual(REMEDY.inspect_parent(fd)["HOST_PARENT_INSPECTION"],
                                     "FAIL_CLOSED_MANUAL")
                    fake["mode"] = 0o710
                    (parent / REMEDY.TARGET).mkdir()
                    self.assertEqual(REMEDY.inspect_parent(fd)["HOST_PARENT_INSPECTION"],
                                     "FAIL_CLOSED_MANUAL")
                    (parent / REMEDY.TARGET).rmdir()
                    (parent / "foreign").write_text("preserved", encoding="utf-8")
                    result = REMEDY.inspect_parent(fd)
                    self.assertEqual(result["HOST_PARENT_INSPECTION"], "FAIL_CLOSED_MANUAL")
                    self.assertEqual(result["unexpectedEntryCount"], 1)
                    self.assertEqual((parent / "foreign").read_text(encoding="utf-8"), "preserved")
            finally:
                os.close(fd)

    def test_parent_inspection_rejects_symlink_partial_and_source_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            phi = pathlib.Path(tmp)
            fd = os.open(phi, REMEDY.DIR_FLAGS)
            try:
                parent = phi / "searxng"
                parent.symlink_to("/etc")
                with self.assertRaises(OSError):
                    REMEDY.inspect_parent(fd)
                parent.unlink()
                parent.mkdir()
                (parent / REMEDY.INCOMING).mkdir()
                with patch.object(REMEDY, "verify_acl"), \
                     patch.object(REMEDY, "mount_id", return_value=40), \
                     patch.object(REMEDY, "source_bytes", side_effect=REMEDY.GateError("changed")), \
                     patch.object(REMEDY, "check_cache"), \
                     patch.object(REMEDY, "fixed_docker_state"):
                    result = REMEDY.inspect_parent(fd)
                self.assertEqual(result["HOST_PARENT_INSPECTION"], "FAIL_CLOSED_MANUAL")
                self.assertEqual(result["transactionState"], "INCOMING_MANUAL")
                self.assertEqual(result["sourceIntegrity"], "FAIL_OR_UNKNOWN")
                self.assertEqual(result["sourceIntegrityReason"], "changed")
            finally:
                os.close(fd)


if __name__ == "__main__":
    unittest.main()
