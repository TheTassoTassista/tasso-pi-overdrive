import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { ownedWindowsHelper, windowsRecoveryStatus } from '../platform/windows/process.mjs';
import { planWindowsStartupRecovery } from '../platform/windows/startup-recovery.mjs';

test('V5 mixed journal reconstructs per-operation physical evidence without enabling publication or recovery', () => {
  const source = fs.readFileSync(new URL('../platform/windows/native/PublicationJournal.cs', import.meta.url), 'utf8');
  assert.match(source, /version == 5/u);
  assert.match(source, /operationPhases = Enumerable\.Repeat\("NOT_STARTED"/u);
  assert.match(source, /MIXED_JOURNAL_ONLY_NOT_VERIFIED_PUBLICATION/u);
  assert.match(source, /return parsed\.InspectMixedPhysical\(trace\)/u);
  assert.match(source, /void PublishMixedModify\([\s\S]*?AtomicModify\.ReplaceDefaultStream\(project/u);
  assert.match(source, /void PublishMixedCreate\([\s\S]*?AnchoredFile\.CreateNoReplace\(project/u);
  assert.match(source, /journal\.PublishMixedModify\(Encoding\.UTF8\.GetBytes\("a-new"\)/u);
  assert.match(source, /journal\.PublishMixedCreate\(Encoding\.UTF8\.GetBytes\("b-new"\)/u);
  assert.match(source, /void PublishMixedDelete\([\s\S]*?parent\.QuarantineDeleteSource\(source, quarantine\)/u);
  assert.match(source, /void PublishMixedRename\([\s\S]*?parent\.RenameExpectedSource\(source/u);
  assert.match(source, /void PublishMixedCleanup\([\s\S]*?parent\.UnlinkQuarantinedFile\(held, expected\)/u);
  assert.match(source, /internal static int RunMixed\(Stream input\)/u);
  assert.match(source, /observedQuarantineIdentity/u);
  assert.match(source, /observedCreateTempIdentity/u);
  assert.match(source, /new string\[\] \{ "REPLACE", "CREATE", "DELETE", "RENAME" \}/u);
  assert.equal(planWindowsStartupRecovery({ status: 'PASS_READ_ONLY_DISCOVERY', rootIdentityVerified: true,
    projectPublished: false, actionPerformed: false, projectTransactions: 1,
    entries: [{ transactionId: 'a'.repeat(32), journalVersion: 5, phase: 'PREPARED', classification: 'MANUAL_RECOVERY_REQUIRED' }] }).kind,
  'BLOCKED_MANUAL_RECOVERY_REQUIRED');
});

test('production native V5 endpoint physically applies all four operations and retains no temp or quarantine',
  { skip: process.platform !== 'win32', timeout: 45000 }, () => {
    const run = spawnSync(ownedWindowsHelper(), ['--publication-mixed-physical-selftest'], {
      shell: false, windowsHide: true, encoding: 'utf8', timeout: 35000, maxBuffer: 8192,
    });
    assert.equal(run.status, 0, run.stderr);
    const receipt = JSON.parse(run.stdout);
    assert.equal(receipt.passed, true);
    assert.equal(receipt.scope, 'V5_NATIVE_MIXED_NO_CRASH_PHYSICAL_ONLY');
    assert.equal(receipt.publisherGone, true);
    assert.equal(receipt.readerNoMutation, true);
    assert.equal(receipt.fixtureCleanup, true);
    assert.equal(receipt.projectPublished, false);
    assert.equal(receipt.externalRequests, 0);
    assert.equal(receipt.evidence.phase, 'CLEANED');
    assert.equal(receipt.evidence.journalState, 'FINALIZED');
    assert.deepEqual(receipt.evidence.operationStates, Array(4).fill('NEW_COMPLETE_OBSERVED'));
    assert.equal(receipt.evidence.createIdentityPreserved, true);
    assert.equal(receipt.evidence.renameIdentityPreserved, true);
    assert.equal(receipt.evidence.deleteDestinationAbsent, true);
    assert.equal(receipt.evidence.quarantineAbsent, true);
    assert.equal(receipt.evidence.draftDigestMatched, true);
    assert.equal(windowsRecoveryStatus().status, 'PASS');
    assert.doesNotMatch(JSON.stringify(receipt), /a-old|a-new|b-new|c-old|d-old/u);
    console.log(JSON.stringify({ control: 'V5_NATIVE_MIXED_NO_CRASH_PHYSICAL_ONLY', ...receipt }));
  });

test('real publisher death retains a four-operation V5 journal for a fresh process without mutating project',
  { skip: process.platform !== 'win32', timeout: 45000 }, () => {
    const run = spawnSync(ownedWindowsHelper(), ['--publication-mixed-journal-selftest', 'partial-after-modify-journal-only'], {
      shell: false, windowsHide: true, encoding: 'utf8', timeout: 35000, maxBuffer: 8192,
    });
    assert.equal(run.status, 0, run.stderr);
    const receipt = JSON.parse(run.stdout);
    assert.equal(receipt.passed, true);
    assert.equal(receipt.actualPublisherKilled, true);
    assert.equal(receipt.publisherGone, true);
    assert.equal(receipt.freshReaderGone, true);
    assert.equal(receipt.fixtureCleanup, true);
    assert.equal(receipt.snapshotUnchanged, true);
    assert.equal(receipt.scope, 'MIXED_JOURNAL_DURABILITY_ONLY_NO_PHYSICAL_PUBLICATION');
    assert.equal(receipt.projectPublished, false);
    assert.equal(receipt.externalRequests, 0);
    assert.deepEqual(receipt.evidence.operationPhases, ['FINALIZED', 'PREPARED', 'NOT_STARTED', 'NOT_STARTED']);
    assert.equal(receipt.evidence.status, 'CONFLICT');
    assert.equal(receipt.evidence.journalState, 'PARTIAL_PROGRESS');
    assert.equal(receipt.evidence.journalPendingOperations, 3);
    assert.equal(receipt.evidence.filesystemState, 'CONFLICT');
    assert.deepEqual(receipt.evidence.operationPhysicalStates,
      ['CONFLICT', 'OLD_COMPLETE_OBSERVED', 'OLD_COMPLETE_OBSERVED', 'OLD_COMPLETE_OBSERVED']);
    assert.equal(receipt.evidence.sequence, 5);
    assert.equal(receipt.evidence.projectMutations, 0);
    assert.equal(receipt.evidence.journalMutations, 0);
    assert.equal(windowsRecoveryStatus().status, 'PASS');
    assert.doesNotMatch(JSON.stringify(receipt), /a-old|a-new|b-new|c-old|d-old/u);
    console.log(JSON.stringify({ control: 'MIXED_JOURNAL_DURABILITY_ONLY', ...receipt }));
  });

test('real atomic MODIFY in V5 is detected by fresh physical reconstruction after publisher death',
  { skip: process.platform !== 'win32', timeout: 45000 }, () => {
    const run = spawnSync(ownedWindowsHelper(), ['--publication-mixed-journal-selftest', 'partial-after-real-modify'], {
      shell: false, windowsHide: true, encoding: 'utf8', timeout: 35000, maxBuffer: 8192,
    });
    assert.equal(run.status, 0, run.stderr);
    const receipt = JSON.parse(run.stdout);
    assert.equal(receipt.passed, true);
    assert.equal(receipt.actualPublisherKilled, true);
    assert.equal(receipt.publisherGone, true);
    assert.equal(receipt.freshReaderGone, true);
    assert.equal(receipt.fixtureCleanup, true);
    assert.equal(receipt.snapshotUnchanged, false);
    assert.equal(receipt.scope, 'MIXED_V5_SINGLE_PHYSICAL_MODIFY_NOT_MIXED_PUBLICATION');
    assert.equal(receipt.projectPublished, false);
    assert.equal(receipt.externalRequests, 0);
    assert.equal(receipt.evidence.status, 'UNKNOWN_FAIL_SAFE');
    assert.equal(receipt.evidence.filesystemState, 'PARTIALLY_COMMITTED');
    assert.deepEqual(receipt.evidence.operationPhysicalStates,
      ['NEW_COMPLETE_OBSERVED', 'OLD_COMPLETE_OBSERVED', 'OLD_COMPLETE_OBSERVED', 'OLD_COMPLETE_OBSERVED']);
    assert.equal(receipt.evidence.projectMutations, 0);
    assert.equal(receipt.evidence.journalMutations, 0);
    assert.equal(windowsRecoveryStatus().status, 'PASS');
    assert.doesNotMatch(JSON.stringify(receipt), /a-old|a-new|b-new|c-old|d-old/u);
    console.log(JSON.stringify({ control: 'MIXED_V5_SINGLE_PHYSICAL_MODIFY', ...receipt }));
  });

test('fresh V5 physical reconstruction preserves a user-created rename destination after partial progress',
  { skip: process.platform !== 'win32', timeout: 45000 }, () => {
    const run = spawnSync(ownedWindowsHelper(), ['--publication-mixed-journal-selftest', 'partial-after-real-modify-user-e'], {
      shell: false, windowsHide: true, encoding: 'utf8', timeout: 35000, maxBuffer: 8192,
    });
    assert.equal(run.status, 0, run.stderr);
    const receipt = JSON.parse(run.stdout);
    assert.equal(receipt.passed, true);
    assert.equal(receipt.actualPublisherKilled, true);
    assert.equal(receipt.publisherGone, true);
    assert.equal(receipt.freshReaderGone, true);
    assert.equal(receipt.fixtureCleanup, true);
    assert.equal(receipt.snapshotUnchanged, false);
    assert.equal(receipt.scope, 'MIXED_V5_SINGLE_PHYSICAL_MODIFY_NOT_MIXED_PUBLICATION');
    assert.equal(receipt.projectPublished, false);
    assert.equal(receipt.externalRequests, 0);
    assert.equal(receipt.evidence.status, 'CONFLICT');
    assert.equal(receipt.evidence.filesystemState, 'CONFLICT');
    assert.deepEqual(receipt.evidence.operationPhysicalStates,
      ['NEW_COMPLETE_OBSERVED', 'OLD_COMPLETE_OBSERVED', 'OLD_COMPLETE_OBSERVED', 'CONFLICT']);
    assert.equal(receipt.evidence.projectMutations, 0);
    assert.equal(receipt.evidence.journalMutations, 0);
    assert.equal(windowsRecoveryStatus().status, 'PASS');
    assert.doesNotMatch(JSON.stringify(receipt), /a-old|a-new|b-new|c-old|d-old|private-user-e-content/u);
    console.log(JSON.stringify({ control: 'MIXED_V5_PARTIAL_USER_DESTINATION_CONFLICT', ...receipt }));
  });

test('fresh V5 reconstruction identifies the exact staged CREATE temp and remains manual/fail-closed',
  { skip: process.platform !== 'win32', timeout: 45000 }, () => {
    const run = spawnSync(ownedWindowsHelper(), ['--publication-mixed-journal-selftest', 'partial-after-real-modify-create-staged'], {
      shell: false, windowsHide: true, encoding: 'utf8', timeout: 35000, maxBuffer: 8192,
    });
    assert.equal(run.status, 0, run.stderr);
    const receipt = JSON.parse(run.stdout);
    assert.equal(receipt.passed, true);
    assert.equal(receipt.actualPublisherKilled, true);
    assert.equal(receipt.publisherGone, true);
    assert.equal(receipt.freshReaderGone, true);
    assert.equal(receipt.fixtureCleanup, true);
    assert.equal(receipt.scope, 'MIXED_V5_STAGED_CREATE_NOT_MIXED_PUBLICATION');
    assert.equal(receipt.projectPublished, false);
    assert.equal(receipt.externalRequests, 0);
    assert.equal(receipt.evidence.status, 'UNKNOWN_FAIL_SAFE');
    assert.equal(receipt.evidence.filesystemState, 'MANUAL_RECOVERY_REQUIRED');
    assert.deepEqual(receipt.evidence.operationPhases, ['FINALIZED', 'MUTATION_STARTED', 'NOT_STARTED', 'NOT_STARTED']);
    assert.deepEqual(receipt.evidence.operationPhysicalStates,
      ['NEW_COMPLETE_OBSERVED', 'STAGED_COMPLETE_OBSERVED', 'OLD_COMPLETE_OBSERVED', 'OLD_COMPLETE_OBSERVED']);
    assert.equal(receipt.evidence.projectMutations, 0);
    assert.equal(receipt.evidence.journalMutations, 0);
    assert.equal(windowsRecoveryStatus().status, 'PASS');
    assert.doesNotMatch(JSON.stringify(receipt), /a-old|a-new|b-new|c-old|d-old/u);
    console.log(JSON.stringify({ control: 'MIXED_V5_STAGED_CREATE_FAIL_CLOSED', ...receipt }));
  });

for (const [caseName, expectedStatus, expectedFilesystem, expectedCreate] of [
  ['partial-after-real-modify-create-committed', 'UNKNOWN_FAIL_SAFE', 'PARTIALLY_COMMITTED', 'NEW_COMPLETE_OBSERVED'],
  ['partial-after-real-modify-create-committed-user-b', 'CONFLICT', 'CONFLICT', 'CONFLICT'],
]) test(`fresh V5 reconstruction observes real no-clobber CREATE and preserves replacement: ${caseName}`,
  { skip: process.platform !== 'win32', timeout: 45000 }, () => {
    const run = spawnSync(ownedWindowsHelper(), ['--publication-mixed-journal-selftest', caseName], {
      shell: false, windowsHide: true, encoding: 'utf8', timeout: 35000, maxBuffer: 8192,
    });
    assert.equal(run.status, 0, run.stderr);
    const receipt = JSON.parse(run.stdout);
    assert.equal(receipt.passed, true);
    assert.equal(receipt.actualPublisherKilled, true);
    assert.equal(receipt.publisherGone, true);
    assert.equal(receipt.freshReaderGone, true);
    assert.equal(receipt.fixtureCleanup, true);
    assert.equal(receipt.scope, 'MIXED_V5_PHYSICAL_MODIFY_CREATE_NOT_MIXED_PUBLICATION');
    assert.equal(receipt.projectPublished, false);
    assert.equal(receipt.externalRequests, 0);
    assert.equal(receipt.evidence.status, expectedStatus);
    assert.equal(receipt.evidence.filesystemState, expectedFilesystem);
    assert.equal(receipt.evidence.journalPendingOperations, 2);
    assert.deepEqual(receipt.evidence.operationPhases, ['FINALIZED', 'FINALIZED', 'PREPARED', 'NOT_STARTED']);
    assert.deepEqual(receipt.evidence.operationPhysicalStates,
      ['NEW_COMPLETE_OBSERVED', expectedCreate, 'OLD_COMPLETE_OBSERVED', 'OLD_COMPLETE_OBSERVED']);
    assert.equal(receipt.evidence.projectMutations, 0);
    assert.equal(receipt.evidence.journalMutations, 0);
    assert.equal(windowsRecoveryStatus().status, 'PASS');
    assert.doesNotMatch(JSON.stringify(receipt), /a-old|a-new|b-new|c-old|d-old|private-user-b-content/u);
    console.log(JSON.stringify({ control: 'MIXED_V5_PHYSICAL_MODIFY_CREATE', ...receipt }));
  });
