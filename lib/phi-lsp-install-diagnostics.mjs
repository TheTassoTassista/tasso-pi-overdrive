// INTERNAL_TRUSTED CI diagnostics only. NOT ordinary tracing, a receipt, an
// agent tool or a source of success/ownership authority. Never dump the env.
import fs from 'node:fs';
import path from 'node:path';

export function redactInstallText(value, env = {}) {
  let text = String(value ?? '');
  const secrets = Object.entries(env).filter(([key, val]) => /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_KEY|AUTH/iu.test(key) && typeof val === 'string' && val.length >= 3)
    .map(([, val]) => val).sort((a, b) => b.length - a.length);
  for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
  return text.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, '$1[REDACTED]@')
    .replace(/([?&](?:token|key|password|secret|auth)[^=\s]*=)[^&\s]+/giu, '$1[REDACTED]')
    .replace(/((?:authorization\s*[:=]\s*|\b)(?:bearer|basic)\s+)[A-Za-z0-9+/_.=-]+/giu, '$1[REDACTED]')
    .replace(/((?:_authToken|_auth|password|api[_-]?key)\s*[:=]\s*)[^\s]+/giu, '$1[REDACTED]');
}
function redactValue(value, env) {
  if (typeof value === 'string') return redactInstallText(value, env);
  if (Array.isArray(value)) return value.map(item => redactValue(item, env));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, env)]));
  return value;
}

// Inspect fixed clone-relative installation metadata, not project contents or
// unrelated machine paths. Missing/failed observations are never interpreted
// as absence of locks, network activity, or processes.
export function installFileInventory(cwd) {
  const base = path.join(cwd, 'runtime', 'lsp');
  const inspect = relative => {
    try {
      // lstat of the leaf alone would follow a linked ancestor.
      const components = ['runtime', 'lsp', ...relative.split('/')];
      let current = cwd;
      for (const component of components.slice(0, -1)) {
        current = path.join(current, component);
        if (fs.lstatSync(current).isSymbolicLink()) return { relative, exists: 'UNKNOWN', error: 'ANCESTOR_LINK_NOT_INSPECTED' };
      }
      const stat = fs.lstatSync(path.join(base, relative));
      return { relative, exists: true, type: stat.isSymbolicLink() ? 'LINK' : stat.isDirectory() ? 'DIRECTORY' : stat.isFile() ? 'FILE' : 'OTHER', size: stat.size, modifiedUtc: stat.mtime.toISOString() };
    } catch (error) { return { relative, exists: error.code === 'ENOENT' ? false : 'UNKNOWN', error: ['ENOENT', 'EACCES', 'EPERM', 'EBUSY'].includes(error.code) ? error.code : 'UNKNOWN' }; }
  };
  const fixed = ['package-lock.json', 'node_modules/.package-lock.json', 'node_modules/.staging', 'node_modules/.cache', 'node_modules/.bin'];
  const packages = ['@vtsls/language-server', 'bash-language-server', 'pyright', 'typescript', 'vscode-jsonrpc', 'vscode-langservers-extracted', 'yaml-language-server'];
  let entries;
  try {
    const nodeModules = inspect('node_modules');
    if (nodeModules.type !== 'DIRECTORY') entries = [{ exists: 'UNKNOWN', error: 'DIRECTORY_NOT_INSPECTED' }];
    else entries = fs.readdirSync(path.join(base, 'node_modules')).sort().slice(0, 128).map(name => inspect(`node_modules/${name}`));
  }
  catch (error) { entries = [{ exists: 'UNKNOWN', error: error.code === 'ENOENT' ? 'ENOENT' : 'UNKNOWN' }]; }
  return { fixed: fixed.map(inspect), packageManifests: packages.map(name => inspect(`node_modules/${name}/package.json`)), entries,
    limit: 128, lockOwnership: 'UNKNOWN_NOT_A_HANDLE_LOCK_CENSUS', fileContentsRead: false };
}

export function installDiagnostic({ command, args, cwd, env, startedUtc, endedUtc, elapsedMs, result }) {
  const stderr = result.stderr ?? '', marker = 'PHI_LSP_INSTALL_DIAGNOSTIC:';
  const lines = stderr.split(/\r?\n/u), nativeLines = lines.filter(line => line.startsWith(marker));
  let native = null, observationStatus = 'MISSING';
  if (nativeLines.length === 1) {
    try {
      const row = JSON.parse(nativeLines[0].slice(marker.length));
      if (row.version !== 1 || row.scope !== 'FIXED_TRUSTED_LSP_INSTALL_OBSERVATION_NOT_SANDBOX' || !Array.isArray(row.phases) || row.phases.length > 16 || !Array.isArray(row.snapshots) || row.snapshots.length > 8 || !Array.isArray(row.observedProcesses) || row.observedProcesses.length > 128) throw new Error();
      native = row; observationStatus = row.observerStopped === true ? 'CAPTURED' : 'INCOMPLETE';
    } catch { observationStatus = 'INVALID'; }
  }
  // This separate diagnostic log deliberately retains the actual trusted argv,
  // cwd and npm progress required to diagnose the stall. It is not committed
  // as a raw-output receipt. Secret-bearing values are scrubbed first.
  const max = 128 * 1024;
  const raw = { stdout: result.stdout ?? '', stderr: lines.filter(line => !line.startsWith(marker)).join('\n') };
  return redactValue({ version: 1, kind: 'PHI_TRUSTED_INSTALL_DIAGNOSTIC', startedUtc, endedUtc, elapsedMs,
    command, argv: args, cwd, timeoutMs: 120000, shell: false, exitCode: result.status ?? null, timedOut: result.error?.code === 'ETIMEDOUT',
    syntheticTimeoutExit: result.receipt?.timedOut === true, receipt: result.receipt ?? null,
    observationStatus, native, files: installFileInventory(cwd),
    stdout: raw.stdout.slice(0, max), stderr: raw.stderr.slice(0, max), outputTruncated: raw.stdout.length > max || raw.stderr.length > max,
    interpretation: 'Observations only; no root cause or PASS inferred from cache hits, missing files or sampled processes',
  }, env);
}
