import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ownedWindowsHelper } from './process.mjs';
import { runWindowsSecureBroker, windowsNodeToolArguments, validateWindowsBrokerRequest } from './secure-broker.mjs';

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
  const identity = (id) => typeof id === 'string' && /^[0-9a-f]{16}:[0-9a-f]{32}$/u.test(id);
  if (run.status !== 0 || run.error || !shape(value, ['version', 'rootIdentity', 'files', 'identities']) || value.version !== 1 || !identity(value.rootIdentity) ||
      !value.files || !value.identities || Array.isArray(value.files) || Array.isArray(value.identities) ||
      Object.keys(value.files).length !== Object.keys(value.identities).length ||
      Object.keys(value.files).some((file) => typeof value.files[file] !== 'string' || !identity(value.identities[file]))) fail('PHI_PROJECT_SNAPSHOT_REJECTED');
  validateWindowsBrokerRequest({ version: 1, executable: { path: process.execPath, sha256: 'a'.repeat(64) }, argv: [], cwd: '.', environment: {},
    profile: 'TEST', grants: { workspace: value.files, assets: {} }, network: 'DENY', timeoutMs: 1, guardianPid: process.pid,
    context: { sessionId: 'a'.repeat(32), operation: 'verification', role: 'tester' } });
  return Object.freeze({ files: Object.freeze(value.files), rootIdentity: value.rootIdentity, identities: Object.freeze(value.identities),
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
  if (!shape(input, ['program', 'args', 'cwd', 'timeoutMs']) || !context || Object.keys(context).some((key) => !['operation', 'sessionId', 'signal', 'snapshot'].includes(key))) fail('PHI_TOOL_REQUEST_INVALID');
  const intent = windowsCodingIntent(input.program, input.args, context.operation);
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 120000 ||
      typeof input.cwd !== 'string') fail('PHI_TOOL_REQUEST_INVALID');
  const sessionId = context.sessionId?.replaceAll('-', '');
  if (!/^[0-9a-f]{32}$/u.test(sessionId ?? '')) fail('PHI_TOOL_SESSION_INVALID');
  if (context.signal?.aborted) fail('PHI_TOOL_CANCELLED');
  // Controller-only reuse: tools cannot submit grants/base data.
  const snapshot = context.snapshot ?? readWindowsProjectSnapshot(input.cwd);
  if (!Object.hasOwn(snapshot.files, intent.script)) fail('PHI_TOOL_ENTRY_MISSING');
  const request = { version: 1, executable: { path: process.execPath, sha256: hash(fs.readFileSync(process.execPath)) },
    argv: [...intent.argv], cwd: '.', environment: { CI: '1', NO_COLOR: '1' }, profile: intent.profile,
    grants: { workspace: snapshot.files, assets: {} }, network: 'DENY', timeoutMs: input.timeoutMs, guardianPid: process.pid,
    context: { sessionId, operation: context.operation, role: intent.role } };
  const result = await runWindowsSecureBroker(request, { signal: context.signal });
  const failureReason = codingFailureReason(result.receipt);
  return { ...result, metadata: Object.freeze({ ...result.receipt, productionPath: context.operation === 'safe-exec' ? 'safe_exec' : 'verification',
    snapshotDigest: snapshot.digest, publicationState: failureReason === null ? 'VERIFIED' : result.receipt.cleanup === 'PASS' ? 'ROLLED_BACK' : 'FAILED', projectPublished: false,
    failureReason }) };
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

export async function verifyWindowsProject({ cwd, mode = 'quick', listOnly = false, signal, timeoutMs = 120000 }) {
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
