import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { validateSeedManifest, validateAssetMetadata, validateDownloadedAsset, stageSeedArchive } from '../scripts/e4-stage-seeds.mjs';

const manifest = validateSeedManifest(JSON.parse(fs.readFileSync(new URL('../config/e4-toolchain-seeds.json', import.meta.url), 'utf8')));
const git = manifest.assets.find((asset) => asset.logicalName === 'git-2.55.0');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('E4 seed manifest binds six distinct immutable assets and exact runtime paths', () => {
  assert.equal(manifest.assets.length, 6);
  assert.equal(new Set(manifest.assets.map((asset) => asset.assetId)).size, 6);
  assert.equal(manifest.release.internalOnly, true);
  assert.throws(() => validateSeedManifest({ ...manifest, assets: manifest.assets.slice(1) }), /E4_SEED_MANIFEST_INVALID/u);
  assert.throws(() => validateSeedManifest({ ...manifest, assets: [...manifest.assets.slice(0, -1), manifest.assets[0]] }), /E4_SEED_MANIFEST_ASSET_INVALID/u);
});

test('E4 private asset identity rejects wrong ID, size, digest and bytes', () => {
  const metadata = { id: git.assetId, name: git.name, size: git.size, digest: `sha256:${git.sha256}`, state: 'uploaded' };
  validateAssetMetadata(git, metadata);
  for (const change of [{ id: git.assetId + 1 }, { size: git.size - 1 }, { digest: `sha256:${'0'.repeat(64)}` }, { name: 'latest.pkg.tar.zst' }, { state: 'starter' }]) {
    assert.throws(() => validateAssetMetadata(git, { ...metadata, ...change }), /E4_SEED_REMOTE_IDENTITY_MISMATCH/u);
  }
  assert.throws(() => validateDownloadedAsset(git, Buffer.alloc(git.size)), /E4_SEED_DOWNLOAD_IDENTITY_MISMATCH/u);
});

test('E4 contained extraction stages only the approved file and preserves its digest', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-e4-seed-test-'));
  try {
    const source = path.join(temporary, 'source');
    const destination = path.join(temporary, 'destination');
    fs.mkdirSync(path.join(source, 'usr', 'bin'), { recursive: true });
    fs.mkdirSync(destination);
    const binary = Buffer.from('fixture-git-binary\n');
    fs.writeFileSync(path.join(source, 'usr', 'bin', 'git'), binary);
    fs.writeFileSync(path.join(source, 'unrelated-secret'), 'never stage');
    const archive = path.join(temporary, 'fixture.tar');
    const packed = spawnSync('tar', ['-cf', archive, '-C', source, 'usr', 'unrelated-secret'], { encoding: 'utf8' });
    assert.equal(packed.status, 0, packed.stderr);
    const bytes = fs.readFileSync(archive);
    const fixture = { ...git, size: bytes.length, sha256: sha(bytes), extracted: [{ path: 'usr/bin/git', installedPath: '/usr/bin/git', sha256: sha(binary) }] };
    stageSeedArchive(fixture, bytes, destination);
    assert.deepEqual(fs.readFileSync(path.join(destination, 'usr', 'bin', 'git')), binary);
    assert.equal(fs.existsSync(path.join(destination, 'unrelated-secret')), false);
    assert.throws(() => stageSeedArchive(fixture, Buffer.concat([bytes, Buffer.from('x')]), destination), /E4_SEED_DOWNLOAD_IDENTITY_MISMATCH/u);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
