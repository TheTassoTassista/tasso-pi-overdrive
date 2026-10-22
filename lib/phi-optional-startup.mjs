import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { readSecondBrainConfig } from './memory-config.mjs';

const ADMIN = new Set(['auth', 'install', 'remove', 'uninstall', 'update', 'list', 'config']);
const UNITS = ['pi-overdrive-embeddings.service', 'pi-overdrive-openviking.service', 'pi-overdrive-hindsight.service'];

// Pi 0.87.1 decides mode from its own parsed arguments and both TTYs. The
// caller supplies the parsed result from that pinned runtime, not a second
// hand-written CLI grammar.
export function entersInteractiveLinuxRepl(args, parsed, { platform = process.platform, stdinTTY = process.stdin.isTTY, stdoutTTY = process.stdout.isTTY } = {}) {
  return platform === 'linux' && stdinTTY === true && stdoutTTY === true &&
    !ADMIN.has(args[0]) && !parsed.diagnostics?.some((item) => item.type === 'error') &&
    !parsed.help && !parsed.version && !parsed.print && !parsed.export &&
    parsed.listModels === undefined && parsed.mode !== 'rpc' && parsed.mode !== 'json';
}

function trustedLocalFile(file, { privateFile = false } = {}) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink() && stat.uid === (process.getuid?.() ?? stat.uid) &&
      (stat.mode & (privateFile ? 0o077 : 0o022)) === 0;
  } catch { return false; }
}

function trustedAncestors(file) {
  if (process.platform !== 'linux' || !path.isAbsolute(file)) return false;
  let cursor = path.dirname(file);
  while (cursor !== path.dirname(cursor)) {
    try {
      const stat = fs.lstatSync(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink() || ![0, process.getuid()].includes(stat.uid) || (stat.mode & 0o022) !== 0) return false;
    } catch { return false; }
    cursor = path.dirname(cursor);
  }
  return true;
}

function runBounded(command, args, env, timeoutMs) {
  return spawnSync(command, args, {
    env, encoding: 'utf8', shell: false, timeout: timeoutMs, killSignal: 'SIGTERM',
    maxBuffer: 2048, windowsHide: true,
  });
}

function cleanEnvironment(environment) {
  const env = { ...environment };
  for (const key of Object.keys(env)) {
    if (key.startsWith('PI_OVERDRIVE_LAUNCHER_TEST_') || key === 'PI_OVERDRIVE_LAUNCHER_TEST_MODE' ||
      key.startsWith('PI_OVERDRIVE_TEST_') || key.startsWith('PI_OVERDRIVE_MEMORY_TEST_') || key === 'PI_OVERDRIVE_MEMORY_TEST_MODE') delete env[key];
    if (key.startsWith('LD_') || ['BASH_ENV', 'ENV', 'BASHOPTS', 'SHELLOPTS', 'CDPATH', 'GLOBIGNORE'].includes(key)) delete env[key];
  }
  env.PATH = '/usr/bin:/bin';
  env.PI_OVERDRIVE_MEMORY_WAIT_ATTEMPTS = '16';
  env.PI_OVERDRIVE_MEMORY_WAIT_INTERVAL = '0.1';
  return env;
}

function memoryEligibility(root, env) {
  let config;
  const configFile = path.join(root, 'config', 'second-brain.json');
  if (!trustedLocalFile(configFile) || !trustedAncestors(configFile)) return { status: 'SECURITY_MISMATCH', reason: 'configuration_identity' };
  try { config = readSecondBrainConfig({ file: configFile, environment: env }); }
  catch { return { status: 'UNAVAILABLE', reason: 'configuration' }; }
  // The existing manager starts all three fixed units together. Any explicit
  // partial disablement or endpoint override must not be silently undone.
  if (config.openViking.mode !== 'auto' || config.hindsight.mode !== 'auto' ||
    config.openViking.endpoint !== 'http://127.0.0.1:1933' ||
    config.hindsight.endpoint !== 'http://127.0.0.1:8889' ||
    config.localEmbeddings.endpoint !== 'http://127.0.0.1:1934') return { status: 'UNAVAILABLE', reason: 'disabled_or_custom' };
  const unitRoot = path.join(env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'systemd', 'user');
  for (const unit of UNITS) {
    const file = path.join(unitRoot, unit);
    if (!fs.existsSync(file)) return { status: 'UNAVAILABLE', reason: 'not_installed' };
    if (!trustedAncestors(file) || !trustedLocalFile(file, { privateFile: true })) return { status: 'SECURITY_MISMATCH', reason: 'unit_identity' };
  }
  const manager = path.join(root, 'scripts', 'pi-overdrive-memory-services.sh');
  if (!fs.existsSync(manager)) return { status: 'UNAVAILABLE', reason: 'manager_not_installed' };
  if (!trustedAncestors(manager) || !trustedLocalFile(manager)) return { status: 'SECURITY_MISMATCH', reason: 'manager_identity' };
  return { status: 'ELIGIBLE', manager };
}

export function prepareOptionalServices({ root, environment = process.env, run = runBounded, now = () => performance.now() } = {}) {
  const started = now();
  const env = cleanEnvironment(environment);
  const result = { searxng: 'DEFERRED_SECURITY_BOUNDARY', omniroute: 'UNAVAILABLE', secondBrain: 'UNAVAILABLE' };

  const policyFile = path.join(root, 'config', 'optional-services.json');
  if (!trustedLocalFile(policyFile) || !trustedAncestors(policyFile)) result.omniroute = 'SECURITY_MISMATCH';
  else {
    try {
      const policy = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
      if (policy.version !== 1 || !['auto', 'deferred'].includes(policy.omniroute) ||
        Object.keys(policy).some((key) => !['version', 'omniroute'].includes(key))) throw new Error('policy_invalid');
      if (policy.omniroute === 'deferred') result.omniroute = 'DEFERRED_FAIL_CLOSED';
      else {
        // The existing launcher owns the lock/PID protocol. Its OmniRoute-only
        // mode never reaches Docker, the dashboard or Pi itself.
        const omni = run(path.join(root, 'scripts', 'pi-launcher.sh'), ['--phi-prepare-omniroute'], env, 8_000);
        result.omniroute = omni.status === 0 ? 'READY' : omni.status === 3 ? 'SECURITY_MISMATCH' :
          omni.error?.code === 'ETIMEDOUT' ? 'TIMEOUT' : 'UNAVAILABLE';
      }
    } catch { result.omniroute = 'SECURITY_MISMATCH'; }
  }

  const memory = memoryEligibility(root, env);
  if (memory.status === 'ELIGIBLE') {
    const status = run(memory.manager, ['status'], env, 4_000);
    if (status.status === 0) result.secondBrain = 'READY';
    else {
      const start = run(memory.manager, ['start'], env, 8_000);
      result.secondBrain = start.status === 0 ? 'STARTED' : start.error?.code === 'ETIMEDOUT' ? 'TIMEOUT' : 'UNAVAILABLE';
    }
  } else result.secondBrain = memory.status;
  result.elapsedMs = Math.max(0, Math.round(now() - started));
  return result;
}
