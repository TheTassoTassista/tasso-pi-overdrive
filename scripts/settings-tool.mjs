#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { clone, merge, removeSelectedPackages, replaceLocalPackageRoot, restoreFields, shouldPreserveSnapshot, snapshotFields } from "../lib/settings.mjs";

const [action, settingsArg, patchArg, manifestArg, packageRootArg] = process.argv.slice(2);
if (!['snapshot', 'enable', 'disable'].includes(action) || !settingsArg || !patchArg || !manifestArg) {
  process.stderr.write('usage: settings-tool.mjs snapshot|enable|disable SETTINGS PATCH MANIFEST [PACKAGE_ROOT]\n');
  process.exit(2);
}

const settingsPath = path.resolve(settingsArg);
const patchPath = path.resolve(patchArg);
const manifestPath = path.resolve(manifestArg);
const packageRoot = packageRootArg ? path.resolve(packageRootArg) : undefined;

const readJson = async (file, fallback) => {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    return JSON.parse(await handle.readFile('utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  } finally {
    await handle?.close();
  }
};

async function atomicWrite(file, value, mode = 0o600) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temp, file);
    await chmod(file, mode);
    const directory = await open(path.dirname(file), constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await handle?.close().catch(() => {});
    await (await import('node:fs/promises')).unlink(temp).catch(() => {});
    throw error;
  }
}

const patch = await readJson(patchPath, {});
const settings = await readJson(settingsPath, {});

if (action === 'snapshot') {
  const existing = await readJson(manifestPath, null);
  if (shouldPreserveSnapshot(existing, settingsPath)) {
    let changed = false;
    for (const key of Object.keys(patch)) {
      if (Object.hasOwn(existing.originalFields, key)) continue;
      existing.originalFields[key] = Object.hasOwn(settings, key) ? { present: true, value: clone(settings[key]) } : { present: false };
      changed = true;
    }
    if (changed) await atomicWrite(manifestPath, existing);
    process.stdout.write(`${manifestPath} (original snapshot preserved)\n`);
    process.exit(0);
  }
  const existingMode = await stat(settingsPath).then((item) => item.mode & 0o777).catch(() => 0o600);
  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    settingsPath,
    settingsMode: existingMode,
    packageRoot,
    originalFields: snapshotFields(settings, patch),
    originalPackages: clone(settings.packages ?? []),
    selectedSources: [],
  };
  await atomicWrite(manifestPath, manifest);
  process.stdout.write(`${manifestPath}\n`);
  process.exit(0);
}

const manifest = await readJson(manifestPath);
if (!manifest) throw new Error(`missing install manifest: ${manifestPath}`);

if (action === 'enable') {
  const enabled = merge(settings, patch);
  const priorPackageRoot = manifest.packageRoot;
  if (packageRoot) replaceLocalPackageRoot(enabled, settingsPath, priorPackageRoot, packageRoot);
  manifest.appliedFields = Object.fromEntries(Object.keys(patch).map((key) => [key, clone(enabled[key])]));
  manifest.packageRoot = packageRoot ?? manifest.packageRoot;
  manifest.enabledAt = new Date().toISOString();
  await atomicWrite(settingsPath, enabled, manifest.settingsMode ?? 0o600);
  await atomicWrite(manifestPath, manifest);
  process.stdout.write('Pi Overdrive settings enabled.\n');
  process.exit(0);
}

restoreFields(settings, manifest.originalFields ?? {}, manifest.appliedFields ?? {});
removeSelectedPackages(settings, manifest, settingsPath);
await atomicWrite(settingsPath, settings, manifest.settingsMode ?? 0o600);
manifest.disabledAt = new Date().toISOString();
await atomicWrite(manifestPath, manifest);
process.stdout.write('Pi Overdrive resources disabled; installed package caches and Pi remain intact.\n');
