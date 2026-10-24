import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const script = path.resolve(import.meta.dirname, '../scripts/omniroute-protected-host-install.py');

test('protected installer reports exact root child mismatch and still fails closed', () => {
  const probe = `
import hashlib, os, runpy, tempfile, sys
installer = runpy.run_path(sys.argv[1], run_name="read_only_test_import")
verify = installer["verify_or_copy_tree"]
with tempfile.TemporaryDirectory(prefix="phi-omni-child-regression-") as root:
    os.chmod(root, 0o700)
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    rows = {
        ".": {"type": "directory", "sourceMode": "0700", "expectedMode": "0755"},
        "expected": {"type": "file", "sourceMode": "0600", "expectedMode": "0644",
                     "size": 0, "sha256": hashlib.sha256(b"").hexdigest()},
    }
    children = {".": {"expected"}}
    try:
        try:
            verify(fd, rows, children, os.getuid(), os.getgid())
            raise AssertionError("missing child was accepted")
        except RuntimeError as error:
            assert str(error) == "directory children mismatch: . missing=['expected'] added=[]", error
        extra = os.open("unexpected", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=fd)
        os.close(extra)
        try:
            verify(fd, rows, children, os.getuid(), os.getgid())
            raise AssertionError("extra child was accepted")
        except RuntimeError as error:
            assert str(error) == "directory children mismatch: . missing=['expected'] added=['unexpected']", error
        os.unlink("unexpected", dir_fd=fd)
        expected = os.open("expected", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=fd)
        os.close(expected)
        verify(fd, rows, children, os.getuid(), os.getgid())
        os.unlink("expected", dir_fd=fd)
        original_listdir = os.listdir
        observations = iter(([], ["transient"]))
        os.listdir = lambda directory_fd: next(observations)
        try:
            try:
                verify(fd, {".": rows["."]}, {".": set()}, os.getuid(), os.getgid())
                raise AssertionError("post-scan change was accepted")
            except RuntimeError as error:
                assert str(error) == "directory changed during scan: . missing=[] added=['transient']", error
        finally:
            os.listdir = original_listdir
        print("CHILD_DIAGNOSTIC_REGRESSION_PASS")
    finally:
        os.close(fd)
`;
  const result = spawnSync('python3', ['-I', '-c', probe, script], {
    encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CHILD_DIAGNOSTIC_REGRESSION_PASS/u);
});
