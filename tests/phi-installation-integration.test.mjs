import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { bootstrapFoundation } from '../bootstrap/core.mjs';
import { createPhiBackup, restorePhiBackup } from '../lib/phi-backup.mjs';
import { readLocalJson, writeLocalJson } from '../platform/shared/filesystem.mjs';

const source = path.resolve(import.meta.dirname, '..');

test('isolated Phi foundation installs a working wrapper and reads a pinned Pi package without touching auth', { skip: process.platform !== 'linux' }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-install-integration-'));
  const agent = path.join(home, '.pi', 'agent');
  const configHome = path.join(home, '.config');
  const stateHome = path.join(home, '.local', 'state');
  const dirs = { bin: path.join(home, '.local', 'bin'), config: path.join(configHome, 'phi'),
    state: path.join(stateHome, 'phi'), agent, legacyConfig: path.join(configHome, 'pi-overdrive') };
  const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: stateHome };
  try {
    fs.mkdirSync(agent, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ packages: [source],
      defaultProvider: 'openai-codex', defaultModel: 'gpt-6-sol', defaultThinkingLevel: 'medium' }), { mode: 0o600 });
    fs.writeFileSync(path.join(agent, 'auth.json'), 'AUTH_SENTINEL', { mode: 0o600 });
    const first = await bootstrapFoundation({ dirs, env });
    const second = await bootstrapFoundation({ dirs, env });
    assert.equal(first.status, 'FOUNDATION_INSTALLED');
    assert.equal(second.status, 'FOUNDATION_INSTALLED');
    const launch = (args) => spawnSync(first.launcher, args, { env, encoding: 'utf8', timeout: 10_000 });
    const version = launch(['--version']);
    assert.equal(version.status, 0, version.stderr);
    assert.match(version.stdout, /Phi 1\.0\.0 \(Pi 0\.87\.1\)/u);
    const doctor = launch(['doctor', '--json']);
    assert.equal(doctor.status, 0, doctor.stderr);
    const report = JSON.parse(doctor.stdout);
    for (const capability of ['Pi runtime', 'Package configuration', 'GPT default', 'Sandbox']) {
      assert.equal(report.checks.find((item) => item.capability === capability)?.status, 'PASS', capability);
    }
    assert.equal(fs.readFileSync(path.join(agent, 'auth.json'), 'utf8'), 'AUTH_SENTINEL');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('backup restores selected preferences into a second isolated, executable Phi target', { skip: process.platform !== 'linux' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-restore-integration-'));
  const makeTarget = (name) => {
    const home = path.join(root, name);
    const agent = path.join(home, '.pi', 'agent');
    const configHome = path.join(home, '.config');
    const stateHome = path.join(home, '.local', 'state');
    const dirs = { bin: path.join(home, '.local', 'bin'), config: path.join(configHome, 'phi'),
      state: path.join(stateHome, 'phi'), agent, legacyConfig: path.join(configHome, 'pi-overdrive') };
    const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: stateHome };
    fs.mkdirSync(agent, { recursive: true, mode: 0o700 });
    writeLocalJson(path.join(agent, 'settings.json'), { packages: [source], defaultProvider: 'openai-codex', defaultModel: 'gpt-6-sol', defaultThinkingLevel: 'medium' });
    fs.writeFileSync(path.join(agent, 'auth.json'), `${name}_AUTH_SENTINEL`, { mode: 0o600 });
    return { dirs, env };
  };
  try {
    const first = makeTarget('first');
    const second = makeTarget('second');
    await bootstrapFoundation(first);
    await bootstrapFoundation(second);
    writeLocalJson(path.join(first.dirs.config, 'preferences.json'), { version: 1, theme: 'mono' });
    const backup = createPhiBackup(first.dirs);
    const payload = fs.readFileSync(backup.file, 'utf8');
    assert.doesNotMatch(payload, /AUTH_SENTINEL|model-callability|privateKey/u);
    assert.throws(() => restorePhiBackup(backup.file, { dirs: second.dirs, apply: true }), /model_callability_version/u);
    writeLocalJson(path.join(second.dirs.legacyConfig, 'model-callability.json'), { version: 1,
      entries: { 'openai-codex/gpt-6-sol': { runtimeStatus: 'RUNTIME_CALLABLE', reasonCode: 'LOCAL_FIXTURE_ONLY' } } });
    assert.equal(restorePhiBackup(backup.file, { dirs: second.dirs, apply: true }).status, 'PASS');
    assert.equal(readLocalJson(path.join(second.dirs.config, 'preferences.json')).theme, 'mono');
    assert.equal(fs.readFileSync(path.join(second.dirs.agent, 'auth.json'), 'utf8'), 'second_AUTH_SENTINEL');
    const version = spawnSync(path.join(second.dirs.bin, 'phi'), ['--version'], { env: second.env, encoding: 'utf8', timeout: 10_000 });
    assert.equal(version.status, 0, version.stderr);
    const doctor = spawnSync(path.join(second.dirs.bin, 'phi'), ['doctor', '--json'], { env: second.env, encoding: 'utf8', timeout: 10_000 });
    assert.equal(doctor.status, 0, doctor.stderr);
    assert.equal(JSON.parse(doctor.stdout).checks.find((item) => item.capability === 'Pi runtime')?.status, 'PASS');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
