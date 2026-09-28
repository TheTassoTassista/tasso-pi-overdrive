import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { ownedWindowsHelper, windowsRecoveryStatus } from '../platform/windows/process.mjs';

test('publication journal is source-attested, bounded metadata, append/flush/checksum and no project writer', () => {
  const source = fs.readFileSync(new URL('../platform/windows/native/PublicationJournal.cs', import.meta.url), 'utf8').split('// Fixed fixtures only.')[0];
  for (const phase of ['PREPARED', 'TEMP_WRITTEN', 'TEMP_FLUSHED', 'READY_TO_COMMIT', 'COMMIT_STARTED', 'COMMITTED', 'VERIFIED', 'CLEANED', 'CONFLICT', 'ROLLBACK_REQUIRED', 'ROLLED_BACK', 'RECOVERY_REQUIRED', 'FAILED']) assert.match(source, new RegExp('"' + phase + '"', 'u'));
  assert.match(source, /RegFlushKey/u); assert.match(source, /SHA256/u); assert.match(source, /ReadChain/u);
  assert.match(source, /MaxTransactions = 64, MaxEvents = 512, MaxBytes = 65536/u);
  assert.match(source, /PHI_PUBLICATION_COMMIT_PROOF_NOT_IMPLEMENTED/u);
  assert.doesNotMatch(source, /WriteFile|WriteAll|DeleteFile|CopyFile|File\.Move|Process\.Start|\.Kill\(/u);
  for (const name of ['process.mjs', 'build-process.mjs']) {
    const text = fs.readFileSync(new URL('../platform/windows/' + name, import.meta.url), 'utf8');
    assert.match(text, /publicationJournalSourceSha256/u);
  }
});

const cases = ['metadata', 'transition', 'duplicate', 'active', 'corrupt', 'gap', 'oversized', 'unknown-owner', 'unsafe-acl',
  'project-replaced', 'user-change', 'same-content-replaced', 'protected',
  'crash-prepared', 'crash-written', 'crash-flushed', 'crash-ready', 'crash-commit-started'];
for (const name of cases) test('native durable publication journal: ' + name, { skip: process.platform !== 'win32', timeout: 30000 }, () => {
  const result = spawnSync(ownedWindowsHelper(), ['--publication-journal-selftest', name], { shell: false, encoding: 'utf8', windowsHide: true, timeout: 16000, maxBuffer: 16384 });
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.passed, true); assert.equal(receipt.fixtureCleanup, true); assert.equal(receipt.projectPublished, false);
  assert.equal(receipt.scope, 'DURABLE_JOURNAL_ONLY_NOT_PUBLICATION_CRASH_RECOVERY'); assert.equal(receipt.externalRequests, 0);
  if (name.startsWith('crash-')) {
    assert.equal(receipt.actualProcessKilled, true); assert.equal(receipt.childGone, true); assert.equal(receipt.restartedInspector, true);
    assert.equal(receipt.evidence.status, 'RECOVERY_REQUIRED'); assert.equal(receipt.evidence.ownerGenerationAlive, false);
    assert.equal(receipt.evidence.baseMatches, true); assert.equal(receipt.evidence.projectMutations, 0); assert.equal(receipt.evidence.journalMutations, 0); assert.equal(receipt.evidence.processKills, 0);
    assert.equal(receipt.evidence.metadata.projectPublished, false); assert.deepEqual(receipt.evidence.metadata.filesCommitted, []);
    assert.equal(receipt.evidence.metadata.cleanup, 'NOT_PERFORMED');
  }
  assert.doesNotMatch(JSON.stringify(receipt), /old-complete|new-complete|FORBIDDEN_RAW_SENTINEL/u);
  assert.equal(windowsRecoveryStatus().status, 'PASS');
  console.log(JSON.stringify({ control: 'PUBLICATION_DURABLE_JOURNAL_ONLY', ...receipt }));
});
