import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

// Trusted launcher/verification ownership, NOT an agent execution capability.
// No use from safe_exec or autonomous roles until separate confinement is proven.
const root = path.resolve(import.meta.dirname, '../..');
const buildRoot = path.join(root, '.phi-cache', 'windows', 'process');
export const WINDOWS_PROCESS_LIMITS = Object.freeze({ lifetimeMs: 120000, outputBytes: 2 * 1024 * 1024, inputBytes: 1024 * 1024, processes: 32 });
const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export function ownedWindowsHelper() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('PHI_NATIVE_PROCESS_PLATFORM_UNSUPPORTED');
  for (const directory of [root, path.join(root, '.phi-cache'), path.join(root, '.phi-cache', 'windows'), buildRoot]) {
    const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error('PHI_NATIVE_PROCESS_BUILD_REQUIRED');
  }
  const binary = path.join(buildRoot, 'phi-owned-process.exe');
  const manifest = path.join(buildRoot, 'manifest.json');
  for (const file of [binary, manifest]) {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new Error('PHI_NATIVE_PROCESS_BUILD_REQUIRED');
  }
  const record = JSON.parse(fs.readFileSync(manifest, 'utf8').replace(/^\uFEFF/u, ''));
  if (record.brokerSourceSha256 !== digest(path.join(root, 'platform', 'windows', 'native', 'ExecutionBroker.cs'))) throw new Error('PHI_NATIVE_PROCESS_BUILD_INVALID');
  if (record.anchoredFileSourceSha256 !== digest(path.join(root, 'platform', 'windows', 'native', 'AnchoredFile.cs'))) throw new Error('PHI_NATIVE_PROCESS_BUILD_INVALID');
  if (record.recoverySourceSha256 !== digest(path.join(root, 'platform', 'windows', 'native', 'ScopeRecovery.cs')) || record.recoveryFilesystemSourceSha256 !== digest(path.join(root, 'platform', 'windows', 'native', 'RecoveryFilesystem.cs'))) throw new Error('PHI_NATIVE_PROCESS_BUILD_INVALID');
  if (record.schemaVersion !== 1 || record.abi !== 1 || record.sourceSha256 !== digest(path.join(root, 'platform', 'windows', 'native', 'OwnedProcess.cs')) || record.confinementSourceSha256 !== digest(path.join(root, 'platform', 'windows', 'native', 'AppContainerScope.cs')) || record.binarySha256 !== digest(binary)) throw new Error('PHI_NATIVE_PROCESS_BUILD_INVALID');
  return binary;
}
export function processBackendStatus() {
  try {
    ownedWindowsHelper();
    return { id: 'windows-job-object', available: true, scope: 'trusted non-interactive ownership; NOT a sandbox', evidence: 'local build hashes only; not ACL or live cleanup attestation' };
  } catch {
    return { id: 'windows-job-object', available: false, scope: 'trusted non-interactive ownership; NOT a sandbox', evidence: 'native tracked-source build required' };
  }
}
// Metadata-only Doctor adapter, never a cleanup or autonomous execution API.
export function parseWindowsRecoveryStatus(result) {
  const invalid = () => ({ status: 'FAIL', detail: 'native recovery status unavailable or invalid; no raw output published' });
  if (result?.error || ![0, 70].includes(result?.status) || typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > 8192) return invalid();
  let value;
  try { value = JSON.parse(result.stdout); } catch { return invalid(); }
  const fields = ['scope', 'scanned', 'active', 'stale', 'quarantined', 'processKills', 'cleanupPerformed', 'status'];
  if (!value || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some((key) => !Object.hasOwn(value, key))) return invalid();
  if (value.scope !== 'FIXED_NATIVE_SCOPES_ONLY' || value.processKills !== 0 || value.cleanupPerformed !== false || !['scanned', 'active', 'stale', 'quarantined'].every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 65)) return invalid();
  const clean = value.stale === 0 && value.quarantined === 0;
  if (value.status !== (clean ? 'PASS' : 'FAIL') || result.status !== (clean ? 0 : 70) || clean && value.active !== value.scanned) return invalid();
  return { status: clean ? 'PASS' : 'FAIL', detail: `fixed native scopes only; active=${value.active}, stale=${value.stale}, quarantined=${value.quarantined}; read-only, zero process kills` };
}
export function windowsRecoveryStatus() {
  let helper;
  try { helper = ownedWindowsHelper(); }
  catch { return { status: 'NOT AVAILABLE', detail: 'verified native helper build required; no recovery performed' }; }
  return parseWindowsRecoveryStatus(spawnSync(helper, ['--scope-recovery-status'], { shell: false, windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 8192 }));
}
export function windowsProcessRequest(command, args, { cwd = process.cwd(), env = process.env, timeoutMs = WINDOWS_PROCESS_LIMITS.lifetimeMs } = {}) {
  if (process.platform !== 'win32') throw new Error('PHI_NATIVE_PROCESS_PLATFORM_UNSUPPORTED');
  const string = (value) => typeof value === 'string' && !value.includes('\0');
  if (!string(command) || !path.win32.isAbsolute(command) || command.startsWith('\\\\') || !command.toLowerCase().endsWith('.exe') || !string(cwd) || !path.win32.isAbsolute(cwd) || cwd.startsWith('\\\\')) throw new Error('PHI_NATIVE_PROCESS_PATH_INVALID');
  if (!Array.isArray(args) || args.length > 256 || !args.every(string)) throw new Error('PHI_NATIVE_PROCESS_ARGUMENT_INVALID');
  const boundedTimeout = timeoutMs === 0 ? WINDOWS_PROCESS_LIMITS.lifetimeMs : timeoutMs;
  if (!Number.isSafeInteger(boundedTimeout) || boundedTimeout < 1 || boundedTimeout > WINDOWS_PROCESS_LIMITS.lifetimeMs) throw new Error('PHI_NATIVE_PROCESS_LIMIT_INVALID');
  if (!env || typeof env !== 'object' || Array.isArray(env) || Object.keys(env).length > 512) throw new Error('PHI_NATIVE_PROCESS_ENV_INVALID');
  const environment = Object.create(null), seen = new Set();
  for (const [key, value] of Object.entries(env)) {
    if (!string(key) || !key || key.includes('=') || !string(value) || seen.has(key.toLowerCase())) throw new Error('PHI_NATIVE_PROCESS_ENV_INVALID');
    seen.add(key.toLowerCase()); environment[key] = value;
  }
  const request = { command, args, cwd, env: environment, timeoutMs: boundedTimeout, guardianPid: process.pid };
  if (Buffer.byteLength(JSON.stringify(request)) > WINDOWS_PROCESS_LIMITS.inputBytes) throw new Error('PHI_NATIVE_PROCESS_REQUEST_LIMIT');
  return request;
}
export async function runOwnedEngine(command, args, { stdio = 'inherit', input = '', signal, ...options } = {}) {
  if (!['inherit', 'ignore'].includes(stdio) || typeof input !== 'string' || Buffer.byteLength(input) > WINDOWS_PROCESS_LIMITS.inputBytes) throw new Error('PHI_NATIVE_PROCESS_IO_INVALID');
  if (signal?.aborted) throw new Error('PHI_NATIVE_PROCESS_CANCELLED');
  const request = windowsProcessRequest(command, args, options);
  const child = spawn(ownedWindowsHelper(), [], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let cancelled = false, exceeded = false, emergencyTimeout = false, bytes = 0;
  const terminate = () => { if (child.pid) child.kill('SIGKILL'); };
  const cancel = () => { cancelled = true; terminate(); };
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { emergencyTimeout = true; terminate(); }, request.timeoutMs + 7000);
  const receive = (chunk, destination) => {
    bytes += chunk.length;
    if (bytes > WINDOWS_PROCESS_LIMITS.outputBytes) { exceeded = true; terminate(); return; }
    if (stdio === 'inherit') destination.write(chunk);
  };
  child.stdout.on('data', (chunk) => receive(chunk, process.stdout));
  child.stderr.on('data', (chunk) => receive(chunk, process.stderr));
  // Requests travel only in the pipe; never a file, environment or command line.
  child.stdin.on('error', () => {});
  child.stdin.end(`${JSON.stringify(request)}\n${input}`);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', () => reject(new Error('PHI_NATIVE_PROCESS_SPAWN_FAILED')));
      child.once('close', (status) => resolve(status ?? 1));
    });
    if (cancelled) throw new Error('PHI_NATIVE_PROCESS_CANCELLED');
    if (exceeded) throw new Error('PHI_NATIVE_PROCESS_OUTPUT_LIMIT');
    if (emergencyTimeout) return 124;
    return code;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}
