import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { merge, removeSelectedPackages, replaceLocalPackageRoot, restoreFields, shouldPreserveSnapshot, snapshotFields } from "../lib/settings.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tool = path.join(root, "scripts", "settings-tool.mjs");

test("shipped GPT-6 daily defaults migrate only defaults without altering role routes or auth", () => {
  const shipped = JSON.parse(fs.readFileSync(path.join(root, "config/settings-patch.json"), "utf8"));
  assert.equal(shipped.defaultProvider, "openai-codex");
  assert.equal(shipped.defaultModel, "gpt-6-sol");
  assert.equal(shipped.defaultThinkingLevel, "medium");
  assert.equal(shipped.subagents.defaultModel, "openai-codex/gpt-6-sol");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gpt6-default-"));
  try {
    const settings = path.join(temporary, "settings.json");
    const patch = path.join(temporary, "patch.json");
    const manifest = path.join(temporary, "manifest.json");
    const auth = path.join(temporary, "auth.json");
    const original = { defaultProvider: "openai-codex", defaultModel: "gpt-5.6-terra", defaultThinkingLevel: "medium", subagents: structuredClone(shipped.subagents) };
    fs.writeFileSync(settings, JSON.stringify(original));
    fs.writeFileSync(auth, '{"fixture":"untouched"}');
    const authBefore = fs.readFileSync(auth);
    fs.writeFileSync(patch, JSON.stringify(Object.fromEntries(["defaultProvider", "defaultModel", "defaultThinkingLevel"].map(k => [k, shipped[k]]))));
    for (const action of ["snapshot", "enable"]) assert.equal(spawnSync(process.execPath, [tool, action, settings, patch, manifest, root], { encoding: "utf8" }).status, 0);
    const activated = JSON.parse(fs.readFileSync(settings));
    assert.equal(activated.defaultModel, "gpt-6-sol");
    assert.deepEqual(activated.subagents, original.subagents);
    assert.deepEqual(fs.readFileSync(auth), authBefore);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test("enable/disable is reversible, preserves later user changes, and keeps the first snapshot", () => {
  const settingsPath = "/tmp/pi-overdrive-settings/agent/settings.json";
  const packageRoot = "/tmp/pi-overdrive-settings/package";
  const original = { defaultProvider: "before", defaultModel: "before-model", packages: ["npm:user-owned@1.0.0"] };
  const patch = { defaultProvider: "after", defaultModel: "after-model" };
  const manifest = {
    version: 1,
    settingsPath,
    originalFields: snapshotFields(original, patch),
    originalPackages: [...original.packages],
    selectedSources: ["npm:selected@2.0.0"],
    packageRoot,
  };
  assert.equal(shouldPreserveSnapshot(manifest, settingsPath), true);

  const enabled = merge(original, patch);
  manifest.appliedFields = Object.fromEntries(Object.keys(patch).map((key) => [key, structuredClone(enabled[key])]));
  enabled.defaultModel = "later-user-choice";
  enabled.packages.push("npm:selected@2.0.0", path.relative(path.dirname(settingsPath), packageRoot));

  restoreFields(enabled, manifest.originalFields, manifest.appliedFields);
  removeSelectedPackages(enabled, manifest, settingsPath);
  assert.equal(enabled.defaultProvider, "before");
  assert.equal(enabled.defaultModel, "later-user-choice");
  assert.deepEqual(enabled.packages, ["npm:user-owned@1.0.0"]);
});

test("stable package migration removes old and duplicate local roots only", () => {
  const settingsPath = "/home/user/.pi/agent/settings.json";
  const oldRoot = "/home/user/dated/output/tasso-pi-overdrive";
  const stableRoot = "/home/user/Projects/tasso-pi-overdrive";
  const settings = { packages: [oldRoot, "npm:fixed@1.2.3", stableRoot, { source: "../other-local" }] };
  replaceLocalPackageRoot(settings, settingsPath, oldRoot, stableRoot);
  assert.deepEqual(settings.packages, ["npm:fixed@1.2.3", { source: "../other-local" }, stableRoot]);
});

test("activation makes Pi settings owner-only while disable restores their original mode", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-settings-mode-"));
  const settings = path.join(temporary, "settings.json");
  const patch = path.join(temporary, "patch.json");
  const manifest = path.join(temporary, "manifest.json");
  const run = (action) => spawnSync(process.execPath, [tool, action, settings, patch, manifest, root], { encoding: "utf8" });
  try {
    fs.writeFileSync(settings, '{"defaultModel":"legacy"}\n', { mode: 0o644 });
    fs.chmodSync(settings, 0o644);
    fs.writeFileSync(patch, '{"defaultModel":"reviewed"}\n', { mode: 0o600 });
    assert.equal(run("snapshot").status, 0);
    assert.equal(run("enable").status, 0);
    assert.equal(fs.statSync(settings).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(settings, "utf8")).defaultModel, "reviewed");
    assert.equal(run("disable").status, 0);
    assert.equal(fs.statSync(settings).mode & 0o777, 0o644);
    assert.equal(JSON.parse(fs.readFileSync(settings, "utf8")).defaultModel, "legacy");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
