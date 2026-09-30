import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectKnownWindowsTransaction, recoverKnownWindowsRename, validateWindowsKnownReconstruction,
  validateWindowsKnownRecovery } from '../platform/windows/publication.mjs';

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
  assert.throws(() => recoverKnownWindowsRename({ cwd: '.', transactionId }), /BACKEND_UNAVAILABLE/u);
});

const recoveryReceipt = (decision, observedStatus, phaseBefore, phaseAfter, journalMutations) => ({
  version: 1, status: 'PASS_BOUNDED_RENAME_RECOVERY', transactionId, rootIdentity, rootIdentityVerified: true,
  observedStatus, decision, phaseBefore, phaseAfter,
  baseDigestVerified: !['CONFLICT', 'MANUAL_RECOVERY_REQUIRED'].includes(decision),
  verifiedDraftDigestMatched: !['CONFLICT', 'MANUAL_RECOVERY_REQUIRED'].includes(decision),
  actionPerformed: journalMutations > 0, journalMutations, projectMutations: 0, processKills: 0,
  projectPublished: false, externalRequests: 0,
});

test('bounded restarted-controller receipt accepts only terminal metadata recovery, never publication', () => {
  const accepted = [
    recoveryReceipt('ROLLBACK', 'OLD_COMPLETE_OBSERVED', 'PREPARED', 'ROLLED_BACK', 2),
    { ...recoveryReceipt('RESUME', 'OLD_COMPLETE_OBSERVED', 'RENAME_INTENT', 'CLEANED', 4), projectMutations: 1 },
    recoveryReceipt('RESUME', 'RENAME_COMMITTED_DESTINATION_RETAINED', 'RENAME_INTENT', 'CLEANED', 4),
    recoveryReceipt('FINALIZE_COMMIT', 'RENAME_COMMITTED_DESTINATION_RETAINED', 'COMMITTED', 'CLEANED', 2),
    recoveryReceipt('CLEANUP_ONLY', 'RENAME_COMMITTED_DESTINATION_RETAINED', 'CLEANED', 'CLEANED', 0),
    recoveryReceipt('CONFLICT', 'CONFLICT', 'RENAME_INTENT', 'RENAME_INTENT', 0),
    recoveryReceipt('MANUAL_RECOVERY_REQUIRED', 'UNKNOWN_FAIL_SAFE', 'RENAME_INTENT', 'RENAME_INTENT', 0),
  ];
  for (const value of accepted) {
    const decoded = validateWindowsKnownRecovery(run, value, transactionId);
    assert.equal(decoded.projectPublished, false);
    assert.equal(decoded.projectMutations, value.projectMutations);
    assert.throws(() => { decoded.decision = 'PUBLISHED'; }, TypeError);
  }
});

test('bounded recovery decoder rejects forged authority, incomplete actions and extra content', () => {
  const valid = recoveryReceipt('RESUME', 'RENAME_COMMITTED_DESTINATION_RETAINED', 'RENAME_INTENT', 'CLEANED', 4);
  for (const change of [
    { projectPublished: true }, { projectMutations: 1 }, { processKills: 1 }, { externalRequests: 1 },
    { rootIdentityVerified: false }, { rootIdentity: 'wrong' }, { transactionId: 'd'.repeat(32) },
    { baseDigestVerified: false }, { verifiedDraftDigestMatched: false }, { actionPerformed: false },
    { journalMutations: 0 }, { journalMutations: 3 }, { phaseBefore: 'PREPARED' },
    { phaseAfter: 'RECOVERY_REQUIRED' }, { observedStatus: 'ACTIVE' },
    { decision: 'PUBLISHED' }, { content: 'secret' },
  ]) assert.throws(() => validateWindowsKnownRecovery(run, { ...valid, ...change }, transactionId), /RECOVERY_UNCONFIRMED/u);
  assert.throws(() => validateWindowsKnownRecovery({ ...run, status: 70 }, valid, transactionId), /RECOVERY_UNCONFIRMED/u);
});
