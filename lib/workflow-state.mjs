import {
  assertConfiguredSpawnBudget,
  createWorkflowSpawnBudgetGuard,
  MAX_CORRECTION_ITERATIONS,
  MAX_SUBAGENT_DEPTH,
  MAX_WORKFLOW_CONCURRENCY,
  workflowSpawnBudgetForRequest,
} from "./workflow-spawn-budget.mjs";
import { validateTokenGovernor } from "./token-governor.mjs";
import { validateTaskPolicy } from "./task-governor.mjs";
import { validateLocalPrewalkText } from "./local-prewalk.mjs";

export { MAX_CORRECTION_ITERATIONS, MAX_SUBAGENT_DEPTH, MAX_WORKFLOW_CONCURRENCY };
export const WORKFLOW_VERSION = 5;

const REVIEWERS = Object.freeze(["correctness-reviewer", "security-reviewer", "simplicity-reviewer"]);
const COUNCIL_MEMBERS = Object.freeze(["council-1", "council-2", "council-3"]);
export const COUNCIL_MEMBER_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false, required: ["conclusion", "recommendation", "confidence", "evidence", "risks", "blockingConcerns"],
  properties: {
    conclusion: { type: "string", minLength: 1 }, recommendation: { type: "string", minLength: 1 }, confidence: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
    evidence: { type: "array", items: { type: "string" } }, risks: { type: "array", items: { type: "string" } }, blockingConcerns: { type: "array", items: { type: "string" } },
  },
});
export const COUNCIL_JUDGE_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false, required: ["decision", "decisionBasis", "confidence", "agreements", "disagreements", "requiredActions"],
  properties: {
    decision: { type: "string", minLength: 1 }, decisionBasis: { type: "string", minLength: 1 }, confidence: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
    agreements: { type: "array", items: { type: "string" } }, disagreements: { type: "array", items: { type: "string" } }, requiredActions: { type: "array", items: { type: "string" } },
  },
});

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
  if (response.agent !== undefined && response.agent !== role) throw new Error(`${role} failed: deterministic role mismatch (${response.agent})`);
  return response;
}

function exactStringArrays(value, scalarKeys, arrayKeys, allowedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowedKeys.includes(key)) || allowedKeys.some((key) => !Object.hasOwn(value, key))) return false;
  if (scalarKeys.some((key) => typeof value[key] !== "string" || value[key].length === 0)) return false;
  return arrayKeys.every((key) => Array.isArray(value[key]) && value[key].every((item) => typeof item === "string"));
}

function reviewValue(role, response) {
  requireCompleted(role, response);
  const value = response.result?.kind === "structured" ? response.result.value : undefined;
  if (!value || typeof value !== "object" || !["PASS", "BLOCKING"].includes(value.verdict) || !Array.isArray(value.findings)) throw new Error(`${role} returned invalid structured review evidence`);
  for (const finding of value.findings) {
    if (!finding || typeof finding !== "object" || !["INFO", "NON_BLOCKING", "BLOCKING"].includes(finding.severity)) throw new Error(`${role} returned an invalid finding severity`);
  }
  const blocking = value.verdict === "BLOCKING" || value.findings.some((finding) => finding.severity === "BLOCKING");
  return { role, blocking, verdict: blocking ? "BLOCKING" : "PASS", findings: value.findings, model: response.model, thinking: response.thinking, usage: response.usage, runId: response.runId, nodeId: response.nodeId, ownerRunId: response.ownerRunId };
}

export function councilMemberValue(role, response) {
  requireCompleted(role, response);
  const value = response.result?.kind === "structured" ? response.result.value : undefined;
  const keys = ["conclusion", "recommendation", "confidence", "evidence", "risks", "blockingConcerns"];
  if (!exactStringArrays(value, ["conclusion", "recommendation", "confidence"], ["evidence", "risks", "blockingConcerns"], keys) || !["LOW", "MEDIUM", "HIGH"].includes(value.confidence)) throw new Error(`${role} returned invalid structured council evidence`);
  return { role, conclusion: value.conclusion, recommendation: value.recommendation, confidence: value.confidence, evidence: value.evidence, risks: value.risks, blockingConcerns: value.blockingConcerns, model: response.model, thinking: response.thinking, usage: response.usage, runId: response.runId, nodeId: response.nodeId, ownerRunId: response.ownerRunId };
}

export function councilJudgeValue(response) {
  requireCompleted("council-judge", response);
  const value = response.result?.kind === "structured" ? response.result.value : undefined;
  const keys = ["decision", "decisionBasis", "confidence", "agreements", "disagreements", "requiredActions"];
  if (!exactStringArrays(value, ["decision", "decisionBasis", "confidence"], ["agreements", "disagreements", "requiredActions"], keys) || !["LOW", "MEDIUM", "HIGH"].includes(value.confidence)) throw new Error("council-judge returned invalid structured synthesis");
  return value;
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

function freshState({ allocation, ownerRunId, runId, taskId, modelPolicy, routingStrategy, taskPolicy, spawnBudget, memoryPack }) {
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
    modelPolicy,
    routingStrategy,
    taskPolicy: taskPolicy ? structuredClone(taskPolicy) : undefined,
    memoryPack: memoryPack ? structuredClone(memoryPack) : undefined,
    hardLimits: { concurrency: MAX_WORKFLOW_CONCURRENCY, subagentDepth: MAX_SUBAGENT_DEPTH, correctionIterations: MAX_CORRECTION_ITERATIONS },
    spawnBudget,
    allocation,
    evidence: { roles: [], receipts: [], verifications: [], reviews: [], councils: [], transitions: [] },
    resumeData: { roleResults: {} },
  };
}

function validateResumeState(candidate, { allocation, ownerRunId, runId, taskId, modelPolicy, routingStrategy, taskPolicy }) {
  if (!candidate || candidate.workflowVersion !== WORKFLOW_VERSION) throw new Error("resumed workflow version mismatch");
  if (!["RUNNING", "INTERRUPTED", "PASS"].includes(candidate.status)) throw new Error("workflow state is not resumable");
  if (candidate.hardLimits?.concurrency !== MAX_WORKFLOW_CONCURRENCY || candidate.hardLimits?.subagentDepth !== MAX_SUBAGENT_DEPTH || candidate.hardLimits?.correctionIterations !== MAX_CORRECTION_ITERATIONS) throw new Error("resumed workflow hard limits mismatch");
  if (runId && candidate.runId && candidate.runId !== runId) throw new Error("resumed workflow run id mismatch");
  if (taskId && candidate.taskId && candidate.taskId !== taskId) throw new Error("resumed workflow task id mismatch");
  if (ownerRunId && candidate.ownerRunId && candidate.ownerRunId !== ownerRunId) throw new Error("resumed workflow owner id mismatch");
  if (!candidate.modelPolicy || candidate.modelPolicy.digest !== modelPolicy?.digest) throw new Error("resumed workflow model policy mismatch");
  if (JSON.stringify(candidate.routingStrategy) !== JSON.stringify(routingStrategy)) throw new Error("resumed workflow routing strategy mismatch");
  if (candidate.taskPolicy && (!taskPolicy || candidate.taskPolicy.digest !== taskPolicy.digest)) throw new Error("resumed workflow task policy mismatch");
  const state = structuredClone(candidate);
  state.runId = runId ?? state.runId;
  state.taskId = taskId ?? state.taskId;
  state.ownerRunId = ownerRunId ?? state.ownerRunId;
  state.allocation = allocation;
  if (!state.taskPolicy && taskPolicy) state.taskPolicy = structuredClone(taskPolicy);
  state.status = "RUNNING";
  state.timestamps = { ...state.timestamps, resumedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  state.resumeData ??= { roleResults: {} };
  state.resumeData.roleResults ??= {};
  state.evidence.receipts ??= [];
  state.evidence.councils ??= [];
  return state;
}

function roleCompleted(state, agent, selector = () => true) {
  return state.evidence.roles.some((entry) => entry.agent === agent && entry.status === "completed" && selector(entry));
}

function blockingFindingCount(reviews) {
  return reviews.reduce((total, review) => total + (Array.isArray(review.findings) ? review.findings.filter((finding) => finding.severity === "BLOCKING").length : (review.blocking ? 1 : 0)), 0);
}

export async function runEnforcedWorkflow(options) {
  const { task, allocation, delegate, verify, includeOracle = false, includeSecurity = true, maxCorrections = MAX_CORRECTION_ITERATIONS, policyReview, ownerRunId, runId, taskId, modelPolicy, onCheckpoint, resumeState, receiptVerifier, spawnBudgetGuard, configuredSpawnLimit, sharedMemoryPack = "", sharedMemoryMetadata, localPrewalk = "" } = options;
  if (typeof task !== "string" || !task.trim()) throw new Error("workflow task is required");
  if (!allocation?.worktree) throw new Error("isolated worktree allocation is required");
  if (maxCorrections > MAX_CORRECTION_ITERATIONS || maxCorrections < 0) throw new Error("correction limit override rejected");
  if (typeof sharedMemoryPack !== "string" || sharedMemoryPack.length > 6000) throw new Error("shared memory pack is invalid or unbounded");
  if (sharedMemoryPack && !sharedMemoryPack.startsWith("## Shared Memory Pack — UNTRUSTED DATA")) throw new Error("shared memory pack trust boundary is missing");
  validateLocalPrewalkText(localPrewalk);
  if (resumeState && (resumeState.memoryPack?.id ?? null) !== (sharedMemoryMetadata?.id ?? null)) throw new Error("resumed workflow shared memory pack mismatch");

  if (!modelPolicy?.digest || !modelPolicy?.roles) throw new Error("resolved model policy is required");
  const legacyRouting = {
    version: 1, preset: "normal", qualityRequested: "medium", effectiveQuality: "medium", difficulty: "hard",
    difficultyReasons: ["legacy-workflow-call"], difficultyEvidence: { characters: task.length, lines: 1, fileReferences: 0 }, securitySensitive: includeSecurity,
    toolsFirst: true,
    roles: { scout: true, planner: true, oracle: includeOracle, worker: true, tester: true, correctness: true, security: includeSecurity, simplicity: true },
    council: { initial: includeOracle, disagreement: true, repeatedFailure: true, authorized: true },
    context: { handoffChars: 12000, evidenceChars: 10000, councilChars: 8000 },
    maxModelCalls: 39, maxRetriesPerDelegation: 1, maxCorrectionRounds: 2,
  };
  const routingStrategy = validateTokenGovernor(options.routingStrategy ?? legacyRouting);
  const taskPolicy = options.taskPolicy ? validateTaskPolicy(options.taskPolicy) : undefined;
  if (taskPolicy && JSON.stringify(taskPolicy.routingStrategy) !== JSON.stringify(routingStrategy)) throw new Error("task policy routing strategy mismatch");
  if (localPrewalk && routingStrategy.roles.scout) throw new Error("local prewalk duplicates Scout");
  if (localPrewalk && localPrewalk.length > routingStrategy.context.handoffChars) throw new Error("local prewalk exceeds context handoff budget");
  let budgetGuard = spawnBudgetGuard;
  if (!budgetGuard && configuredSpawnLimit !== undefined) {
    const plan = workflowSpawnBudgetForRequest({ includeOracle, includeSecurity });
    assertConfiguredSpawnBudget(configuredSpawnLimit, plan, { workflowVersion: WORKFLOW_VERSION, maxCorrections });
    const priorBudget = resumeState?.spawnBudget;
    if (resumeState && (!Number.isSafeInteger(priorBudget?.used) || !Number.isSafeInteger(priorBudget?.retriesUsed))) throw new Error("resumed workflow has no valid spawn budget state");
    budgetGuard = createWorkflowSpawnBudgetGuard({ configuredSpawnLimit, plan, initialUsed: priorBudget?.used ?? 0, initialRetriesUsed: priorBudget?.retriesUsed ?? 0 });
  }
  if (resumeState && budgetGuard) {
    const restored = budgetGuard.snapshot();
    if (resumeState.spawnBudget?.used !== restored.used || resumeState.spawnBudget?.retriesUsed !== restored.retriesUsed || resumeState.spawnBudget?.requiredTotalSpawns !== restored.requiredTotalSpawns || resumeState.spawnBudget?.configuredSpawnLimit !== restored.configuredSpawnLimit) throw new Error("resumed workflow spawn budget state mismatch");
  }
  const state = resumeState ? validateResumeState(resumeState, { allocation, ownerRunId, runId, taskId, modelPolicy, routingStrategy, taskPolicy }) : freshState({ allocation, ownerRunId, runId, taskId, modelPolicy, routingStrategy, taskPolicy, spawnBudget: budgetGuard?.snapshot(), memoryPack: sharedMemoryMetadata });
  const evidence = state.evidence;
  const compact = (value, kind = "handoff") => bounded(value, routingStrategy.context[`${kind}Chars`] ?? routingStrategy.context.handoffChars);
  const checkpoint = () => {
    if (budgetGuard) state.spawnBudget = budgetGuard.snapshot();
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
  const roleResultKey = (agent, metadata = {}) => `${agent}:${metadata.round ?? 0}:${metadata.iteration ?? 0}:${metadata.purpose ?? "default"}`;
  const runRole = async (agent, stageTask, result = { kind: "text" }, metadata = {}) => {
    setRoleStatus(agent, "RUNNING");
    transition(agent.toUpperCase().replaceAll("-", "_"), { phase: "start", ...metadata });
    try {
      const response = requireCompleted(agent, await delegate({ agent, task: stageTask, cwd: allocation.worktree, result, round: metadata.round ?? 0, iteration: metadata.iteration ?? 0 }));
      const admitted = receiptVerifier ? receiptVerifier(response, { agent, round: metadata.round ?? 0, iteration: metadata.iteration ?? 0 }) : undefined;
      if (receiptVerifier && !admitted) throw new Error(`${agent} has no admitted durable receipt`);
      const receipt = admitted ? { executionId: admitted.executionId, sequence: admitted.sequence, sha256: admitted.sha256 } : undefined;
      if (receipt) evidence.receipts.push({ agent, round: metadata.round ?? 0, iteration: metadata.iteration ?? 0, ...receipt });
      evidence.roles.push({ agent, status: response.status, provider: response.provider, model: response.model, thinking: response.thinking, fallbackIndex: response.fallbackIndex, callNumber: response.callNumber, retryCount: response.retryCount, runId: response.runId, nodeId: response.nodeId, ownerRunId: response.ownerRunId, usage: response.usage, receipt, ...metadata });
      if (["scout", "planner", "oracle", "council-judge"].includes(agent)) state.resumeData.roleResults[roleResultKey(agent, metadata)] = response.result;
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
    const key = roleResultKey(agent);
    if (roleCompleted(state, agent) && state.resumeData.roleResults[key]) return { status: "completed", result: state.resumeData.roleResults[key] };
    return runRole(agent, stageTask);
  };

  const base = [taskContext(task.trim(), allocation), sharedMemoryPack].filter(Boolean).join("\n\n");

  const runCouncil = async (purpose, evidencePacket, iteration = 0) => {
    let entry = evidence.councils.find((candidate) => candidate.purpose === purpose && candidate.iteration === iteration);
    if (entry?.complete === true) return entry;
    const pendingCouncilSpawns = entry ? (entry.judge ? 0 : 1) : COUNCIL_MEMBERS.length + 1;
    const releaseCouncilBudget = pendingCouncilSpawns > 0 ? budgetGuard?.beginAtomicBlock(`${purpose}-council`, pendingCouncilSpawns) : undefined;
    try {
      if (!entry) {
        if (COUNCIL_MEMBERS.length !== MAX_WORKFLOW_CONCURRENCY) throw new Error("internal council concurrency exceeds hard limit");
        transition("COUNCIL", { phase: "members-start", purpose, iteration, concurrency: COUNCIL_MEMBERS.length });
        const common = `${base}\nCouncil purpose: ${purpose}.\nEvidence packet:\n${compact(evidencePacket, "council")}\nAnalyze independently. You have not received and must not infer any other council member's answer. Base every conclusion on the shared evidence packet; do not majority-vote.`;
        const responses = await Promise.allSettled(COUNCIL_MEMBERS.map((agent) => delegate({ agent, cwd: allocation.worktree, task: common, result: { kind: "structured", schema: COUNCIL_MEMBER_SCHEMA }, round: 0, iteration })));
        const members = [];
        let failed = false;
        for (let index = 0; index < responses.length; index += 1) {
          const agent = COUNCIL_MEMBERS[index];
          const response = responses[index];
          try {
            if (response.status === "rejected") throw response.reason;
            const admitted = receiptVerifier ? receiptVerifier(response.value, { agent, round: 0, iteration }) : undefined;
            if (receiptVerifier && !admitted) throw new Error(`${agent} has no admitted durable receipt`);
            const member = councilMemberValue(agent, response.value);
            const receipt = admitted ? { executionId: admitted.executionId, sequence: admitted.sequence, sha256: admitted.sha256 } : undefined;
            if (receipt) evidence.receipts.push({ agent, round: 0, iteration, ...receipt });
            evidence.roles.push({ agent, status: "completed", provider: response.value.provider, model: member.model, thinking: member.thinking, fallbackIndex: response.value.fallbackIndex, callNumber: response.value.callNumber, retryCount: response.value.retryCount, runId: member.runId, nodeId: member.nodeId, ownerRunId: member.ownerRunId, usage: member.usage, receipt, iteration, purpose });
            members.push(member);
          } catch {
            failed = true;
            evidence.roles.push({ agent, status: "failed", iteration, purpose });
          }
        }
        if (failed || members.length !== COUNCIL_MEMBERS.length) {
          transition("COUNCIL", { phase: "members-failed", purpose, iteration });
          throw new Error("one or more mandatory council members failed");
        }
        entry = { purpose, iteration, members, complete: false };
        evidence.councils.push(entry);
        transition("COUNCIL", { phase: "members-complete", purpose, iteration, members: members.length });
      }
      if (!entry.judge) {
        const metadata = { iteration, purpose };
        const key = roleResultKey("council-judge", metadata);
        let judgeResponse;
        if (roleCompleted(state, "council-judge", (role) => role.iteration === iteration && role.purpose === purpose) && state.resumeData.roleResults[key]) judgeResponse = { status: "completed", result: state.resumeData.roleResults[key] };
        else judgeResponse = await runRole("council-judge", `${base}\nCouncil purpose: ${purpose}.\nIndependent structured reports:\n${compact(entry.members, "council")}\nSynthesize only the evidence/conclusions/confidence/disagreement; do not edit or delegate.`, { kind: "structured", schema: COUNCIL_JUDGE_SCHEMA }, metadata);
        entry.judge = councilJudgeValue(judgeResponse);
      }
      entry.complete = true;
      transition("COUNCIL", { phase: "complete", purpose, iteration, decisionConfidence: entry.judge.confidence });
      return entry;
    } finally {
      releaseCouncilBudget?.();
    }
  };

  try {
    if (resumeState) transition("RESUME", { phase: "accepted", from: resumeState.currentPhase });
    else transition("REQUEST", { phase: "accepted" });
    let scout;
    if (routingStrategy.roles.scout) scout = await completedTextRole("scout", `${base}\nMap only relevant implementation, tests, and failure evidence. Return a compact handoff; never include unrelated repository content.`);
    let planner;
    if (routingStrategy.roles.planner) planner = await completedTextRole("planner", [base, scout ? `Scout evidence:\n${compact(scout.result)}` : "", "Produce the smallest safe structured plan: constraints, relevant files, steps, and exact acceptance checks only."].filter(Boolean).join("\n"));
    let oracle;
    if (routingStrategy.roles.oracle) oracle = await completedTextRole("oracle", [base, scout ? `Scout evidence:\n${compact(scout.result)}` : "", planner ? `Planner evidence:\n${compact(planner.result)}` : "", "Challenge only the material risk/ambiguity and identify the safest resolution."].filter(Boolean).join("\n"));
    let planningCouncil;
    if (routingStrategy.council.initial) planningCouncil = await runCouncil("high-risk-planning", { scout: scout?.result, planner: planner?.result, oracle: oracle?.result }, 0);

    const workerTask = [base, scout ? `Scout evidence:\n${compact(scout.result)}` : localPrewalk, planner ? `Plan:\n${compact(planner.result)}` : "", oracle ? `Oracle:\n${compact(oracle.result)}` : "", planningCouncil ? `Council decision:\n${compact(planningCouncil.judge, "council")}` : "", "Implement the approved minimal fix. Use only safe_exec for commands and do not commit."].filter(Boolean).join("\n\n");
    if (!roleCompleted(state, "worker", (entry) => entry.iteration === 0)) await runRole("worker", workerTask, { kind: "text" }, { iteration: 0 });

    const reviewerSchema = {
      type: "object", additionalProperties: false, required: ["verdict", "findings", "summary"],
      properties: {
        verdict: { type: "string", enum: ["PASS", "BLOCKING"] }, summary: { type: "string" },
        findings: { type: "array", items: { type: "object", additionalProperties: false, required: ["severity", "title", "evidence"], properties: { severity: { type: "string", enum: ["INFO", "NON_BLOCKING", "BLOCKING"] }, title: { type: "string" }, evidence: { type: "string" } } } },
      },
    };

    const runVerificationRound = async (roundNumber) => {
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
      const testerRequired = routingStrategy.roles.tester || verification.status !== "PASS" || roundNumber > 0;
      if (testerRequired && !roleCompleted(state, "tester", (entry) => entry.round === roundNumber)) {
        await runRole("tester", `${base}\nDeterministic verification round ${roundNumber} completed with status ${verification.status}. Interpret the actual diff and verification evidence only where model judgment is useful. You have no edit, write, or general command tool.`, { kind: "text" }, { round: roundNumber });
      }

      let reviewRound = evidence.reviews.find((entry) => entry.round === roundNumber && entry.complete === true);
      if (!reviewRound) {
        const activeReviewers = [];
        if (routingStrategy.roles.correctness || verification.status !== "PASS" || roundNumber > 0) activeReviewers.push("correctness-reviewer");
        if (routingStrategy.roles.security) activeReviewers.push("security-reviewer");
        if (routingStrategy.roles.simplicity) activeReviewers.push("simplicity-reviewer");
        if (activeReviewers.length > MAX_WORKFLOW_CONCURRENCY) throw new Error("internal reviewer concurrency exceeds hard limit");
        const releaseReviewBudget = activeReviewers.length > 0 ? budgetGuard?.beginAtomicBlock(`review-round-${roundNumber}`, activeReviewers.length) : undefined;
        state.reviewStatus = "RUNNING";
        transition("REVIEW", { phase: "start", round: roundNumber, concurrency: activeReviewers.length });
        let responses;
        try {
          responses = await Promise.allSettled(activeReviewers.map((agent) => delegate({ agent, cwd: allocation.worktree, task: `${base}\nReview round ${roundNumber}, after implementation and verification status ${verification.status}. Inspect the actual diff and tests. Return BLOCKING only for a reproducible violation of the stated acceptance criteria, an introduced regression, or a demonstrable security issue within the stated trust model. Speculative hardening or a requirement explicitly outside scope is NON_BLOCKING. Never edit and never delegate.`, result: { kind: "structured", schema: reviewerSchema }, round: roundNumber, iteration: 0 })));
        } finally {
          releaseReviewBudget?.();
        }
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
            evidence.roles.push({ agent: review.role, status: "completed", provider: response.value.provider, model: review.model, thinking: review.thinking, fallbackIndex: response.value.fallbackIndex, callNumber: response.value.callNumber, retryCount: response.value.retryCount, runId: review.runId, nodeId: review.nodeId, ownerRunId: review.ownerRunId, usage: review.usage, receipt, round: roundNumber });
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
      const reviewerVerdicts = new Set(reviewRound.reviews.filter((review) => REVIEWERS.includes(review.role)).map((review) => review.blocking ? "BLOCKING" : "PASS"));
      if (reviewerVerdicts.size > 1 && routingStrategy.council.disagreement) await runCouncil("reviewer-disagreement", { verification, reviews: reviewRound.reviews }, roundNumber);
      return { verification, reviews: reviewRound.reviews };
    };

    let correction = evidence.transitions.filter((entry) => entry.state === "CORRECTION_REQUIRED" && entry.phase === "enforced").length;
    if (correction > 0 && !roleCompleted(state, "worker", (entry) => entry.iteration === correction)) {
      const priorVerification = evidence.verifications.find((entry) => entry.round === correction - 1);
      const priorReviews = evidence.reviews.find((entry) => entry.round === correction - 1)?.reviews ?? [];
      const correctionEvidence = { verification: priorVerification, reviews: priorReviews.filter((review) => review.blocking) };
      const disagreementCouncil = evidence.councils.find((entry) => entry.purpose === "reviewer-disagreement" && entry.iteration === correction - 1 && entry.complete === true);
      if (disagreementCouncil) correctionEvidence.council = disagreementCouncil.judge;
      await runRole("worker", [base, scout ? "" : localPrewalk, `Correction iteration ${correction} is mandatory. Repair every blocking item below, rerun targeted checks with safe_exec, and do not commit.`, compact(correctionEvidence, "evidence")].filter(Boolean).join("\n"), { kind: "text" }, { iteration: correction });
    }
    let round = await runVerificationRound(correction);
    while ((round.verification.status !== "PASS" || round.reviews.some((review) => review.blocking)) && correction < maxCorrections) {
      const nextCorrection = correction + 1;
      const activeReviewerCount = includeSecurity ? REVIEWERS.length : REVIEWERS.length - 1;
      const councilBlock = COUNCIL_MEMBERS.length + 1;
      const repeatedFailureBlock = nextCorrection >= 2 ? 1 + councilBlock : 0;
      const correctionRoundBlock = 1 + 1 + activeReviewerCount + councilBlock + repeatedFailureBlock;
      budgetGuard?.assertBlock(`correction-round-${nextCorrection}`, correctionRoundBlock);
      if (!evidence.transitions.some((entry) => entry.state === "CORRECTION_REQUIRED" && entry.phase === "enforced" && entry.correction === nextCorrection)) {
        state.correctionPerformed = true;
        transition("CORRECTION_REQUIRED", { phase: "enforced", round: correction, correction: nextCorrection, verification: round.verification.status, blockingReviewers: round.reviews.filter((review) => review.blocking).map((review) => review.role) });
      }
      correction = nextCorrection;
      if (!roleCompleted(state, "worker", (entry) => entry.iteration === correction)) {
        const correctionEvidence = { verification: round.verification, reviews: round.reviews.filter((review) => review.blocking) };
        const disagreementCouncil = evidence.councils.find((entry) => entry.purpose === "reviewer-disagreement" && entry.iteration === correction && entry.complete === true);
        if (disagreementCouncil) correctionEvidence.council = disagreementCouncil.judge;
        if (correction >= 2 && routingStrategy.council.repeatedFailure) {
          const oracleMetadata = { iteration: correction, purpose: "repeated-failure" };
          const oracleKey = roleResultKey("oracle", oracleMetadata);
          let escalationOracle;
          if (roleCompleted(state, "oracle", (entry) => entry.iteration === correction && entry.purpose === "repeated-failure") && state.resumeData.roleResults[oracleKey]) escalationOracle = { status: "completed", result: state.resumeData.roleResults[oracleKey] };
          else escalationOracle = await runRole("oracle", `${base}\nRepeated failure evidence:\n${compact(correctionEvidence, "evidence")}\nFind the root cause and safest final correction.`, { kind: "text" }, oracleMetadata);
          const escalationCouncil = await runCouncil("repeated-failure", { ...correctionEvidence, oracle: escalationOracle.result }, correction);
          correctionEvidence.oracle = escalationOracle.result;
          correctionEvidence.council = escalationCouncil.judge;
        }
        await runRole("worker", [base, scout ? "" : localPrewalk, `Correction iteration ${correction} is mandatory. Repair every blocking item below, rerun targeted checks with safe_exec, and do not commit.`, compact(correctionEvidence, "evidence")].filter(Boolean).join("\n"), { kind: "text" }, { iteration: correction });
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
