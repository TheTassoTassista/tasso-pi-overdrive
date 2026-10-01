import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { ownedWindowsHelper, windowsRecoveryStatus } from '../platform/windows/process.mjs';

test('admission cannot return a publisher journal before a flushed PREPARED event', () => {
  const source = fs.readFileSync(new URL('../platform/windows/native/PublicationJournal.cs', import.meta.url), 'utf8');
  const begin = source.slice(source.indexOf('internal static PublicationJournal Begin('), source.indexOf('void Append(', source.indexOf('internal static PublicationJournal Begin(')));
  const reclaim = begin.indexOf('ReclaimForAdmission(root, project,');
  const crash = begin.indexOf('fixtureAfterReclaim();');
  const create = begin.indexOf('root.CreateSubKey(transactionId,');
  const prepared = begin.indexOf('result.Append(key, "PREPARED"');
  const returned = begin.indexOf('return result;');
  assert.ok(reclaim >= 0 && reclaim < crash && crash < create && create < prepared && prepared < returned);
});

test('real publisher death after terminal-key flush but before incoming PREPARED is safe and auditable',
  { skip: process.platform !== 'win32', timeout: 30000 }, () => {
    const run = spawnSync(ownedWindowsHelper(), ['--publication-retention-admission-crash-selftest'],
      { shell: false, encoding: 'utf8', windowsHide: true, timeout: 22000, maxBuffer: 16384 });
    assert.equal(run.status, 0, run.stderr);
    const receipt = JSON.parse(run.stdout);
    assert.equal(receipt.status, 'PASS');
    assert.equal(receipt.scope, 'NATIVE_RECLAIM_BEFORE_PREPARED_PROCESS_CRASH_NOT_POWER_LOSS');
    for (const key of ['passed', 'fixtureCleanup', 'publisherGone', 'admissionKilled', 'admissionGone',
      'freshReaderGone', 'terminalRemoved', 'incomingAbsent', 'projectUnchanged', 'freshAdmission'])
      assert.equal(receipt[key], true, key);
    assert.equal(receipt.capacityBefore, 64);
    assert.equal(receipt.capacityAfterCrash, 63);
    assert.equal(receipt.capacityAfterFresh, 64);
    assert.equal(receipt.beforeProjectDigest, receipt.afterProjectDigest);
    assert.equal(receipt.discovery.status, 'PASS_READ_ONLY_DISCOVERY');
    assert.deepEqual(receipt.discovery.entries, []);
    assert.equal(receipt.discovery.scannedTransactions, 63);
    assert.equal(receipt.discovery.projectTransactions, 0);
    assert.equal(receipt.discovery.actionPerformed, false);
    assert.equal(receipt.projectPublished, false);
    assert.equal(receipt.externalRequests, 0);
    assert.equal(windowsRecoveryStatus().status, 'PASS');
    console.log(JSON.stringify({ control: 'NATIVE_RETENTION_ADMISSION_PROCESS_CRASH', ...receipt }));
  });
