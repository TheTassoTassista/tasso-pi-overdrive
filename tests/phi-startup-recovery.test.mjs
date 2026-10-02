import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { planWindowsStartupRecovery, runWindowsStartupRecovery } from '../platform/windows/startup-recovery.mjs';
import { ownedWindowsHelper, windowsRecoveryStatus } from '../platform/windows/process.mjs';

const id = 'a'.repeat(32);
const base = { status: 'PASS_READ_ONLY_DISCOVERY', rootIdentityVerified: true, projectPublished: false,
  actionPerformed: false, projectTransactions: 0, entries: [] };
const entry = (phase, classification = 'RECOVERY_REQUIRED', journalVersion = 4) =>
  ({ transactionId: id, phase, classification, journalVersion });
const inventory = (...entries) => ({ ...base, projectTransactions: entries.length, entries });

test('startup selection ignores only terminal journals and never treats an advisory inventory as authority', () => {
  assert.equal(planWindowsStartupRecovery(inventory()).kind, 'NO_PENDING');
  assert.equal(planWindowsStartupRecovery(inventory(entry('CLEANED', 'TERMINAL_RETAINED'))).kind, 'NO_PENDING');
  assert.equal(planWindowsStartupRecovery(inventory(entry('ROLLED_BACK', 'TERMINAL_RETAINED'))).kind, 'NO_PENDING');
  assert.equal(planWindowsStartupRecovery(inventory(entry('CLEANED', 'CONFLICT'))).kind, 'BLOCKED_CONFLICT');
  assert.equal(planWindowsStartupRecovery(inventory(entry('ROLLED_BACK', 'MANUAL_RECOVERY_REQUIRED'))).kind, 'BLOCKED_MANUAL_RECOVERY_REQUIRED');
  assert.equal(planWindowsStartupRecovery(inventory(entry('RENAME_INTENT'))).kind, 'RECOVER');
  assert.equal(planWindowsStartupRecovery(inventory(entry('DELETE_INTENT', 'RECOVERY_REQUIRED', 3))).kind, 'RECOVER');
  assert.equal(planWindowsStartupRecovery(inventory(entry('COMMIT_STARTED', 'RECOVERY_REQUIRED', 2))).kind, 'RECOVER');
  assert.equal(planWindowsStartupRecovery(inventory(entry('PREPARED', 'RECOVERY_REQUIRED', 1))).kind, 'BLOCKED_UNSUPPORTED_VERSION');
  assert.equal(planWindowsStartupRecovery(inventory(entry('PREPARED', 'MANUAL_RECOVERY_REQUIRED', 5))).kind, 'BLOCKED_MANUAL_RECOVERY_REQUIRED');
  assert.equal(planWindowsStartupRecovery(inventory(entry('UNKNOWN_ACTIVE', 'ACTIVE_UNVERIFIED'))).kind, 'BLOCKED_ACTIVE_UNVERIFIED');
  assert.equal(planWindowsStartupRecovery(inventory(entry('RENAME_INTENT', 'CONFLICT'))).kind, 'BLOCKED_CONFLICT');
  assert.equal(planWindowsStartupRecovery(inventory(entry('RENAME_INTENT'), { ...entry('DELETE_INTENT'), transactionId: 'b'.repeat(32) })).kind,
    'BLOCKED_MULTIPLE_PENDING');
  assert.throws(() => planWindowsStartupRecovery({ ...inventory(), projectTransactions: 1 }), /RECOVERY_UNCONFIRMED/u);
  assert.throws(() => planWindowsStartupRecovery({ ...inventory(), projectPublished: true }), /RECOVERY_UNCONFIRMED/u);
});

test('ordinary Phi launch invokes recovery before unchanged autonomous-backend gate, not help/doctor/splash', () => {
  const source = fs.readFileSync(new URL('../bin/phi.mjs', import.meta.url), 'utf8');
  const recovery = source.indexOf('runWindowsStartupRecovery({ cwd: process.cwd() })');
  const gate = source.indexOf('requireAutonomousBackend();');
  assert.ok(recovery > source.indexOf("if (args[0] === 'splash')"));
  assert.ok(gate > recovery);
  assert.match(source, /if \(recovery\.status === 'BLOCKED'\) throw new Error\('PHI_STARTUP_RECOVERY_BLOCKED'\)/u);
  assert.match(source, /"status":"UNKNOWN_FAIL_SAFE"/u);
  assert.doesNotMatch(source, /PHI_STARTUP_RECOVERY.*PUBLISHED/u);
});

test('Windows startup recovery has no portable mutation fallback', { skip: process.platform === 'win32' }, () => {
  assert.throws(() => runWindowsStartupRecovery({ cwd: '.' }), /RECOVERY_UNCONFIRMED/u);
});

for (const name of ['resume', 'conflict', 'manual']) {
  test('actual normal Phi startup after killed V4 publisher: ' + name,
    { skip: process.platform !== 'win32', timeout: 120000 }, () => {
      const run = spawnSync(ownedWindowsHelper(), ['--publication-startup-recovery-selftest', name], {
        shell: false, windowsHide: true, encoding: 'utf8', timeout: 105000, maxBuffer: 12000,
      });
      assert.equal(run.status, 0, run.stderr);
      const evidence = JSON.parse(run.stdout);
      assert.equal(evidence.caseName, name);
      for (const key of ['passed', 'fixtureCleanup', 'gitMetadataClean', 'actualProcessKilled', 'childGone',
        'firstStartupGone', 'secondStartupGone', 'idempotent']) assert.equal(evidence[key], true, key);
      assert.equal(evidence.scope, 'NORMAL_PHI_WINDOWS_STARTUP_RECOVERY_NOT_AUTONOMY');
      assert.equal(evidence.firstExit, 1); // Existing Windows autonomous backend remains blocked.
      assert.equal(evidence.secondExit, 1);
      assert.equal(evidence.firstReceipt.status, name === 'resume' ? 'PASS_RECOVERED' : 'BLOCKED');
      assert.equal(evidence.firstReceipt.projectMutations, name === 'resume' ? 1 : 0);
      assert.equal(evidence.secondReceipt.status, name === 'resume' ? 'PASS_NO_PENDING' : 'BLOCKED');
      assert.equal(evidence.secondReceipt.projectMutations, 0);
      assert.equal(evidence.firstReceipt.projectPublished, false);
      assert.equal(evidence.secondReceipt.projectPublished, false);
      assert.equal(evidence.externalRequests, 0);
      assert.doesNotMatch(JSON.stringify(evidence), /old-rename-complete|new-rename-user|unrelated-rename-user/u);
      assert.equal(windowsRecoveryStatus().status, 'PASS');
      console.log(JSON.stringify({ control: 'NORMAL_PHI_STARTUP_RECOVERY', ...evidence }));
    });
}
