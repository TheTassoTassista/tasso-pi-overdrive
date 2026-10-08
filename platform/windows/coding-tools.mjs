import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ownedWindowsHelper } from './process.mjs';
import { runWindowsSecureBroker, windowsNodeToolArguments, validateWindowsBrokerRequest } from './secure-broker.mjs';
import { admitWindowsWorkerTool } from '../../lib/phi-worker-authority.mjs';
import { draftContentDigest } from '../../lib/phi-worker-draft.mjs';

const fail = (code) => { const error = new Error(code); error.code = code; throw error; };
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const shape = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const safeEntry = (name) => typeof name === 'string' && /^(?!-)[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:js|cjs|mjs)$/u.test(name) && !name.split('/').some((part) => ['.', '..'].includes(part));

// Code-owned subset, never a caller-selected profile/executable/environment.
// B1 intentionally has NO EDIT authority, even for an interactive/Worker call.
export function windowsCodingIntent(program, args, operation) {
  if (program !== 'node' || !Array.isArray(args) || args.length > 128 || args.some((arg) => typeof arg !== 'string' || arg.includes('\0') || arg.length > 4096) || !['safe-exec', 'verification'].includes(operation)) fail('PHI_TOOL_COMMAND_UNREGISTERED');
  const syntax = args[0] === '--check' && args.length === 2;
  const script = syntax ? args[1] : args[0];
  if (!safeEntry(script)) fail('PHI_TOOL_COMMAND_UNREGISTERED');
  const role = operation === 'verification' || !syntax ? 'tester' : 'scout';
  const launch = windowsNodeToolArguments(script, syntax ? [] : args.slice(1));
  return Object.freeze({ role, profile: role === 'scout' ? 'READ_ONLY' : 'TEST',
    script, argv: Object.freeze(syntax ? [...launch.slice(0, 4), '--check', script] : [...launch]) });
}

export function readWindowsProjectSnapshot(root) {
  if (process.platform !== 'win32') fail('PHI_CODING_BACKEND_UNAVAILABLE');
  if (typeof root !== 'string' || root.includes('\0') || root.length > 1024) fail('PHI_PROJECT_SNAPSHOT_REJECTED');
  const run = spawnSync(ownedWindowsHelper(), ['--project-snapshot'], {
    shell: false, windowsHide: true, input: JSON.stringify({ root }) + '\n',
    encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024,
  });
  let value;
  try { value = JSON.parse(run.stdout); } catch { fail('PHI_PROJECT_SNAPSHOT_REJECTED'); }
  if (run.status !== 0 || run.error) fail('PHI_PROJECT_SNAPSHOT_REJECTED');
  return validateWindowsSnapshot(value);
}

export function validateWindowsSnapshot(value) {
  const identity = (id) => typeof id === 'string' && /^[0-9a-f]{16}:[0-9a-f]{32}$/u.test(id);
  if (!shape(value, ['version', 'rootIdentity', 'files', 'identities']) || value.version !== 1 || !identity(value.rootIdentity) ||
      !value.files || !value.identities || Array.isArray(value.files) || Array.isArray(value.identities) ||
      Object.keys(value.files).length !== Object.keys(value.identities).length ||
      Object.keys(value.files).some((file) => typeof value.files[file] !== 'string' || !Object.hasOwn(value.identities, file) || !identity(value.identities[file])) ||
      new Set(Object.values(value.identities)).size !== Object.keys(value.files).length) fail('PHI_PROJECT_SNAPSHOT_REJECTED');
  // Validate payload policy without executing anything, including on Linux.
  validateWindowsBrokerRequest({ version: 1, executable: { path: 'C:/Phi/snapshot-validation.exe', sha256: 'a'.repeat(64) }, argv: [], cwd: '.', environment: {},
    profile: 'TEST', grants: { workspace: value.files, assets: {} }, network: 'DENY', timeoutMs: 1, guardianPid: process.pid,
    context: { sessionId: 'a'.repeat(32), operation: 'verification', role: 'tester' } });
  return Object.freeze({ files: Object.freeze({ ...value.files }), rootIdentity: value.rootIdentity, identities: Object.freeze({ ...value.identities }),
    digest: hash(JSON.stringify({ root: value.rootIdentity, identities: value.identities, files: value.files })) });
}

export function codingFailureReason(receipt) {
  if (receipt.cleanup !== 'PASS') return 'RECOVERY_FAILED';
  if (receipt.securityFailure === 'CANCELLED') return 'CANCELLED';
  if (receipt.timedOut) return 'TIMEOUT';
  if (receipt.securityFailure !== null) return 'SECURITY_SETUP_FAILED';
  return receipt.exitCode === 0 ? null : 'PROCESS_EXITED_NONZERO';
}

export async function executeWindowsCodingTool(input, context) {
  if (process.platform !== 'win32') fail('PHI_CODING_BACKEND_UNAVAILABLE');
  if (!shape(input, ['program', 'args', 'cwd', 'timeoutMs']) || !context || Object.keys(context).some((key) => !['operation', 'sessionId', 'signal', 'snapshot', 'workerAuthority'].includes(key))) fail('PHI_TOOL_REQUEST_INVALID');
  const intent = windowsCodingIntent(input.program, input.args, context.operation);
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 120000 ||
      typeof input.cwd !== 'string') fail('PHI_TOOL_REQUEST_INVALID');
  const sessionId = context.sessionId?.replaceAll('-', '');
  if (!/^[0-9a-f]{32}$/u.test(sessionId ?? '')) fail('PHI_TOOL_SESSION_INVALID');
  if (context.signal?.aborted) fail('PHI_TOOL_CANCELLED');
  if (Object.hasOwn(context, 'workerAuthority') && context.snapshot) fail('PHI_TOOL_REQUEST_INVALID');
  const worker = Object.hasOwn(context, 'workerAuthority') ? admitWindowsWorkerTool(context.workerAuthority, {
    cwd: input.cwd, sessionId: context.sessionId, syntax: input.args[0] === '--check', signal: context.signal, operation: context.operation,
  }) : null;
  try {
  // Controller-only reuse: tools cannot submit grants/base data.
  const source = context.snapshot ?? readWindowsProjectSnapshot(input.cwd);
  if (worker && source.rootIdentity !== worker.expectedRootIdentity) fail('PHI_WORKER_WORKSPACE_CHANGED');
  const snapshot = worker ? worker.snapshot : source;
  if (worker && !snapshot) fail('PHI_WORKER_DRAFT_IDENTITY_INVALID');
  const result = await runSnapshot(input, context, intent, snapshot, worker);
  if (!worker) return result;
  const finished = worker.finish(result.draftSnapshot, result.code === 0);
  return { ...finishDraftResult(result, worker, finished), lspOnWritePaths: result.code === 0 && !finished.cancelled && worker.profile === 'EDIT'
    ? Object.keys(result.draftSnapshot.files).filter(file => file.endsWith('.json') && result.draftSnapshot.files[file] !== snapshot.files[file]) : [] };
  } finally { worker?.release(); }
}

async function runSnapshot(input, context, intent, snapshot, worker) {
  if (!Object.hasOwn(snapshot.files, intent.script)) fail('PHI_TOOL_ENTRY_MISSING');
  const request = { version: 1, executable: { path: process.execPath, sha256: hash(fs.readFileSync(process.execPath)) },
    argv: [...intent.argv], cwd: '.', environment: { CI: '1', NO_COLOR: '1' }, profile: worker?.profile ?? intent.profile,
    grants: { workspace: snapshot.files, assets: {} }, network: 'DENY', timeoutMs: worker ? Math.min(input.timeoutMs, worker.remainingMs) : input.timeoutMs, guardianPid: process.pid,
    context: { sessionId: context.sessionId.replaceAll('-', ''), operation: context.operation, role: worker?.role ?? intent.role },
    ...(worker ? { draft: worker.binding } : {}) };
  const result = await runWindowsSecureBroker(request, { signal: worker?.signal ?? context.signal });
  const failureReason = codingFailureReason(result.receipt);
  const draftSnapshot = worker && result.code === 0 ? validateWindowsSnapshot(result.draftSnapshot) : null;
  return { ...result, draftSnapshot, metadata: Object.freeze({ ...result.receipt, productionPath: context.operation === 'safe-exec' ? 'safe_exec' : 'verification',
    brokerHelperClosed: result.brokerHelperClosed === true, brokerPipesDrained: result.brokerPipesDrained === true,
    snapshotDigest: snapshot.digest, publicationState: failureReason === null ? 'VERIFIED' : result.receipt.cleanup === 'PASS' ? 'ROLLED_BACK' : 'FAILED', projectPublished: false,
    failureReason, ...(worker ? { workerAuthority: worker.metadata } : {}) }) };
}

function finishDraftResult(result, worker, finished) {
  return { ...result, code: finished.cancelled ? 125 : result.code, metadata: Object.freeze({ ...result.metadata,
    ...(finished.cancelled ? { nativeExitCode: result.code, exitCode: 125, failureReason: 'CANCELLED', publicationState: 'ROLLED_BACK' } : {}),
    draftBefore: worker.before, draft: finished.draft, jobEmptyVerified: result.jobEmptyVerified ?? null,
    publicationState: finished.cancelled || result.code !== 0 ? 'ROLLED_BACK' : finished.draft.state }) };
}

// No shell parser: only explicit registered single Node command forms.
export function windowsVerificationCommands(snapshot, mode = 'quick') {
  if (!['quick', 'full'].includes(mode)) fail('PHI_VERIFICATION_MODE_INVALID');
  let pkg;
  try { pkg = JSON.parse(snapshot.files['package.json'] ?? '{}'); } catch { fail('PHI_VERIFICATION_MANIFEST_INVALID'); }
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg) ||
      (pkg.scripts !== undefined && (!pkg.scripts || typeof pkg.scripts !== 'object' || Array.isArray(pkg.scripts)))) fail('PHI_VERIFICATION_MANIFEST_INVALID');
  const order = mode === 'full' ? ['typecheck', 'lint', 'format:check', 'test', 'test:unit', 'build', 'test:e2e'] : ['typecheck', 'lint', 'test'];
  const scripts = pkg.scripts ?? {};
  const checks = [];
  for (const name of order) {
    if (!Object.hasOwn(scripts, name)) continue;
    if (typeof scripts[name] !== 'string' || !/^node (?:--check )?[A-Za-z0-9_.\/-]+\.(?:cjs|mjs|js)$/u.test(scripts[name])) fail('PHI_VERIFICATION_COMMAND_UNREGISTERED');
    const args = scripts[name].slice(5).split(' ');
    windowsCodingIntent('node', args, 'verification');
    checks.push(Object.freeze({ name, program: 'node', args }));
  }
  return Object.freeze(checks);
}

export async function verifyWindowsProject(input) {
  if (!input || Object.keys(input).some(key => !['cwd', 'mode', 'listOnly', 'signal', 'timeoutMs', 'workerAuthority', 'sessionId'].includes(key))) fail('PHI_TOOL_REQUEST_INVALID');
  const { cwd, mode = 'quick', listOnly = false, signal, timeoutMs = 120000, workerAuthority, sessionId: workerSessionId } = input;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 || typeof listOnly !== 'boolean') fail('PHI_TOOL_REQUEST_INVALID');
  if (Object.hasOwn(input, 'workerAuthority')) return verifyWorkerDraft({ cwd, mode, listOnly, signal, timeoutMs, workerAuthority, sessionId: workerSessionId });
  if (workerSessionId !== undefined) fail('PHI_TOOL_SESSION_INVALID');
  const snapshot = readWindowsProjectSnapshot(cwd);
  const checks = windowsVerificationCommands(snapshot, mode);
  const sessionId = randomUUID();
  if (listOnly) return { status: 'LIST_ONLY', checks, sandboxed: false, executionPerformed: false, projectPublished: false };
  const results = [];
  for (const check of checks) {
    const run = await executeWindowsCodingTool({ program: check.program, args: check.args, cwd, timeoutMs },
      { operation: 'verification', sessionId, signal, snapshot });
    results.push({ name: check.name, status: run.code === 0 ? 'PASS' : 'FAIL', exitCode: run.code, sandboxed: true,
      output: run.stdout + run.stderr, receipt: run.metadata });
    if (run.code !== 0) break;
  }
  return { status: results.length === 0 ? 'NO_CHECKS' : results.length === checks.length && results.every((row) => row.status === 'PASS') ? 'PASS' : 'FAIL',
    platform: 'win32', backend: 'windows-lpac-broker', sandboxed: results.length > 0, projectPublished: false, results };
}

async function verifyWorkerDraft({ cwd, mode, listOnly, signal, timeoutMs, workerAuthority, sessionId }) {
  const worker = admitWindowsWorkerTool(workerAuthority, { cwd, sessionId, signal, operation: 'verification' });
  try {
    if (!worker.snapshot || readWindowsProjectSnapshot(cwd).rootIdentity !== worker.expectedRootIdentity) fail('PHI_WORKER_WORKSPACE_CHANGED');
    const snapshot = worker.snapshot, checks = windowsVerificationCommands(snapshot, mode), results = [];
    if (listOnly) return { status: 'LIST_ONLY', checks, sandboxed: false, executionPerformed: false, projectPublished: false, draft: worker.before };
    let last;
    for (const check of checks) {
      if (results.length) worker.nextCall();
      const run = await runSnapshot({ program: check.program, args: check.args, cwd, timeoutMs }, { operation: 'verification', sessionId, signal },
        windowsCodingIntent(check.program, check.args, 'verification'), snapshot, worker);
      // The TEST kernel denies writes; compare content anyway before any PASS.
      if (run.code === 0 && draftContentDigest(run.draftSnapshot.files) !== worker.binding.digest) fail('PHI_WORKER_DRAFT_IDENTITY_INVALID');
      last = run;
      results.push({ name: check.name, status: run.code === 0 ? 'PASS' : 'FAIL', exitCode: run.code, sandboxed: true,
        output: run.stdout + run.stderr, receipt: finishDraftResult(run, worker, { cancelled: false, draft: worker.before }).metadata });
      if (run.code !== 0) break;
    }
    let status = results.length === 0 ? 'NO_CHECKS' : results.length === checks.length && results.every(row => row.status === 'PASS') ? 'PASS' : 'FAIL';
    const finished = worker.finish(last?.draftSnapshot, status === 'PASS', status === 'PASS');
    if (finished.cancelled) status = 'FAIL';
    if (last) results.at(-1).receipt = finishDraftResult(last, worker, finished).metadata;
    return { status, platform: 'win32', backend: 'windows-lpac-broker', sandboxed: results.length > 0, projectPublished: false,
      draft: finished.draft, results };
  } catch(error) { worker.verificationFailed();throw error; }
  finally { worker.release(); }
}
