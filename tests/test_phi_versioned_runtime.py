import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "bootstrap" / "versioned-runtime.py"
SPEC = importlib.util.spec_from_file_location("phi_versioned_runtime", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class RuntimeInstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="phi-versioned-runtime-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.prefix = self.root / "prefix"
        self.git("init", "-q")
        (self.repo / "bin").mkdir()
        (self.repo / "package.json").write_text('{"name":"phi-coding-system","version":"1.0.0"}\n')
        (self.repo / "bin" / "phi.mjs").write_text('console.log("A")\n')
        self.a = self.commit("A")

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.repo), *args], check=True,
                              capture_output=True, env={**os.environ, "GIT_AUTHOR_NAME": "Fixture",
                                                       "GIT_AUTHOR_EMAIL": "fixture@example.test",
                                                       "GIT_COMMITTER_NAME": "Fixture",
                                                       "GIT_COMMITTER_EMAIL": "fixture@example.test"}).stdout.decode().strip()

    def commit(self, message):
        self.git("add", ".")
        self.git("commit", "-qm", message)
        return self.git("rev-parse", "HEAD")

    def b_commit(self):
        (self.repo / "bin" / "phi.mjs").write_text('console.log("B")\n')
        return self.commit("B")

    def install(self, release_id, **kwargs):
        return MODULE.transact(self.prefix, "install", str(self.repo), release_id, **kwargs)

    def test_clean_reinstall_update_rollback_and_persistent_state(self):
        state = self.root / "persistent-user-state"
        state.write_text("DO_NOT_CHANGE")
        self.assertEqual(self.install(self.a)["action"], "ACTIVATED")
        self.assertEqual(self.install(self.a)["action"], "REINSTALLED")
        b = self.b_commit()
        self.assertEqual(self.install(b)["action"], "ACTIVATED")
        self.assertEqual(MODULE.diagnose(self.prefix)["active"], b)
        self.assertTrue((self.prefix / "releases" / self.a).exists())
        self.assertEqual(MODULE.transact(self.prefix, "rollback")["active"], self.a)
        self.assertEqual(state.read_text(), "DO_NOT_CHANGE")
        launched = subprocess.run(["node", str(self.prefix / "active" / "bin" / "phi.mjs")],
                                  capture_output=True, text=True, check=True)
        self.assertEqual(launched.stdout.strip(), "A")

    def test_candidate_corruption_and_changed_active_reference_fail_closed(self):
        self.install(self.a)
        b = self.b_commit()
        stage = self.prefix / "releases" / b
        stage.mkdir()
        with self.assertRaises(MODULE.InstallError):
            self.install(b)
        shutil.rmtree(stage)
        (self.prefix / "active").unlink()
        (self.prefix / "active").symlink_to("../../repo")
        with self.assertRaises(MODULE.InstallError):
            MODULE.diagnose(self.prefix)
        with self.assertRaises(MODULE.InstallError):
            self.install(b)

    def test_interrupted_activation_classification_and_explicit_rollback(self):
        self.install(self.a)
        b = self.b_commit()
        with self.assertRaisesRegex(MODULE.InstallError, "injected_before_switch"):
            self.install(b, fault="before_switch")
        self.assertEqual(MODULE.diagnose(self.prefix)["state"], "INTENT_BEFORE_SWITCH")
        with self.assertRaisesRegex(MODULE.InstallError, "recovery_required"):
            self.install(b)
        # An operator may inspect; no automatic rollback or deletion follows.
        self.assertTrue((self.prefix / "releases" / b).exists())

    def test_post_switch_fault_is_not_misreported_as_stable(self):
        self.install(self.a)
        b = self.b_commit()
        with self.assertRaisesRegex(MODULE.InstallError, "injected_after_switch"):
            self.install(b, fault="after_switch")
        self.assertEqual(MODULE.diagnose(self.prefix)["state"], "SWITCHED_UNCONFIRMED")
        with self.assertRaisesRegex(MODULE.InstallError, "recovery_required"):
            MODULE.transact(self.prefix, "rollback")

    def test_actual_process_interruption_before_switch_and_fresh_diagnosis(self):
        self.install(self.a)
        b = self.b_commit()
        snippet = f'''import importlib.util, os, signal
spec = importlib.util.spec_from_file_location("runtime", {str(SCRIPT)!r})
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
def interrupted(*args): os.kill(os.getpid(), signal.SIGKILL)
module.os.replace = interrupted
module.transact({str(self.prefix)!r}, "install", {str(self.repo)!r}, {b!r})
'''
        child = subprocess.run(["python3", "-c", snippet], capture_output=True)
        self.assertEqual(child.returncode, -9)
        snapshot = subprocess.run(["python3", str(SCRIPT), "inspect", "--prefix", str(self.prefix)],
                                  capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(snapshot.stdout)["state"], "INTENT_BEFORE_SWITCH")
        self.assertEqual(MODULE.active_id(self.prefix), self.a)

    def test_post_switch_receipt_io_failure_remains_unconfirmed(self):
        self.install(self.a)
        b = self.b_commit()
        original = MODULE.write_json_atomic
        writes = 0

        def interrupted(parent, name, value):
            nonlocal writes
            writes += 1
            if writes == 2:
                raise OSError(28, "No space left on device")
            return original(parent, name, value)

        with patch.object(MODULE, "write_json_atomic", side_effect=interrupted):
            with self.assertRaises(OSError):
                self.install(b)
        self.assertEqual(MODULE.active_id(self.prefix), b)
        self.assertEqual(MODULE.diagnose(self.prefix)["state"], "SWITCHED_UNCONFIRMED")
        with self.assertRaisesRegex(MODULE.InstallError, "recovery_required"):
            MODULE.transact(self.prefix, "rollback")

    def test_staging_interruption_and_symlink_source_fail_closed(self):
        with self.assertRaisesRegex(MODULE.InstallError, "injected_staging"):
            self.install(self.a, fault="staging")
        self.assertEqual(MODULE.diagnose(self.prefix)["stagingCount"], 1)
        with self.assertRaisesRegex(MODULE.InstallError, "recovery_required"):
            self.install(self.a)
        other = self.root / "other"
        other.mkdir()
        (other / "releases").symlink_to(self.prefix / "releases")
        with self.assertRaises(MODULE.InstallError):
            MODULE.ensure_prefix(other)

    def test_previous_corruption_blocks_update_and_rollback(self):
        self.install(self.a)
        b = self.b_commit()
        self.install(b)
        old = self.prefix / "releases" / self.a / "bin" / "phi.mjs"
        old.chmod(0o644)
        old.write_text("tampered")
        with self.assertRaises(MODULE.InstallError):
            MODULE.transact(self.prefix, "rollback")
        with self.assertRaisesRegex(MODULE.InstallError, "receipt_previous_mismatch"):
            MODULE.diagnose(self.prefix)

    def test_concurrent_lock_refuses_second_installer(self):
        MODULE.ensure_prefix(self.prefix)
        lock = os.open(self.prefix / "install.lock", os.O_RDWR | os.O_CREAT, 0o600)
        try:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            child = subprocess.run(["python3", str(SCRIPT), "install", "--prefix", str(self.prefix),
                                    "--repository", str(self.repo), "--release-id", self.a],
                                   capture_output=True, text=True)
            self.assertEqual(child.returncode, 1)
            self.assertEqual(json.loads(child.stdout)["reason"], "concurrent_installer")
        finally:
            os.close(lock)

    def test_receipt_write_failure_and_temporary_artifact_fail_closed(self):
        self.install(self.a)
        b = self.b_commit()
        original = MODULE.os.write

        def full_disk(fd, data):
            if len(data) > 64:
                raise OSError(28, "No space left on device")
            return original(fd, data)

        with patch.object(MODULE.os, "write", side_effect=full_disk):
            with self.assertRaises(OSError):
                self.install(b)
        self.assertEqual(MODULE.diagnose(self.prefix)["state"], "TEMPORARY_ARTIFACTS")
        with self.assertRaisesRegex(MODULE.InstallError, "recovery_required"):
            self.install(b)
        self.assertEqual(MODULE.active_id(self.prefix), self.a)

    def test_staging_file_sync_failure_preserves_unpublished_stage(self):
        with patch.object(MODULE, "sync_file", side_effect=OSError(5, "I/O error")):
            with self.assertRaises(OSError):
                self.install(self.a)
        snapshot = MODULE.diagnose(self.prefix)
        self.assertIsNone(snapshot["active"])
        self.assertEqual(snapshot["stagingCount"], 1)
        self.assertEqual(snapshot["releases"], {})
        with self.assertRaisesRegex(MODULE.InstallError, "recovery_required"):
            self.install(self.a)

    def test_actual_process_interruption_after_switch(self):
        self.install(self.a)
        b = self.b_commit()
        snippet = f'''import importlib.util, os, signal
spec = importlib.util.spec_from_file_location("runtime", {str(SCRIPT)!r})
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
original = module.write_reference
def interrupted(*args, **kwargs):
    original(*args, **kwargs)
    os.kill(os.getpid(), signal.SIGKILL)
module.write_reference = interrupted
module.transact({str(self.prefix)!r}, "install", {str(self.repo)!r}, {b!r})
'''
        child = subprocess.run(["python3", "-c", snippet], capture_output=True)
        self.assertEqual(child.returncode, -9)
        self.assertEqual(MODULE.diagnose(self.prefix)["state"], "SWITCHED_UNCONFIRMED")
        with self.assertRaisesRegex(MODULE.InstallError, "recovery_required"):
            self.install(b)

    def test_untrusted_prefix_and_receipt_symlink_rejected(self):
        self.install(self.a)
        receipt = self.prefix / "transition.json"
        receipt.unlink()
        receipt.symlink_to("nonexistent")
        with self.assertRaisesRegex(MODULE.InstallError, "receipt_untrusted"):
            MODULE.diagnose(self.prefix)
        receipt.unlink()
        self.prefix.chmod(0o777)
        with self.assertRaisesRegex(MODULE.InstallError, "directory_untrusted"):
            MODULE.diagnose(self.prefix)

    def test_writable_nonsticky_ancestor_rejected(self):
        unsafe = self.root / "unsafe-parent"
        unsafe.mkdir(mode=0o777)
        unsafe.chmod(0o777)
        with self.assertRaisesRegex(MODULE.InstallError, "ancestor_untrusted"):
            MODULE.transact(unsafe / "prefix", "install", str(self.repo), self.a)
        self.assertFalse((unsafe / "prefix").exists())

    def test_corrupt_manifest_and_unrelated_release_block_all_mutation(self):
        self.install(self.a)
        b = self.b_commit()
        second = self.prefix / "releases" / b
        second.mkdir()
        (second / ".phi-release.json").write_text("not json")
        second.chmod(0o555)
        with self.assertRaisesRegex(MODULE.InstallError, "existing_release_invalid"):
            self.install(self.a)
        self.assertEqual(MODULE.active_id(self.prefix), self.a)

    def test_malformed_receipt_identity_fails_closed_before_mutation(self):
        self.install(self.a)
        file = self.prefix / "transition.json"
        original = file.read_text()
        for replacement in ({"to": [self.a]}, {"toDigest": "bad"}, {"from": "../other"}, []):
            value = json.loads(original)
            if isinstance(replacement, dict):
                value.update(replacement)
            else:
                value = replacement
            file.write_text(json.dumps(value))
            with self.assertRaisesRegex(MODULE.InstallError, "receipt_invalid"):
                self.install(self.a)
            self.assertEqual(MODULE.active_id(self.prefix), self.a)
        file.write_text(original)


if __name__ == "__main__":
    unittest.main()
