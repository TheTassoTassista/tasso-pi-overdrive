import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { checkpointWorkflowJournal, createEvidenceRun, initialWorkflowJournal, readEvidenceReceipt, readWorkflowJournal, recoverInterruptedWorkflowRuns, taskDigest, writeEvidenceExecution, writeEvidenceReceipt, writeWorkflowJournal } from "../lib/workflow-evidence.mjs";

function writeRun(run, digest) {
  const execution = { runId: run.runId, taskDigest: digest, status: "PASS", evidence: { roles: [], transitions: [], verifications: [], reviews: [] } };
  writeEvidenceExecution(run, execution);
  const executionSha256 = createHash("sha256").update(fs.readFileSync(run.executionFile)).digest("hex");
  writeEvidenceReceipt(run, { ...execution, executionSha256, cleanup: { status: "PASS" } });
}

test("run-specific evidence survives disposable cleanup and rejects stale, foreign, missing, malformed, and wrong-task proof", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-evidence-"));
  const evidenceRoot = path.join(root, "evidence");
  const disposable = path.join(root, "runtime");
  const runId = randomUUID();
  const digest = taskDigest("current task");
  try {
    fs.mkdirSync(disposable);
    const run = createEvidenceRun({ root: evidenceRoot, runId });
    writeRun(run, digest);
    fs.rmSync(disposable, { recursive: true, force: true });
    assert.equal(readEvidenceReceipt({ root: evidenceRoot, runId, taskDigest: digest }).receipt.status, "PASS");
    assert.throws(() => createEvidenceRun({ root: evidenceRoot, runId }), /exist/iu);
    assert.throws(() => readEvidenceReceipt({ root: evidenceRoot, runId, taskDigest: taskDigest("other task") }), /another task/iu);
    assert.throws(() => readEvidenceReceipt({ root: evidenceRoot, runId: randomUUID() }));

    const foreignId = randomUUID();
    const foreignDir = path.join(evidenceRoot, foreignId);
    fs.mkdirSync(foreignDir, { mode: 0o700 });
    fs.copyFileSync(run.receiptFile, path.join(foreignDir, "receipt.json"));
    fs.copyFileSync(run.executionFile, path.join(foreignDir, "execution.json"));
    fs.chmodSync(path.join(foreignDir, "receipt.json"), 0o400);
    fs.chmodSync(path.join(foreignDir, "execution.json"), 0o400);
    assert.throws(() => readEvidenceReceipt({ root: evidenceRoot, runId: foreignId }), /another run/iu);

    const malformedId = randomUUID();
    const malformedDir = path.join(evidenceRoot, malformedId);
    fs.mkdirSync(malformedDir, { mode: 0o700 });
    fs.writeFileSync(path.join(malformedDir, "receipt.json"), "not-json\n", { mode: 0o400 });
    assert.throws(() => readEvidenceReceipt({ root: evidenceRoot, runId: malformedId }), /malformed/iu);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("incomplete and malformed crash artifacts fail closed without invalidating prior evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-evidence-crash-"));
  try {
    const interrupted = createEvidenceRun({ root, runId: randomUUID() });
    const digest = taskDigest("interrupted task");
    const journal = initialWorkflowJournal(interrupted, { taskDigest: digest, workflowVersion: 4, sourceRepository: "/tmp/source", ownerRunId: "owner" });
    journal.process.bootId = "00000000-0000-0000-0000-000000000000";
    journal.current_phase = "CLEANUP";
    journal.cleanup_status = "PASS";
    journal.workflow_status = "PASS";
    writeWorkflowJournal(interrupted, journal);
    writeEvidenceExecution(interrupted, { runId: interrupted.runId, taskDigest: digest, status: "PASS" });
    const recovered = recoverInterruptedWorkflowRuns({ root });
    assert.equal(recovered.recovered[0].status, "INTERRUPTED");
    assert.equal(readWorkflowJournal(interrupted).evidence_status, "INCOMPLETE");
    assert.throws(() => readEvidenceReceipt({ root, runId: interrupted.runId, taskDigest: digest }));

    const malformed = createEvidenceRun({ root, runId: randomUUID() });
    fs.writeFileSync(malformed.stateFile, "{\"status\":", { mode: 0o600 });
    const malformedRecovery = recoverInterruptedWorkflowRuns({ root });
    assert.equal(malformedRecovery.inconsistent.some((entry) => entry.runId === malformed.runId), true);
    assert.equal(readWorkflowJournal(malformed).status, "INCONSISTENT");
    assert.equal(fs.readdirSync(malformed.directory).some((name) => name.startsWith("state.corrupt-")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workflow journal checkpoint sequence is controller-owned and monotonic", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-journal-order-"));
  try {
    const run = createEvidenceRun({ root });
    let journal = initialWorkflowJournal(run, { taskDigest: taskDigest("ordered"), workflowVersion: 4, sourceRepository: "/tmp/source", ownerRunId: "owner" });
    writeWorkflowJournal(run, journal);
    assert.equal(readWorkflowJournal(run).checkpoint_seq, 0);
    journal = checkpointWorkflowJournal(run, journal, { checkpoint_seq: 999, current_phase: "SCOUT" });
    assert.equal(journal.checkpoint_seq, 1);
    journal = checkpointWorkflowJournal(run, journal, { checkpoint_seq: 0, current_phase: "PLANNER" });
    assert.equal(readWorkflowJournal(run).checkpoint_seq, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
