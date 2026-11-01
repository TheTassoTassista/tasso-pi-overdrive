import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPhiBackup, restorePhiBackup, validatePhiBackup } from '../lib/phi-backup.mjs';
import { readLocalJson, writeLocalJson } from '../platform/shared/filesystem.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-backup-'));
  const dirs = Object.fromEntries(['config', 'state', 'agent', 'legacyConfig'].map((key) => [key, path.join(root, key)]));
  for (const directory of Object.values(dirs)) fs.mkdirSync(directory, { mode: 0o700 });
  writeLocalJson(path.join(dirs.agent, 'settings.json'), { defaultProvider: 'openai-codex', defaultModel: 'gpt-6-sol', defaultThinkingLevel: 'medium', packages: ['UNCHANGED'], privateKey: 'DO_NOT_EXPORT' });
  fs.writeFileSync(path.join(dirs.agent, 'auth.json'), 'DO_NOT_OPEN_AUTH');
  writeLocalJson(path.join(dirs.legacyConfig, 'model-policy.json'), { version: 2, preset: 'normal', basePreset: 'normal', overrides: {} });
  return { root, dirs };
}
test('backup schema rejects unknown/credential fields and unreviewed billing routes', () => {
  const value = { version: 1, product: 'Phi', phiVersion: '1.0.0', createdAt: '2026-09-26T00:00:00.000Z', preferences: { version: 1, theme: 'mono' }, default: { provider: 'openai-codex', model: 'gpt-6-sol', thinking: 'medium' }, rolePolicy: { version: 2, preset: 'normal', basePreset: 'normal', overrides: {} } };
  assert.equal(validatePhiBackup(value).default.model, 'gpt-6-sol');
  assert.throws(() => validatePhiBackup({ ...value, apiKey: 'FORBIDDEN' }));
  assert.throws(() => validatePhiBackup({ ...value, default: { ...value.default, model: 'secret-value' } }));
  assert.throws(() => validatePhiBackup({ ...value, rolePolicy: { ...value.rolePolicy, overrides: { worker: { model: 'omniroute/auto/best-coding', thinking: 'medium' } } } }));
});
test('backup excludes auth/secrets/callability and restore defaults to zero-write plan', { skip: process.platform !== 'linux' }, () => {
  const setup = fixture();
  try {
    const created = createPhiBackup(setup.dirs);
    const text = fs.readFileSync(created.file, 'utf8');
    assert.doesNotMatch(text, /DO_NOT_EXPORT|DO_NOT_OPEN_AUTH|UNCHANGED|runtimeStatus|\/home\//u);
    const before = fs.readFileSync(path.join(setup.dirs.agent, 'settings.json'), 'utf8');
    const result = restorePhiBackup(created.file, { dirs: setup.dirs });
    assert.equal(result.writes, 0); assert.equal(result.status, 'PLAN');
    assert.equal(fs.readFileSync(path.join(setup.dirs.agent, 'settings.json'), 'utf8'), before);
    assert.throws(() => restorePhiBackup(path.join(setup.dirs.agent, 'auth.json'), { dirs: setup.dirs }), /PATH_INVALID/u);
  } finally { fs.rmSync(setup.root, { recursive: true, force: true }); }
});
test('restore requires local callability and preserves unrelated settings/auth', { skip: process.platform !== 'linux' }, () => {
  const setup = fixture();
  try {
    const created = createPhiBackup(setup.dirs);
    assert.throws(() => restorePhiBackup(created.file, { dirs: setup.dirs, apply: true }));
    writeLocalJson(path.join(setup.dirs.legacyConfig, 'model-callability.json'), { version: 1, entries: { 'openai-codex/gpt-6-sol': { runtimeStatus: 'RUNTIME_REJECTED', reasonCode: 'FIXTURE_REJECTED' } } });
    assert.throws(() => restorePhiBackup(created.file, { dirs: setup.dirs, apply: true }), /UNATTESTED/u);
    writeLocalJson(path.join(setup.dirs.legacyConfig, 'model-callability.json'), { version: 1, entries: { 'openai-codex/gpt-6-sol': { runtimeStatus: 'RUNTIME_CALLABLE', reasonCode: 'LOCAL_FIXTURE_ONLY' } } });
    const result = restorePhiBackup(created.file, { dirs: setup.dirs, apply: true });
    assert.equal(result.status, 'PASS'); assert.equal(result.authModified, false);
    assert.equal(readLocalJson(path.join(setup.dirs.agent, 'settings.json')).privateKey, 'DO_NOT_EXPORT');
    assert.equal(fs.readFileSync(path.join(setup.dirs.agent, 'auth.json'), 'utf8'), 'DO_NOT_OPEN_AUTH');
  } finally { fs.rmSync(setup.root, { recursive: true, force: true }); }
});

test('bundled Anthropic default and explicit roles back up and restore reversibly without credentials', { skip: process.platform !== 'linux' }, () => {
  const setup = fixture();
  try {
    const original = createPhiBackup(setup.dirs);
    const settingsFile = path.join(setup.dirs.agent, 'settings.json');
    const policyFile = path.join(setup.dirs.legacyConfig, 'model-policy.json');
    writeLocalJson(settingsFile, { ...readLocalJson(settingsFile), defaultProvider: 'anthropic', defaultModel: 'claude-opus-5' });
    const roles = ['scout', 'planner', 'oracle', 'worker', 'tester', 'correctness', 'security', 'simplicity', 'council-1', 'council-2', 'council-3', 'council-judge'];
    writeLocalJson(policyFile, { version: 2, preset: 'custom', basePreset: 'normal', overrides: Object.fromEntries(roles.map((role) => [role, { model: 'anthropic/claude-opus-5', thinking: ['security', 'council-judge'].includes(role) ? 'high' : 'medium' }])) });
    const alternative = createPhiBackup(setup.dirs);
    assert.doesNotMatch(fs.readFileSync(alternative.file, 'utf8'), /DO_NOT_EXPORT|DO_NOT_OPEN_AUTH/u);
    writeLocalJson(settingsFile, { ...readLocalJson(settingsFile), defaultProvider: 'openai-codex', defaultModel: 'gpt-6-sol' });
    writeLocalJson(policyFile, { version: 2, preset: 'normal', basePreset: 'normal', overrides: {} });
    writeLocalJson(path.join(setup.dirs.legacyConfig, 'model-callability.json'), { version: 1, entries: {
      'openai-codex/gpt-6-sol': { runtimeStatus: 'RUNTIME_CALLABLE', reasonCode: 'LOCAL_FIXTURE' },
      'anthropic/claude-opus-5': { runtimeStatus: 'RUNTIME_CALLABLE', reasonCode: 'LOCAL_FIXTURE' },
    } });
    assert.equal(restorePhiBackup(alternative.file, { dirs: setup.dirs }).status, 'PLAN');
    assert.equal(restorePhiBackup(alternative.file, { dirs: setup.dirs, apply: true }).status, 'PASS');
    assert.equal(readLocalJson(settingsFile).defaultProvider, 'anthropic');
    assert.equal(readLocalJson(policyFile).overrides.worker.model, 'anthropic/claude-opus-5');
    assert.equal(restorePhiBackup(original.file, { dirs: setup.dirs, apply: true }).status, 'PASS');
    assert.equal(readLocalJson(settingsFile).defaultProvider, 'openai-codex');
    assert.equal(fs.readFileSync(path.join(setup.dirs.agent, 'auth.json'), 'utf8'), 'DO_NOT_OPEN_AUTH');
    assert.throws(() => validatePhiBackup({ ...readLocalJson(alternative.file), default: { provider: 'anthropic', model: 'not-a-model', thinking: 'medium' } }), /DEFAULT_INVALID/u);
  } finally { fs.rmSync(setup.root, { recursive: true, force: true }); }
});

test('restore failure preserves newer settings instead of overwriting them during rollback', { skip: process.platform !== 'linux' }, () => {
  const setup = fixture();
  const originalRename = fs.renameSync;
  try {
    const backup = createPhiBackup(setup.dirs);
    const settingsFile = path.join(setup.dirs.agent, 'settings.json');
    const policyFile = path.join(setup.dirs.legacyConfig, 'model-policy.json');
    writeLocalJson(settingsFile, { ...readLocalJson(settingsFile), defaultModel: 'gpt-5.5' });
    writeLocalJson(path.join(setup.dirs.legacyConfig, 'model-callability.json'), { version: 1, entries: { 'openai-codex/gpt-6-sol': { runtimeStatus: 'RUNTIME_CALLABLE', reasonCode: 'LOCAL_FIXTURE' } } });
    fs.renameSync = (from, to) => {
      if (to === policyFile) {
        fs.renameSync = originalRename;
        writeLocalJson(settingsFile, { ...readLocalJson(settingsFile), defaultModel: 'gpt-6-astra' });
        throw new Error('fixture_write_failure');
      }
      return originalRename(from, to);
    };
    assert.throws(() => restorePhiBackup(backup.file, { dirs: setup.dirs, apply: true }), /ROLLBACK_INCOMPLETE/u);
    assert.equal(readLocalJson(settingsFile).defaultModel, 'gpt-6-astra');
    assert.equal(fs.readFileSync(path.join(setup.dirs.agent, 'auth.json'), 'utf8'), 'DO_NOT_OPEN_AUTH');
  } finally { fs.renameSync = originalRename; fs.rmSync(setup.root, { recursive: true, force: true }); }
});
