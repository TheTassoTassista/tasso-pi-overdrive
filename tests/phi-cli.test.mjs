import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { phiDoctor } from '../lib/phi-doctor.mjs';
import { discoverPiRuntime } from '../lib/phi-runtime.mjs';

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
    assert.equal(report.checks.find((row) => row.capability === 'GPT default').detail, 'openai-codex/gpt-6-sol:medium');
    assert.equal(report.checks.find((row) => row.capability === 'Runtime callability').status, 'WARN');
    assert.equal(report.checks.find((row) => row.capability === 'Authentication').status, 'PASS');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
test('runtime discovery refuses unreviewed Pi versions and package traversal', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-runtime-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '0.99.0', bin: { pi: 'cli.mjs' } }));
    fs.writeFileSync(path.join(root, 'cli.mjs'), 'throw new Error("must not run");');
    assert.equal(discoverPiRuntime({ PHI_PI_ROOT: root }), null);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '0.87.1', bin: { pi: '../escape.mjs' } }));
    assert.equal(discoverPiRuntime({ PHI_PI_ROOT: root }), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
