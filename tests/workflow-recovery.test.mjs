import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runEnforcedWorkflow, WORKFLOW_VERSION } from "../lib/workflow-state.mjs";
import { checkpointWorkflowJournal, openEvidenceRun, readEvidenceReceipt, readWorkflowJournal, recoverInterruptedWorkflowRuns, taskDigest, writeEvidenceExecution, writeEvidenceReceipt } from "../lib/workflow-evidence.mjs";

const child = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "workflow-interrupt-child.mjs");
const modelPolicy = { digest: "recovery-test-policy", roles: {} };

test("SIGKILL recovery marks RUNNING as INTERRUPTED and resumes from the last complete stage", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-recovery-"));
  const evidenceRoot = path.join(root, "evidence");
  const runId = randomUUID();
  const digest = taskDigest("simulated interruption fixture");
  try {
    const interrupted = spawnSync(process.execPath, [child], { env: { ...process.env, PI_TEST_EVIDENCE_ROOT: evidenceRoot, PI_TEST_RUN_ID: runId, PI_TEST_TASK_DIGEST: digest }, encoding: "utf8" });
    assert.equal(interrupted.signal, "SIGKILL");
    assert.throws(() => readEvidenceReceipt({ root: evidenceRoot, runId, taskDigest: digest }));

    const recovery = recoverInterruptedWorkflowRuns({ root: evidenceRoot });
    assert.deepEqual(recovery.recovered.map((entry) => entry.status), ["INTERRUPTED"]);
    const run = openEvidenceRun({ root: evidenceRoot, runId });
    let journal = readWorkflowJournal(run);
    assert.equal(journal.status, "INTERRUPTED");
    assert.equal(journal.current_phase, "CORRECTION_REQUIRED");
    assert.equal(journal.correction_performed, true);
    assert.equal(journal.workflow_state.evidence.roles.filter((entry) => entry.agent === "worker").length, 1);

    const calls = [];
    let identity = 100;
    const ownerRunId = journal.owner_run_id;
    const delegate = async ({ agent, result }) => {
      calls.push(agent);
      const response = { status: "completed", agent, model: `model-${agent}`, runId: `resume-run-${identity}`, nodeId: `${identity++}-${agent}`, ownerRunId };
      return result.kind === "structured"
        ? { ...response, result: { kind: "structured", value: { verdict: "PASS", summary: "resumed", findings: [] } } }
        : { ...response, result: { kind: "text", text: "resumed" } };
    };
    const state = await runEnforcedWorkflow({
      task: "simulated interruption fixture",
      allocation: journal.workflow_state.allocation,
      delegate,
      verify: async () => ({ status: "PASS", processExitCode: 0 }),
      ownerRunId,
      runId,
      taskId: digest,
      resumeState: journal.workflow_state,
      modelPolicy,
      onCheckpoint: (checkpoint) => {
        journal = checkpointWorkflowJournal(run, journal, { status: "RUNNING", workflow_status: checkpoint.status, current_phase: checkpoint.currentPhase, round: checkpoint.round, worker_status: checkpoint.workerStatus, tester_status: checkpoint.testerStatus, verification_status: checkpoint.verificationStatus, review_status: checkpoint.reviewStatus, blocking_findings_count: checkpoint.blockingFindingsCount, correction_performed: checkpoint.correctionPerformed, final_verification_status: checkpoint.finalVerificationStatus, workflow_state: checkpoint });
      },
    });
    assert.equal(state.status, "PASS");
    assert.equal(calls.includes("scout"), false);
    assert.equal(calls.includes("planner"), false);
    assert.equal(calls.filter((agent) => agent === "worker").length, 1);
    assert.equal(calls.filter((agent) => agent === "tester").length, 1);
    assert.equal(calls.filter((agent) => agent.endsWith("reviewer")).length, 3);
    assert.equal(state.evidence.verifications.length, 2);

    const execution = { ...state, runId, taskDigest: digest };
    writeEvidenceExecution(run, execution);
    const executionSha256 = createHash("sha256").update(fs.readFileSync(run.executionFile)).digest("hex");
    writeEvidenceReceipt(run, { ...execution, executionSha256, cleanup: { status: "PASS", resourcesAbsent: true } });
    journal = checkpointWorkflowJournal(run, journal, { status: "COMPLETED", workflow_status: "PASS", current_phase: "FINALIZED", evidence_status: "PASS", cleanup_status: "PASS", workflow_state: { workflowVersion: WORKFLOW_VERSION, status: "PASS" } });
    assert.equal(readEvidenceReceipt({ root: evidenceRoot, runId, taskDigest: digest }).receipt.status, "PASS");
    assert.equal(readWorkflowJournal(run).status, "COMPLETED");
    assert.equal(recoverInterruptedWorkflowRuns({ root: evidenceRoot }).recovered.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
