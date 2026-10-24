import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const script = path.resolve(import.meta.dirname, '../scripts/omniroute-quarantine-process-attest.py');

test('host attestor keeps quarantine identity exact and fails closed on malformed mount data', () => {
  const probe = `
import os, runpy, sys
a = runpy.run_path(sys.argv[1], run_name="read_only_test_import")
root = a["QUARANTINE"]
assert a["within"](root)
assert a["within"](root + "/file")
assert not a["within"](root + "-other")
assert a["mount_references"](["40 1 0:36 / / rw - btrfs /dev/x rw"]) is False
assert a["mount_references"](["41 1 0:36 " + root + " /other rw - btrfs /dev/x rw"])
assert a["mount_references"](["41 1 0:36 / " + root + "/child rw - btrfs /dev/x rw"])
alias = a["mount_alias_references"]
item = os.stat("/")
alias.__globals__["EXPECTED_DEV"] = item.st_dev
device = str(os.major(item.st_dev)) + ":" + str(os.minor(item.st_dev))
line = "40 1 " + device + " / / rw - btrfs /dev/x rw"
assert alias(str(os.getpid()), [line], {(item.st_dev, item.st_ino)})
assert not alias(str(os.getpid()), [line], set())
try:
    a["mount_references"](["malformed"])
    raise AssertionError("malformed mount data accepted")
except RuntimeError as error:
    assert str(error) == "mountinfo_malformed"
assert a["EXPECTED_DEV"] == 36 and a["EXPECTED_INO"] == 859869
assert a["EXPECTED_MOUNT_ID"] == 40 and a["EXPECTED_ENTRIES"] == 20466
start, state = a["process_identity"](str(os.getpid()))
assert int(start) > 0 and state != "Z"
print("HOST_ATTESTOR_PARSER_PASS")
`;
  const result = spawnSync('python3', ['-I', '-B', '-c', probe, script], {
    encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /HOST_ATTESTOR_PARSER_PASS/u);
});

test('only the attestor-owned quarantine FD is exempt; other Python readers remain visible', () => {
  const probe = `
import os, runpy, subprocess, sys, tempfile
a = runpy.run_path(sys.argv[1], run_name="self_fd_regression")
with tempfile.TemporaryDirectory(prefix="phi-omni-attestor-fd-") as root:
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try:
        item = os.fstat(fd)
        ids = {(item.st_dev, item.st_ino)}
        mapped = {(os.major(item.st_dev), os.minor(item.st_dev), item.st_ino)}
        inspect = a["inspect_process"]
        assert "read_fd" in inspect(str(os.getpid()), ids, mapped)[1]
        assert inspect(str(os.getpid()), ids, mapped, fd)[1] == []
        other_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            assert "read_fd" in inspect(str(os.getpid()), ids, mapped, fd)[1]
            child = subprocess.Popen(
                [sys.executable, "-I", "-B", "-c",
                 "import sys; print('READY', flush=True); sys.stdin.buffer.read(1)"],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                pass_fds=(other_fd,), text=False)
            try:
                assert child.stdout.readline() == b"READY\\n"
                assert "read_fd" in inspect(str(child.pid), ids, mapped, fd)[1]
            finally:
                child.stdin.write(b"x")
                child.stdin.close()
                child.stdout.close()
                assert child.wait(timeout=5) == 0
        finally:
            os.close(other_fd)
    finally:
        os.close(fd)
print("SELF_FD_EXACT_EXEMPTION_PASS")
`;
  const result = spawnSync('python3', ['-I', '-B', '-c', probe, script], {
    encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SELF_FD_EXACT_EXEMPTION_PASS/u);
});
