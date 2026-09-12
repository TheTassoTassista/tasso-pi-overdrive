import { assertModelRoute } from "./model-policy.mjs";

const ROUTING = Object.freeze({
  scout: { model: "openai-codex/gpt-5.6-luna", thinking: "low" },
  planner: { model: "openai-codex/gpt-5.6-sol", thinking: "high" },
  oracle: { model: "openai-codex/gpt-6-astra", thinking: "high" },
  worker: { model: "openai-codex/gpt-5.6-terra", thinking: "high" },
  tester: { model: "openai-codex/gpt-5.6-luna", thinking: "medium" },
  "correctness-reviewer": { model: "openai-codex/gpt-5.6-sol", thinking: "high" },
  "security-reviewer": { model: "openai-codex/gpt-5.6-sol", thinking: "high" },
  "simplicity-reviewer": { model: "openai-codex/gpt-5.6-luna", thinking: "medium" },
});

export function validateWorkflowEvidence(state, options = {}) {
  const errors = [];
  const requireCorrection = options.requireCorrection === true;
  if (!state || typeof state !== "object") return { valid: false, errors: ["missing structured workflow state"] };
  if (state.status !== "PASS") errors.push(`workflow status is ${state.status ?? "missing"}`);
  if (state.workflowVersion !== 5) errors.push("workflow version is not 5");
  if (!/^[0-9a-f-]{36}$/iu.test(state.runId ?? "")) errors.push("workflow evidence run id is missing");
  if (!/^[0-9a-f]{64}$/u.test(state.taskDigest ?? "")) errors.push("workflow task digest is missing");
  if (typeof state.ownerRunId !== "string" || !state.ownerRunId) errors.push("workflow delegation owner id is missing");
  if (state.hardLimits?.concurrency !== 3) errors.push("concurrency hard limit is not 3");
  if (state.hardLimits?.subagentDepth !== 1) errors.push("subagent depth hard limit is not 1");
  const roles = Array.isArray(state.evidence?.roles) ? state.evidence.roles : [];
  for (const [role, route] of Object.entries(ROUTING)) {
    const matches = roles.filter((entry) => entry.agent === role && entry.status === "completed");
    if (matches.length === 0) errors.push(`${role} has no completed runtime evidence`);
    if (matches.some((entry) => { try { return !assertModelRoute(route, entry); } catch { return true; } })) errors.push(`${role} used an unintended model or thinking level`);
    if (matches.some((entry) => typeof entry.runId !== "string" || typeof entry.nodeId !== "string" || entry.ownerRunId !== state.ownerRunId)) errors.push(`${role} evidence identity is missing or belongs to another workflow`);
  }
  const nodeIds = roles.filter((entry) => typeof entry.nodeId === "string").map((entry) => entry.nodeId);
  if (new Set(nodeIds).size !== nodeIds.length) errors.push("delegated node evidence was reused");
  const receipts = Array.isArray(state.evidence?.receipts) ? state.evidence.receipts : [];
  const executionIds = receipts.map((entry) => entry.executionId);
  const receiptSequences = receipts.map((entry) => entry.sequence);
  if (receipts.length !== roles.filter((entry) => entry.status === "completed").length) errors.push("completed roles do not have one admitted receipt each");
  if (new Set(executionIds).size !== executionIds.length) errors.push("role execution receipt was reused");
  if (new Set(receiptSequences).size !== receiptSequences.length) errors.push("role receipt sequence was reused");
  for (const role of roles.filter((entry) => entry.status === "completed")) {
    const reference = role.receipt;
    const matched = receipts.find((entry) => entry.executionId === reference?.executionId && entry.sequence === reference?.sequence && entry.sha256 === reference?.sha256 && entry.agent === role.agent && (entry.round ?? 0) === (role.round ?? 0) && (entry.iteration ?? 0) === (role.iteration ?? 0));
    if (!matched || !/^[0-9a-f-]{36}$/iu.test(reference?.executionId ?? "") || !/^[0-9a-f]{64}$/u.test(reference?.sha256 ?? "")) errors.push(`${role.agent} durable role receipt is missing or mismatched`);
  }
  const verifications = Array.isArray(state.evidence?.verifications) ? state.evidence.verifications : [];
  if (verifications.length === 0) errors.push("no verification executed");
  for (const verification of verifications) {
    if (verification.status === "PASS" && verification.processExitCode !== 0) errors.push("verification reported PASS with non-zero process exit");
    if (verification.status === "NO_CHECKS") errors.push("NO_CHECKS was treated as workflow evidence");
  }
  if (verifications.at(-1)?.status !== "PASS") errors.push("final verification is not PASS");
  const reviews = Array.isArray(state.evidence?.reviews) ? state.evidence.reviews : [];
  if (reviews.length === 0) errors.push("no post-implementation review round executed");
  const finalReviews = reviews.at(-1)?.reviews ?? [];
  if (finalReviews.some((review) => review.blocking || review.verdict === "BLOCKING")) errors.push("final review still has blocking findings");
  const transitions = Array.isArray(state.evidence?.transitions) ? state.evidence.transitions : [];
  const completed = transitions.filter((entry) => entry.phase === "complete").map((entry) => entry.state);
  for (const expected of ["SCOUT", "PLANNER", "ORACLE", "WORKER", "TESTER", "VERIFICATION", "REVIEW", "FINAL"]) {
    if (!completed.includes(expected)) errors.push(`missing completed transition ${expected}`);
  }
  const correctionCount = transitions.filter((entry) => entry.state === "CORRECTION_REQUIRED" && entry.phase === "enforced").length;
  if (requireCorrection && correctionCount < 1) errors.push("planted blocking review did not force correction");
  if (requireCorrection && roles.filter((entry) => entry.agent === "worker").length < 2) errors.push("corrected Worker run is missing");
  if (requireCorrection && verifications.length < 2) errors.push("verification was not rerun after correction");
  const verdict = state.finalVerdict;
  if (!verdict || typeof verdict !== "object") errors.push("final structured verdict is missing");
  else {
    if (verdict.run_id !== state.runId || verdict.task_id !== state.taskDigest) errors.push("final verdict identity mismatch");
    if (verdict.workflow_version !== state.workflowVersion) errors.push("final verdict workflow version mismatch");
    if (verdict.status !== state.status) errors.push("final verdict status mismatch");
    if (verdict.final_verification_status !== verifications.at(-1)?.status) errors.push("final verdict verification mismatch");
    if (verdict.blocking_count !== finalReviews.filter((review) => review.blocking || review.verdict === "BLOCKING").length) errors.push("final verdict blocking count mismatch");
    const finalBlockingFindings = finalReviews.reduce((count, review) => count + (Array.isArray(review.findingSeverities) ? review.findingSeverities.filter((severity) => severity === "BLOCKING").length : (review.blocking ? 1 : 0)), 0);
    if (verdict.blocking_findings_count !== finalBlockingFindings) errors.push("final verdict blocking finding count mismatch");
    if (requireCorrection && verdict.correction_performed !== true) errors.push("final verdict omits performed correction");
  }
  if (options.requireCleanup === true) {
    if (state.cleanup?.status !== "PASS" || state.cleanup?.resourcesAbsent !== true) errors.push("disposable runtime cleanup is not proven");
    if (state.cleanupStatus !== "PASS") errors.push("top-level cleanup status is not PASS");
    if (verdict?.cleanup_status !== "PASS") errors.push("final verdict cleanup status is not PASS");
  }
  if (state.evidenceStatus !== "PASS") errors.push("top-level evidence status is not PASS");
  if (verdict?.evidence_status !== "PASS") errors.push("final verdict evidence status is not PASS");
  return { valid: errors.length === 0, errors };
}
