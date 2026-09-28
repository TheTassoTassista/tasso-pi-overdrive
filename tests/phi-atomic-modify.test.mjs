import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { ownedWindowsHelper, windowsRecoveryStatus } from '../platform/windows/process.mjs';

test('atomic MODIFY uses native transaction-bound handles only; no ordinary target writer or unsafe fallback', () => {
  const source = fs.readFileSync(new URL('../platform/windows/native/AtomicModify.cs', import.meta.url), 'utf8');
  assert.match(source, /CreateFileTransactedW/u);
  assert.match(source, /CommitTransaction\(transaction\)/u);
  assert.match(source, /RollbackTransaction\(transaction\)/u);
  assert.match(source, /checkpoint\("before-commit", tempId\)/u);
  assert.match(source, /Hash\(Read\(target\)\) != expectedDigest/u);
  assert.match(source, /SecurityDigest\(target\) != security/u);
  assert.doesNotMatch(source, /extern.*(?:MoveFile|ReplaceFile|CopyFile|CreateFileW)\b/u);
  for (const name of ['build-process.mjs', 'process.mjs']) assert.match(fs.readFileSync(new URL('../platform/windows/' + name, import.meta.url), 'utf8'), /atomicModifySourceSha256/u);
  assert.equal(fs.readFileSync(new URL('../platform/windows/index.mjs', import.meta.url), 'utf8').includes('autonomousReady: true'), false);
});
for (const name of ['commit', 'old-visible-before-commit', 'locked-after-handles-close', 'changed-content', 'same-content-recreated', 'write', 'flush', 'before-commit', 'committed']) {
  test('native atomic MODIFY primitive: ' + name, { skip: process.platform !== 'win32', timeout: 30000 }, () => {
    const run = spawnSync(ownedWindowsHelper(), ['--atomic-modify-selftest', name], { shell: false, windowsHide: true, encoding: 'utf8', timeout: 20000, maxBuffer: 8192 });
    assert.equal(run.status, 0, run.stderr);
    const receipt = JSON.parse(run.stdout);
    assert.equal(receipt.passed, true); assert.equal(receipt.fixtureCleanup, true); assert.equal(receipt.externalRequests, 0);
    assert.equal(receipt.scope, 'NATIVE_TRANSACTION_PRIMITIVE_NOT_PRODUCTION_PUBLICATION'); assert.equal(receipt.projectPublished, false);
    if (name === 'locked-after-handles-close') { assert.equal(receipt.lockedAfterHandlesClose, true); assert.equal(receipt.outsideWritePositive, true); assert.equal(receipt.oldVisibleBeforeCommit, true); }
    assert.equal(windowsRecoveryStatus().status, 'PASS');
    console.log(JSON.stringify({ control: 'NATIVE_ATOMIC_MODIFY_PRIMITIVE_ONLY', ...receipt }));
  });
}
