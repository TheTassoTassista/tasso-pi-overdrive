export const MAX_WORKFLOW_CONCURRENCY = 3;
export const MAX_SUBAGENT_DEPTH = 1;
export const MAX_CORRECTION_ITERATIONS = 2;
export const WORKFLOW_VERSION = 4;

const REVIEWERS = Object.freeze(["correctness-reviewer", "security-reviewer", "simplicity-reviewer"]);

export class WorkflowInterruptedError extends Error {
  constructor(message = "workflow interrupted") {
    super(message);
    this.name = "WorkflowInterruptedError";
    this.code = "PI_OVERDRIVE_INTERRUPTED";
  }
}

function bounded(value, max = 12000) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length <= max ? text : `${text.slice(0, max)}\n[truncated by workflow controller]`;
}

function requireCompleted(role, response) {
  if (!response || response.status !== "completed") throw new Error(`${role} failed: ${response?.status ?? "missing response"}`);
  return response;
}

function reviewValue(role, response) {
  requireCompleted(role, response);
  const value = response.result?.kind === "structured" ? response.result.value : undefined;
  if (!value || typeof value !== "object" || !["PASS", "BLOCKING"].includes(value.verdict) || !Array.isArray(value.findings)) throw new Error(`${role} returned invalid structured review evidence`);
  for (const finding of value.findings) {
    if (!finding || typeof finding !== "object" || !["INFO", "NON_BLOCKING", "BLOCKING"].includes(finding.severity)) throw new Error(`${role} returned an invalid finding severity`);
  }
  const blocking = value.verdict === "BLOCKING" || value.findings.some((finding) => finding.severity === "BLOCKING");
  return { role, blocking, verdict: blocking ? "BLOCKING" : "PASS", findings: value.findings, model: response.model, usage: response.usage, runId: response.runId, nodeId: response.nodeId, ownerRunId: response.ownerRunId };
}

function taskContext(task, allocation) {
  return [
    task,
    `Assigned isolated worktree: ${allocation.worktree}`,
    `Runtime port: ${allocation.port}`,
    `State directory (host metadata): ${allocation.stateDir}`,
    `Browser profile/session: ${allocation.browserProfile} / ${allocation.browserSession}. Any agent_browser launch must pass --session ${allocation.browserSession} --profile ${allocation.browserProfile} with sessionMode=fresh; later calls must pass --session ${allocation.browserSession}.`,
    `Database/schema identifiers: ${allocation.database} / ${allocation.schema}`,
    "Do not operate outside this worktree. Never delegate or spawn another agent.",
  ].join("\n");
}

function freshState({ allocation, ownerRunId, runId, taskId }) {
  const now = new Date().toISOString();
  return {
    workflowVersion: WORKFLOW_VERSION,
    runId,
    taskId,
    status: "RUNNING",
    currentPhase: "INITIALIZING",
    round: 0,
    workerStatus: "NOT_RUN",
    testerStatus: "NOT_RUN",
    verificationStatus: "NOT_RUN",
    reviewStatus: "NOT_RUN",
    blockingFindingsCount: 0,
    correctionPerformed: false,
    finalVerificationStatus: "NOT_RUN",
    cleanupStatus: "NOT_RUN",
    evidenceStatus: "NOT_RUN",
    timestamps: { startedAt: now, updatedAt: now },
    ownerRunId,
    hardLimits: { concurrency: MAX_WORKFLOW_CONCURRENCY, subagentDepth: MAX_SUBAGENT_DEPTH, correctionIterations: MAX_CORRECTION_ITERATIONS },
    allocation,
    evidence: { roles: [], receipts: [], verifications: [], reviews: [], transitions: [] },
    resumeData: { roleResults: {} },
  };
}

function validateResumeState(candidate, { allocation, ownerRunId, runId, taskId }) {
  if (!candidate || candidate.workflowVersion !== WORKFLOW_VERSION) throw new Error("resumed workflow version mismatch");
  if (!["RUNNING", "INTERRUPTED", "PASS"].includes(candidate.status)) throw new Error("workflow state is not resumable");
  if (candidate.hardLimits?.concurrency !== MAX_WORKFLOW_CONCURRENCY || candidate.hardLimits?.subagentDepth !== MAX_SUBAGENT_DEPTH || candidate.hardLimits?.correctionIterations !== MAX_CORRECTION_ITERATIONS) throw new Error("resumed workflow hard limits mismatch");
  if (runId && candidate.runId && candidate.runId !== runId) throw new Error("resumed workflow run id mismatch");
  if (taskId && candidate.taskId && candidate.taskId !== taskId) throw new Error("resumed workflow task id mismatch");
  if (ownerRunId && candidate.ownerRunId && candidate.ownerRunId !== ownerRunId) throw new Error("resumed workflow owner id mismatch");
  const state = structuredClone(candidate);
  state.runId = runId ?? state.runId;
  state.taskId = taskId ?? state.taskId;
  state.ownerRunId = ownerRunId ?? state.ownerRunId;
  state.allocation = allocation;
  state.status = "RUNNING";
  state.timestamps = { ...state.timestamps, resumedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  state.resumeData ??= { roleResults: {} };
  state.resumeData.roleResults ??= {};
  state.evidence.receipts ??= [];
  return state;
}

function roleCompleted(state, agent, selector = () => true) {
  return state.evidence.roles.some((entry) => entry.agent === agent && entry.status === "completed" && selector(entry));
}

function blockingFindingCount(reviews) {
  return reviews.reduce((total, review) => total + (Array.isArray(review.findings) ? review.findings.filter((finding) => finding.severity === "BLOCKING").length : (review.blocking ? 1 : 0)), 0);
}

export async function runEnforcedWorkflow(options) {
  const { task, allocation, delegate, verify, includeOracle = false, includeSecurity = true, maxCorrections = MAX_CORRECTION_ITERATIONS, policyReview, ownerRunId, runId, taskId, onCheckpoint, resumeState, receiptVerifier } = options;
  if (typeof task !== "string" || !task.trim()) throw new Error("workflow task is required");
  if (!allocation?.worktree) throw new Error("isolated worktree allocation is required");
  if (maxCorrections > MAX_CORRECTION_ITERATIONS || maxCorrections < 0) throw new Error("correction limit override rejected");

  const state = resumeState ? validateResumeState(resumeState, { allocation, ownerRunId, runId, taskId }) : freshState({ allocation, ownerRunId, runId, taskId });
  const evidence = state.evidence;
  const checkpoint = () => {
    state.timestamps.updatedAt = new Date().toISOString();
    if (typeof onCheckpoint === "function") onCheckpoint(structuredClone(state));
  };
  const transition = (workflowState, data = {}) => {
    state.currentPhase = workflowState;
    if (Number.isSafeInteger(data.round)) state.round = data.round;
    evidence.transitions.push({ index: evidence.transitions.length, state: workflowState, at: new Date().toISOString(), ...data });
    checkpoint();
  };
  const setRoleStatus = (agent, status) => {
    if (agent === "worker") state.workerStatus = status;
    if (agent === "tester") state.testerStatus = status;
  };
  const runRole = async (agent, stageTask, result = { kind: "text" }, metadata = {}) => {
    setRoleStatus(agent, "RUNNING");
    transition(agent.toUpperCase().replaceAll("-", "_"), { phase: "start", ...metadata });
    try {
      const response = requireCompleted(agent, await delegate({ agent, task: stageTask, cwd: allocation.worktree, result, round: metadata.round ?? 0, iteration: metadata.iteration ?? 0 }));
      const admitted = receiptVerifier ? receiptVerifier(response, { agent, round: metadata.round ?? 0, iteration: metadata.iteration ?? 0 }) : undefined;
      if (receiptVerifier && !admitted) throw new Error(`${agent} has no admitted durable receipt`);
      const receipt = admitted ? { executionId: admitted.executionId, sequence: admitted.sequence, sha256: admitted.sha256 } : undefined;
      if (receipt) evidence.receipts.push({ agent, round: metadata.round ?? 0, iteration: metadata.iteration ?? 0, ...receipt });
      evidence.roles.push({ agent, status: response.status, model: response.model, runId: response.runId, nodeId: response.nodeId, ownerRunId: response.ownerRunId, usage: response.usage, receipt, ...metadata });
      if (["scout", "planner", "oracle"].includes(agent)) state.resumeData.roleResults[agent] = response.result;
      setRoleStatus(agent, "completed");
      transition(agent.toUpperCase().replaceAll("-", "_"), { phase: "complete", ...metadata });
      return response;
    } catch (error) {
      evidence.roles.push({ agent, status: "failed", ...metadata });
      setRoleStatus(agent, "failed");
      transition(agent.toUpperCase().replaceAll("-", "_"), { phase: "failed", ...metadata });
      throw error;
    }
  };
  const completedTextRole = async (agent, stageTask) => {
    if (roleCompleted(state, agent) && state.resumeData.roleResults[agent]) return { status: "completed", result: state.resumeData.roleResults[agent] };
    return runRole(agent, stageTask);
  };

  try {
    if (resumeState) transition("RESUME", { phase: "accepted", from: resumeState.currentPhase });
    else transition("REQUEST", { phase: "accepted" });
    const base = taskContext(task.trim(), allocation);
    const scout = await completedTextRole("scout", `${base}\nMap only relevant implementation, tests, and failure evidence.`);
    const planner = await completedTextRole("planner", `${base}\nScout evidence:\n${bounded(scout.result)}\nProduce the smallest safe plan and exact acceptance checks.`);
    let oracle;
    if (includeOracle) oracle = await completedTextRole("oracle", `${base}\nScout evidence:\n${bounded(scout.result)}\nPlanner evidence:\n${bounded(planner.result)}\nChallenge the plan and identify the safest resolution.`);

    const workerTask = [base, `Scout evidence:\n${bounded(scout.result)}`, `Plan:\n${bounded(planner.result)}`, oracle ? `Oracle:\n${bounded(oracle.result)}` : "", "Implement the approved minimal fix. Use only safe_exec for commands and do not commit."].filter(Boolean).join("\n\n");
    if (!roleCompleted(state, "worker", (entry) => entry.iteration === 0)) await runRole("worker", workerTask, { kind: "text" }, { iteration: 0 });

    const reviewerSchema = {
      type: "object", additionalProperties: false, required: ["verdict", "findings", "summary"],
      properties: {
        verdict: { type: "string", enum: ["PASS", "BLOCKING"] }, summary: { type: "string" },
        findings: { type: "array", items: { type: "object", additionalProperties: false, required: ["severity", "title", "evidence"], properties: { severity: { type: "string", enum: ["INFO", "NON_BLOCKING", "BLOCKING"] }, title: { type: "string" }, evidence: { type: "string" } } } },
      },
    };

    const runVerificationRound = async (roundNumber) => {
      if (!roleCompleted(state, "tester", (entry) => entry.round === roundNumber)) await runRole("tester", `${base}\nVerification round ${roundNumber}. Independently inspect the change and run verification_gate. You have no edit, write, or general command tool.`, { kind: "text" }, { round: roundNumber });
      let verification = evidence.verifications.find((entry) => entry.round === roundNumber);
      if (!verification) {
        state.verificationStatus = "RUNNING";
        transition("VERIFICATION", { phase: "start", round: roundNumber });
        verification = await verify({ cwd: allocation.worktree, round: roundNumber });
        if (verification?.status === "PASS" && verification.processExitCode !== undefined && verification.processExitCode !== 0) verification = { ...verification, status: "FAIL", exitMismatch: true };
        verification = { ...verification, round: roundNumber };
        evidence.verifications.push(verification);
        state.verificationStatus = verification.status;
        state.finalVerificationStatus = verification.status;
        transition("VERIFICATION", { phase: "complete", round: roundNumber, status: verification.status });
      }

      let reviewRound = evidence.reviews.find((entry) => entry.round === roundNumber && entry.complete === true);
      if (!reviewRound) {
        const activeReviewers = includeSecurity ? REVIEWERS : REVIEWERS.filter((role) => role !== "security-reviewer");
        if (activeReviewers.length > MAX_WORKFLOW_CONCURRENCY) throw new Error("internal reviewer concurrency exceeds hard limit");
        state.reviewStatus = "RUNNING";
        transition("REVIEW", { phase: "start", round: roundNumber, concurrency: activeReviewers.length });
        const responses = await Promise.allSettled(activeReviewers.map((agent) => delegate({ agent, cwd: allocation.worktree, task: `${base}\nReview round ${roundNumber}, after implementation and verification status ${verification.status}. Inspect the actual diff and tests. Return BLOCKING only for a reproducible violation of the stated acceptance criteria, an introduced regression, or a demonstrable security issue within the stated trust model. Speculative hardening or a requirement explicitly outside scope is NON_BLOCKING. Never edit and never delegate.`, result: { kind: "structured", schema: reviewerSchema }, round: roundNumber, iteration: 0 })));
        const reviews = [];
        let reviewerFailure = false;
        for (let index = 0; index < responses.length; index += 1) {
          const response = responses[index];
          const agent = activeReviewers[index];
          try {
            if (response.status === "rejected") throw response.reason;
            const admitted = receiptVerifier ? receiptVerifier(response.value, { agent, round: roundNumber, iteration: 0 }) : undefined;
            if (receiptVerifier && !admitted) throw new Error(`${agent} has no admitted durable receipt`);
            const review = reviewValue(agent, response.value);
            const receipt = admitted ? { executionId: admitted.executionId, sequence: admitted.sequence, sha256: admitted.sha256 } : undefined;
            if (receipt) evidence.receipts.push({ agent, round: roundNumber, iteration: 0, ...receipt });
            reviews.push(review);
            evidence.roles.push({ agent: review.role, status: "completed", model: review.model, runId: review.runId, nodeId: review.nodeId, ownerRunId: review.ownerRunId, usage: review.usage, receipt, round: roundNumber });
          } catch {
            reviewerFailure = true;
            evidence.roles.push({ agent, status: "failed", round: roundNumber });
          }
        }
        if (policyReview) reviews.push(await policyReview({ cwd: allocation.worktree, round: roundNumber }));
        reviewRound = { round: roundNumber, reviews, complete: !reviewerFailure };
        evidence.reviews.push(reviewRound);
        state.blockingFindingsCount = blockingFindingCount(reviews);
        state.reviewStatus = reviewerFailure ? "FAILED" : reviews.some((review) => review.blocking) ? "BLOCKING" : "PASS";
        transition("REVIEW", { phase: reviewerFailure ? "failed" : "complete", round: roundNumber, blocking: reviewerFailure || reviews.some((review) => review.blocking), blockingFindingsCount: state.blockingFindingsCount });
        if (reviewerFailure) throw new Error("one or more mandatory reviewers failed");
      } else {
        state.blockingFindingsCount = blockingFindingCount(reviewRound.reviews);
        state.reviewStatus = reviewRound.reviews.some((review) => review.blocking) ? "BLOCKING" : "PASS";
      }
      return { verification, reviews: reviewRound.reviews };
    };

    let correction = evidence.transitions.filter((entry) => entry.state === "CORRECTION_REQUIRED" && entry.phase === "enforced").length;
    if (correction > 0 && !roleCompleted(state, "worker", (entry) => entry.iteration === correction)) {
      const priorVerification = evidence.verifications.find((entry) => entry.round === correction - 1);
      const priorReviews = evidence.reviews.find((entry) => entry.round === correction - 1)?.reviews ?? [];
      const correctionEvidence = { verification: priorVerification, reviews: priorReviews.filter((review) => review.blocking) };
      await runRole("worker", `${base}\nCorrection iteration ${correction} is mandatory. Repair every blocking item below, rerun targeted checks with safe_exec, and do not commit.\n${bounded(correctionEvidence)}`, { kind: "text" }, { iteration: correction });
    }
    let round = await runVerificationRound(correction);
    while ((round.verification.status !== "PASS" || round.reviews.some((review) => review.blocking)) && correction < maxCorrections) {
      const nextCorrection = correction + 1;
      if (!evidence.transitions.some((entry) => entry.state === "CORRECTION_REQUIRED" && entry.phase === "enforced" && entry.correction === nextCorrection)) {
        state.correctionPerformed = true;
        transition("CORRECTION_REQUIRED", { phase: "enforced", round: correction, correction: nextCorrection, verification: round.verification.status, blockingReviewers: round.reviews.filter((review) => review.blocking).map((review) => review.role) });
      }
      correction = nextCorrection;
      if (!roleCompleted(state, "worker", (entry) => entry.iteration === correction)) {
        const correctionEvidence = { verification: round.verification, reviews: round.reviews.filter((review) => review.blocking) };
        await runRole("worker", `${base}\nCorrection iteration ${correction} is mandatory. Repair every blocking item below, rerun targeted checks with safe_exec, and do not commit.\n${bounded(correctionEvidence)}`, { kind: "text" }, { iteration: correction });
      }
      round = await runVerificationRound(correction);
    }

    state.status = round.verification.status === "PASS" && !round.reviews.some((review) => review.blocking) ? "PASS" : "FAIL";
    state.verificationStatus = round.verification.status;
    state.finalVerificationStatus = round.verification.status;
    state.reviewStatus = round.reviews.some((review) => review.blocking) ? "BLOCKING" : "PASS";
    state.blockingFindingsCount = blockingFindingCount(round.reviews);
    state.timestamps.completedAt = new Date().toISOString();
    transition("FINAL", { phase: "complete", status: state.status, corrections: correction });
    return state;
  } catch (error) {
    if (error?.code === "PI_OVERDRIVE_INTERRUPTED") {
      state.status = "INTERRUPTED";
      state.timestamps.interruptedAt = new Date().toISOString();
      checkpoint();
    } else {
      state.status = "FAIL";
      state.timestamps.failedAt = new Date().toISOString();
      if (!evidence.transitions.some((entry) => entry.state === "FINAL")) transition("FINAL", { phase: "failed", status: "FAIL" });
      else checkpoint();
    }
    if (error && typeof error === "object") error.workflowState = structuredClone(state);
    throw error;
  }
}
