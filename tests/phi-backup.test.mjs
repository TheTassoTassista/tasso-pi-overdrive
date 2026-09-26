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
