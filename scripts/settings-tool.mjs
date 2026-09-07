#!/usr/bin/env node
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { clone, merge, removeSelectedPackages, restoreFields, shouldPreserveSnapshot, snapshotFields } from "../lib/settings.mjs";

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
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
};

async function atomicWrite(file, value, mode = 0o600) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode });
  await rename(temp, file);
  await chmod(file, mode);
}

const patch = await readJson(patchPath, {});
const settings = await readJson(settingsPath, {});

if (action === 'snapshot') {
  const existing = await readJson(manifestPath, null);
  if (shouldPreserveSnapshot(existing, settingsPath)) {
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
