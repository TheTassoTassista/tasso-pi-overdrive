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
import { executeCodingTool, requireCodingBackend, verifyCodingProject } from '../platform/shared/coding-execution.mjs';
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
  hooks.get('before_agent_start')({ prompt: `Task: ${task}` }, ctx);
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
    assert.throws(() => bindWindowsWorker({ cwd: item.project, task, sessionId: randomUUID() }), /AUTHORITY_UNAVAILABLE/u);
    assert.throws(() => bindWindowsWorker({ cwd: item.project, task: `Task: Task: ${task}`, sessionId: randomUUID() }), /AUTHORITY_UNAVAILABLE/u);
    assert.throws(() => bindWindowsWorker({ cwd: item.root, task: `Task: ${task}`, sessionId: randomUUID() }), /AUTHORITY_UNAVAILABLE/u);
    assert.throws(() => bindWindowsWorker({ cwd: item.project, task: `Task: ${task}`, sessionId: parentSessionId }), /AUTHORITY_UNAVAILABLE/u);
    const sessionId = randomUUID(), token = bindWindowsWorker({ cwd: item.project, task: `Task: ${task}`, sessionId });
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
test('controller-retained handoff rejects an in-flight Worker tool and disposes its reservation', () => {
  const item = fixture(), task = approved, sessionId = randomUUID();
  const reservation = reserveWindowsWorker({ executionId: randomUUID(), parentSessionId: randomUUID(), cwd: item.project,
    task, taskPolicy: resolveTaskPolicy({ task }), retainForController: true });
  try {
    const token = bindWindowsWorker({ cwd: item.project, task: `Task: ${task}`, sessionId });
    const admitted = admitWindowsWorkerTool(token, { cwd: item.project, sessionId, syntax: true });
    assert.throws(() => reservation.finishWorker(), /AUTHORITY_UNAVAILABLE/u);
    assert.equal(admitted.signal.aborted, true);
    assert.equal(reservation.status().revoked, true);
    assert.equal(reservation.status().draft?.payloadCleared ?? true, true);
    assert.throws(() => admitWindowsWorkerTool(token, { cwd: item.project, sessionId, syntax: true }), /AUTHORITY_UNAVAILABLE/u);
    admitted.release();
  } finally { reservation.revoke(); item.cleanup(); }
});
test('stale tool lease cannot unlock or settle a later command in the same draft/session', () => {
  const item = fixture(), attempt = controller(item);
  try {
    const old = admitWindowsWorkerTool(attempt.token, { cwd: item.project, sessionId: attempt.sessionId, syntax: true });
    old.release();
    const current = admitWindowsWorkerTool(attempt.token, { cwd: item.project, sessionId: attempt.sessionId, syntax: true });
    old.release();
    assert.throws(() => old.finish(null, false), /DRAFT_IDENTITY_INVALID/u);
    assert.throws(() => admitWindowsWorkerTool(attempt.token, { cwd: item.project, sessionId: attempt.sessionId, syntax: true }), /ALREADY_RUNNING/u);
    current.release();
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
  assert.match(workflow, /reserveWindowsWorker\(\{ executionId, parentSessionId: ctx.sessionManager.getSessionId\(\), cwd, task, taskPolicy: activeTaskPolicy,/u);
  assert.match(workflow, /retainForController: true, publicationEnvelope: boundedEnvelope/u);
  assert.match(workflow, /reservation\.finishWorker\(\)/u);
  assert.match(workflow, /workerTransport\?\.revoke\(\)/u);
  const definition = fs.readFileSync(new URL('../agents/worker.md', import.meta.url), 'utf8');
  assert.match(definition, /extensions\/windows-worker\.ts/u);
  assert.throws(() => requireCodingBackend('made-up'), /OPERATION_INVALID/u);
  if (process.platform === 'win32') assert.throws(() => requireCodingBackend('workflow'), /BACKEND_UNAVAILABLE/u);
  for (const file of ['extensions/windows-worker.ts', 'lib/phi-worker-authority.mjs', 'platform/shared/safe-exec-handler.mjs']) {
    const source = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /spawn\(|spawnSync\(|(?<!\.)\bexec\(|cmd\.exe|powershell|runOwnedEngine/u);
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
  const item = fixture({ 'run.cjs': "console.error('FATAL worker failure');process.exit(73)", 'timeout.cjs': 'setInterval(()=>{},1000)' }), attempt = controller(item);
  try {
    await assert.rejects(executeBrokeredSafeExec({ program: 'node', args: ['run.cjs'] }, attempt.ctx), error => {
      assert.equal(error.receipt.exitCode, 73); assert.equal(error.receipt.cleanup, 'PASS'); assert.match(error.message, /FATAL worker failure/u); return true;
    });
    await assert.rejects(executeBrokeredSafeExec({ program: 'node', args: ['timeout.cjs'], timeoutMs: 250 }, attempt.ctx), error => {
      assert.equal(error.receipt.exitCode, 124); assert.equal(error.receipt.timedOut, true); assert.equal(error.receipt.cleanup, 'PASS'); return true;
    });
    assert.equal(windowsRecoveryStatus().status, 'PASS');
  } finally { attempt.close(); item.cleanup(); }
});

const persistentFiles = () => ({
  'input.txt': 'source', 'package.json': JSON.stringify({ scripts: { lint: 'node --check test.cjs', test: 'node test.cjs' } }),
  'edit.cjs': "require('node:fs').writeFileSync('input.txt','edited');console.log(JSON.stringify({pid:process.pid}));",
  'test.cjs': "const f=require('node:fs'),a=require('node:assert/strict');a.equal(f.readFileSync('input.txt','utf8'),'edited');a.throws(()=>f.writeFileSync('input.txt','forbidden'),e=>['EPERM','EACCES'].includes(e.code));console.log(JSON.stringify({persisted:true,pid:process.pid}));",
  'read.cjs': "require('node:assert/strict').equal(require('node:fs').readFileSync('input.txt','utf8'),'edited');console.log(JSON.stringify({persisted:true,pid:process.pid}));",
  'fail.cjs': "require('node:fs').writeFileSync('input.txt','corrupt');console.error('FATAL partial copy discarded');process.exit(73);",
});
test('native same Worker draft persists and TEST verifies modified draft, never fresh host or concurrent user edit', native, async () => {
  const item = fixture(persistentFiles()), attempt = controller(item), events = [];
  try {
    const original = await verifyCodingProject({ cwd: item.project });
    assert.equal(original.status, 'FAIL'); // canonical false-positive control
    const edit = await executeBrokeredSafeExec({ program: 'node', args: ['edit.cjs'] }, attempt.ctx, undefined, row => events.push(row));
    const edited = edit.details.receipt.draft;
    assert.equal(edited.revision, 1); assert.equal(edited.state, 'EDITED');
    fs.writeFileSync(path.join(item.project, 'input.txt'), 'concurrent-user-change');
    const read = await executeBrokeredSafeExec({ program: 'node', args: ['read.cjs'] }, attempt.ctx, undefined, row => events.push(row));
    assert.equal(JSON.parse(read.content[0].text).persisted, true);
    const summary = await verifyCodingProject({ cwd: item.project, workerAuthority: attempt.token, sessionId: attempt.sessionId });
    assert.equal(summary.status, 'PASS'); assert.equal(summary.results.length, 2);
    assert.equal(summary.draft.state, 'VERIFIED'); assert.equal(summary.draft.revision, 1);
    for (const receipt of [read.details.receipt, ...summary.results.map(row => row.receipt)]) {
      assert.equal(receipt.draft.draftId, edited.draftId); assert.equal(receipt.draft.contentDigest, edited.contentDigest);
      assert.equal(receipt.draft.baseRootIdentity, edited.baseRootIdentity); assert.equal(receipt.sessionId, attempt.sessionId.replaceAll('-', ''));
      assert.equal(receipt.cleanup, 'PASS'); assert.equal(receipt.jobEmptyVerified, true); assert.equal(receipt.projectPublished, false);
    }
    assert.deepEqual(summary.results.map(row => row.receipt.workerAuthority.toolCallNumber), [3, 4]);
    assert.ok(summary.results.every(row => row.receipt.role === 'tester' && row.receipt.profile === 'TEST'));
    for (const result of [edit, read]) assert.throws(() => process.kill(JSON.parse(result.content[0].text).pid, 0), error => error.code === 'ESRCH');
    assert.equal(fs.readFileSync(path.join(item.project, 'input.txt'), 'utf8'), 'concurrent-user-change');
    assert.doesNotMatch(JSON.stringify(events), /input\.txt|edited|concurrent-user-change|files|stdout/u);
    console.log(JSON.stringify({ control: 'SAME_DRAFT_VERIFICATION', receipts: [edit.details.receipt, read.details.receipt, ...summary.results.map(row => row.receipt)], hostUnchangedByWorker: true }));
  } finally { attempt.close(); assert.equal(attempt.reservation.status().draft.payloadCleared, true); item.cleanup(); }
});
test('native partial failed command and subsequent revocation preserve prior draft digest without publication', native, async () => {
  const item = fixture(persistentFiles()), attempt = controller(item);
  try {
    const edit = await executeBrokeredSafeExec({ program: 'node', args: ['edit.cjs'] }, attempt.ctx);
    const prior = edit.details.receipt.draft;
    await assert.rejects(executeBrokeredSafeExec({ program: 'node', args: ['fail.cjs'] }, attempt.ctx), error => {
      assert.equal(error.receipt.exitCode, 73); assert.equal(error.receipt.publicationState, 'ROLLED_BACK');
      assert.deepEqual(error.receipt.draft, prior); assert.match(error.message, /FATAL partial copy discarded/u); return true;
    });
    const read = await executeBrokeredSafeExec({ program: 'node', args: ['read.cjs'] }, attempt.ctx);
    assert.equal(JSON.parse(read.content[0].text).persisted, true);
    const beforeRevoke = attempt.reservation.status().draft;
    attempt.reservation.revoke();
    await assert.rejects(executeBrokeredSafeExec({ program: 'node', args: ['edit.cjs'] }, attempt.ctx), /AUTHORITY_UNAVAILABLE/u);
    await assert.rejects(verifyCodingProject({ cwd: item.project, workerAuthority: attempt.token, sessionId: attempt.sessionId }), /AUTHORITY_UNAVAILABLE/u);
    assert.equal(attempt.reservation.status().draft.contentDigest, beforeRevoke.contentDigest);
    assert.equal(attempt.reservation.status().draft.revision, beforeRevoke.revision);
    assert.equal(attempt.reservation.status().draft.payloadCleared, true);
    assert.equal(fs.readFileSync(path.join(item.project, 'input.txt'), 'utf8'), 'source');
    assert.equal(windowsRecoveryStatus().status, 'PASS');
  } finally { attempt.close(); item.cleanup(); }
});
test('native unsafe draft readback cannot silently omit protected files or accept alias output', native, async () => {
  const item = fixture({ ...persistentFiles(),
    'protected.cjs': "require('node:fs').writeFileSync('.env','not-a-credential');",
    'alias.cjs': "const f=require('node:fs'),p=require('node:path'),a=require('node:assert/strict');a.equal(f.readFileSync('input.txt','utf8'),'edited');try{f.linkSync(p.join(process.cwd(),'input.txt'),p.join(process.cwd(),'alias.txt'));}catch(e){a.equal(f.statSync('input.txt').nlink,1);a.equal(f.existsSync('alias.txt'),false);console.error('PHI_DRAFT_ALIAS_DIAGNOSTIC:'+JSON.stringify({code:typeof e.code==='string'&&/^[A-Z_]{1,30}$/.test(e.code)?e.code:'INVALID',errno:Number.isInteger(e.errno)?e.errno:null}));process.exit(['EPERM','EACCES'].includes(e.code)||e.code==='EBUSY'&&e.errno===-4082?1:91);}",
    'binary.cjs': "require('node:fs').writeFileSync('invalid.txt',Buffer.from([255]));",
  });
  // Real ordinary-host positive control, not a mock denial. Restore single-link
  // source BEFORE the controller's native snapshot admission.
  let attempt;
  try {
    const hostAlias = path.join(item.project, 'host-alias.txt');
    fs.linkSync(path.join(item.project, 'input.txt'), hostAlias);
    assert.equal(fs.statSync(hostAlias).nlink, 2);
    assert.equal(fs.readFileSync(hostAlias, 'utf8'), 'source'); fs.unlinkSync(hostAlias);
    attempt = controller(item);
    const edit = await executeBrokeredSafeExec({ program: 'node', args: ['edit.cjs'] }, attempt.ctx);
    for (const script of ['protected.cjs', 'alias.cjs', 'binary.cjs']) {
      await assert.rejects(executeBrokeredSafeExec({ program: 'node', args: [script] }, attempt.ctx), error => {
        const marker = /PHI_DRAFT_ALIAS_DIAGNOSTIC:(\{[^\r\n]*\})/u.exec(error.message);
        const diagnostic = marker ? JSON.parse(marker[1]) : null;
        console.log(JSON.stringify({ control: script === 'alias.cjs' ? 'ALIAS_OUTPUT' : script === 'protected.cjs' ? 'PROTECTED_OUTPUT' : 'NON_UTF8_OUTPUT',
          diagnostic, receipt: error.receipt })); // before asserting: no lost failure code
        // Permission denial and the observed native sharing denial are
        // distinct. UNKNOWN/other errors still FAIL; never retry an alias.
        const aliasUnavailable = script === 'alias.cjs' && error.receipt.exitCode === 1;
        const sharingDenial = aliasUnavailable && diagnostic?.code === 'EBUSY' && diagnostic?.errno === -4082;
        if (aliasUnavailable) {
          assert.ok(['EPERM', 'EACCES'].includes(diagnostic?.code) || sharingDenial);
          assert.equal(error.receipt.securityFailure, null);
        } else { assert.equal(error.receipt.exitCode, 70); assert.equal(error.receipt.securityFailure, 'DRAFT'); }
        assert.equal(error.receipt.tokenVerified, true); assert.equal(error.receipt.targetStarted, true);
        assert.equal(error.receipt.jobEmptyVerified, true); assert.equal(error.receipt.cleanup, 'PASS');
        assert.deepEqual(error.receipt.draft, edit.details.receipt.draft);
        console.log(JSON.stringify({ control: script === 'alias.cjs' ? 'ALIAS_OUTPUT' : script === 'protected.cjs' ? 'PROTECTED_OUTPUT' : 'NON_UTF8_OUTPUT',
          rejection: sharingDenial ? 'ACTUAL_SHARING_DENIAL_NOT_ACL_PROOF' : aliasUnavailable ? 'ACTUAL_KERNEL_DENIAL' : 'ANCHORED_READBACK_DENIAL',
          ordinaryHostLinkSucceeded: true, receipt: error.receipt })); return true;
      });
    }
    const read = await executeBrokeredSafeExec({ program: 'node', args: ['read.cjs'] }, attempt.ctx);
    assert.equal(JSON.parse(read.content[0].text).persisted, true);
    assert.equal(windowsRecoveryStatus().status, 'PASS');
  } finally { attempt?.close(); item.cleanup(); }
});
