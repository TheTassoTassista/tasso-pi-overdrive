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
const simdjson = manifest.assets.find((asset) => asset.logicalName === 'simdjson-4.6.11-node-runtime');
const rustRuntime = manifest.assets.find((asset) => asset.logicalName === 'llvm-libs-22.1.8-rust-runtime');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('E4 seed manifest binds eleven distinct immutable assets and exact runtime paths', () => {
  assert.equal(manifest.assets.length, 11);
  assert.equal(new Set(manifest.assets.map((asset) => asset.assetId)).size, 11);
  assert.equal(manifest.release.internalOnly, true);
  assert.equal(simdjson.runtimeDependency.soname, 'libsimdjson.so.33');
  assert.equal(simdjson.runtimeDependency.requiredBySha256, manifest.assets.find((asset) => asset.logicalName === 'nodejs-26.8.2').extracted[0].sha256);
  assert.equal(rustRuntime.runtimeDependency.soname, 'libLLVM.so.22.1');
  assert.equal(rustRuntime.runtimeDependency.path, '/usr/lib/libLLVM.so.22.1');
  assert.throws(() => validateSeedManifest({ ...manifest, assets: manifest.assets.map((asset) => asset === rustRuntime ?
    { ...rustRuntime, runtimeDependency: { ...rustRuntime.runtimeDependency, soname: 'libLLVM.so.23.1' } } : asset) }),
  /E4_SEED_MANIFEST_RUST_RUNTIME_DEPENDENCY_INVALID/u);
  assert.throws(() => validateSeedManifest({ ...manifest, assets: manifest.assets.slice(1) }), /E4_SEED_MANIFEST_INVALID/u);
  assert.throws(() => validateSeedManifest({ ...manifest, assets: [...manifest.assets.slice(0, -1), manifest.assets[0]] }), /E4_SEED_MANIFEST_ASSET_INVALID/u);
  const changed = { ...simdjson, runtimeDependency: { ...simdjson.runtimeDependency, soname: 'libsimdjson.so.34' } };
  assert.throws(() => validateSeedManifest({ ...manifest, assets: manifest.assets.map((asset) => asset === simdjson ? changed : asset) }), /E4_SEED_MANIFEST_RUNTIME_DEPENDENCY_INVALID/u);
  const browser = manifest.assets.find((asset) => asset.logicalName.startsWith('browser-runtime-'));
  assert.equal(browser.extracted.length, 2);
  assert.throws(() => validateSeedManifest({ ...manifest, assets: manifest.assets.map((asset) => asset === browser ?
    { ...browser, extracted: [browser.extracted[1], browser.extracted[0]] } : asset) }), /E4_SEED_MANIFEST_BROWSER_IDENTITY_INVALID/u);
  assert.throws(() => validateSeedManifest({ ...manifest, assets: manifest.assets.map((asset) => asset === browser ?
    { ...browser, extracted: [browser.extracted[0], { ...browser.extracted[1], installedPath: '/tmp/chrome' }] } : asset) }), /E4_SEED_MANIFEST_EXTRACTED_INVALID/u);
  assert.equal(manifest.assets.find((asset) => asset.logicalName === 'diffutils-3.12-cmp').extracted[0].path, 'usr/bin/cmp');
  const rust = manifest.assets.find((asset) => asset.logicalName === 'rust-1.98.1-toolchain');
  assert.equal(rust.extracted.length, 2);
  assert.throws(() => validateSeedManifest({ ...manifest, assets: manifest.assets.map((asset) => asset === rust ?
    { ...rust, extracted: [rust.extracted[1], rust.extracted[0]] } : asset) }), /E4_SEED_MANIFEST_RUST_IDENTITY_INVALID/u);
});

test('E4 private asset identity rejects wrong ID, size, digest and bytes', () => {
  const metadata = { id: git.assetId, name: git.name, size: git.size, digest: `sha256:${git.sha256}`, state: 'uploaded' };
  validateAssetMetadata(git, metadata);
  for (const change of [{ id: git.assetId + 1 }, { size: git.size - 1 }, { digest: `sha256:${'0'.repeat(64)}` }, { name: 'latest.pkg.tar.zst' }, { state: 'starter' }]) {
    assert.throws(() => validateAssetMetadata(git, { ...metadata, ...change }), /E4_SEED_REMOTE_IDENTITY_MISMATCH/u);
  }
  assert.throws(() => validateDownloadedAsset(git, Buffer.alloc(git.size)), /E4_SEED_DOWNLOAD_IDENTITY_MISMATCH/u);
});

test('E4 simdjson staging admits only the exact internal SONAME link and file', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-e4-simdjson-seed-test-'));
  try {
    const source = path.join(temporary, 'source');
    const destination = path.join(temporary, 'destination');
    fs.mkdirSync(path.join(source, 'usr', 'lib'), { recursive: true });
    fs.mkdirSync(destination, { mode: 0o700 });
    const library = Buffer.from('fixture-simdjson-library\n');
    fs.writeFileSync(path.join(source, 'usr/lib/libsimdjson.so.33.0.0'), library);
    fs.symlinkSync('libsimdjson.so.33.0.0', path.join(source, 'usr/lib/libsimdjson.so.33'));
    fs.writeFileSync(path.join(source, 'unrelated-secret'), 'never stage');
    const archive = path.join(temporary, 'fixture.tar');
    assert.equal(spawnSync('tar', ['-cf', archive, '-C', source, 'usr', 'unrelated-secret']).status, 0);
    const bytes = fs.readFileSync(archive);
    const fixture = { ...simdjson, size: bytes.length, sha256: sha(bytes),
      extracted: [{ ...simdjson.extracted[0], sha256: sha(library) }],
      runtimeDependency: { ...simdjson.runtimeDependency, sha256: sha(library), size: library.length } };
    stageSeedArchive(fixture, bytes, destination);
    assert.equal(fs.statSync(destination).mode & 0o777, 0o700, 'private stage root must remain private');
    assert.equal(fs.readlinkSync(path.join(destination, 'usr/lib/libsimdjson.so.33')), 'libsimdjson.so.33.0.0');
    assert.deepEqual(fs.readFileSync(path.join(destination, 'usr/lib/libsimdjson.so.33.0.0')), library);
    for (const relative of ['usr', 'usr/lib']) {
      assert.equal(fs.statSync(path.join(destination, relative)).mode & 0o005, 0o005, `${relative} must be traversable/readable by the image self-check user`);
    }
    assert.equal(fs.existsSync(path.join(destination, 'unrelated-secret')), false);
    const badSource = path.join(temporary, 'bad-source');
    fs.mkdirSync(path.join(badSource, 'usr', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(badSource, 'usr/lib/libsimdjson.so.33.0.0'), library);
    fs.symlinkSync('/etc/passwd', path.join(badSource, 'usr/lib/libsimdjson.so.33'));
    const badArchive = path.join(temporary, 'bad.tar');
    assert.equal(spawnSync('tar', ['-cf', badArchive, '-C', badSource, 'usr']).status, 0);
    const badBytes = fs.readFileSync(badArchive);
    assert.throws(() => stageSeedArchive({ ...fixture, size: badBytes.length, sha256: sha(badBytes) }, badBytes, path.join(temporary, 'bad-destination')), /E4_SEED_EXTRACTION_SYMLINK_ESCAPED/u);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('E4 contained extraction stages only the approved file and preserves its digest', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-e4-seed-test-'));
  try {
    const source = path.join(temporary, 'source');
    const destination = path.join(temporary, 'destination');
    fs.mkdirSync(path.join(source, 'usr', 'bin'), { recursive: true });
    fs.mkdirSync(destination, { mode: 0o700 });
    const binary = Buffer.from('fixture-git-binary\n');
    fs.writeFileSync(path.join(source, 'usr', 'bin', 'git'), binary);
    fs.writeFileSync(path.join(source, 'unrelated-secret'), 'never stage');
    const archive = path.join(temporary, 'fixture.tar');
    const packed = spawnSync('tar', ['-cf', archive, '-C', source, 'usr', 'unrelated-secret'], { encoding: 'utf8' });
    assert.equal(packed.status, 0, packed.stderr);
    const bytes = fs.readFileSync(archive);
    const fixture = { ...git, size: bytes.length, sha256: sha(bytes), extracted: [{ path: 'usr/bin/git', installedPath: '/usr/bin/git', sha256: sha(binary) }] };
    stageSeedArchive(fixture, bytes, destination);
    assert.equal(fs.statSync(destination).mode & 0o777, 0o700, 'private stage root must remain private');
    assert.deepEqual(fs.readFileSync(path.join(destination, 'usr', 'bin', 'git')), binary);
    for (const relative of ['usr', 'usr/bin']) {
      assert.equal(fs.statSync(path.join(destination, relative)).mode & 0o005, 0o005, `${relative} must be traversable/readable by the image self-check user`);
    }
    assert.equal(fs.existsSync(path.join(destination, 'unrelated-secret')), false);
    assert.throws(() => stageSeedArchive(fixture, Buffer.concat([bytes, Buffer.from('x')]), destination), /E4_SEED_DOWNLOAD_IDENTITY_MISMATCH/u);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
