import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { E4_TIER_CHECKS, e4JointQualification, e4TierReceipt,
  verifyE4NestedUsernsDenied, verifyE4TierMount } from '../scripts/e4-tier-contract.mjs';
import { containingMount } from '../scripts/e4-rust-startup.mjs';

const sha = 'a'.repeat(40);
const digest = 'b'.repeat(64);
const inventory = [
  ...Array.from({ length: 38 }, (_, index) => `tool:fixture-${index}`),
  ...Array.from({ length: 14 }, (_, index) => `asset:fixture-${index}`),
  ...Array.from({ length: 12 }, (_, index) => `dependent:fixture-${index}`),
].map((id) => ({ id, tier: 'A', status: 'PASS', inputSha256: digest }));
const root = '1 0 0:1 / / ro,relatime - overlay overlay ro';
const tmp = '2 1 0:2 / /tmp rw,nosuid,nodev,noexec,relatime - tmpfs tmpfs rw,size=65536k';
const scratch = '3 1 0:3 / /phi-cert-exec rw,nosuid,nodev,relatime - tmpfs tmpfs rw,size=65536k';
const stat = (mode = 0o700, uid = 1001, gid = 1001) => ({
  mode, uid, gid, isDirectory: () => true, isSymbolicLink: () => false,
});
const tierB = (mountinfo = [root, tmp, scratch].join('\n'), details = stat()) =>
  verifyE4TierMount('B', { mountinfo, lstat: () => details, realpath: () => '/phi-cert-exec' });

test('each mandatory image check has one stable owning tier', () => {
  assert.equal(new Set(E4_TIER_CHECKS.map((check) => check.id)).size, E4_TIER_CHECKS.length);
  assert.deepEqual(E4_TIER_CHECKS.map((check) => check.tier), ['A', 'A', 'A', 'A', 'B']);
  assert.ok(E4_TIER_CHECKS.every((check) => check.input));
});

test('Tier A requires actual tmpfs noexec and no executable scratch mount', () => {
  assert.equal(verifyE4TierMount('A', { mountinfo: [root, tmp].join('\n') }).scratch, 'NOT_MOUNTED');
  assert.throws(() => verifyE4TierMount('A', { mountinfo: [root, tmp, scratch].join('\n') }), /TIER_A_SCRATCH_MOUNTED/u);
  assert.throws(() => verifyE4TierMount('A', { mountinfo: [root, tmp.replace('noexec,', '')].join('\n') }), /TMP_EXECUTABLE/u);
});

test('Tier B requires dedicated effective 64 MiB rw+exec+nosuid+nodev tmpfs owned 1001:1001 mode0700', () => {
  assert.equal(tierB().scratch.mountId, 3);
  assert.throws(() => tierB([root, tmp, scratch.replace('tmpfs tmpfs', 'ext4 /dev/sda')].join('\n')), /SCRATCH_NOT_TMPFS/u);
  assert.throws(() => tierB([root, tmp, scratch.replace('nodev,', '')].join('\n')), /SCRATCH_MISSING_NODEV/u);
  assert.throws(() => tierB([root, tmp, scratch.replace('relatime', 'noexec,relatime')].join('\n')), /SCRATCH_NOEXEC/u);
  assert.throws(() => tierB([root, tmp, scratch.replace('size=65536k', 'size=32768k')].join('\n')), /SCRATCH_SIZE/u);
  assert.throws(() => tierB(undefined, stat(0o755)), /SCRATCH_MODE/u);
  assert.throws(() => tierB(undefined, stat(0o700, 0)), /SCRATCH_UID/u);
  assert.throws(() => tierB(undefined, stat(0o700, 1001, 0)), /SCRATCH_GID/u);
  assert.throws(() => tierB('unavailable'), /MOUNT_EVIDENCE_UNAVAILABLE/u);
});

test('joint image qualification fails closed on missing, failed, stale or cross-candidate receipts', () => {
  const pass = (tier) => e4TierReceipt(tier, Object.fromEntries(E4_TIER_CHECKS.filter((check) => check.tier === tier)
    .map((check) => [check.id, { status: 'PASS', inputSha256: digest }])), sha, digest,
  tier === 'A' ? inventory : []);
  const a = pass('A');
  const b = pass('B');
  assert.equal(e4JointQualification(a, b).status, 'PASS');
  assert.throws(() => e4JointQualification(a, null), /TIER_B_RECEIPT_MISSING/u);
  assert.throws(() => e4JointQualification(a, { ...b, candidateSha: 'c'.repeat(40) }), /TIER_CANDIDATE_MISMATCH/u);
  assert.throws(() => e4JointQualification(a, { ...b, sha256: digest }), /TIER_RECEIPT_DIGEST/u);
  assert.throws(() => e4JointQualification(e4TierReceipt('A', Object.fromEntries(E4_TIER_CHECKS.filter((check) => check.tier === 'A')
    .map((check) => [check.id, { status: 'PASS', inputSha256: digest }])), sha, digest), b), /INVENTORY_tool:_COUNT/u);
  const bad = e4TierReceipt('B', { B_RUST_GENERATED_EXEC: { status: 'FAIL', inputSha256: digest } }, sha, digest);
  assert.throws(() => e4JointQualification(a, bad), /TIER_MANDATORY_CHECK_FAILED/u);
  assert.throws(() => e4TierReceipt('B', {}, sha, digest), /TIER_CHECK_SET/u);
});

test('nested user namespace denial requires observed EPERM, not a missing or failed probe', () => {
  assert.equal(verifyE4NestedUsernsDenied(() => ({ status: 1, stderr: 'unshare: unshare failed: Operation not permitted' })), 'PASS');
  assert.throws(() => verifyE4NestedUsernsDenied(() => ({ status: 0, stderr: '' })), /NESTED_USERNS_NOT_DENIED/u);
  assert.throws(() => verifyE4NestedUsernsDenied(() => ({ status: 1, stderr: 'not found' })), /NESTED_USERNS_DENIAL_UNPROVEN/u);
  assert.throws(() => verifyE4NestedUsernsDenied(() => ({ status: null, error: new Error('ENOENT') })), /NESTED_USERNS_PROBE_SPAWN/u);
});

test('actual local kernel mountinfo is parseable but is not native image-qualification proof', () => {
  const text = fs.readFileSync('/proc/self/mountinfo', 'utf8');
  const mount = containingMount('/tmp', text);
  assert.notEqual(mount, 'UNKNOWN');
  assert.ok(Number.isInteger(mount.id));
});

test('workflow scratch is isolated from Worker and only available in one trusted smoke container', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/phi-foundation.yml', import.meta.url), 'utf8');
  const job = workflow.split('  e4-image-qualification:\n')[1]?.split('  e4-ubuntu-preflight:\n')[0];
  assert.ok(job);
  const mounts = [...job.matchAll(/--tmpfs \/phi-cert-exec:/gu)];
  assert.equal(mounts.length, 1);
  assert.match(job, /phi-e4-trusted-rust-smoke-\$GITHUB_RUN_ID[\s\S]*--tmpfs \/phi-cert-exec:/u);
  assert.doesNotMatch(job.split('phi-e4-trusted-rust-smoke-$GITHUB_RUN_ID')[0], /--tmpfs \/phi-cert-exec:/u);
  assert.match(job, /--network none --read-only --cap-drop ALL/u);
  assert.match(job, /--security-opt no-new-privileges/u);
  assert.match(job, /"phi-e4-trusted-rust-smoke-\$GITHUB_RUN_ID" "phi-e4-rust-diagnostic/u);
  assert.doesNotMatch(job, /--privileged|seccomp=unconfined|--mount|--volume|\s-v\s|\/var\/run\/docker\.sock/u);
  const smoke = fs.readFileSync(new URL('../scripts/e4-trusted-rust-smoke.mjs', import.meta.url), 'utf8');
  assert.match(smoke, /finally \{\s*fs\.rmSync\(workspace, \{ recursive: true, force: false \}\)/u);
  assert.match(smoke, /RUST_SCRATCH_RESIDUAL/u);
});
