import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { PRODUCT } from '../branding/terminal.mjs';
import { platformAdapter, localDirectories } from '../platform/index.mjs';
import { readLocalJson, inspectLocalPath } from '../platform/shared/filesystem.mjs';
import { readPhiConfig } from './phi-config.mjs';
import { discoverPiRuntime } from './phi-runtime.mjs';
import { processBackendStatus } from '../platform/shared/process.mjs';

export const PHI_SOURCE = path.resolve(import.meta.dirname, '..');
const safe = (value) => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/gu, '').slice(0, 200);
const MODEL_IDS = /^(?:gpt-[\w.-]+|auto\/[\w.-]+|(?:deepseek|groq|openrouter)\/[\w./-]+)$/u;
function commandVersion(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 2000, shell: false, windowsHide: true, maxBuffer: 4096 });
  return result.status === 0 ? safe(result.stdout.trim().split('\n')[0]) : null;
}
function health(url) {
  return fetch(url, { redirect: 'error', signal: AbortSignal.timeout(650) }).then((response) => { response.body?.cancel().catch(() => {}); return response.ok; }).catch(() => false);
}

export async function phiDoctor({ source = PHI_SOURCE, env = process.env, dirs = localDirectories({ env }), probeServices = true } = {}) {
  const rows = [];
  const add = (capability, status, detail) => rows.push({ capability, status, detail: safe(detail) });
  const adapter = platformAdapter();
  add('Phi source', 'PASS', source);
  add('Phi version', 'PASS', PRODUCT.version);
  add('Platform', 'PASS', `${os.platform()} / ${os.arch()}`);
  const [major, minor] = process.versions.node.split('.').map(Number);
  add('Node', major > 22 || major === 22 && minor >= 19 ? 'PASS' : 'FAIL', process.version);
  const npm = commandVersion(process.execPath, [path.resolve(path.dirname(process.execPath), adapter.id === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : '../lib/node_modules/npm/bin/npm-cli.js'), '--version']);
  add('npm', npm ? 'PASS' : 'FAIL', npm ?? 'not found beside Node');
  const git = commandVersion('git', ['--version']);
  add('Git', git ? 'PASS' : 'FAIL', git ?? 'not available');
  const gitState = spawnSync('git', ['-C', source, 'status', '--porcelain', '-z'], { encoding: 'utf8', shell: false, timeout: 2000, maxBuffer: 1024 * 1024 });
  add('Git state', gitState.status === 0 ? gitState.stdout ? 'WARN' : 'PASS' : 'WARN', gitState.status === 0 ? gitState.stdout ? 'local changes present (contents not printed)' : 'clean' : 'source not Git-tracked');
  const runtime = discoverPiRuntime(env);
  add('Pi runtime', runtime ? 'PASS' : 'FAIL', runtime ? runtime.version : `required pinned ${PRODUCT.piVersion}`);
  let settings;
  try {
    settings = readLocalJson(path.join(dirs.agent, 'settings.json'), {});
    const loaded = (settings.packages ?? []).some((item) => {
      const candidate = typeof item === 'string' ? item : item?.source;
      try { return typeof candidate === 'string' && fs.realpathSync(candidate) === fs.realpathSync(source); } catch { return false; }
    });
    add('Package configuration', loaded ? 'PASS' : 'FAIL', loaded ? 'Phi source registered in Pi settings' : 'bootstrap/migration required');
    const model = settings.defaultModel;
    const provider = settings.defaultProvider;
    const thinking = settings.defaultThinkingLevel;
    const valid = MODEL_IDS.test(model ?? '') && provider === 'openai-codex' && ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinking);
    add('GPT default', valid ? 'PASS' : 'FAIL', valid ? `${provider}/${model}:${thinking}` : 'missing or unrecognized subscription-backed default');
    add('Runtime callability', 'WARN', 'configuration is not live model evidence; no model calls made');
  } catch { add('Package configuration', 'FAIL', 'unreadable or unsafe local configuration (values suppressed)'); }
  try { add('Theme configuration', 'PASS', readPhiConfig(dirs).theme); } catch { add('Theme configuration', 'FAIL', 'unsafe or invalid preferences'); }
  try {
    const policy = readLocalJson(path.join(dirs.legacyConfig, 'model-policy.json'), null);
    add('Selected preset', policy && ['normal', 'token-saver', 'custom'].includes(policy.preset) ? 'PASS' : 'WARN', policy && ['normal', 'token-saver', 'custom'].includes(policy.preset) ? policy.preset : 'not initialized');
  } catch { add('Selected preset', 'FAIL', 'unsafe or invalid role policy (values suppressed)'); }
  for (const key of ['config', 'state']) {
    try {
      const result = inspectLocalPath(dirs[key], { directory: true });
      const stat = result.exists ? fs.lstatSync(dirs[key]) : null;
      const privateMode = adapter.id === 'win32' ? false : stat && (stat.mode & 0o077) === 0;
      add(`${key} directory`, result.exists ? privateMode ? 'PASS' : 'WARN' : 'WARN', result.exists ? adapter.id === 'win32' ? 'NTFS ACL attestation pending' : privateMode ? 'owner-only' : 'review permissions' : 'created only when needed');
    } catch { add(`${key} directory`, 'FAIL', 'unsafe directory'); }
  }
  add('Launcher', fs.existsSync(path.join(source, 'bin', 'phi.mjs')) ? 'PASS' : 'FAIL', 'portable Node entry point; installation checked by bootstrap');
  const processBackend = await processBackendStatus();
  add('Process backend', processBackend.available ? 'WARN' : 'NOT AVAILABLE', `${processBackend.id}; ${processBackend.evidence}; ${processBackend.scope}`);
  if (adapter.id === 'win32') {
    const { windowsRecoveryStatus } = await import('../platform/windows/process.mjs');
    const recovery = windowsRecoveryStatus();
    add('Windows scope recovery', recovery.status, recovery.detail);
  }
  const sandbox = adapter.sandbox;
  const bwrap = adapter.id === 'linux' ? commandVersion('/usr/bin/bwrap', ['--version']) : null;
  add('Sandbox', sandbox.autonomousReady && bwrap ? 'PASS' : 'FAIL', sandbox.autonomousReady && bwrap ? `${sandbox.id}; actual tool probes required for host parity` : 'native confinement not verified; engine launch blocked');
  add('LSP', fs.existsSync(path.join(source, 'runtime', 'lsp', 'node_modules', 'typescript', 'package.json')) ? 'PASS' : 'WARN', 'managed installation presence only; use semantic diagnostics for live evidence');
  add('Debugger', 'WARN', adapter.id === 'linux' ? 'host-specific reviewed GDB/debugpy identities; optional, lazy' : 'native DAP adapters not yet attested');
  add('Browser', 'WARN', adapter.id === 'linux' ? 'confined browser remains lazy; not launched by Doctor' : 'native confinement pending; unavailable');
  // The old OmniRoute HTTP port is not the authenticated HTTPS edge. A plain
  // loopback probe would misreport availability and bypass the intended gate.
  add('OmniRoute', 'WARN', 'authenticated HTTPS runtime not probed by Doctor; configured models are not callability evidence');
  const endpoints = [['SearXNG', 'http://127.0.0.1:8888/'], ['OpenViking', 'http://127.0.0.1:1933/health'], ['Hindsight', 'http://127.0.0.1:8889/health']];
  const healthResults = probeServices ? await Promise.all(endpoints.map(([, url]) => health(url))) : endpoints.map(() => false);
  endpoints.forEach(([name], index) => add(name, !probeServices ? 'NOT VERIFIED' : healthResults[index] ? 'PASS' : 'NOT AVAILABLE',
    !probeServices ? 'optional service health not probed' : healthResults[index] ? 'loopback HTTP healthy; no inference probe' : 'optional loopback health unavailable; inactive state not established'));
  add('Second Brain', 'WARN', 'local state preserved; backend health is not a retrieval test');
  add('Authentication', 'PASS', 'never opened, modified, printed or probed by Doctor');
  return { version: 1, product: PRODUCT.name, phiVersion: PRODUCT.version, platform: adapter.id, status: rows.some((row) => row.status === 'FAIL') ? 'FAIL' : rows.some((row) => row.status === 'WARN') ? 'WARN' : 'PASS', modelCalls: 0, checks: rows };
}

export function doctorStartupState(report) {
  const detail = (name) => report.checks.find((item) => item.capability === name);
  return { piVersion: detail('Pi runtime')?.status === 'PASS' ? detail('Pi runtime').detail : 'unavailable', preset: detail('Selected preset')?.status === 'PASS' ? detail('Selected preset').detail : 'not initialized', model: detail('GPT default')?.status === 'PASS' ? detail('GPT default').detail.replace('openai-codex/', '') : 'not configured', memory: 'lazy', omniroute: detail('OmniRoute')?.status === 'PASS' ? 'ready' : 'lazy', searxng: detail('SearXNG')?.status === 'PASS' ? 'ready' : 'lazy' };
}
