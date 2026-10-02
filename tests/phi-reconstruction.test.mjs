import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverWindowsTransactions, inspectKnownWindowsTransaction, recoverKnownWindowsRename, recoverKnownWindowsDelete,
  recoverKnownWindowsModify, validateWindowsKnownReconstruction, validateWindowsKnownRecovery, validateWindowsKnownDeleteRecovery,
  validateWindowsKnownModifyRecovery, validateWindowsTransactionDiscovery } from '../platform/windows/publication.mjs';

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
  assert.throws(() => recoverKnownWindowsDelete({ cwd: '.', transactionId }), /BACKEND_UNAVAILABLE/u);
  assert.throws(() => recoverKnownWindowsModify({ cwd: '.', transactionId }), /BACKEND_UNAVAILABLE/u);
  assert.throws(() => discoverWindowsTransactions({ cwd: '.' }), /BACKEND_UNAVAILABLE/u);
});

const modifyRecovery = (decision, observedStatus, phaseBefore, phaseAfter, journalMutations,
  baseDigestVerified, verifiedDraftDigestMatched) => ({
  version: 1, status: 'PASS_BOUNDED_MODIFY_RECOVERY', transactionId, rootIdentity, rootIdentityVerified: true,
  observedStatus, decision, phaseBefore, phaseAfter, baseDigestVerified, verifiedDraftDigestMatched,
  actionPerformed: journalMutations > 0, journalMutations, projectMutations: 0, processKills: 0,
  projectPublished: false, externalRequests: 0,
});

test('V2 dead-controller decoder permits proved base rollback and terminal observation only', () => {
  for (const value of [
    modifyRecovery('ROLLBACK', 'OLD_COMPLETE_OBSERVED', 'TEMP_CREATED', 'ROLLED_BACK', 2, true, false),
    modifyRecovery('ROLLBACK', 'OLD_COMPLETE_OBSERVED', 'COMMIT_STARTED', 'ROLLED_BACK', 2, true, false),
    modifyRecovery('CLEANUP_ONLY', 'OLD_COMPLETE_OBSERVED', 'ROLLED_BACK', 'ROLLED_BACK', 0, true, false),
    modifyRecovery('CLEANUP_ONLY', 'NEW_COMPLETE_OBSERVED', 'CLEANED', 'CLEANED', 0, false, true),
    modifyRecovery('MANUAL_RECOVERY_REQUIRED', 'NEW_COMPLETE_OBSERVED', 'COMMIT_STARTED', 'COMMIT_STARTED', 0, false, true),
    modifyRecovery('MANUAL_RECOVERY_REQUIRED', 'NEW_COMPLETE_OBSERVED', 'COMMITTED', 'COMMITTED', 0, false, true),
    modifyRecovery('CONFLICT', 'OLD_COMPLETE_OBSERVED', 'READY_TO_COMMIT', 'READY_TO_COMMIT', 0, false, false),
    modifyRecovery('CONFLICT', 'CONFLICT', 'READY_TO_COMMIT', 'READY_TO_COMMIT', 0, false, false),
  ]) {
    const decoded = validateWindowsKnownModifyRecovery(run, value, transactionId);
    assert.equal(decoded.projectPublished, false);
    assert.equal(decoded.projectMutations, 0);
    assert.throws(() => { decoded.decision = 'PUBLISHED'; }, TypeError);
  }
});

test('V2 decoder rejects forged finalization, project writes and incomplete aggregate proof', () => {
  const valid = modifyRecovery('ROLLBACK', 'OLD_COMPLETE_OBSERVED', 'TEMP_CREATED', 'ROLLED_BACK', 2, true, false);
  for (const change of [
    { decision: 'RESUME' }, { decision: 'FINALIZE_COMMIT' }, { projectMutations: 1 }, { projectPublished: true },
    { baseDigestVerified: false }, { verifiedDraftDigestMatched: true }, { phaseAfter: 'CLEANED' },
    { journalMutations: 0 }, { actionPerformed: false }, { processKills: 1 }, { externalRequests: 1 },
    { rootIdentity: 'wrong' }, { transactionId: 'd'.repeat(32) }, { rawContent: 'secret' },
  ]) assert.throws(() => validateWindowsKnownModifyRecovery(run, { ...valid, ...change }, transactionId), /RECOVERY_UNCONFIRMED/u);
  assert.throws(() => validateWindowsKnownModifyRecovery({ ...run, status: 70 }, valid, transactionId), /RECOVERY_UNCONFIRMED/u);
  const incomplete = modifyRecovery('MANUAL_RECOVERY_REQUIRED', 'NEW_COMPLETE_OBSERVED', 'COMMITTED', 'COMMITTED', 0, false, true);
  assert.throws(() => validateWindowsKnownModifyRecovery(run, { ...incomplete, decision: 'CLEANUP_ONLY' }, transactionId), /RECOVERY_UNCONFIRMED/u);
});

const discoveryReceipt = (entries = []) => ({
  version: 1, status: 'PASS_READ_ONLY_DISCOVERY', rootIdentity, rootIdentityVerified: true,
  scannedTransactions: entries.length, projectTransactions: entries.length, entries,
  actionPerformed: false, journalMutations: 0, projectMutations: 0, processKills: 0,
  projectPublished: false, externalRequests: 0,
});
const discovered = { transactionId, journalVersion: 4, phase: 'RENAME_INTENT',
  observedStatus: 'OLD_COMPLETE_OBSERVED', classification: 'RECOVERY_REQUIRED' };

test('private-index discovery accepts only bounded advisory metadata, not an action grant', () => {
  for (const entries of [[], [discovered], [
    { ...discovered, transactionId: '1'.repeat(32), phase: 'RENAMED', observedStatus: 'CONFLICT', classification: 'CONFLICT' },
    discovered,
  ], [{ ...discovered, journalVersion: 5, phase: 'PREPARED', observedStatus: 'UNKNOWN_FAIL_SAFE',
    classification: 'MANUAL_RECOVERY_REQUIRED' }]]) {
    const value = validateWindowsTransactionDiscovery(run, discoveryReceipt(entries));
    assert.equal(value.projectTransactions, entries.length);
    assert.equal(value.projectPublished, false);
    assert.throws(() => { value.entries.push(discovered); }, TypeError);
  }
});

test('discovery decoder rejects truncated, reordered, action-bearing and raw-content receipts', () => {
  const valid = discoveryReceipt([discovered]);
  for (const change of [
    { rootIdentityVerified: false }, { rootIdentity: 'wrong' }, { scannedTransactions: 0 },
    { projectTransactions: 0 }, { actionPerformed: true }, { projectMutations: 1 },
    { journalMutations: 1 }, { processKills: 1 }, { projectPublished: true },
    { externalRequests: 1 }, { content: 'secret' },
    { entries: [{ ...discovered, classification: 'TERMINAL_RETAINED' }] },
    { entries: [{ ...discovered, rawContent: 'secret' }] },
    { entries: [discovered, discovered], projectTransactions: 2, scannedTransactions: 2 },
  ]) assert.throws(() => validateWindowsTransactionDiscovery(run, { ...valid, ...change }), /DISCOVERY_UNCONFIRMED/u);
  assert.throws(() => validateWindowsTransactionDiscovery({ ...run, status: 70 }, valid), /DISCOVERY_UNCONFIRMED/u);
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

const deleteRecovery = (decision, observedStatus, phaseBefore, phaseAfter, journalMutations, projectMutations,
  baseDigestVerified, verifiedDraftDigestMatched) => ({
  version: 1, status: 'PASS_BOUNDED_DELETE_RECOVERY', transactionId, rootIdentity, rootIdentityVerified: true,
  observedStatus, decision, phaseBefore, phaseAfter, baseDigestVerified, verifiedDraftDigestMatched,
  actionPerformed: journalMutations > 0 || projectMutations > 0, journalMutations, projectMutations,
  processKills: 0, projectPublished: false, externalRequests: 0,
});

test('fresh DELETE controller decoder distinguishes physical rollback, metadata-only finalization and fail-closed outcomes', () => {
  const accepted = [
    deleteRecovery('ROLLBACK', 'DELETE_COMMITTED_QUARANTINE_RETAINED', 'DELETE_QUARANTINED', 'ROLLED_BACK', 2, 1, true, true),
    deleteRecovery('ROLLBACK', 'DELETE_COMMITTED_QUARANTINE_RETAINED', 'DELETE_INTENT', 'ROLLED_BACK', 2, 1, true, true),
    deleteRecovery('ROLLBACK', 'OLD_COMPLETE_OBSERVED', 'DELETE_INTENT', 'ROLLED_BACK', 2, 0, true, true),
    deleteRecovery('FINALIZE_COMMIT', 'DELETE_COMMITTED_CLEANUP_OBSERVED', 'CLEANUP_STARTED', 'CLEANED', 1, 0, false, true),
    deleteRecovery('CLEANUP_ONLY', 'DELETE_COMMITTED_CLEANUP_OBSERVED', 'CLEANED', 'CLEANED', 0, 0, false, true),
    deleteRecovery('CONFLICT', 'CONFLICT', 'DELETE_QUARANTINED', 'CONFLICT', 1, 0, false, false),
    deleteRecovery('CONFLICT', 'DELETE_COMMITTED_QUARANTINE_RETAINED', 'DELETE_QUARANTINED', 'CONFLICT', 1, 0, false, false),
    deleteRecovery('MANUAL_RECOVERY_REQUIRED', 'UNKNOWN_FAIL_SAFE', 'DELETE_QUARANTINED', 'DELETE_QUARANTINED', 0, 0, false, false),
  ];
  for (const value of accepted) {
    const decoded = validateWindowsKnownDeleteRecovery(run, value, transactionId);
    assert.equal(decoded.projectPublished, false);
    assert.throws(() => { decoded.decision = 'PUBLISHED'; }, TypeError);
  }
});

test('fresh DELETE controller decoder rejects fabricated publication, unsafe rollback and omitted proof', () => {
  const valid = deleteRecovery('ROLLBACK', 'DELETE_COMMITTED_QUARANTINE_RETAINED', 'DELETE_QUARANTINED', 'ROLLED_BACK', 2, 1, true, true);
  for (const change of [
    { projectPublished: true }, { rootIdentityVerified: false }, { projectMutations: 0 }, { journalMutations: 0 },
    { baseDigestVerified: false }, { verifiedDraftDigestMatched: false }, { phaseAfter: 'CLEANED' },
    { processKills: 1 }, { externalRequests: 1 }, { transactionId: 'd'.repeat(32) },
    { actionPerformed: false }, { decision: 'RESUME' }, { rawContent: 'secret' },
  ]) assert.throws(() => validateWindowsKnownDeleteRecovery(run, { ...valid, ...change }, transactionId), /RECOVERY_UNCONFIRMED/u);
  assert.throws(() => validateWindowsKnownDeleteRecovery({ ...run, status: 70 }, valid, transactionId), /RECOVERY_UNCONFIRMED/u);
  const final = deleteRecovery('FINALIZE_COMMIT', 'DELETE_COMMITTED_CLEANUP_OBSERVED', 'CLEANUP_STARTED', 'CLEANED', 1, 0, false, true);
  assert.throws(() => validateWindowsKnownDeleteRecovery(run, { ...final, baseDigestVerified: true }, transactionId), /RECOVERY_UNCONFIRMED/u);
});
