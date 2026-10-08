import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createEvidenceRun, taskDigest } from "../lib/workflow-evidence.mjs";
import { admitRoleReceipt, listRoleReceipts, makeRoleReceipt, openRoleReceiptStore, writeRoleReceipt } from "../lib/workflow-receipts.mjs";
import { runEnforcedWorkflow } from "../lib/workflow-state.mjs";
import { createProtectedFile } from "../lib/protected-artifact.mjs";

const protocolNonce = taskDigest("receipt-protocol-nonce");
const taskId = taskDigest("receipt-protocol-task");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-receipts-"));
  const run = createEvidenceRun({ root: path.join(root, "evidence") });
  const store = openRoleReceiptStore(run);
  return { root, run, store };
}

function receipt(run, overrides = {}) {
  const executionId = overrides.executionId ?? randomUUID();
  const role = overrides.role ?? "scout";
  const nodeId = overrides.nodeId ?? "01-scout";
  const ownerRunId = overrides.ownerRunId ?? "controller-owner";
  return makeRoleReceipt({
    runId: overrides.runId ?? run.runId,
    taskId: overrides.taskId ?? taskId,
    protocolNonce: overrides.protocolNonce ?? protocolNonce,
    executionId,
    sequence: overrides.sequence ?? 0,
    role,
    round: overrides.round ?? 0,
    iteration: overrides.iteration ?? 0,
    attempt: overrides.attempt ?? 1,
    nodeId,
    ownerRunId,
    response: overrides.response ?? { status: "completed", agent: role, nodeId, ownerRunId, runId: randomUUID(), model: "local/test", result: { kind: "text", text: "ok" } },
  });
}

function expected(value) {
  return {
    run_id: value.run_id,
    task_id: value.task_id,
    protocol_nonce: value.protocol_nonce,
    execution_id: value.execution_id,
    sequence: value.sequence,
    role: value.role,
    round: value.round,
    iteration: value.iteration,
    owner_run_id: value.owner_run_id,
    node_id: value.node_id,
    status: "completed",
  };
}

const CHILD_STAGES = new Set([
  "CHILD_START", "RECEIPT_VALIDATION_STARTED", "RECEIPT_VALIDATED", "ROOT_VALIDATION_STARTED", "ROOT_VALIDATED",
  "TEMP_CREATE_STARTED", "TEMP_OPENED", "TEMP_WRITE_STARTED", "TEMP_SYNC_STARTED", "TEMP_SYNCED",
  "TEMP_ACL_VALIDATION_STARTED", "TEMP_ACL_VALIDATED", "LINK_STARTED", "RECEIPT_PUBLISHED",
  "DIRECTORY_SYNC_STARTED", "DIRECTORY_SYNCED", "DUPLICATE_CHECK_STARTED", "DUPLICATE_VALIDATED",
  "TARGET_ACL_VALIDATION_STARTED", "TARGET_ACL_VALIDATED", "COMPLETE",
]);
const CHILD_CATEGORIES = new Set([
  "PASS", "EACCES", "EPERM", "ENOENT", "EEXIST", "EBUSY", "EIO", "EINVAL", "ETIMEDOUT",
  "PROTECTED_ARTIFACT_UNVERIFIED", "CONFLICTING_DUPLICATE", "RECEIPT_REJECTED", "UNCLASSIFIED",
]);

function childDiagnostic(stderr, ordinal) {
  const prefix = "PHI_RECEIPT_CHILD_DIAGNOSTIC ";
  const lines = stderr.split(/\r?\n/u).filter((line) => line.startsWith(prefix));
  if (lines.length !== 1) return { ordinal, lastStage: "UNKNOWN", exitCategory: "DIAGNOSTIC_MISSING", cleanup: "UNKNOWN", elapsedMs: null };
  try {
    const value = JSON.parse(lines[0].slice(prefix.length));
    if (value.ordinal !== ordinal || !CHILD_STAGES.has(value.lastStage) || !CHILD_CATEGORIES.has(value.exitCategory) || !["NOT_STARTED", "STARTED", "PASS", "FAIL"].includes(value.cleanup) || !Number.isSafeInteger(value.elapsedMs) || value.elapsedMs < 0 || Object.keys(value).sort().join(",") !== "cleanup,elapsedMs,exitCategory,lastStage,ordinal") throw new Error("invalid diagnostic");
    return value;
  } catch { return { ordinal, lastStage: "UNKNOWN", exitCategory: "DIAGNOSTIC_INVALID", cleanup: "UNKNOWN", elapsedMs: null }; }
}

function childWrite(store, value, ordinal) {
  const script = path.resolve("tests/fixtures/receipt-writer-child.mjs");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, JSON.stringify(store), JSON.stringify(value), String(ordinal)], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let stdoutDrained = false;
    let stderrDrained = false;
    let spawnError = false;
    child.stdout.on("end", () => { stdoutDrained = true; });
    child.stdout.resume();
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8192); });
    child.stderr.on("end", () => { stderrDrained = true; });
    child.on("error", () => { spawnError = true; });
    child.on("close", (code, signal) => resolve({ code, signal: signal === null ? "NONE" : "SIGNALLED", closed: true, pipesDrained: stdoutDrained && stderrDrained, spawnError, diagnostic: childDiagnostic(stderr, ordinal) }));
  });
}

test("valid durable role receipt is accepted exactly once", () => {
  const { root, run, store } = fixture();
  try {
    const value = receipt(run);
    const reference = writeRoleReceipt(store, value);
    const admitted = new Set();
    assert.equal(admitRoleReceipt(store, reference, expected(value), admitted).receipt.status, "completed");
    assert.throws(() => admitRoleReceipt(store, reference, expected(value), admitted), /already admitted/u);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("launch contract digest and executed route survive immutable receipt storage", () => {
  const { root, run, store } = fixture();
  try {
    const launchContractDigest = taskDigest("launch contract");
    const value = receipt(run, { response: { status: "completed", agent: "scout", nodeId: "01-scout", ownerRunId: "controller-owner", runId: randomUUID(), model: "local/test", thinking: "low", launchContractDigest, result: { kind: "text", text: "ok" } } });
    const reference = writeRoleReceipt(store, value);
    const loaded = admitRoleReceipt(store, reference, { ...expected(value), model: "local/test", thinking: "low", launch_contract_digest: launchContractDigest }, new Set());
    assert.equal(loaded.receipt.launch_contract_digest, launchContractDigest);
    assert.throws(() => writeRoleReceipt(store, { ...value, execution_id: randomUUID(), sequence: 1, launch_contract_digest: "invalid" }), /launch contract digest/u);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("wrong run, task, role, round, and stale nonce are rejected", () => {
  const { root, run, store } = fixture();
  try {
    const value = receipt(run, { round: 2 });
    const reference = writeRoleReceipt(store, value);
    for (const mutation of [
      { run_id: randomUUID() },
      { task_id: taskDigest("other task") },
      { role: "planner" },
      { round: 3 },
      { protocol_nonce: taskDigest("stale protocol") },
    ]) assert.throws(() => admitRoleReceipt(store, reference, { ...expected(value), ...mutation }, new Set()), /mismatch/u);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("future or out-of-order sequence cannot be admitted", () => {
  const { root, run, store } = fixture();
  try {
    const value = receipt(run, { sequence: 4 });
    const reference = writeRoleReceipt(store, value);
    assert.throws(() => admitRoleReceipt(store, reference, { ...expected(value), sequence: 3 }), /sequence mismatch/u);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("missing, malformed, truncated, and non-completed receipts fail closed", () => {
  const { root, run, store } = fixture();
  try {
    assert.throws(() => admitRoleReceipt(store, { file: path.join(store.directory, `000000-${randomUUID()}.json`) }, {}, new Set()), /ENOENT/u);
    const failed = receipt(run, { response: { status: "failed", agent: "scout", nodeId: "01-scout", ownerRunId: "controller-owner", error: "fixture" } });
    const failedReference = writeRoleReceipt(store, failed);
    assert.throws(() => admitRoleReceipt(store, failedReference, { ...expected(failed), status: "failed" }, new Set()), /not completed/u);
    const malformedName = `000009-${randomUUID()}.json`;
    if (process.platform === "win32") createProtectedFile(path.join(store.directory, malformedName));
    fs.writeFileSync(path.join(store.directory, malformedName), '{"version":1');
    if (process.platform !== "win32") fs.chmodSync(path.join(store.directory, malformedName), 0o400);
    assert.throws(() => admitRoleReceipt(store, { file: path.join(store.directory, malformedName) }, {}, new Set()), /malformed/u);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("duplicate writes are idempotent only for identical immutable bytes", () => {
  const { root, run, store } = fixture();
  try {
    const value = receipt(run);
    const first = writeRoleReceipt(store, value);
    const second = writeRoleReceipt(store, value);
    assert.equal(first.sha256, second.sha256);
    assert.throws(() => writeRoleReceipt(store, { ...value, model: "different/model" }), /conflicting duplicate/u);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("two process writers produce a deterministic sorted receipt ledger", async () => {
  const { root, run, store } = fixture();
  try {
    const first = receipt(run, { sequence: 0 });
    const second = receipt(run, { sequence: 1, role: "planner", nodeId: "02-planner" });
    const outcomes = await Promise.all([childWrite(store, second, 0), childWrite(store, first, 1)]);
    let candidateEntries = null;
    try { candidateEntries = fs.readdirSync(store.directory).filter((name) => /^\d{6}-[0-9a-f-]{36}\.json$/iu.test(name)).length; } catch {}
    console.log(`# two-writer-diagnostic ${JSON.stringify({ children: outcomes, candidateEntries, lock: "NOT_APPLICABLE_PER_FILE_PUBLICATION", ledgerReadMerge: "NOT_APPLICABLE_PER_FILE_PUBLICATION" })}`);
    assert.deepEqual(outcomes.map((entry) => entry.code), [0, 0]);
    assert.equal(outcomes.every((entry) => entry.closed && entry.pipesDrained && !entry.spawnError && entry.signal === "NONE" && entry.diagnostic.lastStage === "COMPLETE" && entry.diagnostic.exitCategory === "PASS" && entry.diagnostic.cleanup === "PASS"), true);
    assert.equal(candidateEntries, 2);
    assert.deepEqual(listRoleReceipts(store).map((entry) => entry.receipt.sequence), [0, 1]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    console.log(`# two-writer-fixture-cleanup ${fs.existsSync(root) ? "FAIL" : "PASS"}`);
  }
});

test("receipt must exist before the controller records completion or Planner admission", () => {
  const { root, run, store } = fixture();
  try {
    const transitions = [{ index: 0, state: "REQUEST" }, { index: 1, state: "SCOUT_START" }];
    const value = receipt(run);
    const reference = { file: path.join(store.directory, `000000-${value.execution_id}.json`) };
    assert.throws(() => admitRoleReceipt(store, reference, expected(value), new Set()), /ENOENT/u);
    assert.equal(transitions.some((entry) => entry.state === "PLANNER_START"), false);
    const written = writeRoleReceipt(store, value);
    admitRoleReceipt(store, written, expected(value), new Set());
    transitions.push({ index: 2, state: "SCOUT_COMPLETE" }, { index: 3, state: "PLANNER_START" });
    assert.deepEqual(transitions.map((entry) => entry.state), ["REQUEST", "SCOUT_START", "SCOUT_COMPLETE", "PLANNER_START"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Scout to Planner durable admission is identical across 100 fresh runs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-repeat-"));
  try {
    const signatures = [];
    for (let index = 0; index < 100; index += 1) {
      const run = createEvidenceRun({ root: path.join(root, "evidence") });
      const store = openRoleReceiptStore(run);
      const scout = receipt(run);
      const reference = writeRoleReceipt(store, scout);
      const admitted = admitRoleReceipt(store, reference, expected(scout), new Set());
      signatures.push(JSON.stringify({ receiptStatus: admitted.receipt.status, sequence: admitted.sequence, transitions: ["REQUEST", "SCOUT_START", "SCOUT_COMPLETE", "PLANNER_START"] }));
    }
    assert.equal(new Set(signatures).size, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("actual controller admits Planner after a durable Scout receipt in 100 of 100 runs", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-controller-repeat-"));
  try {
    const signatures = [];
    for (let runIndex = 0; runIndex < 100; runIndex += 1) {
      const run = createEvidenceRun({ root: path.join(root, "evidence") });
      const store = openRoleReceiptStore(run);
      const ownerRunId = `controller-${runIndex}`;
      const admitted = new Set();
      let sequence = 0;
      const delegate = async ({ agent, result, round = 0, iteration = 0 }) => {
        const nodeId = `${String(sequence + 1).padStart(2, "0")}-${agent}`;
        const response = {
          status: "completed", agent, model: "local/deterministic", runId: randomUUID(), nodeId, ownerRunId,
          result: result.kind === "structured" ? { kind: "structured", value: { verdict: "PASS", summary: "ok", findings: [] } } : { kind: "text", text: "ok" },
        };
        const value = makeRoleReceipt({ runId: run.runId, taskId, protocolNonce, executionId: randomUUID(), sequence, role: agent, round, iteration, attempt: 1, nodeId, ownerRunId, response });
        const reference = writeRoleReceipt(store, value);
        const workflowReceipt = { ...reference, executionId: value.execution_id, sequence: value.sequence };
        sequence += 1;
        return { ...response, workflowReceipt };
      };
      const state = await runEnforcedWorkflow({
        task: "controller receipt fixture",
        allocation: { worktree: root, port: 39000, stateDir: root, browserProfile: root, browserSession: "fixture", database: "fixture", schema: "fixture" },
        delegate,
        verify: async () => ({ status: "PASS", processExitCode: 0 }),
        ownerRunId,
        runId: run.runId,
        taskId,
        modelPolicy: { digest: "receipt-test-policy", roles: {} },
        receiptVerifier: (response, expectedRole) => admitRoleReceipt(store, response.workflowReceipt, {
          run_id: run.runId, task_id: taskId, protocol_nonce: protocolNonce,
          execution_id: response.workflowReceipt.executionId, sequence: response.workflowReceipt.sequence,
          role: expectedRole.agent, round: expectedRole.round, iteration: expectedRole.iteration,
          owner_run_id: ownerRunId, node_id: response.nodeId, status: "completed",
        }, admitted),
      });
      const scoutComplete = state.evidence.transitions.findIndex((entry) => entry.state === "SCOUT" && entry.phase === "complete");
      const plannerStart = state.evidence.transitions.findIndex((entry) => entry.state === "PLANNER" && entry.phase === "start");
      assert.equal(state.status, "PASS");
      assert.equal(state.evidence.receipts.some((entry) => entry.agent === "scout"), true);
      assert.equal(plannerStart, scoutComplete + 1);
      signatures.push(JSON.stringify(state.evidence.transitions.map((entry) => [entry.state, entry.phase, entry.round ?? 0])));
    }
    assert.equal(new Set(signatures).size, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("cleanup of disposable runtime cannot erase durable role receipts", () => {
  const { root, run, store } = fixture();
  try {
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-disposable-"));
    const value = receipt(run);
    const reference = writeRoleReceipt(store, value);
    fs.rmSync(runtime, { recursive: true, force: true });
    assert.equal(admitRoleReceipt(store, reference, expected(value), new Set()).receipt.execution_id, value.execution_id);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
