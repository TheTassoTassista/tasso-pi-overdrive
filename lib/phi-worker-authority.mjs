import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateTaskPolicy } from './task-governor.mjs';
import { resolveToolPolicy, validateToolPolicy } from './tool-governor.mjs';
import { inspectWorkspacePath, isAlwaysProtectedWritePath } from './safety.mjs';
import { parseResourceUri } from './resource-fs.mjs';
import { requireBoundedWindowsPublication } from '../platform/shared/coding-execution.mjs';
import { readWindowsProjectSnapshot } from '../platform/windows/coding-tools.mjs';
import { WorkerDraft } from './phi-worker-draft.mjs';
import { publishWindowsSingleOperation } from '../platform/windows/publication.mjs';

// Trusted controller state, not model input or an environment switch. Foreground
// Pi children share the parent process but reload extension modules. Keep one
// package-scoped registry across those reloads; async/external children cannot
// inherit this authority. Arbitrary host extensions are outside this boundary.
const key = Symbol.for('phi.worker-authority.v1:' + fileURLToPath(new URL('../', import.meta.url)));
if (!Object.hasOwn(process, key)) Object.defineProperty(process, key, { value: { records: new Map(), sessions: new Map(), tokens: new WeakMap() } });
const registry = process[key];
const publicationGrants = new WeakMap();
const publicationEnvelopes = new WeakSet();
const fail = (code) => { throw new Error('PHI_WORKER_' + code); };
const digest = (value) => createHash('sha256').update(value).digest('hex');
const uuid = (value) => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value);
const identity = (cwd) => {
  const real = fs.realpathSync(cwd), stat = fs.lstatSync(real, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('WORKSPACE_INVALID');
  return { real, id: `${stat.dev}:${stat.ino}` };
};

// An intentionally narrow initial grammar: the current user task must name
// the one CREATE target. A model-rewritten task cannot expand this authority.
export function boundedCreateTaskTarget(task, trustedUserTask, taskPolicy) {
  if (typeof task !== 'string' || task !== trustedUserTask || !taskPolicy ||
      !validateTaskPolicy(taskPolicy).toolNeed.capabilities.includes('edit')) fail('PUBLICATION_ENVELOPE_DENIED');
  const match = /^Create file `([^`]{1,240})`(?: containing [^\r\n]{1,4000})?\.?$/u.exec(task);
  if (!match) fail('PUBLICATION_ENVELOPE_DENIED');
  const target = match[1];
  if (!/^(?!-)[A-Za-z0-9_.-]+(?:\/(?!-)[A-Za-z0-9_.-]+)*\.[A-Za-z0-9]{1,12}$/u.test(target) ||
      target.split('/').some(part => part === '.' || part === '..') || isAlwaysProtectedWritePath(target)) fail('PUBLICATION_ENVELOPE_DENIED');
  const resource = parseResourceUri(`repo://root/${target}`);
  if (resource.segments.join('/') !== target) fail('PUBLICATION_ENVELOPE_DENIED');
  return target;
}

const boundedPath = (value) => typeof value === 'string' &&
  /^(?!-)[A-Za-z0-9_.-]+(?:\/(?!-)[A-Za-z0-9_.-]+)*\.[A-Za-z0-9]{1,12}$/u.test(value) &&
  !value.split('/').some(part => part === '.' || part === '..') && !isAlwaysProtectedWritePath(value) &&
  parseResourceUri(`repo://root/${value}`).segments.join('/') === value;

// Only the exact latest direct-user task can establish an ordinary publication
// operation. Plans and Worker text remain proposed data, never this authority.
export function boundedTaskPublicationIntent(task, trustedUserTask, taskPolicy) {
  if (typeof task !== 'string' || task !== trustedUserTask || !taskPolicy ||
      !validateTaskPolicy(taskPolicy).toolNeed.capabilities.includes('edit')) fail('PUBLICATION_ENVELOPE_DENIED');
  const create = /^Create file `([^`]{1,240})`(?: containing [^\r\n]{1,4000})?\.?$/u.exec(task);
  const modify = /^Modify file `([^`]{1,240})` to contain [^\r\n]{1,4000}\.?$/u.exec(task);
  const deletion = /^Delete file `([^`]{1,240})`\.?$/u.exec(task);
  const rename = /^Rename file `([^`]{1,240})` to `([^`]{1,240})`\.?$/u.exec(task);
  const operation = create ? 'CREATE' : modify ? 'MODIFY' : deletion ? 'DELETE' : rename ? 'RENAME' : null;
  const target = (create ?? modify ?? deletion)?.[1] ?? rename?.[2];
  const source = rename?.[1] ?? null;
  if (!operation || !boundedPath(target) || source !== null && (!boundedPath(source) || source.toLowerCase() === target.toLowerCase() ||
      source.split('/').slice(0, -1).join('/').toLowerCase() !== target.split('/').slice(0, -1).join('/').toLowerCase()))
    fail('PUBLICATION_ENVELOPE_DENIED');
  return Object.freeze({ operation, target, source });
}

// Controller-only, pre-delegation authority. The native snapshot and path
// check are repeated later; this object cannot be synthesized by a Worker.
export function createWindowsPublicationEnvelope({ task, trustedUserTask, cwd, taskPolicy }) {
  const checked = validateTaskPolicy(taskPolicy);
  const { operation, target, source } = boundedTaskPublicationIntent(task, trustedUserTask, checked);
  requireBoundedWindowsPublication(operation);
  const workspace = identity(cwd);
  const inspected = inspectWorkspacePath(workspace.real, target, { mustExist: operation !== 'CREATE' && operation !== 'RENAME', forWrite: true });
  if (!inspected.allowed || inspected.exists !== (operation === 'MODIFY' || operation === 'DELETE') ||
      isAlwaysProtectedWritePath(inspected.canonical)) fail('PUBLICATION_ENVELOPE_DENIED');
  if (source !== null) {
    const origin = inspectWorkspacePath(workspace.real, source, { mustExist: true, forWrite: true });
    if (!origin.allowed || !origin.exists || isAlwaysProtectedWritePath(origin.canonical)) fail('PUBLICATION_ENVELOPE_DENIED');
  }
  const snapshot = readWindowsProjectSnapshot(workspace.real);
  const existing = source ?? target;
  if (Object.hasOwn(snapshot.files, target) !== (operation === 'MODIFY' || operation === 'DELETE') ||
      source !== null && !Object.hasOwn(snapshot.files, source) || identity(cwd).id !== workspace.id) fail('PUBLICATION_ENVELOPE_DENIED');
  const envelope = Object.freeze({ operation, target, source, expectedIdentity: snapshot.identities[existing] ?? null,
    expectedDigest: Object.hasOwn(snapshot.files, existing) ? digest(snapshot.files[existing]) : null,
    workspace: workspace.real, workspaceId: workspace.id, rootIdentity: snapshot.rootIdentity,
    taskDigest: digest(task), taskPolicyDigest: checked.digest });
  publicationEnvelopes.add(envelope);
  return envelope;
}

function boundedIntent(record, receipt) {
  const envelope = record.envelope;
  if (!envelope) return null;
  const operation = receipt?.operations?.[0];
  const kind = { CREATE: 'CREATE', MODIFY: 'REPLACE', DELETE: 'DELETE', RENAME: 'RENAME' }[envelope.operation];
  if (receipt?.operations?.length !== 1 || operation?.kind !== kind || operation.path !== envelope.target ||
      (envelope.source === null ? operation.sourcePath !== undefined : operation.sourcePath !== envelope.source) ||
      operation.baseIdentity !== envelope.expectedIdentity || operation.baseDigest !== envelope.expectedDigest ||
      (envelope.operation === 'DELETE' ? operation.newDigest !== null : !/^[0-9a-f]{64}$/u.test(operation.newDigest ?? '')) ||
      record.workspace.real !== envelope.workspace || record.workspace.id !== envelope.workspaceId ||
      record.nativeRootIdentity !== envelope.rootIdentity || record.taskPolicy.digest !== envelope.taskPolicyDigest)
    fail('PUBLISH_AUTHORITY_DENIED');
  const inspected = inspectWorkspacePath(record.workspace.real, envelope.target,
    { mustExist: envelope.operation === 'MODIFY' || envelope.operation === 'DELETE', forWrite: true });
  if (!inspected.allowed || inspected.exists !== (envelope.operation === 'MODIFY' || envelope.operation === 'DELETE') ||
      isAlwaysProtectedWritePath(inspected.canonical)) fail('PUBLISH_AUTHORITY_DENIED');
  if (envelope.source !== null) {
    const origin = inspectWorkspacePath(record.workspace.real, envelope.source, { mustExist: true, forWrite: true });
    if (!origin.allowed || !origin.exists || isAlwaysProtectedWritePath(origin.canonical)) fail('PUBLISH_AUTHORITY_DENIED');
  }
  return digest(JSON.stringify({ task: envelope.taskDigest, policy: envelope.taskPolicyDigest, root: envelope.rootIdentity,
    operation: envelope.operation, source: envelope.source, target: envelope.target, transaction: receipt.transactionId,
    expectedIdentity: envelope.expectedIdentity, expectedDigest: envelope.expectedDigest,
    base: receipt.baseDigest, draft: receipt.verifiedDigest, newDigest: operation.newDigest, newBytes: operation.newBytes }));
}
const live = (record) => record && !record.revoked && Date.now() < record.expires;
const workerLive = (record) => live(record) && !record.workerRevoked;
const revokeRecord = (record) => {
  clearTimeout(record.timer); record.revoked = true; record.workerRevoked = true; record.abort.abort();
  record.mixedHandoff = null;
  record.draft?.dispose(); // metadata remains, bounded payload is erased
  registry.records.delete(record.executionId);
  if (record.sessionId) registry.sessions.set(record.sessionId, null); // never downgrade to B1
};
const revokeWorker = (record) => {
  if (!live(record) || record.busy) { if (record && !record.revoked) revokeRecord(record); fail('AUTHORITY_UNAVAILABLE'); }
  if (record.workerRevoked) return;
  record.workerRevoked = true;
  record.abort.abort();
  if (record.sessionId) registry.sessions.set(record.sessionId, null); // revoked child cannot become B1
  if (!record.retainForController) revokeRecord(record);
};

// Called only by the real workflow controller before emitting its delegation.
// Approved task policy is immutable for the attempt; delegated task text only
// binds the child, and cannot request a stronger capability than that policy.
export function reserveWindowsWorker({ executionId, parentSessionId, cwd, task, taskPolicy, retainForController = false, publicationEnvelope = /** @type {ReturnType<typeof createWindowsPublicationEnvelope> | undefined} */ (undefined) }) {
  if (!uuid(executionId) || !uuid(parentSessionId) || typeof task !== 'string' || !task || task.length > 100000) fail('RESERVATION_INVALID');
  if (typeof retainForController !== 'boolean') fail('RESERVATION_INVALID');
  if (registry.records.has(executionId)) fail('RESERVATION_REPLAY');
  if ([...registry.records.values()].filter(live).length >= 3) fail('CONCURRENCY_LIMIT');
  const checkedTask = validateTaskPolicy(taskPolicy);
  const toolPolicy = validateToolPolicy(resolveToolPolicy({ taskPolicy: checkedTask, availableTools: ['read', 'transactional_edit', 'verification_gate', 'safe_exec', 'semantic_nav'] }), checkedTask);
  const workspace = identity(cwd);
  const snapshot = process.platform === 'win32' ? readWindowsProjectSnapshot(workspace.real) : null;
  const nativeRootIdentity = snapshot?.rootIdentity ?? null;
  if (publicationEnvelope !== undefined && (!retainForController || !publicationEnvelopes.has(publicationEnvelope) ||
      publicationEnvelope.workspace !== workspace.real || publicationEnvelope.workspaceId !== workspace.id ||
      publicationEnvelope.rootIdentity !== nativeRootIdentity || publicationEnvelope.taskPolicyDigest !== checkedTask.digest ||
      digest(task.split('\n', 1)[0]) !== publicationEnvelope.taskDigest)) fail('PUBLICATION_ENVELOPE_DENIED');
  if (identity(cwd).id !== workspace.id) fail('WORKSPACE_CHANGED');
  // pi-subagents' foreground transport adds this exact code-owned envelope.
  // Never trim/normalize arbitrary prompts into an approved delegation.
  const record = { executionId, parentSessionId, workspace, taskDigest: digest(`Task: ${task}`), taskPolicy: checkedTask,
    toolPolicy, nativeRootIdentity, draft: snapshot ? new WorkerDraft(snapshot) : null,
    expires: Date.now() + 18 * 60 * 1000, calls: 0, busy: false, mixedHandoff: null, revoked: false, workerRevoked: false,
    retainForController, envelope: publicationEnvelope ?? null, sessionId: null, abort: new AbortController() };
  registry.records.set(executionId, record);
  record.timer = setTimeout(() => revokeRecord(record), Math.max(1, record.expires - Date.now()));
  record.timer.unref();
  return Object.freeze({
    // The real controller holds this closure. Worker tokens/tools never do.
    // Explicit host-project approval is distinct from draft EDIT capability.
    preparePublication: approval => {
      if(!live(record)||record.busy||record.mixedHandoff||!record.sessionId||!record.draft)fail('AUTHORITY_UNAVAILABLE');
      if(record.retainForController&&!record.workerRevoked)fail('WORKER_NOT_REVOKED');
      if(!approval || typeof approval!=='object' || Array.isArray(approval) || Object.keys(approval).length!==(Object.hasOwn(approval,'rename')?2:1) ||
        !Object.hasOwn(approval,'approveProjectMutation') || approval.approveProjectMutation!==true ||
        (Object.hasOwn(approval,'rename') && approval.rename==null) ||
        !['edit','verify'].every(c=>record.toolPolicy.capabilities.includes(c)) || !record.toolPolicy.activeTools.includes('transactional_edit'))fail('PUBLISH_AUTHORITY_DENIED');
      const current=identity(record.workspace.real);
      if(current.id!==record.workspace.id)fail('WORKSPACE_CHANGED');
      if (record.envelope?.operation === 'RENAME' && (approval.rename?.sourcePath !== record.envelope.source ||
          approval.rename?.destinationPath !== record.envelope.target)) fail('PUBLISH_AUTHORITY_DENIED');
      if (record.envelope?.operation !== 'RENAME' && Object.hasOwn(approval,'rename')) fail('PUBLISH_AUTHORITY_DENIED');
      const receipt=record.draft.preparePublication(readWindowsProjectSnapshot(record.workspace.real),Object.hasOwn(approval,'rename')?approval.rename:null);
      if(receipt.state!=='READY_TO_PUBLISH')return Object.freeze({receipt,authority:null});
      const intentDigest=boundedIntent(record,receipt);
      // V5 transfers draft mutation authority exactly once. Native PREPARED
      // is the durable handoff before any host-project mutation; until then
      // the controller holds only this private, revocable in-memory grant.
      if(receipt.operations.length===4)record.mixedHandoff=Object.freeze({binding:record.draft.binding,transactionId:receipt.transactionId});
      const authority=Object.freeze({});publicationGrants.set(authority,{record,binding:record.draft.binding,transactionId:receipt.transactionId,intentDigest});
      return Object.freeze({receipt,authority,intentDigest});
    },
    // Ends only the child mutation phase. The controller-owned draft and
    // verification evidence remain private until publication or final revoke.
    finishWorker: () => {
      if (!record.retainForController || !record.sessionId || !live(record)) fail('AUTHORITY_UNAVAILABLE');
      revokeWorker(record);
      return record.draft.metadata;
    },
    publicationStatus: () => record.draft?.publicationMetadata??null,
    revoke: () => revokeRecord(record), status: () => Object.freeze({ executionId, sessionId: record.sessionId,
    revoked: record.revoked, workerRevoked: record.workerRevoked, busy: Boolean(record.busy), draft: record.draft?.metadata ?? null }) });
}

export function bindWindowsWorker({ cwd, task, sessionId }) {
  if (!uuid(sessionId) || typeof task !== 'string') fail('BINDING_INVALID');
  const workspace = identity(cwd);
  const existing = registry.sessions.get(sessionId);
  if (registry.sessions.has(sessionId) && !existing) fail('AUTHORITY_UNAVAILABLE');
  if (existing) {
    if (!workerLive(existing) || existing.workspace.real !== workspace.real || existing.workspace.id !== workspace.id) fail('BINDING_INVALID');
    return existing.token; // Follow-up turns never reclassify/escalate authority.
  }
  const matching = [...registry.records.values()].filter(record => workerLive(record) && record.sessionId === null && record.parentSessionId !== sessionId &&
    record.workspace.real === workspace.real && record.workspace.id === workspace.id && record.taskDigest === digest(task));
  if (matching.length !== 1) fail('AUTHORITY_UNAVAILABLE');
  if (registry.sessions.size >= 1024) fail('SESSION_CAPACITY'); // bounded, no eviction that could permit a downgrade
  const record = matching[0]; record.sessionId = sessionId; record.token = Object.freeze({});
  registry.tokens.set(record.token, record); registry.sessions.set(sessionId, record);
  return record.token;
}

export function windowsWorkerAuthority(sessionId) {
  const record = registry.sessions.get(sessionId);
  if (registry.sessions.has(sessionId) && !workerLive(record)) fail('AUTHORITY_UNAVAILABLE');
  if (!record) return undefined;
  return record.token;
}

export function admitWindowsWorkerTool(token, { cwd, sessionId, syntax, signal, operation = 'safe-exec' }) {
  const record = registry.tokens.get(token);
  if (!workerLive(record) || record.sessionId !== sessionId || signal?.aborted) fail('AUTHORITY_UNAVAILABLE');
  if (record.mixedHandoff) fail('PUBLISH_HANDOFF_CLOSED');
  if (record.draft?.publicationMetadata.projectPublished) fail('ATTEMPT_ALREADY_PUBLISHED');
  const workspace = identity(cwd);
  if (workspace.real !== record.workspace.real || workspace.id !== record.workspace.id) fail('WORKSPACE_CHANGED');
  if (record.busy) fail('TOOL_ALREADY_RUNNING');
  if (record.calls >= 40) fail('TOOL_BUDGET_EXHAUSTED');
  if (!['safe-exec', 'verification', 'lsp'].includes(operation)) fail('CAPABILITY_DENIED');
  const capability = operation === 'lsp' ? 'lsp' : operation === 'verification' ? 'verify' : syntax ? 'read' : record.toolPolicy.capabilities.includes('edit') ? 'edit' : 'verify';
  const tool = capability === 'lsp' ? 'semantic_nav' : capability === 'edit' ? 'transactional_edit' : capability === 'verify' ? 'verification_gate' : 'read';
  if (!record.toolPolicy.capabilities.includes(capability) || !record.toolPolicy.activeTools.includes(tool)) fail('CAPABILITY_DENIED');
  record.calls++; const lease = Symbol('worker-tool'); record.busy = lease;
  const binding = record.draft?.binding, before = record.draft?.metadata;
  let settled = false;
  return Object.freeze({ role: operation === 'verification' ? 'tester' : 'worker', profile: operation === 'lsp' ? 'LSP_READ_ONLY' : operation === 'verification' ? 'TEST' : syntax ? 'READ_ONLY' : capability === 'edit' ? 'EDIT' : 'TEST',
    snapshot: record.draft?.snapshot, binding, before,
    finish: (snapshot, success, verified = false) => {
      if (settled || record.busy !== lease) fail('DRAFT_IDENTITY_INVALID'); settled = true;
      if(verified && (operation!=='verification'||success!==true))fail('CAPABILITY_DENIED');
      if (!workerLive(record) || signal?.aborted) return { cancelled: true, draft: record.draft?.metadata };
      const current = identity(cwd);
      if (current.real !== record.workspace.real || current.id !== record.workspace.id) fail('WORKSPACE_CHANGED');
      if (record.nativeRootIdentity && readWindowsProjectSnapshot(cwd).rootIdentity !== record.nativeRootIdentity) fail('WORKSPACE_CHANGED');
      if(operation==='verification' && !success)record.draft?.invalidateVerification(binding);
      return { cancelled: false, draft: record.draft?.settle(binding, snapshot, { success, edit: capability === 'edit', verified }) };
    },
    recordLsp: (path, diagnostics, success) => {
      if(operation!=='lsp'||!settled||record.busy!==lease||!workerLive(record)||signal?.aborted)fail('CAPABILITY_DENIED');
      record.draft.recordLsp(binding,path,diagnostics,success);
    },
    recordLspFailure: path => {
      if(operation!=='lsp')fail('CAPABILITY_DENIED');
      if(record.busy===lease && workerLive(record) && !signal?.aborted && Object.hasOwn(record.draft?.snapshot.files??{},path))record.draft.recordLsp(binding,path,null,false);
    },
    verificationFailed: () => {
      if(operation!=='verification')fail('CAPABILITY_DENIED');
      if(record.busy===lease && workerLive(record) && !signal?.aborted)record.draft?.invalidateVerification(binding);
    },
    nextCall: () => { if (!workerLive(record)) fail('AUTHORITY_UNAVAILABLE'); if (record.calls >= 40) fail('TOOL_BUDGET_EXHAUSTED'); record.calls++; },
    expectedRootIdentity: record.nativeRootIdentity,
    remainingMs: record.expires - Date.now(),
    signal: signal ? AbortSignal.any([signal, record.abort.signal]) : record.abort.signal,
    get metadata() { return Object.freeze({ authority: 'CONTROLLER_TASK_TOOL_GOVERNORS', executionId: record.executionId,
      taskPolicyDigest: record.taskPolicy.digest, toolPolicyDigest: record.toolPolicy.digest, toolCallNumber: record.calls,
      depth: 1, toolCallLimit: 40 }); },
    release: () => { if (record.busy === lease) record.busy = false; } });
}

export function executePreparedWindowsPublication(authority) {
  const grant=publicationGrants.get(authority);
  if(!grant || !live(grant.record) || grant.record.busy || ['id','revision','digest'].some(k=>grant.binding[k]!==grant.record.draft.binding[k]) || grant.record.draft.publicationMetadata.state!=='READY_TO_PUBLISH' || grant.transactionId!==grant.record.draft.publicationMetadata.transactionId)fail('PUBLISH_AUTHORITY_DENIED');
  const record=grant.record, lease=Symbol('publication');
  if (record.envelope && grant.intentDigest !== boundedIntent(record,record.draft.publicationMetadata)) fail('PUBLISH_AUTHORITY_DENIED');
  if(record.retainForController&&!record.workerRevoked)fail('PUBLISH_AUTHORITY_DENIED');
  if(record.draft.publicationMetadata.operations.length===4 &&
    (!record.mixedHandoff || record.mixedHandoff.transactionId!==grant.transactionId ||
      ['id','revision','digest'].some(k=>record.mixedHandoff.binding[k]!==grant.binding[k])))fail('PUBLISH_AUTHORITY_DENIED');
  // Consume before any native attempt. No automatic replay, model-selected
  // runner, native profile or override can reuse this approval.
  publicationGrants.delete(authority);record.busy=lease;
  try {
    record.draft.beginPublication(grant.binding,grant.transactionId);
    const current=identity(record.workspace.real);if(current.id!==record.workspace.id)fail('WORKSPACE_CHANGED');
    const proof=publishWindowsSingleOperation({cwd:record.workspace.real,base:record.draft.publicationBase,snapshot:record.draft.snapshot,binding:grant.binding,
      metadata:record.draft.publicationMetadata,remainingMs:record.expires-Date.now()});
    if(!live(record))fail('AUTHORITY_UNAVAILABLE');
    return record.draft.completePublication(grant.binding,proof);
  } catch(error) {
    if(record.draft.publicationMetadata.state==='PUBLISHING')record.draft.failPublication(error.code==='PHI_PUBLICATION_CONFLICT',error.publicationEvidence??null);throw error;
  } finally { if(record.busy===lease)record.busy=false; }
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
    // denied, even if the upstream Worker tool list exposes them. Bounded C
    // diagnostics are available; D host publication is still unavailable.
    if (!token || !['safe_exec', 'verification_gate', 'semantic_nav', 'read', 'grep', 'find', 'ls'].includes(event.toolName)) return { block: true, reason: 'PHI_WORKER_TOOL_DENIED' };
    return undefined;
  });
  pi.on('session_shutdown', () => {
    const record = registry.sessions.get(sessionId);
    if (record) {
      if (record.retainForController) {
        try { revokeWorker(record); } catch { revokeRecord(record); }
      } else revokeRecord(record);
    }
  });
}
