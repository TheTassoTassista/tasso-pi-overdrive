import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { phiDoctor } from '../lib/phi-doctor.mjs';
import { discoverPiRuntime, bundledPiModel } from '../lib/phi-runtime.mjs';

const source = path.resolve(import.meta.dirname, '..');
const cli = path.join(source, 'bin', 'phi.mjs');
test('portable CLI exposes Phi help/version/splash without starting Pi or services', () => {
  for (const args of [['--version'], ['--help'], ['theme', 'list'], ['splash', '--theme', 'aurora']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '' } });
    assert.equal(result.status, 0, result.stderr); assert.doesNotMatch(result.stdout, /Pi Overdrive|\x1b/u);
  }
});
test('Doctor prints whitelisted state, never credentials/config values or model-call claims', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-doctor-'));
  try {
    const dirs = { agent: path.join(temp, 'agent'), config: path.join(temp, 'config'), state: path.join(temp, 'state'), legacyConfig: path.join(temp, 'legacy') };
    fs.mkdirSync(dirs.agent);
    fs.writeFileSync(path.join(dirs.agent, 'settings.json'), JSON.stringify({ packages: [source], defaultProvider: 'openai-codex', defaultModel: 'gpt-6-sol', defaultThinkingLevel: 'medium', secret: 'NEVER_EMIT_SENTINEL', apiKey: 'NEVER_EMIT_SENTINEL' }));
    fs.writeFileSync(path.join(dirs.agent, 'auth.json'), 'not-json-NEVER_EMIT_SENTINEL');
    const report = await phiDoctor({ dirs, probeServices: false });
    assert.equal(report.modelCalls, 0); assert.doesNotMatch(JSON.stringify(report), /NEVER_EMIT_SENTINEL|not-json/u);
    assert.equal(report.checks.find((row) => row.capability === 'Model default').detail, 'openai-codex/gpt-6-sol:medium');
    assert.equal(report.checks.find((row) => row.capability === 'Runtime callability').status, 'WARN');
    assert.equal(report.checks.find((row) => row.capability === 'Authentication').status, 'PASS');
    assert.equal(report.checks.find((row) => row.capability === 'OmniRoute').status, 'WARN');
    assert.match(report.checks.find((row) => row.capability === 'OmniRoute').detail, /authenticated HTTPS runtime not probed/u);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
test('runtime discovery refuses unreviewed Pi versions and package traversal', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-runtime-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '0.99.0', bin: { pi: 'cli.mjs' } }));
    fs.writeFileSync(path.join(root, 'cli.mjs'), 'throw new Error("must not run");');
    assert.equal(discoverPiRuntime({ PHI_PI_ROOT: root }), null);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.5.0', bin: { pi: '../escape.mjs' } }));
    assert.equal(discoverPiRuntime({ PHI_PI_ROOT: root }), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('bundled model lookup accepts nested and npm-hoisted pi-ai but rejects missing or mismatched packages', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-pi-catalog-layout-'));
  try {
    const root = path.join(temp, 'node_modules', '@earendil-works', 'pi-coding-agent');
    const nested = path.join(root, 'node_modules', '@earendil-works', 'pi-ai');
    const hoisted = path.join(root, '..', 'pi-ai');
    const env = { PHI_PI_ROOT: root };
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.5.0', bin: { pi: 'cli.mjs' } }));
    fs.writeFileSync(path.join(root, 'cli.mjs'), '');
    const writeCatalog = (directory, name = '@earendil-works/pi-ai', version = '1.5.0') => {
      fs.mkdirSync(path.join(directory, 'dist', 'providers', 'data'), { recursive: true });
      fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name, version }));
      fs.writeFileSync(path.join(directory, 'dist', 'providers', 'data', 'anthropic.json'), JSON.stringify({ api: { 'chat:fixture': { provider: 'anthropic', id: 'fixture', cost: { input: 1, output: 2 } } } }));
    };
    assert.equal(bundledPiModel('anthropic', 'fixture', env), null);
    writeCatalog(hoisted);
    assert.deepEqual(bundledPiModel('anthropic', 'fixture', env)?.cost, { input: 1, output: 2 });
    writeCatalog(nested);
    assert.deepEqual(bundledPiModel('anthropic', 'fixture', env)?.cost, { input: 1, output: 2 });
    fs.writeFileSync(path.join(nested, 'package.json'), JSON.stringify({ name: 'wrong-package', version: '1.5.0' }));
    assert.equal(bundledPiModel('anthropic', 'fixture', env), null);
    fs.rmSync(nested, { recursive: true });
    fs.writeFileSync(path.join(hoisted, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-ai', version: '0.87.1' }));
    assert.equal(bundledPiModel('anthropic', 'fixture', env), null);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('Doctor accepts a bundled non-Codex default without claiming authentication or live callability', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-anthropic-doctor-'));
  try {
    const dirs = { agent: path.join(temp, 'agent'), config: path.join(temp, 'config'), state: path.join(temp, 'state'), legacyConfig: path.join(temp, 'legacy') };
    fs.mkdirSync(dirs.agent);
    const file = path.join(dirs.agent, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ packages: [source], defaultProvider: 'anthropic', defaultModel: 'claude-opus-5', defaultThinkingLevel: 'medium' }), { mode: 0o600 });
    const report = await phiDoctor({ dirs, probeServices: false });
    assert.equal(report.checks.find((row) => row.capability === 'Model default').status, 'PASS');
    assert.equal(report.checks.find((row) => row.capability === 'Runtime callability').status, 'WARN');
    assert.equal(report.modelCalls, 0);
    fs.writeFileSync(file, JSON.stringify({ packages: [source], defaultProvider: 'anthropic', defaultModel: 'not-a-model', defaultThinkingLevel: 'medium' }), { mode: 0o600 });
    const rejected = await phiDoctor({ dirs, probeServices: false });
    assert.equal(rejected.checks.find((row) => row.capability === 'Model default').status, 'FAIL');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('candidate Phi RPC retains the selected default without silently falling back to an authenticated provider', { skip: !discoverPiRuntime() }, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-anthropic-rpc-'));
  try {
    const agent = path.join(temp, 'agent');
    fs.mkdirSync(agent, { mode: 0o700 });
    fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ packages: [source], defaultProvider: 'anthropic', defaultModel: 'claude-opus-5', defaultThinkingLevel: 'medium' }), { mode: 0o600 });
    const requests = [{ id: 'state', type: 'get_state' }, { id: 'models', type: 'get_available_models' },
      { id: 'select', type: 'set_model', provider: 'anthropic', modelId: 'claude-opus-5' }];
    for (const authenticated of [false, true]) {
      const result = spawnSync(process.execPath, [cli, '--offline', '--no-session', '--no-context-files', '--no-tools', '--mode', 'rpc'], {
        cwd: temp, encoding: 'utf8', timeout: 15000,
        input: `${requests.map((request) => JSON.stringify(request)).join('\n')}\n`,
        env: { PATH: process.env.PATH ?? '', HOME: temp, XDG_CONFIG_HOME: path.join(temp, 'config'), XDG_STATE_HOME: path.join(temp, 'state'), PI_CODING_AGENT_DIR: agent, PHI_PI_ROOT: discoverPiRuntime().root, ...(authenticated ? { ANTHROPIC_API_KEY: 'fixture-not-valid' } : {}) },
      });
      assert.equal(result.status, 0, result.stderr);
      const events = result.stdout.split(/\r?\n/u).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
      const state = events.find((event) => event.type === 'response' && event.id === 'state');
      const models = events.find((event) => event.type === 'response' && event.id === 'models');
      const select = events.find((event) => event.type === 'response' && event.id === 'select');
      assert.equal(state?.success, true);
      assert.equal(state.data?.model?.provider, 'anthropic');
      assert.equal(state.data?.model?.id, 'claude-opus-5');
      assert.equal(models?.data?.models?.some((model) => model.provider === 'anthropic' && model.id === 'claude-opus-5'), authenticated);
      assert.equal(select?.success, authenticated);
      assert.equal(events.filter((event) => ['agent_start', 'message_start', 'message_update', 'message_end'].includes(event.type)).length, 0);
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('Doctor never probes the obsolete unauthenticated OmniRoute backend port', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => { calls.push(String(url)); return { ok: false, body: { cancel: async () => {} } }; };
  try {
    const report = await phiDoctor({ probeServices: true });
    assert.equal(report.checks.find((row) => row.capability === 'OmniRoute').status, 'WARN');
    assert.ok(calls.every((url) => !url.includes(':20128') && !url.includes(':20129')));
  } finally { globalThis.fetch = original; }
});
