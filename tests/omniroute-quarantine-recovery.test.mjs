import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const script = path.resolve(import.meta.dirname, '../scripts/omniroute-protected-host-install.py');

test('quarantine recovery keeps exact identity, sidecar binding, no-clobber and crash states', () => {
  const probe = `
import errno, hashlib, json, os, runpy, stat, sys, tempfile
a = runpy.run_path(sys.argv[1], run_name="recovery_fixture")
g = a["recovery_identity"].__globals__
with tempfile.TemporaryDirectory(prefix="phi-omni-recovery-") as parent:
    g["PARENT"] = parent
    g["QUARANTINE"] = "quarantine"
    parent_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        parent_info = os.fstat(parent_fd)
        g["PARENT_DEV"] = parent_info.st_dev
        g["PARENT_INO"] = parent_info.st_ino
        g["PARENT_MOUNT_ID"] = a["mount_id"](parent_fd)
        a["parent_identity"](parent_fd, os.getuid(), os.getgid())
        g["PARENT_INO"] += 1
        try:
            a["parent_identity"](parent_fd, os.getuid(), os.getgid())
            raise AssertionError("wrong parent inode accepted")
        except RuntimeError:
            pass
        g["PARENT_INO"] = parent_info.st_ino
        assert a["recovery_state"](parent_fd) == "ABSENT"
        os.mkdir("quarantine", 0o755, dir_fd=parent_fd)
        quarantine_fd = os.open("quarantine", os.O_RDONLY | os.O_DIRECTORY, dir_fd=parent_fd)
        try:
            info = os.fstat(quarantine_fd)
            mount_id = a["mount_id"](quarantine_fd)
            g["QUARANTINE_DEV"] = info.st_dev
            g["QUARANTINE_INO"] = info.st_ino
            g["QUARANTINE_MOUNT_ID"] = mount_id
            assert a["recovery_state"](parent_fd) == "QUARANTINE_ONLY"
            a["recovery_identity"](parent_fd, quarantine_fd, os.getuid(), os.getgid())
            g["QUARANTINE_MOUNT_ID"] = mount_id + 1
            try:
                a["recovery_identity"](parent_fd, quarantine_fd, os.getuid(), os.getgid())
                raise AssertionError("wrong mount accepted")
            except RuntimeError:
                pass
            g["QUARANTINE_MOUNT_ID"] = mount_id
            raw = b"fixture canonical manifest bytes"
            g["MANIFEST_SHA256"] = hashlib.sha256(raw).hexdigest()
            sidecar = a["recovery_sidecar"](raw, info, mount_id)
            recovered_raw, binding = a["unpack_sidecar"](sidecar)
            assert recovered_raw == raw and binding == (info.st_dev, info.st_ino, mount_id)
            altered = json.loads(sidecar)
            altered["destination"] += "-different"
            try:
                a["unpack_sidecar"]((json.dumps(altered, sort_keys=True, separators=(",", ":")) + "\\n").encode())
                raise AssertionError("wrong destination accepted")
            except RuntimeError:
                pass
            altered["destination"] = parent + "/" + a["VERSION"]
            altered["quarantineIno"] += 1
            try:
                a["unpack_sidecar"]((json.dumps(altered, sort_keys=True, separators=(",", ":")) + "\\n").encode())
                raise AssertionError("wrong quarantine inode accepted")
            except RuntimeError:
                pass
            altered["quarantineIno"] = info.st_ino
            altered["manifestBase64"] = "invalid$base64"
            try:
                a["unpack_sidecar"]((json.dumps(altered, sort_keys=True, separators=(",", ":")) + "\\n").encode())
                raise AssertionError("invalid embedded manifest accepted")
            except RuntimeError:
                pass
            os.rename("quarantine", "held", src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
            os.symlink("held", "quarantine", dir_fd=parent_fd)
            try:
                a["recovery_identity"](parent_fd, quarantine_fd, os.getuid(), os.getgid())
                raise AssertionError("symlink substitution accepted")
            except RuntimeError:
                pass
            os.unlink("quarantine", dir_fd=parent_fd)
            os.rename("held", "quarantine", src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
            os.rename("quarantine", "held", src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
            os.mkdir("quarantine", dir_fd=parent_fd)
            try:
                a["recovery_identity"](parent_fd, quarantine_fd, os.getuid(), os.getgid())
                raise AssertionError("new object at same name accepted")
            except RuntimeError:
                pass
            os.rmdir("quarantine", dir_fd=parent_fd)
            os.rename("held", "quarantine", src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
            with os.fdopen(os.open(a["SIDECAR"], os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                                   0o600, dir_fd=parent_fd), "wb") as out:
                out.write(sidecar)
            assert a["recovery_state"](parent_fd) == "INCOMPLETE_SIDECAR_WITHOUT_TARGET"
            os.mkdir(a["VERSION"], dir_fd=parent_fd)
            try:
                a["no_replace_rename"](parent_fd, "quarantine", a["VERSION"])
                raise AssertionError("existing target overwritten")
            except OSError as error:
                assert error.errno == errno.EEXIST, error
            assert os.stat("quarantine", dir_fd=parent_fd).st_ino == info.st_ino
            os.rmdir(a["VERSION"], dir_fd=parent_fd)
            os.symlink("quarantine", a["VERSION"], dir_fd=parent_fd)
            try:
                a["no_replace_rename"](parent_fd, "quarantine", a["VERSION"])
                raise AssertionError("symlink target overwritten")
            except OSError as error:
                assert error.errno == errno.EEXIST, error
            os.unlink(a["VERSION"], dir_fd=parent_fd)
            a["no_replace_rename"](parent_fd, "quarantine", a["VERSION"])
            assert a["recovery_state"](parent_fd) == "VERIFY_REQUIRED"
            assert os.stat(a["VERSION"], dir_fd=parent_fd).st_ino == info.st_ino
            target_fd = os.open(a["VERSION"], os.O_RDONLY | os.O_DIRECTORY, dir_fd=parent_fd)
            try:
                a["verify_recovery_target_identity"](target_fd, binding)
                try:
                    a["verify_recovery_target_identity"](target_fd,
                        (binding[0], binding[1] + 1, binding[2]))
                    raise AssertionError("sidecar/target inode mismatch accepted")
                except RuntimeError:
                    pass
            finally:
                os.close(target_fd)
            os.rename(a["VERSION"], "held-target", src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
            assert a["recovery_state"](parent_fd) == "INCOMPLETE_SIDECAR_WITHOUT_TARGET"
            os.rename("held-target", a["VERSION"], src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
            os.mkdir("quarantine", dir_fd=parent_fd)
            assert a["recovery_state"](parent_fd) == "FAIL_CLOSED_CONFLICT"
            os.rmdir("quarantine", dir_fd=parent_fd)
            os.unlink(a["SIDECAR"], dir_fd=parent_fd)
            assert a["recovery_state"](parent_fd) == "FAIL_CLOSED_TARGET_WITHOUT_SIDECAR"
        finally:
            os.close(quarantine_fd)
    finally:
        os.close(parent_fd)
print("RECOVERY_STATES_NO_CLOBBER_PASS")
`;
  const result = spawnSync('python3', ['-I', '-B', '-c', probe, script], {
    encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /RECOVERY_STATES_NO_CLOBBER_PASS/u);
});

test('recovery reuses the canonical tree verifier and rejects changed payload or entries', () => {
  const probe = `
import hashlib, os, runpy, sys, tempfile
a = runpy.run_path(sys.argv[1], run_name="recovery_verifier_fixture")
with tempfile.TemporaryDirectory(prefix="phi-omni-verify-") as root:
    with open(os.path.join(root, "entry"), "wb") as out:
        out.write(b"expected")
    os.chmod(os.path.join(root, "entry"), 0o644)
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try:
        rows = {
            ".": {"type": "directory", "expectedMode": "0700"},
            "entry": {"type": "file", "expectedMode": "0644", "size": 8,
                      "sha256": hashlib.sha256(b"expected").hexdigest()},
        }
        children = {".": {"entry"}}
        verify = a["verify_or_copy_tree"]
        verify(fd, rows, children, os.getuid(), os.getgid(), target=True,
               expected_mount_id=a["mount_id"](fd))
        try:
            verify(fd, rows, children, os.getuid(), os.getgid(), target=True,
                   expected_mount_id=a["mount_id"](fd) + 1)
            raise AssertionError("wrong mount accepted")
        except RuntimeError:
            pass
        with open(os.path.join(root, "entry"), "wb") as out:
            out.write(b"modified")
        try:
            verify(fd, rows, children, os.getuid(), os.getgid(), target=True,
                   expected_mount_id=a["mount_id"](fd))
            raise AssertionError("modified payload accepted")
        except RuntimeError:
            pass
        with open(os.path.join(root, "entry"), "wb") as out:
            out.write(b"expected")
        with open(os.path.join(root, "unexpected"), "wb") as out:
            out.write(b"extra")
        try:
            verify(fd, rows, children, os.getuid(), os.getgid(), target=True,
                   expected_mount_id=a["mount_id"](fd))
            raise AssertionError("extra entry accepted")
        except RuntimeError:
            pass
    finally:
        os.close(fd)
print("CANONICAL_RECOVERY_VERIFIER_PASS")
`;
  const result = spawnSync('python3', ['-I', '-B', '-c', probe, script], {
    encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CANONICAL_RECOVERY_VERIFIER_PASS/u);
});
