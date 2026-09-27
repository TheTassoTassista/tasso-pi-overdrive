import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateTaskPolicy } from './task-governor.mjs';
import { resolveToolPolicy, validateToolPolicy } from './tool-governor.mjs';
import { readWindowsProjectSnapshot } from '../platform/windows/coding-tools.mjs';
import { WorkerDraft } from './phi-worker-draft.mjs';

// Trusted controller state, not model input or an environment switch. Foreground
// Pi children share the parent process but reload extension modules. Keep one
// package-scoped registry across those reloads; async/external children cannot
// inherit this authority. Arbitrary host extensions are outside this boundary.
const key = Symbol.for('phi.worker-authority.v1:' + fileURLToPath(new URL('../', import.meta.url)));
if (!Object.hasOwn(process, key)) Object.defineProperty(process, key, { value: { records: new Map(), sessions: new Map(), tokens: new WeakMap() } });
const registry = process[key];
const fail = (code) => { throw new Error('PHI_WORKER_' + code); };
const digest = (value) => createHash('sha256').update(value).digest('hex');
const uuid = (value) => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value);
const identity = (cwd) => {
  const real = fs.realpathSync(cwd), stat = fs.lstatSync(real, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('WORKSPACE_INVALID');
  return { real, id: `${stat.dev}:${stat.ino}` };
};
const live = (record) => record && !record.revoked && Date.now() < record.expires;
const revokeRecord = (record) => {
  clearTimeout(record.timer); record.revoked = true; record.abort.abort();
  record.draft?.dispose(); // metadata remains, bounded payload is erased
  registry.records.delete(record.executionId);
  if (record.sessionId) registry.sessions.set(record.sessionId, null); // never downgrade to B1
};

// Called only by the real workflow controller before emitting its delegation.
// Approved task policy is immutable for the attempt; delegated task text only
// binds the child, and cannot request a stronger capability than that policy.
export function reserveWindowsWorker({ executionId, parentSessionId, cwd, task, taskPolicy }) {
  if (!uuid(executionId) || !uuid(parentSessionId) || typeof task !== 'string' || !task || task.length > 100000) fail('RESERVATION_INVALID');
  if (registry.records.has(executionId)) fail('RESERVATION_REPLAY');
  if ([...registry.records.values()].filter(live).length >= 3) fail('CONCURRENCY_LIMIT');
  const checkedTask = validateTaskPolicy(taskPolicy);
  const toolPolicy = validateToolPolicy(resolveToolPolicy({ taskPolicy: checkedTask, availableTools: ['read', 'transactional_edit', 'verification_gate', 'safe_exec'] }), checkedTask);
  const workspace = identity(cwd);
  const snapshot = process.platform === 'win32' ? readWindowsProjectSnapshot(workspace.real) : null;
  const nativeRootIdentity = snapshot?.rootIdentity ?? null;
  if (identity(cwd).id !== workspace.id) fail('WORKSPACE_CHANGED');
  // pi-subagents' foreground transport adds this exact code-owned envelope.
  // Never trim/normalize arbitrary prompts into an approved delegation.
  const record = { executionId, parentSessionId, workspace, taskDigest: digest(`Task: ${task}`), taskPolicy: checkedTask,
    toolPolicy, nativeRootIdentity, draft: snapshot ? new WorkerDraft(snapshot) : null,
    expires: Date.now() + 18 * 60 * 1000, calls: 0, busy: false, revoked: false, sessionId: null, abort: new AbortController() };
  registry.records.set(executionId, record);
  record.timer = setTimeout(() => revokeRecord(record), Math.max(1, record.expires - Date.now()));
  record.timer.unref();
  return Object.freeze({ revoke: () => revokeRecord(record), status: () => Object.freeze({ executionId, sessionId: record.sessionId,
    revoked: record.revoked, busy: Boolean(record.busy), draft: record.draft?.metadata ?? null }) });
}

export function bindWindowsWorker({ cwd, task, sessionId }) {
  if (!uuid(sessionId) || typeof task !== 'string') fail('BINDING_INVALID');
  const workspace = identity(cwd);
  const existing = registry.sessions.get(sessionId);
  if (registry.sessions.has(sessionId) && !existing) fail('AUTHORITY_UNAVAILABLE');
  if (existing) {
    if (!live(existing) || existing.workspace.real !== workspace.real || existing.workspace.id !== workspace.id) fail('BINDING_INVALID');
    return existing.token; // Follow-up turns never reclassify/escalate authority.
  }
  const matching = [...registry.records.values()].filter(record => live(record) && record.sessionId === null && record.parentSessionId !== sessionId &&
    record.workspace.real === workspace.real && record.workspace.id === workspace.id && record.taskDigest === digest(task));
  if (matching.length !== 1) fail('AUTHORITY_UNAVAILABLE');
  if (registry.sessions.size >= 1024) fail('SESSION_CAPACITY'); // bounded, no eviction that could permit a downgrade
  const record = matching[0]; record.sessionId = sessionId; record.token = Object.freeze({});
  registry.tokens.set(record.token, record); registry.sessions.set(sessionId, record);
  return record.token;
}

export function windowsWorkerAuthority(sessionId) {
  const record = registry.sessions.get(sessionId);
  if (registry.sessions.has(sessionId) && !live(record)) fail('AUTHORITY_UNAVAILABLE');
  if (!record) return undefined;
  return record.token;
}

export function admitWindowsWorkerTool(token, { cwd, sessionId, syntax, signal, operation = 'safe-exec' }) {
  const record = registry.tokens.get(token);
  if (!live(record) || record.sessionId !== sessionId || signal?.aborted) fail('AUTHORITY_UNAVAILABLE');
  const workspace = identity(cwd);
  if (workspace.real !== record.workspace.real || workspace.id !== record.workspace.id) fail('WORKSPACE_CHANGED');
  if (record.busy) fail('TOOL_ALREADY_RUNNING');
  if (record.calls >= 40) fail('TOOL_BUDGET_EXHAUSTED');
  if (!['safe-exec', 'verification'].includes(operation)) fail('CAPABILITY_DENIED');
  const capability = operation === 'verification' ? 'verify' : syntax ? 'read' : record.toolPolicy.capabilities.includes('edit') ? 'edit' : 'verify';
  const tool = capability === 'edit' ? 'transactional_edit' : capability === 'verify' ? 'verification_gate' : 'read';
  if (!record.toolPolicy.capabilities.includes(capability) || !record.toolPolicy.activeTools.includes(tool)) fail('CAPABILITY_DENIED');
  record.calls++; const lease = Symbol('worker-tool'); record.busy = lease;
  const binding = record.draft?.binding, before = record.draft?.metadata;
  let settled = false;
  return Object.freeze({ role: operation === 'verification' ? 'tester' : 'worker', profile: operation === 'verification' ? 'TEST' : syntax ? 'READ_ONLY' : capability === 'edit' ? 'EDIT' : 'TEST',
    snapshot: record.draft?.snapshot, binding, before,
    finish: (snapshot, success, verified = false) => {
      if (settled || record.busy !== lease) fail('DRAFT_IDENTITY_INVALID'); settled = true;
      if (!live(record) || signal?.aborted) return { cancelled: true, draft: record.draft?.metadata };
      const current = identity(cwd);
      if (current.real !== record.workspace.real || current.id !== record.workspace.id) fail('WORKSPACE_CHANGED');
      if (record.nativeRootIdentity && readWindowsProjectSnapshot(cwd).rootIdentity !== record.nativeRootIdentity) fail('WORKSPACE_CHANGED');
      return { cancelled: false, draft: record.draft?.settle(binding, snapshot, { success, edit: capability === 'edit', verified }) };
    },
    nextCall: () => { if (!live(record)) fail('AUTHORITY_UNAVAILABLE'); if (record.calls >= 40) fail('TOOL_BUDGET_EXHAUSTED'); record.calls++; },
    expectedRootIdentity: record.nativeRootIdentity,
    remainingMs: record.expires - Date.now(),
    signal: signal ? AbortSignal.any([signal, record.abort.signal]) : record.abort.signal,
    get metadata() { return Object.freeze({ authority: 'CONTROLLER_TASK_TOOL_GOVERNORS', executionId: record.executionId,
      taskPolicyDigest: record.taskPolicy.digest, toolPolicyDigest: record.toolPolicy.digest, toolCallNumber: record.calls,
      depth: 1, toolCallLimit: 40 }); },
    release: () => { if (record.busy === lease) record.busy = false; } });
}

// The actual Worker-only extension installs these hooks. No role is inferred
// from a prompt tag, tool field, environment variable or caller-selected profile.
export function registerWindowsWorkerBoundary(pi) {
  let sessionId;
  pi.on('before_agent_start', (event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId();
    bindWindowsWorker({ cwd: ctx.cwd, task: event.prompt, sessionId });
  });
  pi.on('tool_call', (event, ctx) => {
    const token = windowsWorkerAuthority(ctx.sessionManager.getSessionId());
    // Host write/edit/AST rewrite/removal and alternate command transports are
    // denied, even if the upstream Worker tool list exposes them. C/D pending.
    if (!token || !['safe_exec', 'verification_gate', 'read', 'grep', 'find', 'ls'].includes(event.toolName)) return { block: true, reason: 'PHI_WORKER_TOOL_DENIED' };
    return undefined;
  });
  pi.on('session_shutdown', () => {
    const record = registry.sessions.get(sessionId);
    if (record) revokeRecord(record);
  });
}
