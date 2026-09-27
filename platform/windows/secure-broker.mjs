import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ownedWindowsHelper, WINDOWS_PROCESS_LIMITS } from './process.mjs';

// Controller interface, not a model-selected platform/readiness switch. These
// profiles do not grant paths from the host: they accept explicit snapshots.
export const WINDOWS_CAPABILITY_PROFILES = Object.freeze(Object.fromEntries(
  ['READ_ONLY', 'EDIT', 'TEST'].map((id) => [id, Object.freeze({
    id, workspace: id === 'EDIT' ? 'READ_WRITE' : 'READ_ONLY', assets: 'READ_ONLY',
    scratch: 'READ_WRITE', network: 'DENY', registry: 'registryRead',
    children: 'SAME_TOKEN_NON_BREAKAWAY_JOB_32', environment: 'ISOLATED_ALLOWLIST',
    cwd: 'SNAPSHOT_WORKSPACE_ONLY',
  })]),
));
const fail = (code) => { throw new Error(`PHI_WINDOWS_BROKER_${code}`); };
const object = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) fail('SHAPE_INVALID');
};
const string = (value) => typeof value === 'string' && !value.includes('\0');
const id = (value) => typeof value === 'string' && /^[0-9a-f]{32}$/u.test(value);
const relative = (value, root = false) => {
  if (!string(value) || value.length > 512) fail('PATH_INVALID');
  if (root && value === '.') return;
  const parts = value.split('/');
  if (parts.length > 12 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/u.test(part) || ['.', '..'].includes(part) || part.endsWith('.') || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)|^(?:\.git|\.env(?:\..*)?|\.ssh|\.aws|auth\.json|credentials(?:\.json)?|id_rsa|id_ed25519)$|\.(?:pem|p12|pfx|key)$/iu.test(part))) fail('PATH_INVALID');
};
const profileForRole = (role) => ({ worker: 'EDIT', tester: 'TEST', scout: 'READ_ONLY', reviewer: 'READ_ONLY' })[role];
export function validateWindowsBrokerRequest(request) {
  object(request, ['version', 'executable', 'argv', 'cwd', 'environment', 'profile', 'grants', 'network', 'timeoutMs', 'guardianPid', 'context']);
  object(request.executable, ['path', 'sha256']); object(request.context, ['sessionId', 'operation', 'role']); object(request.grants, ['workspace', 'assets']);
  if (request.version !== 1 || !id(request.context.sessionId) || !['safe-exec', 'verification'].includes(request.context.operation) || !Object.hasOwn(WINDOWS_CAPABILITY_PROFILES, request.profile) || request.profile !== profileForRole(request.context.role) || request.context.operation === 'verification' && request.context.role !== 'tester' || request.network !== 'DENY') fail('POLICY_INVALID');
  const executable = request.executable.path;
  if (!string(executable) || !/^[A-Za-z]:[\\/]/u.test(executable) || executable.slice(2).includes(':') || !executable.toLowerCase().endsWith('.exe') || /^(?:cmd|powershell|pwsh|wscript|cscript|mshta|rundll32|regsvr32)\.exe$/iu.test(path.win32.basename(executable)) || !/^[0-9a-f]{64}$/u.test(request.executable.sha256)) fail('EXECUTABLE_INVALID');
  if (!Array.isArray(request.argv) || request.argv.length > 128 || request.argv.some((arg) => !string(arg) || arg.length > 4096)) fail('ARGUMENT_INVALID');
  relative(request.cwd, true);
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > WINDOWS_PROCESS_LIMITS.lifetimeMs || !Number.isSafeInteger(request.guardianPid) || request.guardianPid < 1) fail('LIMIT_INVALID');
  if (!request.environment || Array.isArray(request.environment) || typeof request.environment !== 'object' || Object.entries(request.environment).some(([key, value]) => !['CI', 'NO_COLOR'].includes(key) || value !== '1')) fail('ENVIRONMENT_INVALID');
  let files = 0, bytes = 0;
  for (const space of ['workspace', 'assets']) {
    const grant = request.grants[space];
    if (!grant || Array.isArray(grant) || typeof grant !== 'object') fail('GRANT_INVALID');
    const seen = new Set();
    for (const [file, value] of Object.entries(grant)) {
      relative(file); if (!string(value) || seen.has(file.toLowerCase())) fail('GRANT_INVALID');
      seen.add(file.toLowerCase()); files++; bytes += Buffer.byteLength(value);
    }
  }
  if (files > 256 || bytes > 512 * 1024 || Buffer.byteLength(JSON.stringify(request)) > WINDOWS_PROCESS_LIMITS.inputBytes) fail('INPUT_LIMIT');
  return structuredClone(request);
}
export function validateWindowsBrokerReceipt(value) {
  object(value, ['version', 'platform', 'backend', 'profile', 'role', 'operation', 'sessionId', 'scopeId', 'tokenVerified', 'jobAttested', 'targetStarted', 'exitCode', 'timedOut', 'cleanup', 'securityFailure']);
  const interrupted = ['CANCELLED', 'SUPERVISOR'].includes(value.securityFailure);
  if (value.version !== 1 || value.platform !== 'win32' || value.backend !== 'windows-lpac-broker' || ![null, 'REQUEST', 'SCOPE', 'RUNTIME', 'GRANTS', 'LAUNCH', 'EXECUTION', 'CLEANUP', 'CANCELLED', 'SUPERVISOR'].includes(value.securityFailure) || !['PASS', 'FAIL'].includes(value.cleanup) || !Number.isInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255 || typeof value.timedOut !== 'boolean' || ['tokenVerified', 'jobAttested', 'targetStarted'].some((key) => typeof value[key] !== 'boolean' && !(interrupted && value[key] === null))) fail('RECEIPT_INVALID');
  if (value.scopeId !== null && !id(value.scopeId) || value.sessionId !== null && !id(value.sessionId) || value.profile !== null && !Object.hasOwn(WINDOWS_CAPABILITY_PROFILES, value.profile) || value.role !== null && !Object.hasOwn({ worker: 1, tester: 1, scout: 1, reviewer: 1 }, value.role) || value.operation !== null && !['safe-exec', 'verification'].includes(value.operation)) fail('RECEIPT_INVALID');
  if (value.securityFailure === null && (!value.tokenVerified || !value.jobAttested || !value.targetStarted || value.cleanup !== 'PASS' || value.scopeId === null || value.profile !== profileForRole(value.role)) || value.exitCode === 0 && value.securityFailure !== null || value.timedOut !== (value.exitCode === 124)) fail('RECEIPT_INVALID');
  return Object.freeze({ ...value });
}

export async function runWindowsSecureBroker(input, { signal, onAdmission } = {}) {
  if (process.platform !== 'win32') fail('PLATFORM_UNSUPPORTED');
  const request = validateWindowsBrokerRequest(input);
  if (request.guardianPid !== process.pid) fail('GUARDIAN_INVALID');
  if (signal?.aborted) fail('CANCELLED');
  const helper = ownedWindowsHelper();
  const child = spawn(helper, ['--lpac-broker'], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', total = 0, admission = null, cancelled = false, overflow = false, emergency = false;
  const kill = () => { if (child.pid) child.kill('SIGKILL'); };
  const cancel = () => { cancelled = true; kill(); };
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { emergency = true; kill(); }, request.timeoutMs + 20000);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    total += Buffer.byteLength(chunk);
    if (total > 4 * 1024 * 1024) { overflow = true; kill(); return; }
    stdout += chunk;
    if (!admission && stdout.includes('\n')) {
      try {
        const first = JSON.parse(stdout.slice(0, stdout.indexOf('\n')));
        if (Object.keys(first).length === 2 && first.kind === 'admitted' && id(first.scopeId)) { admission = first; onAdmission?.(Object.freeze({ ...first })); }
      } catch { /* final strict parsing rejects invalid controller output */ }
    }
  });
  // Native diagnostics never become tool results/receipts. Bounds still apply.
  child.stderr.on('data', (chunk) => { total += chunk.length; if (total > 4 * 1024 * 1024) { overflow = true; kill(); } });
  child.stdin.on('error', () => {}); child.stdin.end(`${JSON.stringify(request)}\n`);
  let status;
  try { status = await new Promise((resolve, reject) => { child.once('error', () => reject(new Error('PHI_WINDOWS_BROKER_SPAWN_FAILED'))); child.once('close', resolve); }); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  const recovery = () => {
    const result = spawnSync(helper, admission ? ['--recover-scope', admission.scopeId] : ['--recover-scopes'], { shell: false, windowsHide: true, encoding: 'utf8', timeout: 20000, maxBuffer: 8192 });
    try {
      const value = JSON.parse(result.stdout);
      return result.status === 0 && value.status === 'PASS' && value.quarantined === 0 && value.processKills === 0 && value.active === 0;
    } catch { return false; }
  };
  if (cancelled || emergency || overflow || status === null) {
    const cleaned = recovery();
    const receipt = validateWindowsBrokerReceipt({ version: 1, platform: 'win32', backend: 'windows-lpac-broker', profile: request.profile, ...request.context, scopeId: admission?.scopeId ?? null, tokenVerified: null, jobAttested: null, targetStarted: null, exitCode: cancelled ? 125 : 70, timedOut: false, cleanup: cleaned ? 'PASS' : 'FAIL', securityFailure: cancelled ? 'CANCELLED' : 'SUPERVISOR' });
    return { code: receipt.exitCode, stdout: '', stderr: '', receipt };
  }
  try {
    const records = stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    if (records.length !== (admission ? 2 : 1)) fail('PROTOCOL_INVALID');
    const result = records.at(-1); object(result, ['kind', 'stdoutBase64', 'stderrBase64', 'receipt']);
    if (result.kind !== 'result') fail('PROTOCOL_INVALID');
    const receipt = validateWindowsBrokerReceipt(result.receipt);
    if (status !== receipt.exitCode || receipt.scopeId !== (admission?.scopeId ?? null) || ['profile', 'role', 'operation', 'sessionId'].some((key) => receipt[key] !== (key === 'profile' ? request.profile : request.context[key]))) fail('PROTOCOL_INVALID');
    const decode = (value) => {
      if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) fail('PROTOCOL_INVALID');
      return Buffer.from(value, 'base64');
    };
    const output = decode(result.stdoutBase64), error = decode(result.stderrBase64);
    if (output.length + error.length > WINDOWS_PROCESS_LIMITS.outputBytes) fail('OUTPUT_LIMIT');
    return { code: receipt.exitCode, stdout: output.toString('utf8'), stderr: error.toString('utf8'), receipt };
  } catch { recovery(); fail('PROTOCOL_INVALID'); }
}
