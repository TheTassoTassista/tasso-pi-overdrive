#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const manifestPath = path.join(root, 'config', 'e4-toolchain-seeds.json');
const repository = 'TheTassoTassista/tasso-pi-overdrive';
const selected = Object.freeze({
  'git-2.55.0': ['usr/bin/git'],
  'gdb-17.2': ['usr/bin/gdb'],
  'gdb-common-17.2': ['usr/share/gdb/python'],
  'python-3.14.7': ['usr/bin/python3.14', 'usr/lib/libpython3.14.so', 'usr/lib/libpython3.14.so.1.0', 'usr/lib/python3.14'],
  'nodejs-26.8.2': ['usr/bin/node'],
  'simdjson-4.6.11-node-runtime': ['usr/lib/libsimdjson.so.33', 'usr/lib/libsimdjson.so.33.0.0'],
  'util-linux-2.42.4': ['usr/bin/prlimit'],
});

function fail(code) { throw new Error(`E4_SEED_${code}`); }
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const validHash = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);

export function validateSeedManifest(manifest) {
  if (manifest?.schemaVersion !== 1 || manifest.repository !== repository ||
      manifest.release?.tag !== 'phi-cert-toolchain-seed-v1' ||
      !Number.isSafeInteger(manifest.release.id) || manifest.release.id < 1 ||
      manifest.release.privateRepository !== true || manifest.release.internalOnly !== true ||
      manifest.extractionMethod !== 'bsdtar -xf into isolated stage' ||
      manifest.provenance !== 'CONTENT_IDENTITY_VERIFIED' ||
      !Array.isArray(manifest.assets) || manifest.assets.length !== Object.keys(selected).length) fail('MANIFEST_INVALID');
  const names = new Set();
  const ids = new Set();
  for (const asset of manifest.assets) {
    if (!Object.hasOwn(selected, asset.logicalName) || names.has(asset.logicalName) ||
        !Number.isSafeInteger(asset.assetId) || asset.assetId < 1 || ids.has(asset.assetId) ||
        typeof asset.name !== 'string' || !/^[a-z0-9][a-z0-9._-]+\.pkg\.tar\.zst$/u.test(asset.name) ||
        !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > 100 * 1024 * 1024 ||
        !['UNAVAILABLE_IN_CHECKED_SOURCES', 'NOT_ASSESSED_FOR_THIS_TRANSPORT'].includes(asset.upstreamRefetchability) ||
        !validHash(asset.sha256) || !Array.isArray(asset.extracted) || asset.extracted.length !== 1) fail('MANIFEST_ASSET_INVALID');
    names.add(asset.logicalName);
    ids.add(asset.assetId);
    const item = asset.extracted[0];
    if (!selected[asset.logicalName].some((relative) => item?.path === relative || item?.path?.startsWith(`${relative}/`)) || !validHash(item.sha256) ||
        item.installedPath !== `/${item.path}`) fail('MANIFEST_EXTRACTED_INVALID');
    if (asset.logicalName === 'simdjson-4.6.11-node-runtime') {
      const runtime = asset.runtimeDependency;
      const node = manifest.assets.find((entry) => entry.logicalName === 'nodejs-26.8.2');
      if (asset.assetId !== 641772299 || asset.name !== 'simdjson-1.4.6.11-1.1-x86_64_v3.pkg.tar.zst' ||
          asset.sourcePackage !== 'simdjson 1:4.6.11-1.1 x86_64_v3' ||
          asset.signatureFingerprint !== '882DCFE48E2051D48E2562ABF3B607488DB35A47' ||
          runtime?.soname !== 'libsimdjson.so.33' || runtime.linkPath !== '/usr/lib/libsimdjson.so.33' ||
          runtime.linkTarget !== 'libsimdjson.so.33.0.0' || runtime.path !== '/usr/lib/libsimdjson.so.33.0.0' ||
          runtime.size !== 145480 || runtime.sha256 !== item.sha256 ||
          runtime.requiredBy !== '/usr/bin/node' || runtime.requiredBySha256 !== node?.extracted?.[0]?.sha256 ||
          item.path !== 'usr/lib/libsimdjson.so.33.0.0') fail('MANIFEST_RUNTIME_DEPENDENCY_INVALID');
    } else if (asset.runtimeDependency !== undefined) fail('MANIFEST_RUNTIME_DEPENDENCY_INVALID');
  }
  if (names.size !== Object.keys(selected).length) fail('MANIFEST_INCOMPLETE');
  return manifest;
}

export function validateAssetMetadata(asset, metadata) {
  if (metadata?.id !== asset.assetId || metadata.name !== asset.name ||
      metadata.size !== asset.size || metadata.digest !== `sha256:${asset.sha256}` ||
      metadata.state !== 'uploaded') fail('REMOTE_IDENTITY_MISMATCH');
}

export function validateDownloadedAsset(asset, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== asset.size || digest(bytes) !== asset.sha256) fail('DOWNLOAD_IDENTITY_MISMATCH');
}

function run(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: null, maxBuffer: 128 * 1024 * 1024, ...options });
  if (result.status !== 0 || result.error) fail(`${program.toUpperCase()}_FAILED`);
  return result.stdout;
}

function safeRelative(relative) {
  if (!relative || path.isAbsolute(relative) || relative.split('/').some((part) => !part || part === '..' || part === '.')) fail('ARCHIVE_PATH_UNSAFE');
  return relative;
}

function inspectTree(base, item) {
  const resolved = path.resolve(base, item);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) fail('EXTRACTION_ESCAPED');
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink()) {
    const actual = fs.realpathSync(resolved);
    if (!actual.startsWith(`${base}${path.sep}`)) fail('EXTRACTION_SYMLINK_ESCAPED');
  } else if (stat.isDirectory()) {
    for (const child of fs.readdirSync(resolved)) inspectTree(base, path.join(item, child));
  } else if (!stat.isFile()) fail('EXTRACTION_SPECIAL_FILE');
}

export function stageSeedArchive(asset, bytes, destination) {
  validateDownloadedAsset(asset, bytes);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-e4-seed-'));
  try {
    const archive = path.join(stage, 'seed.pkg.tar.zst');
    const extract = path.join(stage, 'extract');
    fs.mkdirSync(extract, { mode: 0o700 });
    fs.writeFileSync(archive, bytes, { mode: 0o600 });
    const entries = run('bsdtar', ['-tf', archive]).toString('utf8').split('\n').filter(Boolean);
    for (const entry of entries) safeRelative(entry.replace(/\/$/u, ''));
    run('bsdtar', ['-xf', archive, '-C', extract]);
    for (const relative of selected[asset.logicalName]) {
      inspectTree(extract, relative);
      const source = path.join(extract, relative);
      const target = path.join(destination, relative);
      // The stage root is private; paths copied into the image must remain
      // traversable by the non-root self-check (UID 1001).
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
      fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: true, dereference: false, verbatimSymlinks: true });
    }
    for (const relative of selected[asset.logicalName]) inspectTree(destination, relative);
    for (const item of asset.extracted) {
      const target = path.join(destination, item.path);
      if (!fs.lstatSync(target).isFile() || digest(fs.readFileSync(target)) !== item.sha256) fail('STAGED_RUNTIME_IDENTITY_MISMATCH');
    }
    if (asset.logicalName === 'simdjson-4.6.11-node-runtime') {
      const runtime = asset.runtimeDependency;
      const link = path.join(destination, 'usr/lib/libsimdjson.so.33');
      const library = path.join(destination, 'usr/lib/libsimdjson.so.33.0.0');
      if (!fs.lstatSync(link).isSymbolicLink() || fs.readlinkSync(link) !== runtime.linkTarget ||
          fs.realpathSync(link) !== library || fs.statSync(library).size !== runtime.size ||
          digest(fs.readFileSync(library)) !== runtime.sha256) fail('STAGED_RUNTIME_DEPENDENCY_MISMATCH');
    }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

function githubJson(endpoint) {
  try { return JSON.parse(run('gh', ['api', endpoint]).toString('utf8')); }
  catch { fail('GITHUB_METADATA_UNAVAILABLE'); }
}

export function stageFromGitHub(destination) {
  const manifest = validateSeedManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) fail('GITHUB_AUTH_UNAVAILABLE');
  if (fs.existsSync(destination)) fail('DESTINATION_EXISTS');
  const release = githubJson(`repos/${repository}/releases/${manifest.release.id}`);
  if (release.id !== manifest.release.id || release.tag_name !== manifest.release.tag || release.draft) fail('RELEASE_IDENTITY_MISMATCH');
  fs.mkdirSync(destination, { recursive: false, mode: 0o700 });
  try {
    for (const asset of manifest.assets) {
      const metadata = githubJson(`repos/${repository}/releases/assets/${asset.assetId}`);
      validateAssetMetadata(asset, metadata);
      const bytes = run('gh', ['api', '-H', 'Accept: application/octet-stream', `repos/${repository}/releases/assets/${asset.assetId}`], { maxBuffer: asset.size + 1024 * 1024 });
      stageSeedArchive(asset, bytes, destination);
      process.stdout.write(`E4_SEED_STAGED ${asset.logicalName} asset_id=${asset.assetId} bytes=${asset.size} sha256=${asset.sha256}\n`);
    }
  } catch (error) {
    fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }
  return { releaseId: manifest.release.id, staged: manifest.assets.length, destination };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2 || !process.env.RUNNER_TEMP || !path.isAbsolute(process.env.RUNNER_TEMP)) fail('USAGE');
  const destination = path.join(fs.realpathSync(process.env.RUNNER_TEMP), 'phi-e4-seeds');
  try { process.stdout.write(`${JSON.stringify(stageFromGitHub(destination))}\n`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
