import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { ownedWindowsHelper, windowsRecoveryStatus } from '../platform/windows/process.mjs';

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
