import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { ownedWindowsHelper, windowsRecoveryStatus } from '../platform/windows/process.mjs';
import { planWindowsStartupRecovery } from '../platform/windows/startup-recovery.mjs';

test('V5 mixed journal records per-operation progress without enabling publication or recovery', () => {
  const source = fs.readFileSync(new URL('../platform/windows/native/PublicationJournal.cs', import.meta.url), 'utf8');
  assert.match(source, /version == 5/u);
  assert.match(source, /operationPhases = Enumerable\.Repeat\("NOT_STARTED"/u);
  assert.match(source, /MIXED_JOURNAL_ONLY_NOT_VERIFIED_PUBLICATION/u);
  assert.match(source, /status = "UNKNOWN_FAIL_SAFE", metadata = parsed\.Metadata\("MANUAL_RECOVERY_REQUIRED"\)/u);
  assert.match(source, /new string\[\] \{ "REPLACE", "CREATE", "DELETE", "RENAME" \}/u);
  assert.equal(planWindowsStartupRecovery({ status: 'PASS_READ_ONLY_DISCOVERY', rootIdentityVerified: true,
    projectPublished: false, actionPerformed: false, projectTransactions: 1,
    entries: [{ transactionId: 'a'.repeat(32), journalVersion: 5, phase: 'PREPARED', classification: 'MANUAL_RECOVERY_REQUIRED' }] }).kind,
  'BLOCKED_MANUAL_RECOVERY_REQUIRED');
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
    assert.equal(receipt.evidence.status, 'UNKNOWN_FAIL_SAFE');
    assert.equal(receipt.evidence.journalState, 'PARTIAL_PROGRESS');
    assert.equal(receipt.evidence.journalPendingOperations, 3);
    assert.equal(receipt.evidence.filesystemState, 'UNVERIFIED');
    assert.equal(receipt.evidence.sequence, 5);
    assert.equal(receipt.evidence.projectMutations, 0);
    assert.equal(receipt.evidence.journalMutations, 0);
    assert.equal(windowsRecoveryStatus().status, 'PASS');
    assert.doesNotMatch(JSON.stringify(receipt), /a-old|a-new|b-new|c-old|d-old/u);
    console.log(JSON.stringify({ control: 'MIXED_JOURNAL_DURABILITY_ONLY', ...receipt }));
  });
