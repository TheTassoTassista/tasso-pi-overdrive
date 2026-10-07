import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertProtectedArtifact, ensureProtectedDirectory } from "../lib/protected-artifact.mjs";
import { captureProcessIdentity, inspectProcessIdentity } from "../lib/process-identity.mjs";
import { ownedWindowsHelper } from "../platform/windows/process.mjs";
import { createEvidenceRun, initialWorkflowJournal, readEvidenceReceipt, taskDigest, writeEvidenceExecution, writeEvidenceReceipt, writeWorkflowJournal } from "../lib/workflow-evidence.mjs";

test("POSIX protected artifact predicate preserves owner-only mode", { skip: process.platform === "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phi-protected-posix-"));
  try {
    const directory = path.join(root, "private");
    ensureProtectedDirectory(directory);
    assertProtectedArtifact(directory, "directory", "directory unprotected");
    const file = path.join(directory, "receipt.json");
    fs.writeFileSync(file, "{}\n", { mode: 0o600 });
    assertProtectedArtifact(file, "file", "file unprotected");
    fs.chmodSync(file, 0o644);
    assert.throws(() => assertProtectedArtifact(file, "file", "file unprotected"), /unprotected/u);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("native Windows process generation matches the shared recovery primitive and detects exit", { skip: process.platform !== "win32" }, async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore", windowsHide: true });
  let identity;
  try {
    identity = captureProcessIdentity(child.pid);
    const native = spawnSync(ownedWindowsHelper(), ["--process-identity", String(child.pid)], { encoding: "utf8", windowsHide: true });
    assert.equal(native.status, 0);
    assert.equal(JSON.parse(native.stdout).creationTime, identity.creationTime);
    assert.equal(inspectProcessIdentity(identity).alive, true);
    assert.equal(inspectProcessIdentity({ ...identity, creationTime: identity.creationTime === "0000000000000000" ? "0000000000000001" : "0000000000000000" }).reason, "pid-reused");
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("close", resolve));
  }
  assert.equal(inspectProcessIdentity(identity).alive, false);
});

test("native protected ACL policy creates, validates and rejects permissive/null/unverifiable descriptors", { skip: process.platform !== "win32" }, () => {
  const result = spawnSync(ownedWindowsHelper(), ["--protected-artifact-selftest"], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { status: "PASS", trustedAcl: true, permissiveRejected: true, nullRejected: true, missingRejected: true });
});

test("Windows evidence creation rejects an existing unprotected fixture root", { skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phi-unprotected-evidence-"));
  try {
    const weakened = spawnSync("icacls", [root, "/grant", "*S-1-1-0:(R)"], { windowsHide: true, encoding: "utf8" });
    assert.equal(weakened.status, 0);
    assert.throws(() => createEvidenceRun({ root }), /protected artifact security could not be verified/u);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Windows workflow writer and reader agree on protected ACL and reject a permissive receipt", { skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phi-protected-flow-"));
  try {
    const run = createEvidenceRun({ root: path.join(root, "evidence"), runId: randomUUID() });
    const digest = taskDigest("protected artifact fixture");
    writeWorkflowJournal(run, initialWorkflowJournal(run, { taskDigest: digest, workflowVersion: 4, sourceRepository: root, ownerRunId: "owner" }));
    assert.equal(path.basename(run.stateFile), "state.win-v1.json");
    assert.equal(fs.existsSync(path.join(run.directory, "state.json")), false, "legacy reader must not reinterpret Windows process identity");
    writeEvidenceExecution(run, { runId: run.runId, taskDigest: digest, status: "PASS" });
    const executionSha256 = createHash("sha256").update(fs.readFileSync(run.executionFile)).digest("hex");
    writeEvidenceReceipt(run, { runId: run.runId, taskDigest: digest, executionSha256, status: "PASS" });
    assert.equal(readEvidenceReceipt({ root: run.root, runId: run.runId, taskDigest: digest }).receipt.status, "PASS");
    const weakened = spawnSync("icacls", [run.receiptFile, "/grant", "*S-1-1-0:(R)"], { windowsHide: true, encoding: "utf8" });
    assert.equal(weakened.status, 0);
    assert.throws(() => readEvidenceReceipt({ root: run.root, runId: run.runId, taskDigest: digest }), /protected|verified/u);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
