import test from "node:test";
import assert from "node:assert/strict";
import { validateWorkflowEvidence } from "../lib/e2e-evidence.mjs";

const models = {
  scout: "openai-codex/gpt-5.6-luna:low", planner: "openai-codex/gpt-5.6-sol:high", oracle: "openai-codex/gpt-6-astra:high",
  worker: "openai-codex/gpt-5.6-terra:high", tester: "openai-codex/gpt-5.6-luna:medium", "correctness-reviewer": "openai-codex/gpt-5.6-sol:high",
  "security-reviewer": "openai-codex/gpt-5.6-sol:high", "simplicity-reviewer": "openai-codex/gpt-5.6-luna:medium",
};
let identity = 0;
const ownerRunId = "secure-owner";
const roles = Object.entries(models).flatMap(([agent, model]) => [{ agent, model, status: "completed", runId: `run-${identity}`, nodeId: `node-${identity++}`, ownerRunId }, ...(["worker", "tester", "correctness-reviewer", "security-reviewer", "simplicity-reviewer"].includes(agent) ? [{ agent, model, status: "completed", runId: `run-${identity}`, nodeId: `node-${identity++}`, ownerRunId }] : [])]);
const receipts = roles.map((role, sequence) => ({ agent: role.agent, round: sequence >= 8 ? 1 : 0, iteration: role.agent === "worker" && sequence >= 8 ? 1 : 0, executionId: `00000000-0000-4000-8${String(sequence).padStart(3, "0")}-000000000001`, sequence, sha256: sequence.toString(16).padStart(64, "0") }));
for (let index = 0; index < roles.length; index += 1) {
  roles[index].round = receipts[index].round;
  roles[index].iteration = receipts[index].iteration;
  roles[index].receipt = { executionId: receipts[index].executionId, sequence: receipts[index].sequence, sha256: receipts[index].sha256 };
}
const valid = {
  runId: "00000000-0000-4000-8000-000000000001", taskDigest: "a".repeat(64), ownerRunId,
  workflowVersion: 4, status: "PASS", hardLimits: { concurrency: 3, subagentDepth: 1 },
  cleanupStatus: "PASS", evidenceStatus: "PASS", cleanup: { status: "PASS", resourcesAbsent: true },
  evidence: {
    roles,
    receipts,
    verifications: [{ status: "FAIL", processExitCode: 1 }, { status: "PASS", processExitCode: 0 }],
    reviews: [{ reviews: [{ blocking: true, verdict: "BLOCKING", findingSeverities: ["BLOCKING"] }] }, { reviews: [{ blocking: false, verdict: "PASS", findingSeverities: [] }] }],
    transitions: ["SCOUT", "PLANNER", "ORACLE", "WORKER", "TESTER", "VERIFICATION", "REVIEW", "CORRECTION_REQUIRED", "WORKER", "TESTER", "VERIFICATION", "REVIEW", "FINAL"].map((state) => ({ state, phase: state === "CORRECTION_REQUIRED" ? "enforced" : "complete" })),
  },
};
valid.finalVerdict = {
  run_id: valid.runId,
  task_id: valid.taskDigest,
  workflow_version: 4,
  status: "PASS",
  round_count: 2,
  worker_status: "completed",
  tester_status: "completed",
  verification_status: "PASS",
  review_status: "PASS",
  blocking_count: 0,
  blocking_findings_count: 0,
  correction_performed: true,
  final_verification_status: "PASS",
  cleanup_status: "PASS",
  evidence_status: "PASS",
};

test("structured E2E validator accepts complete evidence and rejects false-positive controls", () => {
  assert.equal(validateWorkflowEvidence(valid, { requireCorrection: true, requireCleanup: true }).valid, true);
  assert.equal(validateWorkflowEvidence({ ...valid, status: "FAIL" }, { requireCorrection: true }).valid, false);
  assert.equal(validateWorkflowEvidence({ ...valid, evidence: { ...valid.evidence, roles: roles.filter((entry) => entry.agent !== "scout") } }, { requireCorrection: true }).valid, false);
  assert.equal(validateWorkflowEvidence({ ...valid, evidence: { ...valid.evidence, verifications: [{ status: "PASS", processExitCode: 7 }] } }, { requireCorrection: true }).valid, false);
  assert.equal(validateWorkflowEvidence({ ...valid, evidence: { ...valid.evidence, transitions: valid.evidence.transitions.filter((entry) => entry.state !== "CORRECTION_REQUIRED") } }, { requireCorrection: true }).valid, false);
  assert.equal(validateWorkflowEvidence({ ...valid, ownerRunId: "other-owner" }, { requireCorrection: true }).valid, false);
  const duplicateIdentity = structuredClone(valid);
  duplicateIdentity.evidence.roles[1].nodeId = duplicateIdentity.evidence.roles[0].nodeId;
  assert.equal(validateWorkflowEvidence(duplicateIdentity, { requireCorrection: true }).valid, false);
  const missingReceipt = structuredClone(valid);
  missingReceipt.evidence.receipts.pop();
  assert.equal(validateWorkflowEvidence(missingReceipt, { requireCorrection: true }).valid, false);
  assert.equal(validateWorkflowEvidence({ ...valid, evidenceStatus: "RUNNING" }, { requireCorrection: true, requireCleanup: true }).valid, false);
  assert.equal(validateWorkflowEvidence({ ...valid, cleanupStatus: "NOT_RUN" }, { requireCorrection: true, requireCleanup: true }).valid, false);
});
