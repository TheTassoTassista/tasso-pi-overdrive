import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { cloneFoundationGate, finalizeCloneFoundationGate } from '../lib/phi-validation-evidence.mjs';
import { runValidationCommand } from '../platform/windows/validation-process.mjs';

function corpus({ total = 500, failed = 0, lastOrdinal = total } = {}) {
  const utc = '2026-01-01T00:00:00.000Z';
  const event = row => `# PHI_RUNTIME ${JSON.stringify({ ...row, elapsedMs: 1, utc })}`;
  return [event({ kind: 'start' }), ...Array.from({ length: lastOrdinal }, (_, index) =>
    `ok ${index + 1} - synthetic\n  ---\n  duration_ms: 1\n  ...\n${event({ kind: 'completion', ordinal: index + 1, failed: false, durationMs: 1 })}`),
  event({ kind: 'end', completed: lastOrdinal }), `# tests ${total}`, `# pass ${total - 12 - failed}`, `# fail ${failed}`, '# skipped 12'].join('\n');
}
function receipt(overrides = {}) {
  return { jobEmptyVerified: true, pipesDrained: true, residualOwnedProcesses: 0, timedOut: false, stallTimedOut: false, outerTimedOut: false,
    progress: { scope: 'FIXED_SUITE_PROGRESS_ONLY', started: true, ended: true, completed: 500, failed: 0,
      invalid: false, stalled: false, lastProgressMs: 1, longestObservedGapMs: 1, stallThresholdMs: 150000 }, ...overrides };
}
test('fixed corpus, numeric reporter and native owned observations jointly certify', () => {
  const gate = cloneFoundationGate({ stdout: corpus(), status: 0, receipt: receipt() }, { native: true });
  assert.equal(gate.classification, 'SUCCESS');
  assert.equal(gate.gateA, 'PENDING_CLEANUP');
  assert.equal(gate.gateB, 'PASS');
  assert.equal(JSON.stringify(gate).includes('synthetic'), false);
});
test('Gate A waits for every post-suite check, clone removal and zero owned residuals', () => {
  const make = () => cloneFoundationGate({ stdout: corpus(), status: 0, receipt: receipt() }, { native: true });
  const cleanup = { status: 'PASS', directoryRemoved: true, residualOwnedProcesses: 0, processOwnership: 'NATIVE_JOB_HANDLES' };
  assert.equal(finalizeCloneFoundationGate(make(), 'PASS_FOUNDATION_ONLY', cleanup, { native: true, runtimeRecorded: true }).gateA, 'PASS');
  assert.equal(finalizeCloneFoundationGate(make(), 'FAIL', cleanup, { native: true }).gateA, 'FAIL');
  assert.equal(finalizeCloneFoundationGate(make(), 'PASS_FOUNDATION_ONLY', { ...cleanup, status: 'FAIL' }, { native: true }).gateA, 'FAIL');
  assert.equal(finalizeCloneFoundationGate(make(), 'PASS_FOUNDATION_ONLY', { ...cleanup, directoryRemoved: false }, { native: true }).gateA, 'FAIL');
  assert.equal(finalizeCloneFoundationGate(make(), 'PASS_FOUNDATION_ONLY', { ...cleanup, residualOwnedProcesses: 1 }, { native: true }).gateA, 'FAIL');
});
test('incomplete ordinals, count mismatch, failed tests and invalid reporter fail closed', () => {
  for (const result of [
    { stdout: corpus({ lastOrdinal: 499 }), status: 0, receipt: receipt() },
    { stdout: corpus({ total: 499, lastOrdinal: 499 }), status: 0, receipt: receipt() },
    { stdout: corpus(), status: 0, receipt: receipt({ progress: { ...receipt().progress, completed: 499 } }) },
    { stdout: corpus(), status: 0, receipt: receipt({ progress: { ...receipt().progress, invalid: true } }) },
    { stdout: corpus().replace('# PHI_RUNTIME {', '# PHI_RUNTIME {bad'), status: 0, receipt: receipt() },
    { stdout: corpus().replace('ok 2 - synthetic', `${corpus().split('\n').find(line => line.includes('"ordinal":1'))}\nok 2 - synthetic`), status: 0, receipt: receipt() },
  ]) assert.equal(cloneFoundationGate(result, { native: true }).classification, 'INCOMPLETE_SUITE');
  assert.equal(cloneFoundationGate({ stdout: corpus({ failed: 1 }), status: 1, receipt: receipt() }, { native: true }).classification, 'TEST_FAILURE');
});
test('watchdog and outer ceiling are distinct from assertion and completeness failures', () => {
  assert.equal(cloneFoundationGate({ stdout: corpus({ lastOrdinal: 3 }), status: 124,
    receipt: receipt({ stallTimedOut: true }) }, { native: true }).classification, 'STALL_TIMEOUT');
  assert.equal(cloneFoundationGate({ stdout: corpus({ lastOrdinal: 3 }), status: 124,
    receipt: receipt({ outerTimedOut: true }) }, { native: true }).classification, 'OUTER_RUNTIME_LIMIT');
  assert.equal(cloneFoundationGate({ stdout: corpus(), status: 0,
    receipt: receipt({ progress: { ...receipt().progress, stalled: true, longestObservedGapMs: 150001 } }) },
    { native: true }).classification, 'STALL_TIMEOUT');
});

// Real Windows Job focused controls. This exact trusted validation entry uses a
// disposable fixture, never the full clone corpus or a model/provider call.
async function nativeFixture(testSource, timeoutMs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-watchdog-'));
  try {
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.mkdirSync(path.join(root, 'tests'));
    fs.writeFileSync(path.join(root, 'tests', 'fixture.mjs'), testSource);
    const reporter = pathToFileURL(path.resolve('scripts/phi-runtime-reporter.mjs')).href;
    fs.writeFileSync(path.join(root, 'scripts', 'phi-check.mjs'), `import { spawnSync } from 'node:child_process';
import path from 'node:path';
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter', ${JSON.stringify(reporter)},
  path.join(process.cwd(), 'tests', 'fixture.mjs')], { stdio: 'inherit', shell: false });
process.exitCode = result.status ?? 1;
`);
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    return await runValidationCommand(process.execPath, [path.join(root, 'scripts', 'phi-check.mjs'), '--owned-validation'],
      { cwd: root, env, timeoutMs });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
test('native progressing-but-slow runner survives beyond 150 seconds', { skip: process.platform !== 'win32' }, async () => {
  const result = await nativeFixture(`import test from 'node:test';
test('slow one', async () => { await new Promise(resolve => setTimeout(resolve, 85000)); });
test('slow two', async () => { await new Promise(resolve => setTimeout(resolve, 85000)); });
`, 220000);
  assert.equal(result.status, 0);
  assert.equal(result.receipt.stallTimedOut, false);
  assert.equal(result.receipt.outerTimedOut, false);
  assert.equal(result.receipt.progress.completed, 2);
  assert.equal(result.receipt.jobEmptyVerified, true);
  assert.equal(result.receipt.residualOwnedProcesses, 0);
});
test('native no-progress watchdog terminates owned child and drains Job', { skip: process.platform !== 'win32' }, async () => {
  const result = await nativeFixture(`import test from 'node:test';
import { spawn } from 'node:child_process';
test('hang with owned descendant', () => { spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); return new Promise(() => {}); });
`, 190000);
  assert.equal(result.status, 124);
  assert.equal(result.receipt.stallTimedOut, true);
  assert.equal(result.receipt.outerTimedOut, false);
  assert.equal(result.receipt.jobEmptyVerified, true);
  assert.equal(result.receipt.pipesDrained, true);
  assert.equal(result.receipt.residualOwnedProcesses, 0);
});
const outerCeilingFixture = `import test from 'node:test';
test('hang', () => { setInterval(() => {}, 1000); return new Promise(() => {}); });
`;
test('outer ceiling fixture stays live until an external deadline', () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', outerCeilingFixture],
    { encoding: 'utf8', env, timeout: 1200 });
  assert.equal(result.error?.code, 'ETIMEDOUT');
  assert.equal(result.status, null);
  assert.match(result.stdout, /TAP version 13/);
});
test('native outer resource ceiling terminates owned Job independently', { skip: process.platform !== 'win32' }, async () => {
  const result = await nativeFixture(outerCeilingFixture, 4000);
  assert.equal(result.status, 124);
  assert.equal(result.receipt.stallTimedOut, false);
  assert.equal(result.receipt.outerTimedOut, true);
  assert.equal(result.receipt.jobEmptyVerified, true);
  assert.equal(result.receipt.residualOwnedProcesses, 0);
});
