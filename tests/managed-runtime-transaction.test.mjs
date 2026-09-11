import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promoteManagedRuntime, recoverManagedRuntime } from "../lib/managed-runtime-transaction.mjs";

const childFixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "managed-runtime-crash-child.mjs");
const roots = [];
const required = ["bin/rust-analyzer", "rust-src/core/lib.rs", "go/bin/go", "bin/gopls", "provenance.json"];
const removeTree = (root) => fs.rmSync(root, { recursive: true, force: true });
const digest = (value) => createHash("sha256").update(value).digest("hex");

function root() {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "pi-managed-runtime-"));
  roots.push(value);
  return value;
}

function writeRuntime(directory, generation, { missing = [], corrupt = false, simple = false } = {}) {
  fs.mkdirSync(directory, { recursive: true });
  if (simple) {
    fs.writeFileSync(path.join(directory, "install-record.json"), `${JSON.stringify({ valid: true, generation })}\n`);
    return;
  }
  const hashes = {};
  for (const relative of required) {
    if (missing.includes(relative)) continue;
    const target = path.join(directory, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const content = `${generation}:${relative}\n`;
    fs.writeFileSync(target, content);
    hashes[relative] = digest(content);
  }
  fs.writeFileSync(path.join(directory, "install-record.json"), `${JSON.stringify({ generation, hashes })}\n`);
  if (corrupt) fs.appendFileSync(path.join(directory, "bin", "gopls"), "corrupt\n");
}

function inspect(directory) {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(directory, "install-record.json"), "utf8"));
    for (const relative of required) {
      const content = fs.readFileSync(path.join(directory, relative));
      if (digest(content) !== record.hashes?.[relative]) return { status: "FAIL" };
    }
    return { status: "PASS", generation: record.generation };
  } catch {
    return { status: "FAIL" };
  }
}

function generation(runtimeRoot) {
  return JSON.parse(fs.readFileSync(path.join(runtimeRoot, "managed", "install-record.json"), "utf8")).generation;
}

after(() => {
  for (const directory of roots) removeTree(directory);
});

test("failure before staging exists leaves a valid active runtime unchanged", () => {
  const runtimeRoot = root();
  writeRuntime(path.join(runtimeRoot, "managed"), "old");
  const result = recoverManagedRuntime({ runtimeRoot, inspect, removeTree });
  assert.equal(result.action, "UNCHANGED");
  assert.equal(generation(runtimeRoot), "old");
});

test("half-installed Rust staging is disposable and cannot affect active", () => {
  const runtimeRoot = root();
  writeRuntime(path.join(runtimeRoot, "managed"), "old");
  writeRuntime(path.join(runtimeRoot, ".managed-install-half-rust"), "new", { missing: required.slice(1) });
  const result = recoverManagedRuntime({ runtimeRoot, inspect, removeTree });
  assert.equal(result.action, "DISCARDED_STALE_STAGING");
  assert.equal(result.discardedStaging, 1);
  assert.equal(generation(runtimeRoot), "old");
});

test("staging with Rust but missing gopls is rejected without touching active", () => {
  const runtimeRoot = root();
  writeRuntime(path.join(runtimeRoot, "managed"), "old");
  const staging = path.join(runtimeRoot, ".managed-install-no-gopls");
  writeRuntime(staging, "new", { missing: ["bin/gopls"] });
  assert.throws(() => promoteManagedRuntime({ runtimeRoot, stagingRoot: staging, inspect, removeTree }), /staging_validation_failed/u);
  assert.equal(generation(runtimeRoot), "old");
  assert.ok(fs.existsSync(staging));
});

test("complete files with an invalid hash are rejected before swap", () => {
  const runtimeRoot = root();
  writeRuntime(path.join(runtimeRoot, "managed"), "old");
  const staging = path.join(runtimeRoot, ".managed-install-bad-hash");
  writeRuntime(staging, "new", { corrupt: true });
  assert.throws(() => promoteManagedRuntime({ runtimeRoot, stagingRoot: staging, inspect, removeTree }), /staging_validation_failed/u);
  assert.equal(generation(runtimeRoot), "old");
});

test("failure immediately before swap leaves active unchanged", () => {
  const runtimeRoot = root();
  writeRuntime(path.join(runtimeRoot, "managed"), "old");
  const staging = path.join(runtimeRoot, ".managed-install-before-swap");
  writeRuntime(staging, "new");
  assert.throws(() => promoteManagedRuntime({ runtimeRoot, stagingRoot: staging, inspect, removeTree, fault: (point) => { if (point === "before_swap") throw new Error("injected"); } }), /injected/u);
  assert.equal(generation(runtimeRoot), "old");
  assert.ok(fs.existsSync(staging));
});

test("failure after preserving previous runtime rolls back deterministically", () => {
  const runtimeRoot = root();
  writeRuntime(path.join(runtimeRoot, "managed"), "old");
  const staging = path.join(runtimeRoot, ".managed-install-after-preserve");
  writeRuntime(staging, "new");
  assert.throws(() => promoteManagedRuntime({ runtimeRoot, stagingRoot: staging, inspect, removeTree, transactionId: "rollback", fault: (point) => { if (point === "after_previous_preserved") throw new Error("injected"); } }), /injected/u);
  assert.equal(generation(runtimeRoot), "old");
  assert.ok(fs.existsSync(staging));
  assert.equal(fs.existsSync(path.join(runtimeRoot, ".managed-previous-rollback")), false);
});

test("failed post-promotion validation restores previous runtime", () => {
  const runtimeRoot = root();
  writeRuntime(path.join(runtimeRoot, "managed"), "old");
  const staging = path.join(runtimeRoot, ".managed-install-post-fail");
  writeRuntime(staging, "new");
  assert.throws(() => promoteManagedRuntime({
    runtimeRoot,
    stagingRoot: staging,
    inspect,
    removeTree,
    transactionId: "post-fail",
    fault: (point) => { if (point === "after_promotion") fs.appendFileSync(path.join(runtimeRoot, "managed", "bin", "gopls"), "invalid\n"); },
  }), /post_promotion_validation_failed/u);
  assert.equal(generation(runtimeRoot), "old");
  assert.equal(fs.existsSync(path.join(runtimeRoot, ".managed-previous-post-fail")), false);
});

test("successful promotion validates new runtime before deleting previous", () => {
  const runtimeRoot = root();
  writeRuntime(path.join(runtimeRoot, "managed"), "old");
  const staging = path.join(runtimeRoot, ".managed-install-success");
  writeRuntime(staging, "new");
  let promotedValidated = false;
  const inspecting = (directory) => {
    const result = inspect(directory);
    if (path.basename(directory) === "managed" && result.status === "PASS" && result.generation === "new") promotedValidated = true;
    return result;
  };
  const removing = (directory) => {
    if (path.basename(directory).startsWith(".managed-previous-")) assert.equal(promotedValidated, true, "previous runtime removed before post-promotion validation");
    removeTree(directory);
  };
  const result = promoteManagedRuntime({ runtimeRoot, stagingRoot: staging, inspect: inspecting, removeTree: removing, transactionId: "success" });
  assert.equal(result.status, "PASS");
  assert.equal(result.previousRemoved, true);
  assert.equal(generation(runtimeRoot), "new");
  assert.equal(fs.existsSync(staging), false);
  assert.equal(fs.existsSync(path.join(runtimeRoot, ".managed-previous-success")), false);
});

test("abrupt child interruption is recovered on the next invocation", () => {
  const runtimeRoot = root();
  writeRuntime(path.join(runtimeRoot, "managed"), "old", { simple: true });
  const staging = path.join(runtimeRoot, ".managed-install-abrupt");
  writeRuntime(staging, "new", { simple: true });
  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, [childFixture, runtimeRoot, staging], { encoding: "utf8", env: childEnvironment });
  assert.equal(child.signal, "SIGKILL", child.stderr);
  assert.equal(fs.existsSync(path.join(runtimeRoot, "managed")), false);
  assert.ok(fs.existsSync(path.join(runtimeRoot, ".managed-previous-abrupt-child")));
  const simpleInspect = (directory) => {
    try { return { status: JSON.parse(fs.readFileSync(path.join(directory, "install-record.json"), "utf8")).valid === true ? "PASS" : "FAIL" }; }
    catch { return { status: "FAIL" }; }
  };
  const recovered = recoverManagedRuntime({ runtimeRoot, inspect: simpleInspect, removeTree });
  assert.match(recovered.action, /^ROLLED_BACK_PREVIOUS/u);
  assert.equal(JSON.parse(fs.readFileSync(path.join(runtimeRoot, "managed", "install-record.json"), "utf8")).generation, "old");
  assert.equal(fs.existsSync(staging), false);
});

test("recovery is deterministic for completed promotion and valid staged leftovers", () => {
  const completed = root();
  writeRuntime(path.join(completed, "managed"), "new");
  writeRuntime(path.join(completed, ".managed-previous-complete"), "old");
  const completedResult = recoverManagedRuntime({ runtimeRoot: completed, inspect, removeTree });
  assert.equal(completedResult.action, "COMPLETED_PROMOTION_CLEANED");
  assert.equal(generation(completed), "new");

  const staged = root();
  writeRuntime(path.join(staged, "managed"), "old");
  writeRuntime(path.join(staged, ".managed-install-complete"), "new");
  const downloadCache = path.join(staged, "download-cache");
  fs.mkdirSync(downloadCache);
  fs.writeFileSync(path.join(downloadCache, "archive.stale.tmp"), "untrusted partial download\n");
  const stagedResult = recoverManagedRuntime({ runtimeRoot: staged, inspect, removeTree });
  assert.equal(stagedResult.action, "DISCARDED_STALE_STAGING");
  assert.equal(generation(staged), "old");
  assert.ok(fs.existsSync(path.join(downloadCache, "archive.stale.tmp")), "transaction recovery must not trust or mutate download cache");
});

test("missing active runtime is restored from one valid preserved previous", () => {
  const runtimeRoot = root();
  writeRuntime(path.join(runtimeRoot, ".managed-previous-restore"), "old");
  const result = recoverManagedRuntime({ runtimeRoot, inspect, removeTree });
  assert.equal(result.action, "ROLLED_BACK_PREVIOUS");
  assert.equal(generation(runtimeRoot), "old");
});
