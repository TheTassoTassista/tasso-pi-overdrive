import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ownedWindowsHelper, WINDOWS_PROCESS_LIMITS } from './process.mjs';

// Controller interface, not a model-selected platform/readiness switch. These
// profiles do not grant paths from the host: they accept explicit snapshots.
export const WINDOWS_CAPABILITY_PROFILES = Object.freeze(Object.fromEntries(
  ['READ_ONLY', 'EDIT', 'TEST', 'LSP_READ_ONLY'].map((id) => [id, Object.freeze({
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
const relative = (value, root = false, scoped = false) => {
  if (!string(value) || value.length > 512) fail('PATH_INVALID');
  if (root && value === '.') return;
  const parts = value.split('/');
  if (parts.length > 12 || parts.some((part) => !(scoped ? /^@?[A-Za-z0-9_.-]+$/u : /^[A-Za-z0-9_.-]+$/u).test(part) || ['.', '..'].includes(part) || part.endsWith('.') || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)|^(?:\.git|\.env(?:\..*)?|\.ssh|\.aws|auth\.json|credentials(?:\.json)?|id_rsa|id_ed25519)$|\.(?:pem|p12|pfx|key)$/iu.test(part))) fail('PATH_INVALID');
};
const profileForRole = (role) => ({ worker: 'EDIT', tester: 'TEST', scout: 'READ_ONLY', reviewer: 'READ_ONLY' })[role];
const profileAllowed = (role, profile) => role === 'worker' ? ['READ_ONLY', 'TEST', 'EDIT', 'LSP_READ_ONLY'].includes(profile) : profile === profileForRole(role);
// Node's default realpath loader lstat()s ungranted host ancestors. Preserve
// the already-controlled snapshot path instead; the kernel LPAC boundary, not
// Node canonicalization, remains the security authority. No ancestor ACL grant.
export function windowsNodeToolArguments(script, args = []) {
  relative(script);
  if (script.startsWith('-') || !/\.(?:cjs|mjs|js)$/u.test(script) || !Array.isArray(args) || args.some((arg) => !string(arg))) fail('NODE_ENTRY_INVALID');
  return Object.freeze(['--no-addons', '--no-global-search-paths', '--preserve-symlinks-main', '--preserve-symlinks', script, ...args]);
}
export function validateWindowsBrokerRequest(request) {
  object(request, ['version', 'executable', 'argv', 'cwd', 'environment', 'profile', 'grants', 'network', 'timeoutMs', 'guardianPid', 'context', ...(Object.hasOwn(request ?? {}, 'draft') ? ['draft'] : []), ...(Object.hasOwn(request ?? {}, 'lsp') ? ['lsp'] : [])]);
  object(request.executable, ['path', 'sha256']); object(request.context, ['sessionId', 'operation', 'role']); object(request.grants, ['workspace', 'assets']);
  if (request.version !== 1 || !id(request.context.sessionId) || !['safe-exec', 'verification', 'lsp'].includes(request.context.operation) || !Object.hasOwn(WINDOWS_CAPABILITY_PROFILES, request.profile) || !profileAllowed(request.context.role, request.profile) || request.context.operation === 'verification' && request.context.role !== 'tester' || request.network !== 'DENY') fail('POLICY_INVALID');
  const lsp = Object.hasOwn(request, 'lsp');
  if (lsp !== (request.context.operation === 'lsp') || lsp !== (request.profile === 'LSP_READ_ONLY')) fail('POLICY_INVALID');
  if (lsp) {
    object(request.lsp, ['path', 'onWrite']); relative(request.lsp.path);
    if (!request.lsp.path.endsWith('.json') || typeof request.lsp.onWrite !== 'boolean' || !Object.hasOwn(request, 'draft') || request.context.role !== 'worker' || !Object.hasOwn(request.grants.workspace, request.lsp.path)) fail('LSP_INVALID');
    const argv = ['--no-addons', '--no-global-search-paths', '--preserve-symlinks-main', '--preserve-symlinks', '../assets/node_modules/vscode-langservers-extracted/lib/json-language-server/node/jsonServerMain.js', '--stdio'];
    if (JSON.stringify(request.argv) !== JSON.stringify(argv) || request.cwd !== '.') fail('LSP_INVALID');
  }
  if (Object.hasOwn(request, 'draft')) {
    object(request.draft, ['id', 'revision', 'digest']);
    if (!id(request.draft.id) || !Number.isSafeInteger(request.draft.revision) || request.draft.revision < 0 || request.draft.revision > 40 || !/^[0-9a-f]{64}$/u.test(request.draft.digest) || !['worker', 'tester'].includes(request.context.role)) fail('DRAFT_INVALID');
  }
  const executable = request.executable.path;
  if (!string(executable) || !/^[A-Za-z]:[\\/]/u.test(executable) || executable.slice(2).includes(':') || !executable.toLowerCase().endsWith('.exe') || /^(?:cmd|powershell|pwsh|wscript|cscript|mshta|rundll32|regsvr32)\.exe$/iu.test(path.win32.basename(executable)) || !/^[0-9a-f]{64}$/u.test(request.executable.sha256)) fail('EXECUTABLE_INVALID');
  if (!Array.isArray(request.argv) || request.argv.length > 128 || request.argv.some((arg) => !string(arg) || arg.length > 4096)) fail('ARGUMENT_INVALID');
  relative(request.cwd, true);
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > WINDOWS_PROCESS_LIMITS.lifetimeMs || !Number.isSafeInteger(request.guardianPid) || request.guardianPid < 1) fail('LIMIT_INVALID');
  if (!request.environment || Array.isArray(request.environment) || typeof request.environment !== 'object' || Object.entries(request.environment).some(([key, value]) => !['CI', 'NO_COLOR'].includes(key) || value !== '1')) fail('ENVIRONMENT_INVALID');
  for (const space of ['workspace', 'assets']) {
    const grant = request.grants[space];
    if (!grant || Array.isArray(grant) || typeof grant !== 'object') fail('GRANT_INVALID');
    const seen = new Set(); let files = 0, bytes = 0;
    for (const [file, value] of Object.entries(grant)) {
      relative(file, false, lsp && space === 'assets'); if (!string(value) || seen.has(file.toLowerCase()) || lsp && space === 'assets' && (!file.startsWith('node_modules/') || !/\.(?:js|json)$/u.test(file))) fail('GRANT_INVALID');
      seen.add(file.toLowerCase()); files++; bytes += Buffer.byteLength(value);
    }
    if (files > (lsp && space === 'assets' ? 512 : 256) || bytes > (lsp && space === 'assets' ? 2 * 1024 * 1024 : 512 * 1024)) fail('INPUT_LIMIT');
  }
  if (!lsp && (Object.keys(request.grants.workspace).length + Object.keys(request.grants.assets).length > 256 || Object.values(request.grants.workspace).concat(Object.values(request.grants.assets)).reduce((n,x)=>n+Buffer.byteLength(x),0)>512*1024)) fail('INPUT_LIMIT');
  if (Buffer.byteLength(JSON.stringify(request)) > (lsp ? 4 * 1024 * 1024 : WINDOWS_PROCESS_LIMITS.inputBytes)) fail('INPUT_LIMIT');
  return structuredClone(request);
}
export function validateWindowsBrokerReceipt(value) {
  object(value, ['version', 'platform', 'backend', 'profile', 'role', 'operation', 'sessionId', 'scopeId', 'tokenVerified', 'jobAttested', 'targetStarted', 'exitCode', 'timedOut', 'cleanup', 'securityFailure']);
  const interrupted = ['CANCELLED', 'SUPERVISOR'].includes(value.securityFailure);
  if (value.version !== 1 || value.platform !== 'win32' || value.backend !== 'windows-lpac-broker' || ![null, 'REQUEST', 'SCOPE', 'RUNTIME', 'GRANTS', 'LAUNCH', 'EXECUTION', 'LSP', 'DRAFT', 'CLEANUP', 'CANCELLED', 'SUPERVISOR'].includes(value.securityFailure) || !['PASS', 'FAIL'].includes(value.cleanup) || !Number.isInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255 || typeof value.timedOut !== 'boolean' || ['tokenVerified', 'jobAttested', 'targetStarted'].some((key) => typeof value[key] !== 'boolean' && !(interrupted && value[key] === null))) fail('RECEIPT_INVALID');
  if (value.scopeId !== null && !id(value.scopeId) || value.sessionId !== null && !id(value.sessionId) || value.profile !== null && !Object.hasOwn(WINDOWS_CAPABILITY_PROFILES, value.profile) || value.role !== null && !Object.hasOwn({ worker: 1, tester: 1, scout: 1, reviewer: 1 }, value.role) || value.operation !== null && !['safe-exec', 'verification', 'lsp'].includes(value.operation)) fail('RECEIPT_INVALID');
  if (value.securityFailure === null && (!value.tokenVerified || !value.jobAttested || !value.targetStarted || value.cleanup !== 'PASS' || value.scopeId === null || !profileAllowed(value.role, value.profile)) || value.exitCode === 0 && value.securityFailure !== null || value.timedOut !== (value.exitCode === 124)) fail('RECEIPT_INVALID');
  return Object.freeze({ ...value });
}

// Only the trusted helper's separate stderr channel may supply this marker.
// Never parse untrusted target stderr (which is encoded in the result record).
export function nativeBrokerFailureMarker(text) {
  if (typeof text !== 'string' || text.length > 1024) return null;
  return text.split(/\r?\n/u).find(line => /^PHI_NATIVE_PROCESS_(?:FAILED:[0-9]{1,10}|INVALID_OR_CLEANUP_FAILED):(?:REQUEST|JOB|STDIO|ATTRIBUTES|CREATE|ATTEST|RESUME|CLEANUP)$/u.test(line)) ?? null;
}

export async function runWindowsSecureBroker(input, { signal, onAdmission, onTargetStarted } = {}) {
  if (process.platform !== 'win32') fail('PLATFORM_UNSUPPORTED');
  const request = validateWindowsBrokerRequest(input);
  if (request.guardianPid !== process.pid) fail('GUARDIAN_INVALID');
  if (signal?.aborted) fail('CANCELLED');
  const helper = ownedWindowsHelper();
  const child = spawn(helper, ['--lpac-broker'], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', total = 0, admission = null, started = null, cancelled = false, overflow = false, emergency = false;
  let nativeDiagnostics = '';
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
    if (request.lsp && !started && stdout.split('\n').length >= 3) {
      try {
        const value = JSON.parse(stdout.split('\n')[1]);
        object(value, ['kind','scopeId','childPid','childGeneration']);
        if (value.kind !== 'lsp-started' || value.scopeId !== admission?.scopeId || !Number.isSafeInteger(value.childPid) || value.childPid < 1 || !/^[0-9]+$/u.test(value.childGeneration)) fail('PROTOCOL_INVALID');
        started = value; onTargetStarted?.(Object.freeze({...value}));
      } catch { /* final strict parsing rejects invalid records */ }
    }
  });
  // Retain at most 1 KiB solely for fixed phase/code extraction; raw native
  // diagnostics never become tool output or receipts. Existing bound unchanged.
  child.stderr.on('data', (chunk) => { total += chunk.length; nativeDiagnostics += chunk.toString('utf8').slice(0, Math.max(0, 1025-nativeDiagnostics.length)); if (total > 4 * 1024 * 1024) { overflow = true; kill(); } });
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
    return { code: receipt.exitCode, stdout: '', stderr: '', receipt, nativeFailure: nativeBrokerFailureMarker(nativeDiagnostics) };
  }
  try {
    const records = stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    if (records.length !== (admission ? 2 : 1) + (started ? 1 : 0) || started && records[1].kind !== 'lsp-started') fail('PROTOCOL_INVALID');
    const result = records.at(-1); object(result, ['kind', 'stdoutBase64', 'stderrBase64', 'receipt', ...(request.draft ? ['draft'] : []), ...(request.lsp ? ['lsp'] : [])]);
    if (result.kind !== 'result') fail('PROTOCOL_INVALID');
    const receipt = validateWindowsBrokerReceipt(result.receipt);
    if (status !== receipt.exitCode || receipt.scopeId !== (admission?.scopeId ?? null) || ['profile', 'role', 'operation', 'sessionId'].some((key) => receipt[key] !== (key === 'profile' ? request.profile : request.context[key]))) fail('PROTOCOL_INVALID');
    const decode = (value) => {
      if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) fail('PROTOCOL_INVALID');
      return Buffer.from(value, 'base64');
    };
    const output = decode(result.stdoutBase64), error = decode(result.stderrBase64);
    if (output.length + error.length > WINDOWS_PROCESS_LIMITS.outputBytes) fail('OUTPUT_LIMIT');
    if (request.draft) {
      object(result.draft, ['id', 'revision', 'digest', 'snapshot', 'jobEmptyVerified']);
      if (['id', 'revision', 'digest'].some(key => result.draft[key] !== request.draft[key]) || receipt.exitCode === 0 && result.draft.snapshot === null || receipt.exitCode !== 0 && result.draft.snapshot !== null) fail('DRAFT_INVALID');
      if (typeof result.draft.jobEmptyVerified !== 'boolean' || receipt.exitCode === 0 && !result.draft.jobEmptyVerified) fail('DRAFT_INVALID');
    }
    if (request.lsp && (receipt.exitCode === 0 && (!result.lsp || result.lsp.path !== request.lsp.path || result.lsp.onWrite !== request.lsp.onWrite || result.lsp.initialized !== true || result.lsp.shutdown !== true || !Array.isArray(result.lsp.diagnostics)) || receipt.exitCode !== 0 && result.lsp !== null)) fail('LSP_INVALID');
    return { code: receipt.exitCode, stdout: output.toString('utf8'), stderr: error.toString('utf8'), receipt, nativeFailure: nativeBrokerFailureMarker(nativeDiagnostics), ...(request.draft ? { draftSnapshot: result.draft.snapshot, jobEmptyVerified: result.draft.jobEmptyVerified } : {}), ...(request.lsp ? { lspResult: result.lsp, ownedTarget: started } : {}) };
  } catch { recovery(); fail('PROTOCOL_INVALID'); }
}
