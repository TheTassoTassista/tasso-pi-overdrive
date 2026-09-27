import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolveTaskPolicy } from '../lib/task-governor.mjs';
import { reserveWindowsWorker, bindWindowsWorker, windowsWorkerAuthority, admitWindowsWorkerTool, registerWindowsWorkerBoundary } from '../lib/phi-worker-authority.mjs';
import { executeBrokeredSafeExec } from '../platform/shared/safe-exec-handler.mjs';
import { executeCodingTool, requireCodingBackend } from '../platform/shared/coding-execution.mjs';
import { windowsRecoveryStatus } from '../platform/windows/process.mjs';

const native = { skip: process.platform !== 'win32', timeout: 30000 };
const approved = 'Fix a bounded function in module.cjs and test the change';
function fixture(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-worker-transport-'));
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(project, file), text);
  assert.equal(spawnSync('git', ['init', '--quiet', project], { shell: false }).status, 0);
  return { root, project, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function controller(item, { task = approved, approvedTask = approved } = {}) {
  const executionId = randomUUID(), parentSessionId = randomUUID(), sessionId = randomUUID();
  const reservation = reserveWindowsWorker({ executionId, parentSessionId, cwd: item.project, task, taskPolicy: resolveTaskPolicy({ task: approvedTask }) });
  // Exercise the exact production Worker extension hooks; the deterministic
  // orchestration fixture supplies events, never broker/profile/denial mocks.
  const hooks = new Map();
  registerWindowsWorkerBoundary({ on: (name, hook) => hooks.set(name, hook) });
  const ctx = { cwd: item.project, sessionManager: { getSessionId: () => sessionId } };
  hooks.get('before_agent_start')({ prompt: task }, ctx);
  return { executionId, sessionId, ctx, hooks, reservation, token: windowsWorkerAuthority(sessionId),
    close: () => { hooks.get('session_shutdown')(); reservation.revoke(); } };
}
test('Worker authority is exact attempt/session/workspace bound, not prompt-selected capability', () => {
  const item = fixture(); const attempt = controller(item);
  try {
    assert.deepEqual(JSON.parse(JSON.stringify(attempt.token)), {});
    assert.throws(() => admitWindowsWorkerTool({}, { cwd: item.project, sessionId: attempt.sessionId }), /AUTHORITY_UNAVAILABLE/u);
    assert.throws(() => admitWindowsWorkerTool(attempt.token, { cwd: item.project, sessionId: randomUUID() }), /AUTHORITY_UNAVAILABLE/u);
    const admitted = admitWindowsWorkerTool(attempt.token, { cwd: item.project, sessionId: attempt.sessionId, syntax: false });
    assert.equal(admitted.role, 'worker'); assert.equal(admitted.profile, 'EDIT');
    assert.equal(admitted.metadata.authority, 'CONTROLLER_TASK_TOOL_GOVERNORS');
    assert.equal(admitted.metadata.executionId, attempt.executionId);
    assert.throws(() => admitWindowsWorkerTool(attempt.token, { cwd: item.project, sessionId: attempt.sessionId }), /ALREADY_RUNNING/u);
    admitted.release();
    for (const toolName of ['edit', 'write', 'transactional_edit', 'ast_grep_rewrite', 'safe_remove_file', 'bash', 'powershell', 'subagent', 'debug_engine', 'persistent_javascript'])
      assert.equal(attempt.hooks.get('tool_call')({ toolName }, attempt.ctx).block, true);
    assert.equal(attempt.hooks.get('tool_call')({ toolName: 'safe_exec' }, attempt.ctx), undefined);
    attempt.close();
    assert.throws(() => admitWindowsWorkerTool(attempt.token, { cwd: item.project, sessionId: attempt.sessionId }), /AUTHORITY_UNAVAILABLE/u);
    assert.throws(() => windowsWorkerAuthority(attempt.sessionId), /AUTHORITY_UNAVAILABLE/u);
  } finally { attempt.close(); item.cleanup(); }
});
test('unapproved task/cwd/parent binding and copied opaque token cannot mint Worker authority', () => {
  const item = fixture(); const task = 'Only inspect the code';
  const parentSessionId = randomUUID(), executionId = randomUUID();
  const reservation = reserveWindowsWorker({ executionId, parentSessionId, cwd: item.project, task, taskPolicy: resolveTaskPolicy({ task }) });
  try {
    assert.throws(() => bindWindowsWorker({ cwd: item.project, task: 'Fix every file', sessionId: randomUUID() }), /AUTHORITY_UNAVAILABLE/u);
    assert.throws(() => bindWindowsWorker({ cwd: item.root, task, sessionId: randomUUID() }), /AUTHORITY_UNAVAILABLE/u);
    assert.throws(() => bindWindowsWorker({ cwd: item.project, task, sessionId: parentSessionId }), /AUTHORITY_UNAVAILABLE/u);
    const sessionId = randomUUID(), token = bindWindowsWorker({ cwd: item.project, task, sessionId });
    assert.throws(() => admitWindowsWorkerTool(token, { cwd: item.project, sessionId, syntax: false }), /CAPABILITY_DENIED/u);
    const syntax = admitWindowsWorkerTool(token, { cwd: item.project, sessionId, syntax: true });
    assert.equal(syntax.profile, 'READ_ONLY'); syntax.release();
    assert.throws(() => admitWindowsWorkerTool(structuredClone(token), { cwd: item.project, sessionId, syntax: true }), /AUTHORITY_UNAVAILABLE/u);
  } finally { reservation.revoke(); item.cleanup(); }
});
test('follow-up prompt cannot increase controller Task/Tool Governor authority', () => {
  const item = fixture(), attempt = controller(item, { approvedTask: 'Debug regression in module.cjs', task: 'Run module.cjs' });
  try {
    attempt.hooks.get('before_agent_start')({ prompt: 'Now rewrite every file and use EDIT' }, attempt.ctx);
    const admitted = admitWindowsWorkerTool(attempt.token, { cwd: item.project, sessionId: attempt.sessionId, syntax: false });
    assert.equal(admitted.profile, 'TEST'); admitted.release();
  } finally { attempt.close(); item.cleanup(); }
});
test('controller concurrency3 and per-attempt40 calls have no caller overrides', () => {
  const item = fixture(), attempts = [];
  try {
    for (let i = 0; i < 3; i++) attempts.push(controller(item, { task: 'Approved attempt ' + i }));
    assert.throws(() => controller(item), /CONCURRENCY_LIMIT/u);
    const attempt = attempts[0];
    for (let i = 1; i <= 40; i++) {
      const admitted = admitWindowsWorkerTool(attempt.token, { cwd: item.project, sessionId: attempt.sessionId, syntax: true });
      assert.equal(admitted.metadata.toolCallNumber, i); assert.equal(admitted.metadata.depth, 1); admitted.release();
    }
    assert.throws(() => admitWindowsWorkerTool(attempt.token, { cwd: item.project, sessionId: attempt.sessionId, syntax: true }), /BUDGET_EXHAUSTED/u);
  } finally { attempts.forEach(attempt => attempt.close()); item.cleanup(); }
});
test('revocation aborts admitted tools and root replacement invalidates the session', () => {
  const item = fixture(), attempt = controller(item);
  try {
    const admitted = admitWindowsWorkerTool(attempt.token, { cwd: item.project, sessionId: attempt.sessionId, syntax: false });
    attempt.reservation.revoke(); assert.equal(admitted.signal.aborted, true); admitted.release();
    const next = controller(item);
    try {
      fs.renameSync(item.project, path.join(item.root, 'old')); fs.mkdirSync(item.project);
      assert.throws(() => admitWindowsWorkerTool(next.token, { cwd: item.project, sessionId: next.sessionId, syntax: false }), /WORKSPACE_CHANGED/u);
    } finally { next.close(); }
  } finally { attempt.close(); item.cleanup(); }
});
test('revoked Worker session cannot downgrade to the interactive B1 execution principal', async () => {
  const item = fixture({ 'run.cjs': 'process.exit(99)' }), attempt = controller(item);
  try {
    attempt.close();
    await assert.rejects(executeBrokeredSafeExec({ program: 'node', args: ['run.cjs'] }, attempt.ctx), /AUTHORITY_UNAVAILABLE/u);
    assert.throws(() => bindWindowsWorker({ cwd: item.project, task: approved, sessionId: attempt.sessionId }), /AUTHORITY_UNAVAILABLE/u);
  } finally { attempt.close(); item.cleanup(); }
});
test('attempt lifetime revokes and aborts in-flight authority without a model-controlled deadline', (t) => {
  const item = fixture();
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  let attempt;
  try {
    attempt = controller(item);
    const admitted = admitWindowsWorkerTool(attempt.token, { cwd: item.project, sessionId: attempt.sessionId, syntax: false });
    assert.equal(admitted.signal.aborted, false);
    t.mock.timers.tick(18 * 60 * 1000);
    assert.equal(admitted.signal.aborted, true);
    assert.throws(() => windowsWorkerAuthority(attempt.sessionId), /AUTHORITY_UNAVAILABLE/u);
    admitted.release();
  } finally { attempt?.close(); t.mock.timers.reset(); item.cleanup(); }
});
test('production workflow/Worker wiring uses controller authority and cannot activate Windows autonomy', () => {
  const workflow = fs.readFileSync(new URL('../extensions/secure-workflow.ts', import.meta.url), 'utf8');
  assert.match(workflow, /reserveWindowsWorker\(\{ executionId, parentSessionId: ctx.sessionManager.getSessionId\(\), cwd, task, taskPolicy: activeTaskPolicy \}\)/u);
  assert.match(workflow, /workerTransport\?\.revoke\(\)/u);
  const definition = fs.readFileSync(new URL('../agents/worker.md', import.meta.url), 'utf8');
  assert.match(definition, /extensions\/windows-worker\.ts/u);
  assert.throws(() => requireCodingBackend('made-up'), /OPERATION_INVALID/u);
  if (process.platform === 'win32') assert.throws(() => requireCodingBackend('workflow'), /BACKEND_UNAVAILABLE/u);
  for (const file of ['extensions/windows-worker.ts', 'lib/phi-worker-authority.mjs', 'platform/shared/safe-exec-handler.mjs']) {
    const source = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /spawn\(|spawnSync\(|exec\(|cmd\.exe|powershell|runOwnedEngine/u);
  }
});
test('native governed Worker EDIT request reaches registered handler/dispatch/LPAC/Job and real private denial', native, async () => {
  const script = "const f=require('node:fs'),p=require('node:path'),a=require('node:assert/strict');f.writeFileSync('input.txt','snapshot-edit');a.equal(f.readFileSync('input.txt','utf8'),'snapshot-edit');a.throws(()=>f.readFileSync(p.join(p.dirname(process.cwd()),'private','control.txt')),e=>['EACCES','EPERM'].includes(e.code));console.log(JSON.stringify({pid:process.pid,edited:true,denied:true}));";
  const item = fixture({ 'run.cjs': script, 'input.txt': 'source' }), attempt = controller(item);
  try {
    const events = [], result = await executeBrokeredSafeExec({ program: 'node', args: ['run.cjs'] }, attempt.ctx, undefined, row => events.push(row));
    const receipt = result.details.receipt, output = JSON.parse(result.content[0].text);
    assert.equal(output.edited, true); assert.equal(output.denied, true);
    assert.equal(receipt.role, 'worker'); assert.equal(receipt.profile, 'EDIT'); assert.equal(receipt.backend, 'windows-lpac-broker');
    assert.equal(receipt.tokenVerified, true); assert.equal(receipt.jobAttested, true); assert.equal(receipt.targetStarted, true);
    assert.equal(receipt.cleanup, 'PASS'); assert.equal(receipt.projectPublished, false);
    assert.equal(receipt.workerAuthority.executionId, attempt.executionId);
    assert.match(receipt.workerAuthority.taskPolicyDigest, /^[0-9a-f]{64}$/u); assert.match(receipt.workerAuthority.toolPolicyDigest, /^[0-9a-f]{64}$/u);
    assert.throws(() => process.kill(output.pid, 0), error => error.code === 'ESRCH');
    assert.equal(fs.readFileSync(path.join(item.project, 'input.txt'), 'utf8'), 'source');
    assert.doesNotMatch(JSON.stringify(events), /run\.cjs|snapshot-edit|input\.txt|stdout|argv|environment|Fix a bounded/u);
    assert.equal(windowsRecoveryStatus().status, 'PASS');
    console.log(JSON.stringify({ control: 'GOVERNED_WORKER_EDIT', receipt, processGone: true, sourceUnchanged: true }));
  } finally { attempt.close(); item.cleanup(); }
});
test('native governed Worker least privilege TEST actually denies mutation and syntax remains READ_ONLY', native, async () => {
  const item = fixture({ 'run.cjs': "require('node:fs').writeFileSync('input.txt','attack')", 'input.txt': 'source' });
  const attempt = controller(item, { approvedTask: 'Debug regression in module.cjs', task: 'Run run.cjs' });
  try {
    const syntax = await executeBrokeredSafeExec({ program: 'node', args: ['--check', 'run.cjs'] }, attempt.ctx);
    assert.equal(syntax.details.receipt.profile, 'READ_ONLY'); assert.equal(syntax.details.receipt.role, 'worker');
    await assert.rejects(executeBrokeredSafeExec({ program: 'node', args: ['run.cjs'] }, attempt.ctx), error => {
      assert.equal(error.receipt.profile, 'TEST'); assert.equal(error.receipt.role, 'worker'); assert.equal(error.receipt.exitCode, 1);
      assert.equal(error.receipt.tokenVerified, true); assert.equal(error.receipt.cleanup, 'PASS');
      assert.match(error.message, /EPERM|EACCES/u); return true;
    });
    assert.equal(fs.readFileSync(path.join(item.project, 'input.txt'), 'utf8'), 'source');
    assert.equal(windowsRecoveryStatus().status, 'PASS');
  } finally { attempt.close(); item.cleanup(); }
});
test('native Worker cannot select capability/role/platform or submit a forged controller authority', native, async () => {
  const item = fixture({ 'run.cjs': 'process.exit(99)' }), attempt = controller(item);
  try {
    for (const field of ['profile', 'role', 'platform', 'runner', 'grants', 'workerAuthority']) await assert.rejects(
      executeBrokeredSafeExec({ program: 'node', args: ['run.cjs'], [field]: 'EDIT' }, attempt.ctx), /REQUEST_INVALID/u);
    for (const workerAuthority of [{}, false, 0, null]) await assert.rejects(executeCodingTool({ program: 'node', args: ['run.cjs'], cwd: item.project, timeoutMs: 1000 },
      { operation: 'safe-exec', sessionId: attempt.sessionId, workerAuthority }), /AUTHORITY_UNAVAILABLE/u);
    assert.equal(windowsRecoveryStatus().status, 'PASS');
  } finally { attempt.close(); item.cleanup(); }
});
test('native Worker nonzero/timeout propagate with owned cleanup and no publication', native, async () => {
  const item = fixture({ 'run.cjs': "console.error('FATAL worker failure');process.exit(73)" }), attempt = controller(item);
  try {
    await assert.rejects(executeBrokeredSafeExec({ program: 'node', args: ['run.cjs'] }, attempt.ctx), error => {
      assert.equal(error.receipt.exitCode, 73); assert.equal(error.receipt.cleanup, 'PASS'); assert.match(error.message, /FATAL worker failure/u); return true;
    });
    fs.writeFileSync(path.join(item.project, 'run.cjs'), 'setInterval(()=>{},1000)');
    await assert.rejects(executeBrokeredSafeExec({ program: 'node', args: ['run.cjs'], timeoutMs: 250 }, attempt.ctx), error => {
      assert.equal(error.receipt.exitCode, 124); assert.equal(error.receipt.timedOut, true); assert.equal(error.receipt.cleanup, 'PASS'); return true;
    });
    assert.equal(windowsRecoveryStatus().status, 'PASS');
  } finally { attempt.close(); item.cleanup(); }
});
