import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectKnownWindowsTransaction, validateWindowsKnownReconstruction } from '../platform/windows/publication.mjs';

const transactionId = 'a'.repeat(32);
const rootIdentity = 'b'.repeat(16) + ':' + 'c'.repeat(32);
const run = { status: 0, signal: null, pid: 42 };
const receipt = (observedStatus, decision, phase = 'RECOVERY_REQUIRED') => ({
  version: 1, status: 'PASS_READ_ONLY_RECONSTRUCTION', transactionId, rootIdentity,
  rootIdentityVerified: true, observedStatus, decision,
  phase, journalVersion: 4,
  actionPerformed: false, journalMutations: 0, projectMutations: 0, processKills: 0,
  projectPublished: false, externalRequests: 0,
});

test('new-controller known-locator decoder classifies old/new/conflict without publication authority', () => {
  for (const [status, decision] of [
    ['OLD_COMPLETE_OBSERVED', 'ROLLBACK'],
    ['RENAME_COMMITTED_DESTINATION_RETAINED', 'MANUAL_RECOVERY_REQUIRED'],
    ['DELETE_COMMITTED_QUARANTINE_RETAINED', 'MANUAL_RECOVERY_REQUIRED'],
    ['NEW_COMPLETE_OBSERVED', 'MANUAL_RECOVERY_REQUIRED'],
    ['CONFLICT', 'CONFLICT'],
    ['UNKNOWN_FAIL_SAFE', 'MANUAL_RECOVERY_REQUIRED'],
  ]) {
    const value = validateWindowsKnownReconstruction(run, receipt(status, decision), transactionId);
    assert.equal(value.decision, decision);
    assert.equal(value.projectPublished, false);
    assert.equal(value.actionPerformed, false);
    assert.throws(() => { value.decision = 'RESUME'; }, TypeError);
  }
});

test('new-controller decoder rejects fabricated publication, actions, root binding, extra fields and failed execution', () => {
  const valid = receipt('RENAME_COMMITTED_DESTINATION_RETAINED', 'MANUAL_RECOVERY_REQUIRED');
  for (const change of [
    { projectPublished: true }, { actionPerformed: true }, { journalMutations: 1 }, { projectMutations: 1 }, { processKills: 1 },
    { rootIdentityVerified: false }, { rootIdentity: 'wrong' }, { transactionId: 'd'.repeat(32) },
    { decision: 'RESUME' }, { observedStatus: 'PUBLISHED' }, { rawContent: 'secret' },
  ]) assert.throws(() => validateWindowsKnownReconstruction(run, { ...valid, ...change }, transactionId), /RECONSTRUCTION_UNCONFIRMED/u);
  assert.throws(() => validateWindowsKnownReconstruction({ ...run, status: 70 }, valid, transactionId), /RECONSTRUCTION_UNCONFIRMED/u);
  assert.throws(() => validateWindowsKnownReconstruction(run, receipt('ACTIVE', 'MANUAL_RECOVERY_REQUIRED'), transactionId), /RECONSTRUCTION_UNCONFIRMED/u);
});

test('new-controller inspection is unavailable off Windows rather than a portable publication fallback', { skip: process.platform === 'win32' }, () => {
  assert.throws(() => inspectKnownWindowsTransaction({ cwd: '.', transactionId }), /BACKEND_UNAVAILABLE/u);
});
