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
