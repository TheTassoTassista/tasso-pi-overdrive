import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { containingMount } from './e4-rust-startup.mjs';

export const E4_TIER_CHECKS = Object.freeze([
  { id: 'A_EXECUTABLE_INVENTORY', tier: 'A', input: 'e4-toolchain-seeds.json+e4-llvm-toolchain.json' },
  { id: 'A_TOOLCHAIN_IDENTITIES', tier: 'A', input: 'frozen-image-toolchain' },
  { id: 'A_RUNTIME_SMOKES', tier: 'A', input: 'frozen-image-runtimes' },
  { id: 'A_FOCUSED_TESTS', tier: 'A', input: 'frozen-agent-hub-ast-tests' },
  { id: 'B_RUST_GENERATED_EXEC', tier: 'B', input: 'rustc-sha256+frozen-rust-source-sha256' },
]);

export const E4_SCRATCH = '/phi-cert-exec';
const MiB = 1024 * 1024;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const mountText = () => fs.readFileSync('/proc/self/mountinfo', 'utf8');
const mountAt = (point, text) => {
  const mount = containingMount(point, text);
  assert.notEqual(mount, 'UNKNOWN', `MOUNT_EVIDENCE_UNAVAILABLE:${point}`);
  assert.equal(mount.target, point, `MOUNT_NOT_DEDICATED:${point}`);
  return mount;
};
const hasFlag = (mount, flag) => mount.flags.includes(flag) || mount.superFlags.includes(flag);
export function verifyE4NestedUsernsDenied(spawn = spawnSync) {
  const result = spawn('/usr/bin/unshare', ['--user', '--map-root-user', '/usr/bin/true'], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 4096,
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', HOME: '/tmp' },
  });
  assert.equal(result.error, undefined, 'NESTED_USERNS_PROBE_SPAWN');
  assert.equal(result.status, 1, 'NESTED_USERNS_NOT_DENIED');
  assert.match(result.stderr ?? '', /Operation not permitted/u, 'NESTED_USERNS_DENIAL_UNPROVEN');
  return 'PASS';
}
const sizeBytes = (mount) => {
  const match = [...mount.flags, ...mount.superFlags].find((item) => /^size=\d+[kKmMgG]?$/u.test(item));
  if (!match) return null;
  const parsed = /^size=(\d+)([kKmMgG]?)$/u.exec(match);
  return Number(parsed[1]) * ({ '': 1, k: 1024, K: 1024, m: MiB, M: MiB, g: MiB * 1024, G: MiB * 1024 })[parsed[2]];
};

export function verifyE4TierMount(tier, options = {}) {
  assert.ok(tier === 'A' || tier === 'B', 'INVALID_E4_TIER');
  const text = options.mountinfo ?? mountText();
  assert.ok(typeof text === 'string' && text.length > 0 && text.length <= 128 * 1024,
    'MOUNT_EVIDENCE_UNAVAILABLE');
  const tmp = mountAt('/tmp', text);
  assert.equal(tmp.filesystem, 'tmpfs', 'TMP_NOT_TMPFS');
  assert.equal(hasFlag(tmp, 'rw'), true, 'TMP_NOT_WRITABLE');
  assert.equal(hasFlag(tmp, 'noexec'), true, 'TMP_EXECUTABLE');
  assert.equal(hasFlag(tmp, 'nosuid'), true, 'TMP_SUID');
  assert.equal(hasFlag(tmp, 'nodev'), true, 'TMP_DEVICE');
  if (tier === 'A') {
    const scratch = containingMount(E4_SCRATCH, text);
    assert.notEqual(scratch, 'UNKNOWN', 'MOUNT_EVIDENCE_UNAVAILABLE:SCRATCH');
    assert.notEqual(scratch.target, E4_SCRATCH, 'TIER_A_SCRATCH_MOUNTED');
    return { tier, tmp: { filesystem: tmp.filesystem, noexec: true }, scratch: 'NOT_MOUNTED' };
  }
  const scratch = mountAt(E4_SCRATCH, text);
  assert.equal(scratch.filesystem, 'tmpfs', 'SCRATCH_NOT_TMPFS');
  assert.equal(scratch.root, '/', 'SCRATCH_NOT_FRESH_TMPFS');
  for (const flag of ['rw', 'nosuid', 'nodev'])
    assert.equal(hasFlag(scratch, flag), true, `SCRATCH_MISSING_${flag.toUpperCase()}`);
  assert.equal(hasFlag(scratch, 'noexec'), false, 'SCRATCH_NOEXEC');
  assert.equal(sizeBytes(scratch), 64 * MiB, 'SCRATCH_SIZE');
  const details = (options.lstat ?? fs.lstatSync)(E4_SCRATCH);
  assert.equal(details.isDirectory(), true, 'SCRATCH_NOT_DIRECTORY');
  assert.equal(details.isSymbolicLink(), false, 'SCRATCH_SYMLINK');
  assert.equal(details.mode & 0o7777, 0o700, 'SCRATCH_MODE');
  assert.equal(details.uid, 1001, 'SCRATCH_UID');
  assert.equal(details.gid, 1001, 'SCRATCH_GID');
  assert.equal((options.realpath ?? fs.realpathSync)(E4_SCRATCH), E4_SCRATCH, 'SCRATCH_REALPATH');
  return { tier, tmp: { filesystem: tmp.filesystem, noexec: true },
    scratch: { filesystem: scratch.filesystem, mountId: scratch.id, root: scratch.root,
      flags: ['rw', 'exec', 'nosuid', 'nodev'], sizeBytes: 64 * MiB, mode: '0700', uid: 1001, gid: 1001 } };
}

export function e4TierReceipt(tier, results, candidateSha, manifestSha256, inventoryChecks = []) {
  assert.ok(tier === 'A' || tier === 'B', 'INVALID_E4_TIER');
  assert.match(candidateSha, /^[a-f0-9]{40}$/u, 'INVALID_CANDIDATE_SHA');
  assert.match(manifestSha256, /^[a-f0-9]{64}$/u, 'INVALID_MANIFEST_SHA');
  const expected = E4_TIER_CHECKS.filter((check) => check.tier === tier);
  assert.deepEqual(Object.keys(results).sort(), expected.map((check) => check.id).sort(), 'TIER_CHECK_SET');
  const checks = expected.map((check) => {
    const item = results[check.id];
    assert.ok(['PASS', 'FAIL', 'NOT_EXECUTED'].includes(item?.status), `INVALID_CHECK_STATUS:${check.id}`);
    assert.match(item.inputSha256, /^[a-f0-9]{64}$/u, `INVALID_CHECK_INPUT:${check.id}`);
    return { ...check, status: item.status, inputSha256: item.inputSha256 };
  });
  assert.ok(Array.isArray(inventoryChecks), 'INVALID_INVENTORY_CHECKS');
  if (tier === 'B') assert.equal(inventoryChecks.length, 0, 'TIER_B_INVENTORY_OWNERSHIP');
  for (const entry of inventoryChecks) {
    assert.match(entry.id, /^(?:tool|asset|dependent):[A-Za-z0-9_.:/+-]+$/u, 'INVALID_INVENTORY_ID');
    assert.equal(entry.tier, 'A', 'INVENTORY_NOT_TIER_A');
    assert.ok(['PASS', 'FAIL', 'NOT_EXECUTED'].includes(entry.status), 'INVALID_INVENTORY_STATUS');
    assert.match(entry.inputSha256, /^[a-f0-9]{64}$/u, 'INVALID_INVENTORY_INPUT');
  }
  assert.equal(new Set(inventoryChecks.map((entry) => entry.id)).size, inventoryChecks.length,
    'DUPLICATE_INVENTORY_ID');
  const status = checks.every((check) => check.status === 'PASS') ? 'PASS' : 'FAIL';
  const body = { schema: 'phi-e4-tier-receipt-v1', tier, candidateSha, manifestSha256,
    checks, inventoryChecks, status };
  const bytes = Buffer.from(JSON.stringify(body));
  assert.ok(bytes.length <= 32 * 1024, 'TIER_RECEIPT_TOO_LARGE');
  return { ...body, sha256: digest(bytes), bytes: bytes.length };
}

export function e4JointQualification(a, b) {
  assert.equal(a?.schema, 'phi-e4-tier-receipt-v1', 'TIER_A_RECEIPT_MISSING');
  assert.equal(b?.schema, 'phi-e4-tier-receipt-v1', 'TIER_B_RECEIPT_MISSING');
  assert.equal(a.tier, 'A', 'TIER_A_RECEIPT_MISMATCH');
  assert.equal(b.tier, 'B', 'TIER_B_RECEIPT_MISMATCH');
  assert.equal(a.candidateSha, b.candidateSha, 'TIER_CANDIDATE_MISMATCH');
  assert.equal(a.manifestSha256, b.manifestSha256, 'TIER_MANIFEST_MISMATCH');
  for (const receipt of [a, b]) {
    const plain = { schema: receipt.schema, tier: receipt.tier, candidateSha: receipt.candidateSha,
      manifestSha256: receipt.manifestSha256, checks: receipt.checks,
      inventoryChecks: receipt.inventoryChecks, status: receipt.status };
    const bytes = Buffer.from(JSON.stringify(plain));
    assert.ok(bytes.length <= 32 * 1024, 'TIER_RECEIPT_TOO_LARGE');
    assert.equal(receipt.sha256, digest(bytes), 'TIER_RECEIPT_DIGEST');
    assert.equal(receipt.bytes, bytes.length, 'TIER_RECEIPT_SIZE');
    const expected = E4_TIER_CHECKS.filter((check) => check.tier === receipt.tier);
    assert.deepEqual(receipt.checks.map((check) => ({ id: check.id, tier: check.tier, input: check.input })), expected,
      'TIER_CHECK_OWNERSHIP');
    if (receipt.tier === 'A') {
      const items = receipt.inventoryChecks;
      assert.ok(Array.isArray(items), 'INVENTORY_CHECKS_MISSING');
      for (const [prefix, count] of [['tool:', 38], ['asset:', 14], ['dependent:', 12]])
        assert.equal(items.filter((entry) => entry.id.startsWith(prefix)).length, count, `INVENTORY_${prefix}_COUNT`);
      assert.equal(new Set(items.map((entry) => entry.id)).size, items.length, 'DUPLICATE_INVENTORY_ID');
      assert.equal(items.every((entry) => entry.tier === 'A' && entry.status === 'PASS' &&
        /^[a-f0-9]{64}$/u.test(entry.inputSha256)), true, 'INVENTORY_CHECK_NOT_PASS');
    } else assert.deepEqual(receipt.inventoryChecks, [], 'TIER_B_INVENTORY_OWNERSHIP');
    assert.equal(receipt.checks.every((check) => check.status === 'PASS'), true, 'TIER_MANDATORY_CHECK_FAILED');
    assert.equal(receipt.status, 'PASS', 'TIER_NOT_PASS');
  }
  return { status: 'PASS', candidateSha: a.candidateSha, manifestSha256: a.manifestSha256,
    tierA: a.sha256, tierB: b.sha256 };
}
