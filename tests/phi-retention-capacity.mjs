import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { ownedWindowsHelper, windowsRecoveryStatus } from '../platform/windows/process.mjs';
import { validWindowsRetention } from '../platform/windows/publication.mjs';

test('real 64-entry Windows journal pressure reclaims only one proved terminal DELETE', { timeout: 45000 }, () => {
  assert.equal(process.platform, 'win32');
  const run = spawnSync(ownedWindowsHelper(), ['--publication-retention-capacity-selftest'], {
    shell: false, windowsHide: true, encoding: 'utf8', timeout: 35000, maxBuffer: 4096,
  });
  assert.equal(run.status, 0, run.stderr);
  const receipt = JSON.parse(run.stdout);
  assert.equal(receipt.status, 'PASS');
  assert.equal(receipt.scope, 'NATIVE_TERMINAL_RETENTION_AT_REAL_64_ENTRY_CAPACITY');
  for (const key of ['passed', 'fixtureCleanup', 'publisherKilled', 'publisherGone', 'freshReaderGone',
    'normal63To64', 'noSafeBlocked', 'corruptBlocked', 'oneTerminalRemoved', 'otherEntriesPreserved',
    'admittedAfterReclaim', 'secondPassBlocked', 'projectUnchanged']) assert.equal(receipt[key], true, key);
  assert.equal(receipt.beforeReclaim, 64);
  assert.equal(receipt.afterReclaim, 64);
  assert.match(receipt.selectedTransactionId, /^[0-9a-f]{32}$/u);
  assert.equal(receipt.terminalPhase, 'CLEANED');
  assert.equal(validWindowsRetention(receipt.reclaimReceipt), true);
  assert.equal(receipt.reclaimReceipt.selectedTransactionId, receipt.selectedTransactionId);
  assert.equal(receipt.reclaimReceipt.journalVersion, 3);
  assert.equal(receipt.reclaimReceipt.terminalPhase, 'CLEANED');
  assert.equal(receipt.reclaimReceipt.capacityBefore, 64);
  assert.equal(receipt.reclaimReceipt.capacityAfterReclaim, 63);
  assert.equal(receipt.reclaimReceipt.capacityAfterAdmission, 64);
  assert.match(receipt.beforeProjectDigest, /^[0-9a-f]{64}$/u);
  assert.equal(receipt.afterProjectDigest, receipt.beforeProjectDigest);
  assert.ok(Number.isInteger(receipt.originalEntries) && receipt.originalEntries >= 0 && receipt.originalEntries < 64);
  assert.equal(receipt.filledEntries, 63 - receipt.originalEntries);
  assert.equal(receipt.processKillsByRetention, 0);
  assert.equal(receipt.projectPublished, false);
  assert.equal(receipt.externalRequests, 0);
  assert.equal(windowsRecoveryStatus().status, 'PASS');
  console.log(JSON.stringify({ control: 'NATIVE_TERMINAL_RETENTION_CAPACITY', ...receipt }));
});
