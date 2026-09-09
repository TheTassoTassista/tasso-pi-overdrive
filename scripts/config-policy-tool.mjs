#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { clone, merge, restoreFields, shouldPreserveSnapshot, snapshotFields } from "../lib/settings.mjs";

const [action, targetArg, patchArg, manifestArg] = process.argv.slice(2);
if (!["snapshot", "enable", "disable"].includes(action) || !targetArg || !patchArg || !manifestArg) {
  process.stderr.write("usage: config-policy-tool.mjs snapshot|enable|disable TARGET PATCH MANIFEST\n");
  process.exit(2);
}

const targetPath = path.resolve(targetArg);
const patchPath = path.resolve(patchArg);
const manifestPath = path.resolve(manifestArg);

async function readJson(file, fallback) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    return JSON.parse(await handle.readFile("utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function atomicWrite(file, value, mode = 0o600) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
    await chmod(file, mode);
    const directory = await open(path.dirname(file), constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

const patch = await readJson(patchPath, {});
const current = await readJson(targetPath, {});

if (action === "snapshot") {
  const existing = await readJson(manifestPath, null);
  if (shouldPreserveSnapshot(existing, targetPath)) {
    let changed = false;
    for (const key of Object.keys(patch)) {
      if (Object.hasOwn(existing.originalFields, key)) continue;
      existing.originalFields[key] = Object.hasOwn(current, key) ? { present: true, value: clone(current[key]) } : { present: false };
      changed = true;
    }
    if (changed) await atomicWrite(manifestPath, existing);
    process.stdout.write(`${manifestPath} (original snapshot preserved)\n`);
    process.exit(0);
  }
  const existingMode = await stat(targetPath).then((item) => item.mode & 0o777).catch(() => 0o600);
  await atomicWrite(manifestPath, {
    version: 1,
    createdAt: new Date().toISOString(),
    settingsPath: targetPath,
    settingsMode: existingMode,
    originalFields: snapshotFields(current, patch),
  });
  process.stdout.write(`${manifestPath}\n`);
  process.exit(0);
}

const manifest = await readJson(manifestPath, null);
if (!manifest || !shouldPreserveSnapshot(manifest, targetPath)) throw new Error(`missing or mismatched policy manifest: ${manifestPath}`);

if (action === "enable") {
  const enabled = merge(current, patch);
  const appliedFields = Object.fromEntries(Object.keys(patch).map((key) => [key, clone(enabled[key])]));
  manifest.pendingAppliedFields = appliedFields;
  manifest.enabledPendingAt = new Date().toISOString();
  await atomicWrite(manifestPath, manifest);
  await atomicWrite(targetPath, enabled, manifest.settingsMode ?? 0o600);
  manifest.appliedFields = appliedFields;
  delete manifest.pendingAppliedFields;
  delete manifest.enabledPendingAt;
  manifest.enabledAt = new Date().toISOString();
  await atomicWrite(manifestPath, manifest);
  process.stdout.write("Managed configuration policy enabled.\n");
  process.exit(0);
}

restoreFields(current, manifest.originalFields ?? {}, manifest.appliedFields ?? manifest.pendingAppliedFields ?? {});
manifest.disabledAt = new Date().toISOString();
await atomicWrite(targetPath, current, manifest.settingsMode ?? 0o600);
await atomicWrite(manifestPath, manifest);
process.stdout.write("Managed configuration policy disabled; later user changes were preserved.\n");
