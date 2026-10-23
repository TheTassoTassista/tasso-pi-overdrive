import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { entersInteractiveLinuxRepl, prepareOptionalServices } from '../lib/phi-optional-startup.mjs';

const source = path.resolve(import.meta.dirname, '..');
const linuxTest = process.platform === 'linux' ? test : test.skip;

test('only Pi-parsed interactive Linux REPL reaches optional preparation', () => {
  const tty = { platform: 'linux', stdinTTY: true, stdoutTTY: true };
  const yes = { diagnostics: [], mode: undefined };
  assert.equal(entersInteractiveLinuxRepl([], yes, tty), true);
  assert.equal(entersInteractiveLinuxRepl(['--model', 'gpt-6-sol'], yes, tty), true);
  for (const command of ['auth', 'install', 'remove', 'uninstall', 'update', 'list', 'config']) {
    assert.equal(entersInteractiveLinuxRepl([command], yes, tty), false, command);
  }
  for (const parsed of [{ ...yes, print: true }, { ...yes, help: true }, { ...yes, version: true },
    { ...yes, export: 'file' }, { ...yes, mode: 'rpc' }, { ...yes, mode: 'json' },
    { ...yes, listModels: true }, { ...yes, diagnostics: [{ type: 'error' }] }]) {
    assert.equal(entersInteractiveLinuxRepl([], parsed, tty), false);
  }
  assert.equal(entersInteractiveLinuxRepl([], yes, { ...tty, stdinTTY: false }), false);
  assert.equal(entersInteractiveLinuxRepl([], yes, { ...tty, stdoutTTY: false }), false);
  assert.equal(entersInteractiveLinuxRepl([], yes, { ...tty, platform: 'win32' }), false);
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.homedir(), '.phi-optional-test-'));
  const unitRoot = path.join(root, 'config-home', 'systemd', 'user');
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(unitRoot, { recursive: true });
  fs.copyFileSync(path.join(source, 'config', 'second-brain.json'), path.join(root, 'config', 'second-brain.json'));
  fs.writeFileSync(path.join(root, 'config', 'optional-services.json'), JSON.stringify({ version: 1, omniroute: 'auto' }), { mode: 0o600 });
  const manager = path.join(root, 'scripts', 'pi-overdrive-memory-services.sh');
  fs.writeFileSync(manager, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  for (const unit of ['pi-overdrive-embeddings', 'pi-overdrive-openviking', 'pi-overdrive-hindsight']) {
    fs.writeFileSync(path.join(unitRoot, `${unit}.service`), '[Unit]\n', { mode: 0o600 });
  }
  return { root, unitRoot, manager, env: { ...process.env, XDG_CONFIG_HOME: path.join(root, 'config-home'), PI_OVERDRIVE_LAUNCHER_TEST_MODE: '1' } };
}

linuxTest('deferred or untrusted OmniRoute policy never launches gateway while memory remains independent', () => {
  const setup = fixture();
  try {
    const policy = path.join(setup.root, 'config', 'optional-services.json');
    const calls = [];
    const run = (_command, args) => { calls.push(args[0]); return { status: 0 }; };
    fs.writeFileSync(policy, JSON.stringify({ version: 1, omniroute: 'deferred' }));
    let result = prepareOptionalServices({ root: setup.root, environment: setup.env, run });
    assert.equal(result.omniroute, 'DEFERRED_FAIL_CLOSED');
    assert.equal(result.secondBrain, 'READY');
    assert.deepEqual(calls, ['status']);
    fs.chmodSync(policy, 0o666);
    result = prepareOptionalServices({ root: setup.root, environment: setup.env, run });
    assert.equal(result.omniroute, 'SECURITY_MISMATCH');
    assert.equal(result.secondBrain, 'READY');
    assert.deepEqual(calls, ['status', 'status']);
  } finally { fs.rmSync(setup.root, { recursive: true, force: true }); }
});

linuxTest('healthy optional services are reused; SearXNG never invokes Docker', () => {
  const setup = fixture();
  try {
    const calls = [];
    const run = (command, args, env, timeout) => {
      calls.push({ command, args, env, timeout });
      return { status: 0 };
    };
    const result = prepareOptionalServices({ root: setup.root, environment: setup.env, run, now: () => 10 });
    assert.deepEqual(result, { searxng: 'DEFERRED_SECURITY_BOUNDARY', omniroute: 'READY', secondBrain: 'READY', elapsedMs: 0 });
    assert.deepEqual(calls.map((call) => call.args), [['--phi-prepare-omniroute'], ['status']]);
    assert.ok(calls.every((call) => !/docker|sudo|browser/u.test(call.command)));
    assert.ok(calls.every((call) => !('PI_OVERDRIVE_LAUNCHER_TEST_MODE' in call.env)));
    assert.ok(calls.every((call) => call.timeout <= 8_000));
  } finally { fs.rmSync(setup.root, { recursive: true, force: true }); }
});

linuxTest('stopped memory uses existing manager start; ordinary failures stay fail-soft', () => {
  const setup = fixture();
  try {
    const calls = [];
    const run = (_command, args) => { calls.push(args[0]); return { status: args[0] === 'status' ? 1 : args[0] === 'start' ? 1 : 2 }; };
    const result = prepareOptionalServices({ root: setup.root, environment: setup.env, run });
    assert.deepEqual(calls, ['--phi-prepare-omniroute', 'status', 'start']);
    assert.equal(result.omniroute, 'UNAVAILABLE');
    assert.equal(result.secondBrain, 'UNAVAILABLE');
    assert.equal(result.searxng, 'DEFERRED_SECURITY_BOUNDARY');
  } finally { fs.rmSync(setup.root, { recursive: true, force: true }); }
});

linuxTest('cold Second Brain start gets a bounded readiness window without restarting healthy units', () => {
  const setup = fixture();
  try {
    const calls = [];
    const run = (_command, args, env, timeout) => {
      calls.push({ action: args[0], attempts: env.PI_OVERDRIVE_MEMORY_WAIT_ATTEMPTS, interval: env.PI_OVERDRIVE_MEMORY_WAIT_INTERVAL, timeout });
      return { status: args[0] === 'status' ? 1 : 0 };
    };
    const result = prepareOptionalServices({ root: setup.root, environment: setup.env, run });
    assert.equal(result.secondBrain, 'STARTED');
    assert.deepEqual(calls.map((call) => call.action), ['--phi-prepare-omniroute', 'status', 'start']);
    assert.deepEqual(calls.at(-1), { action: 'start', attempts: '100', interval: '0.1', timeout: 12_000 });
    assert.equal(calls.at(-2).timeout, 4_000);
  } finally { fs.rmSync(setup.root, { recursive: true, force: true }); }
});

linuxTest('untrusted units fail closed and are not executed', () => {
  const setup = fixture();
  try {
    fs.chmodSync(path.join(setup.unitRoot, 'pi-overdrive-hindsight.service'), 0o666);
    const calls = [];
    const result = prepareOptionalServices({ root: setup.root, environment: setup.env, run: (_command, args) => { calls.push(args[0]); return { status: 3 }; } });
    assert.equal(result.omniroute, 'SECURITY_MISMATCH');
    assert.equal(result.secondBrain, 'SECURITY_MISMATCH');
    assert.deepEqual(calls, ['--phi-prepare-omniroute']);
  } finally { fs.rmSync(setup.root, { recursive: true, force: true }); }
});

linuxTest('missing memory units and bounded manager timeout remain optional', () => {
  const setup = fixture();
  try {
    fs.rmSync(path.join(setup.unitRoot, 'pi-overdrive-openviking.service'));
    let result = prepareOptionalServices({ root: setup.root, environment: setup.env, run: () => ({ error: { code: 'ETIMEDOUT' } }) });
    assert.equal(result.omniroute, 'TIMEOUT');
    assert.equal(result.secondBrain, 'UNAVAILABLE');
    fs.writeFileSync(path.join(setup.unitRoot, 'pi-overdrive-openviking.service'), '[Unit]\n', { mode: 0o600 });
    result = prepareOptionalServices({ root: setup.root, environment: setup.env, run: () => ({ error: { code: 'ETIMEDOUT' } }) });
    assert.equal(result.secondBrain, 'TIMEOUT');
  } finally { fs.rmSync(setup.root, { recursive: true, force: true }); }
});

linuxTest('disabled, unconfigured and absent memory manager never start units', () => {
  const setup = fixture();
  try {
    const configFile = path.join(setup.root, 'config', 'second-brain.json');
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const calls = [];
    const run = (_command, args) => { calls.push(args[0]); return { status: 0 }; };
    config.openViking.mode = 'disabled';
    fs.writeFileSync(configFile, JSON.stringify(config));
    let result = prepareOptionalServices({ root: setup.root, environment: setup.env, run });
    assert.equal(result.secondBrain, 'UNAVAILABLE');
    assert.deepEqual(calls, ['--phi-prepare-omniroute']);
    config.openViking.mode = 'auto';
    config.enabled = false;
    fs.writeFileSync(configFile, JSON.stringify(config));
    result = prepareOptionalServices({ root: setup.root, environment: setup.env, run });
    assert.equal(result.secondBrain, 'UNAVAILABLE');
    config.enabled = true;
    fs.writeFileSync(configFile, JSON.stringify(config));
    fs.rmSync(setup.manager);
    result = prepareOptionalServices({ root: setup.root, environment: setup.env, run });
    assert.equal(result.secondBrain, 'UNAVAILABLE');
    assert.deepEqual(calls, ['--phi-prepare-omniroute', '--phi-prepare-omniroute', '--phi-prepare-omniroute']);
  } finally { fs.rmSync(setup.root, { recursive: true, force: true }); }
});
