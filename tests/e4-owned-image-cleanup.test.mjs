import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanupOwnedImageStages } from '../scripts/e4-owned-image-cleanup.mjs';

test('E4 image cleanup removes only fixed owned staging directories', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-e4-owned-cleanup-'));
  const root = path.join(parent, '_temp');
  try {
    fs.mkdirSync(root);
    for (const name of ['phi-e4-seeds', 'phi-e4-lsp', 'phi-e4-linker-evidence']) {
      fs.mkdirSync(path.join(root, name));
      fs.writeFileSync(path.join(root, name, 'owned'), 'fixture');
    }
    fs.writeFileSync(path.join(root, 'foreign'), 'preserve');
    cleanupOwnedImageStages(root);
    assert.equal(fs.existsSync(path.join(root, 'phi-e4-seeds')), false);
    assert.equal(fs.existsSync(path.join(root, 'phi-e4-lsp')), false);
    assert.equal(fs.existsSync(path.join(root, 'phi-e4-linker-evidence')), false);
    assert.equal(fs.readFileSync(path.join(root, 'foreign'), 'utf8'), 'preserve');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('E4 image cleanup refuses aliased or foreign-shaped roots', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-e4-owned-cleanup-'));
  try {
    const root = path.join(parent, '_temp');
    const alias = path.join(parent, 'alias');
    fs.mkdirSync(root);
    fs.symlinkSync(root, alias);
    assert.throws(() => cleanupOwnedImageStages(alias), /unexpected runner temporary root|aliased/u);
    assert.throws(() => cleanupOwnedImageStages(parent), /unexpected runner temporary root/u);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
