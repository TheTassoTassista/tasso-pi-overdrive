import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { ownedWindowsHelper, windowsRecoveryStatus } from '../platform/windows/process.mjs';
import { windowsPublicationFailure } from '../platform/windows/publication.mjs';
import { validateWindowsKnownModifyRecovery } from '../platform/windows/publication.mjs';

test('single-file MODIFY extends the existing journal; native observations alone advance V2', () => {
  const source = fs.readFileSync(new URL('../platform/windows/native/PublicationJournal.cs', import.meta.url), 'utf8');
  for (const text of ['PublishSingleModify', 'AtomicModify.ReplaceDefaultStream', 'TEMP_CREATED', 'POST_COMMIT_VERIFIED', 'PHI_PUBLICATION_NATIVE_OBSERVATION_REQUIRED', 'InspectSingleModify', 'OLD_COMPLETE_OBSERVED', 'NEW_COMPLETE_OBSERVED']) assert.ok(source.includes(text), text);
  assert.match(source, /Lease\(transactionId, true\)/u); // Global 64-record admission, no competing per-ID overrun.
  assert.match(source, /RecoveryFilesystem\.HandleIdentity\(parsed\.pins\.DirectoryHandle\)/u);
  assert.match(source, /checkpoint\("before-journal-committed"\)/u);
  assert.match(source, /ownerGenerationAlive = false/u);
  assert.match(source, /projectMutations = 0, processKills = 0, projectPublished = false/u);
  assert.equal(fs.readFileSync(new URL('../platform/windows/index.mjs', import.meta.url), 'utf8').includes('autonomousReady: true'), false);
});
const points = ['before-transaction', 'temp', 'write', 'flush', 'validation', 'staged', 'before-commit', 'before-journal-committed', 'committed', 'postverify', 'cleanup'];
for (const name of ['rollback', 'rollback-late', 'manual-post-physical', 'manual-commit', 'cleanup-only', 'unrelated-conflict', 'target-conflict']) {
  test('native V2 dead-controller continuity: ' + name, { skip: process.platform !== 'win32', timeout: 30000 }, () => {
    const result = spawnSync(ownedWindowsHelper(), ['--publication-modify-controller-recovery-selftest', name],
      { shell: false, encoding: 'utf8', windowsHide: true, timeout: 22000, maxBuffer: 16384 });
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    for (const key of ['passed', 'fixtureCleanup', 'actualProcessKilled', 'childGone', 'restartedControllerGone']) assert.equal(receipt[key], true, key);
    assert.equal(receipt.scope, 'NATIVE_BOUNDED_MODIFY_RECOVERY_NOT_RESTORED_PUBLICATION');
    assert.equal(receipt.projectPublished, false); assert.equal(receipt.externalRequests, 0);
    assert.equal(receipt.controllerExit, 0);
    assert.equal(receipt.discoveryEvidence.entries.length, 1);
    assert.equal(receipt.discoveryEvidence.entries[0].journalVersion, 2);
    const value = validateWindowsKnownModifyRecovery({ status: receipt.controllerExit, pid: 42, signal: null },
      receipt.evidence, receipt.evidence.transactionId);
    assert.equal(value.projectMutations, 0);
    if (['rollback', 'rollback-late', 'cleanup-only'].includes(name)) assert.equal(receipt.idempotent, true);
    assert.equal(receipt.gitDiff, name === 'unrelated-conflict' ? 'unrelated.txt' :
      ['manual-post-physical', 'manual-commit', 'cleanup-only', 'target-conflict'].includes(name) ? 'input.txt' : '');
    assert.equal(windowsRecoveryStatus().status, 'PASS');
    console.log(JSON.stringify({ control: 'NATIVE_BOUNDED_MODIFY_RECOVERY', ...receipt }));
  });
}
const cases = ['commit', 'unobserved-advance', 'concurrent-change-at-ready', ...points, ...points.filter(p => p !== 'before-transaction').map(p => 'crash-' + p), 'user-content-after-crash', 'same-content-recreated-after-crash', 'user-delete-after-crash'];
for (const name of cases) test('native journal-bound MODIFY: ' + name, { skip: process.platform !== 'win32', timeout: 30000 }, () => {
  const result = spawnSync(ownedWindowsHelper(), ['--publication-modify-selftest', name], { shell: false, encoding: 'utf8', windowsHide: true, timeout: 22000, maxBuffer: 16384 });
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.passed, true); assert.equal(receipt.fixtureCleanup, true); assert.equal(receipt.tempAbsent, true); assert.equal(receipt.unrelatedPreserved, true);
  assert.equal(receipt.projectPublished, false); assert.equal(receipt.externalRequests, 0);
  assert.equal(receipt.scope, 'NATIVE_JOURNAL_MODIFY_NOT_VERIFIED_WORKER_PUBLICATION');
  if (name.startsWith('crash-') || name.endsWith('after-crash')) {
    assert.equal(receipt.actualProcessKilled, true); assert.equal(receipt.childGone, true); assert.equal(receipt.restartedRecovery, true);
    assert.equal(receipt.evidence.projectMutations, 0); assert.equal(receipt.evidence.processKills, 0); assert.equal(receipt.evidence.projectPublished, false);
    if (name.endsWith('after-crash')) { assert.equal(receipt.evidence.status, 'CONFLICT'); assert.equal(receipt.evidence.journalMutations, 0); }
    if (name === 'user-delete-after-crash') { assert.equal(receipt.evidence.destinationMissing, true); assert.equal(receipt.evidence.observedDigest, null); }
  }
  if (name === 'commit') { assert.equal(receipt.evidence.journal.phase, 'CLEANED'); assert.equal(receipt.evidence.journal.cleanup, 'PASS'); assert.equal(receipt.evidence.nativeProof.tempAbsent, true); }
  if (name === 'concurrent-change-at-ready') { assert.equal(receipt.evidence.phase, 'CONFLICT'); assert.deepEqual(receipt.evidence.filesCommitted, []); assert.equal(receipt.evidence.committedIdentity, null); }
  assert.doesNotMatch(JSON.stringify(receipt), /old-complete|new-complete|user-complete|unrelated-user/u);
  assert.equal(windowsRecoveryStatus().status, 'PASS');
  console.log(JSON.stringify({ control: 'NATIVE_JOURNAL_MODIFY_ONLY', ...receipt }));
});
for (const name of ['admission-content-change', 'admission-recreated', 'admission-missing', 'admission-root-mismatch', 'admission-invalid-header', 'admission-sharing']) {
  test('native production pre-journal admission: ' + name, { skip: process.platform !== 'win32', timeout: 30000 }, () => {
    const result = spawnSync(ownedWindowsHelper(), ['--publication-modify-selftest', name], { shell: false, encoding: 'utf8', windowsHide: true, timeout: 22000, maxBuffer: 16384 });
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    for (const key of ['passed', 'fixtureCleanup', 'childGone', 'journalAbsent', 'tempAbsent', 'userStatePreserved']) assert.equal(receipt[key], true, key);
    assert.equal(receipt.scope, 'NATIVE_PREJOURNAL_ADMISSION');
    const conflict = ['admission-content-change', 'admission-recreated', 'admission-missing'].includes(name);
    assert.equal(receipt.evidence.status, 'FAIL_NATIVE_SINGLE_MODIFY'); assert.equal(receipt.evidence.reason, conflict ? 'CONFLICT' : 'UNCONFIRMED');
    assert.equal(receipt.evidence.journal, null); assert.equal(receipt.evidence.projectPublished, false); assert.equal(receipt.evidence.externalRequests, 0);
    assert.equal(receipt.publisherExitCode, 70); assert.ok(Number.isSafeInteger(receipt.publisherPid) && receipt.publisherPid > 0);
    if (conflict) {
      const admission = receipt.evidence.admission;
      assert.equal(receipt.evidence.phase, 'ADMISSION'); assert.equal(admission.phase, 'ADMISSION_CONFLICT');
      assert.equal(admission.journalCreated, false); assert.equal(admission.mutationStarted, false);
      assert.equal(admission.commitState, 'NOT_STARTED'); assert.deepEqual(admission.filesCommitted, []);
      // Native fixture already asserts every request-binding field. Exercise the
      // production decoder on the actual child failure, not synthetic metadata.
      const header = Object.fromEntries(['transactionId', 'projectIdentity', 'draftId', 'draftVersion', 'verifiedDigest', 'baseDigest', 'operations'].map(key => [key, admission[key]]));
      const error = windowsPublicationFailure({ pid: receipt.publisherPid, status: receipt.publisherExitCode, signal: null }, receipt.evidence, header);
      assert.equal(error.code, 'PHI_PUBLICATION_CONFLICT'); assert.equal(error.publicationEvidence.journal, null);
      assert.deepEqual(error.publicationEvidence.admission, admission);
    } else assert.equal(receipt.evidence.admission, null);
    assert.doesNotMatch(JSON.stringify(receipt), /old-complete|new-complete|user-complete|unrelated-user|FORBIDDEN_RAW_SENTINEL/u);
    assert.equal(windowsRecoveryStatus().status, 'PASS');
    console.log(JSON.stringify({ control: 'NATIVE_PREJOURNAL_ADMISSION', ...receipt }));
  });
}
