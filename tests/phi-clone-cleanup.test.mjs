import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cloneIdentity, cleanupClone, cleanupErrorMetadata, combineValidationResults } from '../lib/phi-clone-cleanup.mjs';
import { runValidationCommand, validationCommandTimeout } from '../platform/windows/validation-process.mjs';
import { ownedWindowsHelper, windowsProcessRequest } from '../platform/windows/process.mjs';
const native = { skip: process.platform !== 'win32', timeout: 20000 };
const fixture = () => fs.mkdtempSync(path.join(os.tmpdir(), 'phi-clone-cleanup-'));
const unitReceipt = { scope: 'TRUSTED_VALIDATION_JOB_NOT_SANDBOX', jobAttested: true, jobEmptyVerified: true, pipesDrained: true, residualOwnedProcesses: 0 };
const releaseFixture = root => fs.rmSync(root, { recursive: true, force: true });
async function ready(root, running) {
  const started = performance.now();
  let ended;
  running?.then(result => { ended = result; }, () => { ended = { status: 70 }; });
  while (!fs.existsSync(path.join(root, 'ready'))) {
    if (ended && ended.status !== 0) {
      const codes = [...(ended.stderr ?? '').matchAll(/PHI_VALIDATION_LOCK:([A-Z_]+):(\d{1,5})/gu)].map(m => ({ phase: m[1], nativeError: Number(m[2]) }));
      throw new Error(JSON.stringify({ status: ended.status, receipt: ended.receipt, lockDiagnostics: codes }));
    }
    if (performance.now() - started > 5000) throw new Error('FIXTURE_NOT_READY');
    await new Promise(r => setTimeout(r, 10));
  }
}
test('cleanup cannot mask any primary result or receipt, including simultaneous timeout and cleanup error', () => {
  for (const status of ['PASS_FOUNDATION_ONLY', 'FAIL', 'TIMEOUT', 'SECURITY_DENIAL', 'PROCESS_ERROR']) {
    const primary = { status, receipt: { exitCode: status === 'TIMEOUT' ? 124 : 73 }, error: { code: 'PRIMARY_FIXED_CODE' } };
    const cleanup = { status: 'FAIL', error: { code: 'EBUSY' } };
    const result = combineValidationResults(primary, cleanup);
    assert.deepEqual(result.primary, primary); assert.deepEqual(result.cleanup, cleanup); assert.equal(result.status, 'FAIL');
  }
  const primary = { status: 'FOCUSED_TEST206_PASS_NON_CERTIFYING' };
  assert.deepEqual(combineValidationResults(primary, { status: 'PASS' }).status, 'FOCUSED_TEST206_PASS_NON_CERTIFYING');
  assert.equal(combineValidationResults(primary, { status: 'PASS' }).classification, 'FOCUSED_DIAGNOSTIC_ONLY');
  assert.equal(combineValidationResults(primary, { status: 'FAIL' }).status, 'FAIL');
});
test('bounded Windows transient retry retains each failed attempt and the primary timeout', async () => {
  const root = fixture(), identity = cloneIdentity(root); let tick = 0, calls = 0;
  try {
    const cleanup = await cleanupClone(root, identity, { platform: 'win32', receipts: [unitReceipt], now: () => tick,
      sleep: async ms => { tick += ms; }, remove: (p, options) => { if (++calls < 3) throw Object.assign(new Error('PRIVATE'), { code: 'EBUSY', errno: -4082, syscall: 'rmdir', path: path.join(root, 'source with spaces') }); fs.rmSync(p, options); } });
    assert.equal(cleanup.status, 'PASS'); assert.equal(cleanup.attemptCount, 3); assert.equal(cleanup.elapsedMs, 75);
    assert.equal(cleanup.diagnostics.length, 2); assert.equal(cleanup.diagnostics[0].pathCategory, 'CLONE_ROOT');
    const primary = { status: 'TIMEOUT', receipt: { timedOut: true, exitCode: 124 } };
    assert.equal(combineValidationResults(primary, cleanup).status, 'FAIL');
    assert.doesNotMatch(JSON.stringify(cleanup), /PRIVATE|phi-clone-cleanup-/u);
  } finally { releaseFixture(root); }
});
test('persistent cleanup failure is bounded, retains the final error and never reports PASS', async () => {
  const root = fixture(); let tick = 0;
  try {
    const cleanup = await cleanupClone(root, cloneIdentity(root), { platform: 'win32', receipts: [unitReceipt], now: () => tick, sleep: async ms => { tick += ms; },
      remove: () => { throw Object.assign(new Error('PRIVATE'), { code: 'EBUSY' }); } });
    assert.equal(cleanup.status, 'FAIL'); assert.equal(cleanup.attemptCount, 6); assert.equal(cleanup.elapsedMs, 775);
    assert.equal(cleanup.error.code, 'EBUSY'); assert.equal(cleanup.directoryRemoved, false); assert.equal(fs.existsSync(root), true);
    const permanent = await cleanupClone(root, cloneIdentity(root), { platform: 'win32', receipts: [unitReceipt], remove: () => { throw Object.assign(new Error(), { code: 'EACCES' }); } });
    assert.equal(permanent.attemptCount, 1); assert.equal(permanent.error.code, 'EACCES');
  } finally { releaseFixture(root); }
});
test('cleanup refuses unknown process ownership and root identity substitution without deletion', async () => {
  const root = fixture(), identity = cloneIdentity(root);
  try {
    const unknown = await cleanupClone(root, identity, { platform: 'win32', receipts: [] });
    assert.equal(unknown.error.code, 'OWNERSHIP_UNVERIFIED'); assert.equal(unknown.cleanupAttempted, false);
    const changed = await cleanupClone(root, { ...identity, ino: identity.ino + 1n }, { platform: 'win32', receipts: [unitReceipt] });
    assert.equal(changed.error.code, 'IDENTITY_CHANGED'); assert.equal(fs.existsSync(root), true);
  } finally { releaseFixture(root); }
});
test('cleanup rejects a broad temp directory even with its true identity', async () => {
  const cleanup = await cleanupClone(os.tmpdir(), cloneIdentity(os.tmpdir()));
  assert.equal(cleanup.error.code, 'TARGET_REJECTED'); assert.equal(cleanup.cleanupAttempted, false);
});
test('cleanup diagnostics contain category/operation/code only, never raw paths, contents or errors', () => {
  const root = fixture();
  try {
    const result = cleanupErrorMetadata({ code: 'EBUSY', errno: -4082, syscall: 'rmdir', path: path.join(root, 'source with spaces'), message: 'PRIVATE', stack: 'PRIVATE' }, root);
    assert.equal(result.pathCategory, 'CLONE_ROOT'); assert.equal(result.operation, 'rmdir');
    assert.equal(result.nativeError, 'NOT_EXPOSED_BY_NODE'); assert.doesNotMatch(JSON.stringify(result), /PRIVATE|phi-clone-cleanup-/u);
  } finally { releaseFixture(root); }
});
test('aggregate validation budget cannot leak into post-test recovery or other commands', async () => {
  const cwd = process.cwd(), entry = path.join(cwd, 'scripts', 'phi-check.mjs');
  assert.equal(validationCommandTimeout(process.execPath, [entry, '--owned-validation'], cwd), 900000);
  assert.equal(validationCommandTimeout(process.execPath, [entry, '--owned-validation'], cwd, { diagnosticOnly: true }), 780000);
  for (const args of [['--scope-recovery-status'], [entry], [entry, '--owned-validation', 'extra'], ['--validation-lock', 'directory', cwd]]) {
    assert.equal(validationCommandTimeout(process.execPath, args, cwd), 120000);
    assert.equal(validationCommandTimeout(process.execPath, args, cwd, { diagnosticOnly: true }), 120000);
  }
  await assert.rejects(runValidationCommand(process.execPath, ['-e', '1'], { cwd, diagnosticOnly: true, timeoutMs: 780000 }), /PHI_VALIDATION_DIAGNOSTIC_SCOPE_INVALID/u);
});
test('native cwd-inside cleanup reproduces EBUSY, leaves cwd and removes only its fixture', native, async () => {
  const root = fixture(), originalCwd = process.cwd(), identity = cloneIdentity(root);
  const command = await runValidationCommand(process.execPath, ['-e', 'process.exit(0)'], { cwd: originalCwd });
  try {
    process.chdir(root);
    let denial;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (error) { denial = cleanupErrorMetadata(error, root); }
    assert.ok(denial); assert.ok(['EBUSY', 'EPERM', 'EACCES'].includes(denial.code));
    assert.equal(denial.pathCategory, 'TEMP_ROOT');
    const cleanup = await cleanupClone(root, identity, { safeCwd: originalCwd, receipts: [command.receipt] });
    assert.equal(cleanup.status, 'PASS'); assert.equal(cleanup.currentCwdInsideBefore, true); assert.equal(cleanup.currentCwdInsideAfter, false);
    assert.equal(cleanup.residualOwnedProcesses, 0); assert.equal(fs.existsSync(root), false);
    console.log(JSON.stringify({ control: 'CURRENT_CWD', denial, cleanup }));
  } finally { process.chdir(originalCwd); releaseFixture(root); }
});
for (const kind of ['file', 'directory', 'inherited-directory']) test(`native ${kind} handle: real remove denial, actual release and owned-tree cleanup`, native, async () => {
  const root = fixture(), identity = cloneIdentity(root); if (kind === 'file') fs.writeFileSync(path.join(root, 'locked.txt'), 'CONTROL');
  const running = runValidationCommand(ownedWindowsHelper(), ['--validation-lock', kind, root], { cwd: process.cwd() });
  try {
    await ready(root, running);
    const nativeDenial = JSON.parse(fs.readFileSync(path.join(root, 'ready'), 'utf8'));
    assert.ok([5, 32].includes(nativeDenial.nativeError)); assert.equal(nativeDenial.inheritedHandle, kind === 'inherited-directory');
    assert.equal(nativeDenial.currentCwdInside, false);
    let denial;
    try { fs.rmSync(kind === 'file' ? path.join(root, 'locked.txt') : root, { recursive: true, force: true }); } catch (error) { denial = cleanupErrorMetadata(error, root); }
    assert.ok(denial); assert.ok(['EBUSY', 'EPERM', 'EACCES'].includes(denial.code));
    const command = await running; assert.equal(command.status, 0);
    assert.equal(command.receipt.jobEmptyVerified, true); assert.equal(command.receipt.residualOwnedProcesses, 0);
    const cleanup = await cleanupClone(root, identity, { safeCwd: process.cwd(), receipts: [command.receipt] });
    assert.equal(cleanup.status, 'PASS'); assert.equal(cleanup.directoryRemoved, true);
    console.log(JSON.stringify({ control: kind.toUpperCase(), nativeDenial, denial, cleanup }));
  } finally { await running.catch(() => {}); releaseFixture(root); }
});
test('native child cwd and timeout: primary124 survives, real Job drained before clone deletion', native, async () => {
  const root = fixture(), identity = cloneIdentity(root);
  const program = "require('node:fs').writeFileSync('ready',process.cwd());require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:process.cwd(),stdio:'ignore'});setInterval(()=>{},1000);";
  const running = runValidationCommand(process.execPath, ['-e', program], { cwd: root, timeoutMs: 1500 });
  let failureStage = 'WAIT_READY';
  try {
    await ready(root, running);
    failureStage = 'READY_CONTENT';
    assert.equal(fs.readFileSync(path.join(root, 'ready'), 'utf8').toLowerCase(), root.toLowerCase());
    failureStage = 'DELETE_DENIAL';
    let denial;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (error) { denial = cleanupErrorMetadata(error, root); }
    assert.ok(denial);
    failureStage = 'JOB_RECEIPT';
    const command = await running; assert.equal(command.status, 124); assert.equal(command.receipt.primaryExitCode, 124); assert.equal(command.receipt.timedOut, true);
    assert.equal(command.receipt.jobAttested, true); assert.match(command.receipt.childGeneration, /^\d+$/u);
    failureStage = 'OWNED_CLEANUP';
    const cleanup = await cleanupClone(root, identity, { receipts: [command.receipt] });
    assert.equal(cleanup.status, 'PASS'); assert.equal(cleanup.residualOwnedProcesses, 0); assert.equal(cleanup.childCwdInsideAfter, false);
    failureStage = 'AGGREGATION';
    const result = combineValidationResults({ status: 'TIMEOUT', receipt: command.receipt }, cleanup);
    assert.equal(result.status, 'FAIL'); assert.equal(result.primary.receipt.primaryExitCode, 124);
    console.log(JSON.stringify({ control: 'CHILD_CWD_TIMEOUT', denial, ...result }));
  } catch (error) {
    // Fixed enum only: the clean-clone controller intentionally redacts test names,
    // paths, stacks and arbitrary assertion text from its CI failure receipt.
    console.log(`PHI_CLONE_TIMEOUT_${failureStage}`);
    throw error;
  } finally { await running.catch(() => {}); releaseFixture(root); }
});
test('native already-exited parent with surviving descendant is drained and cannot hold clone cwd', native, async () => {
  const root = fixture(), identity = cloneIdentity(root);
  try {
    const command = await runValidationCommand(process.execPath, ['-e', "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:process.cwd(),stdio:'ignore'});c.unref();"], { cwd: root });
    assert.equal(command.status, 0); assert.equal(command.receipt.primaryExitCode, 0); assert.equal(command.receipt.jobEmptyVerified, true);
    const cleanup = await cleanupClone(root, identity, { receipts: [command.receipt] });
    assert.equal(cleanup.status, 'PASS'); assert.equal(cleanup.residualOwnedProcesses, 0);
  } finally { releaseFixture(root); }
});
test('native validation cannot enlarge ordinary or agent runtime limits', native, async () => {
  assert.throws(() => windowsProcessRequest(process.execPath, ['-e', '1'], { timeoutMs: 120001 }), /LIMIT_INVALID/u);
  const command = await runValidationCommand(process.execPath, ['-e', '1'], { cwd: process.cwd(), timeoutMs: 120001 });
  assert.equal(command.status, 70); assert.equal(command.receipt.targetStarted, false);
});
