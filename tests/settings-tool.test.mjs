import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { merge, removeSelectedPackages, replaceLocalPackageRoot, restoreFields, shouldPreserveSnapshot, snapshotFields } from '../lib/settings.mjs';

test('enable/disable is reversible, preserves later user changes, and keeps the first snapshot', () => {
  const settingsPath = '/tmp/pi-overdrive-settings/agent/settings.json';
  const packageRoot = '/tmp/pi-overdrive-settings/package';
  const original = { defaultProvider: 'before', defaultModel: 'before-model', packages: ['npm:user-owned@1.0.0'] };
  const patch = { defaultProvider: 'after', defaultModel: 'after-model' };
  const manifest = {
    version: 1,
    settingsPath,
    originalFields: snapshotFields(original, patch),
    originalPackages: [...original.packages],
    selectedSources: ['npm:selected@2.0.0'],
    packageRoot,
  };
  assert.equal(shouldPreserveSnapshot(manifest, settingsPath), true);

  const enabled = merge(original, patch);
  manifest.appliedFields = Object.fromEntries(Object.keys(patch).map((key) => [key, structuredClone(enabled[key])]));
  enabled.defaultModel = 'later-user-choice';
  enabled.packages.push('npm:selected@2.0.0', path.relative(path.dirname(settingsPath), packageRoot));

  restoreFields(enabled, manifest.originalFields, manifest.appliedFields);
  removeSelectedPackages(enabled, manifest, settingsPath);
  assert.equal(enabled.defaultProvider, 'before');
  assert.equal(enabled.defaultModel, 'later-user-choice');
  assert.deepEqual(enabled.packages, ['npm:user-owned@1.0.0']);
});

test('stable package migration removes old and duplicate local roots only', () => {
  const settingsPath = '/home/user/.pi/agent/settings.json';
  const oldRoot = '/home/user/dated/output/tasso-pi-overdrive';
  const stableRoot = '/home/user/Projects/tasso-pi-overdrive';
  const settings = { packages: [oldRoot, 'npm:fixed@1.2.3', stableRoot, { source: '../other-local' }] };
  replaceLocalPackageRoot(settings, settingsPath, oldRoot, stableRoot);
  assert.deepEqual(settings.packages, ['npm:fixed@1.2.3', { source: '../other-local' }, stableRoot]);
});
