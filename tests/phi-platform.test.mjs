import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { platformAdapter, localDirectories, requireAutonomousBackend } from '../platform/index.mjs';
import { containsPath, portableRelativePath, readLocalJson, writeLocalJson } from '../platform/shared/filesystem.mjs';
import { readPhiConfig, setPhiTheme } from '../lib/phi-config.mjs';

test('native platform dispatch is centralized; unsupported platforms fail closed', () => {
  assert.equal(platformAdapter().id, process.platform);
  assert.throws(() => platformAdapter('darwin'), /UNSUPPORTED/u);
});
test('Linux XDG and Windows user-local directories never depend on a developer home', () => {
  const linux = localDirectories({ platform: 'linux', home: '/users/example', env: { XDG_CONFIG_HOME: '/config', XDG_STATE_HOME: '/state' } });
  assert.equal(linux.config, '/config/phi'); assert.equal(linux.state, '/state/phi');
  const win = localDirectories({ platform: 'win32', home: 'C:\\Users\\Example', env: { LOCALAPPDATA: 'D:\\Local' } });
  assert.equal(win.config, 'D:\\Local\\Phi\\config'); assert.equal(win.agent, 'C:\\Users\\Example\\.pi\\agent');
});
test('Windows sandbox is explicitly unavailable and cannot permit engine execution', () => {
  assert.throws(() => requireAutonomousBackend('win32'), /SANDBOX_UNAVAILABLE/u);
  assert.equal(platformAdapter('win32').sandbox.implemented, false);
});
test('platform adapters keep their own path semantics on either native runner', () => {
  assert.equal(platformAdapter('linux').path, path.posix);
  assert.equal(platformAdapter('win32').path, path.win32);
  const linux = localDirectories({ platform: 'linux', home: '/users/example', env: {} });
  assert.deepEqual(linux, {
    config: '/users/example/.config/phi', state: '/users/example/.local/state/phi',
    bin: '/users/example/.local/bin', agent: '/users/example/.pi/agent',
    legacyConfig: '/users/example/.config/pi-overdrive',
  });
});
test('containment rejects different Windows drives, UNC roots, and traversal', () => {
  assert.equal(containsPath('C:\\repo', 'D:\\escape', path.win32), false);
  assert.equal(containsPath('C:\\repo', 'C:\\repository\\escape', path.win32), false);
  assert.equal(containsPath('C:\\repo', 'c:\\REPO\\src\\file', path.win32), true);
  assert.equal(containsPath('\\\\host\\share\\repo', '\\\\other\\share\\repo', path.win32), false);
  assert.equal(containsPath('/repo', '/repo/../escape', path.posix), false);
});
test('portable paths reject NTFS devices, ADS, separators and ambiguous names', () => {
  for (const input of ['CON', 'aux.txt', 'LPT9.log', 'x:y', 'a\\b', 'a/../b', 'a.', 'a ', '/x', 'a//b']) assert.throws(() => portableRelativePath(input));
  assert.deepEqual(portableRelativePath('config/phi.json'), ['config', 'phi.json']);
});
test('local theme persistence is atomic, bounded, and leaves unrelated files intact', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-config-'));
  try {
    const dirs = { config: path.join(root, 'config') };
    assert.equal(readPhiConfig(dirs).theme, 'aurora');
    setPhiTheme('gold', dirs); assert.equal(readPhiConfig(dirs).theme, 'gold');
    assert.equal(fs.readdirSync(dirs.config).length, 1);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dirs.config, 'preferences.json')).mode & 0o777, 0o600);
    assert.throws(() => setPhiTheme('constructor', dirs));
    assert.equal(readPhiConfig(dirs).theme, 'gold');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('local JSON denies symlink/junction escapes and hard links', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-path-'));
  try {
    fs.mkdirSync(path.join(root, 'real'), { mode: 0o700 });
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => writeLocalJson(path.join(root, 'alias', 'x.json'), {}), /LINK_DENIED/u);
    const original = path.join(root, 'real', 'x.json'); writeLocalJson(original, { theme: 'mono' });
    fs.linkSync(original, path.join(root, 'copy.json'));
    assert.throws(() => readLocalJson(original), /TYPE_DENIED/u);
    assert.throws(() => writeLocalJson(original, {}), /TYPE_DENIED/u);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
