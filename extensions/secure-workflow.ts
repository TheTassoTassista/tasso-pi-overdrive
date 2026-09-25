import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { cleanupRuntimeResources, createRuntimeWorktree, recoverStaleRuntimeAllocations, releaseRuntimeResources, resumeRuntimeResources } from "../lib/runtime-isolation.mjs";
import { runEnforcedWorkflow, WORKFLOW_VERSION } from "../lib/workflow-state.mjs";
import { localReviewPolicy } from "../lib/review-policy.mjs";
import { checkpointWorkflowJournal, createEvidenceRun, findResumableWorkflow, initialWorkflowJournal, openEvidenceRun, readEvidenceExecution, readWorkflowJournal, recoverInterruptedWorkflowRuns, snapshotWorktree, taskDigest, writeEvidenceExecution, writeEvidenceReceipt, writeWorkflowJournal } from "../lib/workflow-evidence.mjs";
import { redactMissionValue } from "../lib/mission-privacy.mjs";
import { admitRoleReceipt, listRoleReceipts, makeRoleReceipt, openRoleReceiptStore, writeRoleReceipt } from "../lib/workflow-receipts.mjs";
import { AGENT_TO_ROLE, readModelPolicy, resolveModelPolicy, validateResolvedModelPolicy } from "../lib/model-policy.mjs";
import { getSessionQuality } from "../lib/routing-session.mjs";
import { validateTokenGovernor } from "../lib/token-governor.mjs";
import { availableContextFromPiUsage, resolveTaskPolicy, taskPolicyMetadata, validateTaskPolicy } from "../lib/task-governor.mjs";
import { classifyDelegationFailure } from "../lib/delegation-failure.mjs";
import { executeDelegationWithRetry } from "../lib/delegation-retry.mjs";
import { canonicalizeDelegationResponse } from "../lib/delegation-response.mjs";
import { assertConfiguredSpawnBudget, createWorkflowSpawnBudgetGuard, readConfiguredSpawnLimit, workflowSpawnBudgetForRequest } from "../lib/workflow-spawn-budget.mjs";
import { aggregateUsageAttempts, normalizeProviderUsage, usageAttemptFromReceipt } from "../lib/usage-accounting.mjs";
import { createSecondBrainRuntime } from "../lib/second-brain-runtime.mjs";
import { AGENT_HUB_EVENT, roleReceiptMetadata, roleReservationMetadata, roleStartedMetadata, workflowJournalMetadata } from "../lib/agent-hub.mjs";
import { AgentAttemptController, requestExactUserCancellation } from "../lib/agent-hub-control.mjs";
import { buildLocalPrewalk } from "../lib/local-prewalk.mjs";
import { constrainToolsForModelProfile, modelHarnessProfileMetadata, resolveModelHarnessProfile } from "../lib/model-harness-profile.mjs";
import { WATCHDOG_ADVICE_EVENT, WATCHDOG_EVENT, validateWatchdogAdvice, watchdogObservationFromWorkflow } from "../lib/watchdog.mjs";

const REQUEST_EVENT = "prompt-template:subagent:request";
const STARTED_EVENT = "prompt-template:subagent:started";
const RESPONSE_EVENT = "prompt-template:subagent:response";
const CANCEL_EVENT = "prompt-template:subagent:cancel";
const verifyScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/verify-project.mjs");

const Params = Type.Object({
  task: Type.String({ minLength: 1, maxLength: 16000 }),
  includeOracle: Type.Optional(Type.Boolean({ default: false })),
  includeSecurity: Type.Optional(Type.Boolean({ default: true })),
});

interface DelegationInput {
  agent: string;
  task: string;
  cwd: string;
  result: Record<string, unknown>;
  round?: number;
  iteration?: number;
}

class WorkflowFailure extends Error {
  receiptWritten: boolean;
  constructor(message: string, receiptWritten = false) {
    super(message);
    this.name = "WorkflowFailure";
    this.receiptWritten = receiptWritten;
  }
}

function sanitizeState(state: any) {
  const evidence = state?.evidence ?? {};
  return {
    workflowVersion: state?.workflowVersion ?? WORKFLOW_VERSION,
    status: state?.status ?? "FAIL",
    currentPhase: state?.currentPhase ?? "UNKNOWN",
    round: state?.round ?? 0,
    workerStatus: state?.workerStatus ?? "NOT_RUN",
    testerStatus: state?.testerStatus ?? "NOT_RUN",
    verificationStatus: state?.verificationStatus ?? "NOT_RUN",
    reviewStatus: state?.reviewStatus ?? "NOT_RUN",
    blockingFindingsCount: state?.blockingFindingsCount ?? 0,
    correctionPerformed: state?.correctionPerformed ?? false,
    finalVerificationStatus: state?.finalVerificationStatus ?? "NOT_RUN",
    cleanupStatus: state?.cleanupStatus ?? "NOT_RUN",
    evidenceStatus: state?.evidenceStatus ?? "NOT_RUN",
    modelPolicy: state?.modelPolicy ? { version: state.modelPolicy.version, preset: state.modelPolicy.preset, basePreset: state.modelPolicy.basePreset, qualityRequested: state.modelPolicy.qualityRequested, effectiveQuality: state.modelPolicy.effectiveQuality, roles: state.modelPolicy.roles, routingDecisions: state.modelPolicy.routingDecisions, capabilityDigest: state.modelPolicy.capabilityDigest, diversity: state.modelPolicy.diversity, digest: state.modelPolicy.digest } : undefined,
    routingStrategy: state?.routingStrategy,
    taskPolicy: state?.taskPolicy,
    memoryPack: state?.memoryPack ? { id: state.memoryPack.id, route: state.memoryPack.route, status: state.memoryPack.status, candidateCount: state.memoryPack.candidateCount, itemCount: state.memoryPack.itemCount, packChars: state.memoryPack.packChars, approximateTokens: state.memoryPack.approximateTokens, degradationCount: state.memoryPack.degradationCount } : undefined,
    timestamps: state?.timestamps,
    ownerRunId: state?.ownerRunId,
    hardLimits: state?.hardLimits ?? { concurrency: 3, subagentDepth: 1, correctionIterations: 2 },
    spawnBudget: state?.spawnBudget,
    allocation: state?.allocation,
    evidence: {
      roles: Array.isArray(evidence.roles) ? evidence.roles.map((item: any) => ({ agent: item.agent, status: item.status, model: item.model, thinking: item.thinking, provider: item.provider, fallbackIndex: item.fallbackIndex, callNumber: item.callNumber, retryCount: item.retryCount, runId: item.runId, nodeId: item.nodeId, ownerRunId: item.ownerRunId, usage: item.usage, round: item.round, iteration: item.iteration, receipt: item.receipt })) : [],
      receipts: Array.isArray(evidence.receipts) ? evidence.receipts.map((item: any) => ({ agent: item.agent, round: item.round, iteration: item.iteration, executionId: item.executionId, sequence: item.sequence, sha256: item.sha256 })) : [],
      transitions: Array.isArray(evidence.transitions) ? evidence.transitions : [],
      verifications: Array.isArray(evidence.verifications) ? evidence.verifications.map((item: any) => ({
        status: item.status,
        processExitCode: item.processExitCode,
        results: Array.isArray(item.results) ? item.results.map((entry: any) => ({ name: entry.name, status: entry.status, exitCode: entry.exitCode, sandboxed: entry.sandboxed })) : [],
      })) : [],
      reviews: Array.isArray(evidence.reviews) ? evidence.reviews.map((round: any) => ({
        round: round.round,
        complete: round.complete === true,
        reviews: Array.isArray(round.reviews) ? round.reviews.map((review: any) => ({
          role: review.role,
          runId: review.runId,
          nodeId: review.nodeId,
          ownerRunId: review.ownerRunId,
          blocking: review.blocking,
          verdict: review.verdict,
          findingSeverities: Array.isArray(review.findings) ? review.findings.map((finding: any) => finding.severity) : [],
        })) : [],
      })) : [],
      councils: Array.isArray(evidence.councils) ? evidence.councils.map((council: any) => ({
        purpose: council.purpose,
        iteration: council.iteration,
        complete: council.complete === true,
        members: Array.isArray(council.members) ? council.members.map((member: any) => ({ role: member.role, model: member.model, runId: member.runId, nodeId: member.nodeId, ownerRunId: member.ownerRunId, confidence: member.confidence })) : [],
        judge: council.judge ? { confidence: council.judge.confidence, agreementCount: Array.isArray(council.judge.agreements) ? council.judge.agreements.length : 0, disagreementCount: Array.isArray(council.judge.disagreements) ? council.judge.disagreements.length : 0, requiredActionCount: Array.isArray(council.judge.requiredActions) ? council.judge.requiredActions.length : 0 } : undefined,
      })) : [],
    },
  };
}

function finalVerdict(execution: any, cleanupStatus: string, evidenceStatus: string) {
  const roles = execution.evidence.roles;
  const transitions = execution.evidence.transitions;
  const verifications = execution.evidence.verifications;
  const reviewRounds = execution.evidence.reviews;
  const finalReviews = reviewRounds.at(-1)?.reviews ?? [];
  const latestRole = (agent: string) => roles.filter((entry: any) => entry.agent === agent).at(-1)?.status ?? "NOT_RUN";
  const corrections = transitions.filter((entry: any) => entry.state === "CORRECTION_REQUIRED" && entry.phase === "enforced").length;
  const blockingCount = finalReviews.filter((review: any) => review.blocking || review.verdict === "BLOCKING").length;
  const blockingFindingsCount = finalReviews.reduce((count: number, review: any) => count + (Array.isArray(review.findingSeverities) ? review.findingSeverities.filter((severity: string) => severity === "BLOCKING").length : (review.blocking ? 1 : 0)), 0);
  const verificationStatus = verifications.at(-1)?.status ?? "NOT_RUN";
  const status = execution.status === "PASS" && ["PASS", "RELEASED"].includes(cleanupStatus) && evidenceStatus === "PASS" ? "PASS" : "FAIL";
  return {
    run_id: execution.runId,
    task_id: execution.taskDigest,
    workflow_version: execution.workflowVersion,
    status,
    round_count: Math.max(verifications.length, reviewRounds.length),
    worker_status: latestRole("worker"),
    tester_status: latestRole("tester"),
    verification_status: verificationStatus,
    review_status: reviewRounds.length === 0 ? "NOT_RUN" : blockingCount > 0 ? "BLOCKING" : "PASS",
    blocking_count: blockingCount,
    blocking_findings_count: blockingFindingsCount,
    correction_performed: corrections > 0,
    final_verification_status: verificationStatus,
    cleanup_status: cleanupStatus,
    evidence_status: evidenceStatus,
  };
}

function journalUpdate(state: any, lifecycleStatus = "RUNNING", terminal = false) {
  return {
    status: lifecycleStatus,
    workflow_status: state?.status ?? "RUNNING",
    current_phase: state?.currentPhase ?? "INITIALIZING",
    round: state?.round ?? 0,
    worker_status: state?.workerStatus ?? "NOT_RUN",
    tester_status: state?.testerStatus ?? "NOT_RUN",
    verification_status: state?.verificationStatus ?? "NOT_RUN",
    review_status: state?.reviewStatus ?? "NOT_RUN",
    blocking_findings_count: state?.blockingFindingsCount ?? 0,
    correction_performed: state?.correctionPerformed ?? false,
    final_verification_status: state?.finalVerificationStatus ?? "NOT_RUN",
    cleanup_status: state?.cleanupStatus ?? "NOT_RUN",
    evidence_status: state?.evidenceStatus ?? "NOT_RUN",
    workflow_state: terminal ? sanitizeState(state) : redactMissionValue(state),
  };
}

export default function (pi: ExtensionAPI) {
  let running = false;
  let activeWatchdogRunDigest: string | null = null;
  let pendingWatchdogAdvice: ReturnType<typeof validateWatchdogAdvice> | null = null;
  pi.events.on(WATCHDOG_ADVICE_EVENT, (value) => {
    if (!running || !activeWatchdogRunDigest || !value || typeof value !== "object") return;
    try {
      const message = value as { runDigest?: unknown; advice?: unknown };
      if (message.runDigest === activeWatchdogRunDigest) pendingWatchdogAdvice = validateWatchdogAdvice(message.advice);
    } catch {}
  });
  let agentControl: AgentAttemptController | undefined;
  let agentControlUncertain = false;
  pi.registerCommand("agent-cancel", {
    description: "Request cancellation of one active Worker or Tester attempt shown by /agents",
    handler: async (args, ctx) => {
      const executionId = args.trim();
      if (!agentControl || !running) {
        ctx.ui.notify("Agent control denied: NO_ACTIVE_CONTROLLER", "warning");
        return;
      }
      const requestId = randomUUID();
      const decision = requestExactUserCancellation(agentControl, { requestId, sessionId: ctx.sessionManager.getSessionId(), executionId });
      if (decision.code === "DISPATCH_UNCERTAIN") agentControlUncertain = true;
      try { pi.events.emit("pi-overdrive:agent-control-metadata", { operation: "CANCEL", result: decision.code, role: decision.role, sequence: decision.sequence, attemptDigest: decision.attemptDigest, requestDigest: taskDigest(requestId), stateBefore: decision.stateBefore, stateAfter: decision.stateAfter }); } catch {}
      ctx.ui.notify(`Agent control ${decision.code}${decision.role ? `: ${decision.role}#${decision.sequence}` : ""}. ${decision.code === "CANCEL_REQUESTED" ? "Await the terminal receipt in /agents." : decision.code === "DISPATCH_UNCERTAIN" ? "Workflow will fail closed; cancellation outcome is unconfirmed." : "No cancellation was accepted."}`, decision.code === "CANCEL_REQUESTED" ? "info" : "warning");
    },
  });
  pi.registerTool({
    name: "secure_coding_workflow",
    label: "Enforced coding workflow",
    description: "Run an adaptive tools-first coding workflow with bounded model escalation, sandboxed verification, mandatory correction on failure, and caller-independent concurrency/depth/routing limits.",
    parameters: Params,
    executionMode: "sequential",
    async execute(toolCallId, params, signal, _update, ctx) {
      if (running) throw new WorkflowFailure("Another secure workflow is already active.");
      const spawnBudgetPlan = workflowSpawnBudgetForRequest({ includeOracle: params.includeOracle ?? false, includeSecurity: params.includeSecurity ?? true });
      const configuredSpawnLimit = readConfiguredSpawnLimit();
      assertConfiguredSpawnBudget(configuredSpawnLimit, spawnBudgetPlan, {
        workflowVersion: WORKFLOW_VERSION,
        maxCorrections: spawnBudgetPlan.workflowPolicy.maxCorrectionRounds,
        retryPolicy: {
          maxPerDelegation: spawnBudgetPlan.workflowPolicy.maxTransientRetriesPerDelegation,
          maxPerWorkflow: spawnBudgetPlan.workflowPolicy.maxTransientRetriesPerWorkflow,
        },
      });
      let spawnBudgetGuard = createWorkflowSpawnBudgetGuard({ configuredSpawnLimit, plan: spawnBudgetPlan });
      running = true;
      activeWatchdogRunDigest = null;
      pendingWatchdogAdvice = null;
      agentControlUncertain = false;
      let allocation: Record<string, any> | undefined;
      let ownerRunId = `secure-${toolCallId}-${randomUUID()}`.slice(0, 240);
      const digest = taskDigest(params.task);
      let evidenceRun: ReturnType<typeof createEvidenceRun> | undefined;
      let latestState: any;
      let repositoryEvidence: any;
      let workflowError: unknown;
      let finalReceipt: any;
      let journal: any;
      let priorExecution: any;
      let priorExecutionSha256: string | undefined;
      let recovery: any;
      let sequence = 0;
      let receiptSequence = 0;
      let protocolNonce = taskDigest(randomUUID());
      let roleReceiptStore: ReturnType<typeof openRoleReceiptStore> | undefined;
      const publishHub = (value: Record<string, unknown>) => {
        try { pi.events.emit(AGENT_HUB_EVENT, value); } catch {}
      };
      const publishJournal = () => {
        if (!journal) return;
        try { publishHub(workflowJournalMetadata(journal, configuredSpawnLimit)); } catch {}
      };
      const checkpointJournal = (update: Record<string, unknown>) => {
        if (!evidenceRun || !journal) throw new Error("workflow journal is unavailable");
        journal = checkpointWorkflowJournal(evidenceRun, journal, update);
        publishJournal();
        return journal;
      };
      const availableModels = ctx.modelRegistry.getAvailable();
      const registeredModels = ctx.modelRegistry.getAll();
      const modelCapabilityOptions = { registeredModels };
      const storedModelPolicy = readModelPolicy();
      let activeTaskPolicy: any = resolveTaskPolicy({
        task: params.task,
        preset: storedModelPolicy.preset === "custom" ? storedModelPolicy.basePreset : storedModelPolicy.preset,
        quality: getSessionQuality(),
        includeOracle: params.includeOracle ?? false,
        includeSecurity: params.includeSecurity ?? true,
        availableContext: availableContextFromPiUsage(ctx.getContextUsage()),
      });
      let activeRoutingStrategy = activeTaskPolicy.routingStrategy;
      let activeModelPolicy: any = resolveModelPolicy(availableModels, storedModelPolicy, { ...modelCapabilityOptions, qualityRequested: activeRoutingStrategy.qualityRequested, effectiveQuality: activeRoutingStrategy.effectiveQuality });
      pi.events.emit("pi-overdrive:routing-metadata", { kind: "workflow-policy", preset: activeRoutingStrategy.preset, qualityRequested: activeRoutingStrategy.qualityRequested, effectiveQuality: activeRoutingStrategy.effectiveQuality, difficulty: activeRoutingStrategy.difficulty, securitySensitive: activeRoutingStrategy.securitySensitive, modelCallLimit: activeRoutingStrategy.maxModelCalls, policyDigest: activeModelPolicy.digest });
      pi.events.emit("pi-overdrive:routing-metadata", taskPolicyMetadata(activeTaskPolicy));
      let sharedMemoryPack = "";
      let sharedMemoryMetadata: Record<string, unknown> | undefined;
      let secondBrainRuntime: ReturnType<typeof createSecondBrainRuntime> | undefined;
      try {
        if (!activeTaskPolicy.needs.secondBrain) {
          pi.events.emit("pi-overdrive:memory-metadata", { kind: "memory_policy_skip", reason: "task_policy_current_context_sufficient", taskPolicyDigest: activeTaskPolicy.digest });
        } else {
          secondBrainRuntime = createSecondBrainRuntime({
            cwd: ctx.cwd,
            preset: activeRoutingStrategy.preset,
            qualityRequested: activeRoutingStrategy.qualityRequested,
            effectiveQuality: activeRoutingStrategy.effectiveQuality,
            emit: (metadata: object) => pi.events.emit("pi-overdrive:memory-metadata", metadata),
          });
          const pack = await secondBrainRuntime.controller.build(params.task, { currentContextSufficient: false });
          sharedMemoryPack = pack.text;
          sharedMemoryMetadata = { id: pack.id, route: pack.route.decision, ...pack.metadata };
        }
      } catch {
        pi.events.emit("pi-overdrive:memory-metadata", { kind: "memory_degradation_event", backend: "workflow-controller" });
      }
      const admittedExecutionIds = new Set<string>();
      const delegationAudit: Array<Record<string, unknown>> = [];
      const delegateOnce = ({ agent, task, cwd, result, round = 0, iteration = 0 }: DelegationInput, attempt: number): Promise<Record<string, any>> => new Promise((resolve, reject) => {
        const policyRole = AGENT_TO_ROLE[agent as keyof typeof AGENT_TO_ROLE];
        const route = policyRole ? activeModelPolicy.roles[policyRole] : undefined;
        if (!route) { reject(new Error(`No model route is configured for ${agent}.`)); return; }
        const beforeSpawn = spawnBudgetGuard.snapshot();
        if (beforeSpawn.used >= activeRoutingStrategy.maxModelCalls) {
          const error = new Error(`TOKEN_GOVERNOR_MODEL_CALL_BUDGET_EXHAUSTED:${beforeSpawn.used}/${activeRoutingStrategy.maxModelCalls}`);
          Object.assign(error, { failureCategory: "RESOURCE_LIMIT", failureReason: "TOKEN_GOVERNOR_MODEL_CALL_BUDGET_EXHAUSTED" });
          reject(error);
          return;
        }
        spawnBudgetGuard.claimSpawn(agent, { retry: attempt > 1 });
        const callNumber = beforeSpawn.used + 1;
        const selectedModel = availableModels.find((candidate: any) => `${candidate.provider}/${candidate.id}` === route.model);
        const harnessProfile = resolveModelHarnessProfile({ model: selectedModel, identity: route.model, provider: route.provider, family: route.family, registeredModels, authenticatedModels: availableModels });
        const harnessSelection = constrainToolsForModelProfile([], harnessProfile, { structural: activeTaskPolicy.classification.signals.structuralEdit === true });
        pi.events.emit("pi-overdrive:routing-metadata", { kind: "role-route", preset: activeRoutingStrategy.preset, qualityRequested: activeRoutingStrategy.qualityRequested, effectiveQuality: activeRoutingStrategy.effectiveQuality, difficulty: activeRoutingStrategy.difficulty, role: policyRole, provider: route.provider, model: route.model, effort: route.thinking, fallbackIndex: route.fallbackIndex, callNumber, retryCount: attempt - 1 });
        pi.events.emit("pi-overdrive:routing-metadata", { ...modelHarnessProfileMetadata(harnessProfile, harnessSelection), role: policyRole });
        const requestId = randomUUID();
        const executionId = requestId;
        const assignedReceiptSequence = receiptSequence++;
        const nodeId = `${String(sequence += 1).padStart(2, "0")}-${agent}`;
        if (!agentControl) throw new Error("Agent controller is unavailable for the delegated attempt.");
        agentControl.reserve({ executionId, role: agent, sequence: assignedReceiptSequence, attempt, cancel: () => pi.events.emit(CANCEL_EVENT, { requestId, ownerRunId, nodeId }) });
        let hubReservation: Record<string, unknown> | undefined;
        try {
          const reservationMetadata = roleReservationMetadata({
            runId: evidenceRun?.runId,
            taskDigest: digest,
            executionId,
            sequence: assignedReceiptSequence,
            role: agent,
            round,
            iteration,
            attempt,
            nodeId,
            route,
            callNumber,
            retryCount: attempt - 1,
            spawnBudgetUsed: spawnBudgetGuard.snapshot().used,
            maxRoleAttempts: configuredSpawnLimit,
          });
          hubReservation = reservationMetadata;
          publishHub(reservationMetadata);
        } catch {}
        let settled = false;
        let attemptStarted = false;
        const finish = (callback: (value: any) => void, value: any, terminalStatus: string) => {
          if (settled) return;
          settled = true;
          agentControl?.terminal(executionId, terminalStatus);
          clearTimeout(timer);
          unsubscribeStarted();
          unsubscribe();
          signal?.removeEventListener("abort", abort);
          callback(value);
        };
        const unsubscribeStarted = pi.events.on(STARTED_EVENT, (data) => {
          const started = data as Record<string, unknown>;
          if (started?.requestId === requestId && started?.ownerRunId === ownerRunId && started?.nodeId === nodeId) {
            attemptStarted = true;
            agentControl?.started(executionId);
            if (hubReservation) try { publishHub(roleStartedMetadata(hubReservation)); } catch {}
          }
        });
        const unsubscribe = pi.events.on(RESPONSE_EVENT, (data) => {
          const response = data as Record<string, unknown>;
          if (response?.requestId === requestId && response?.ownerRunId === ownerRunId && response?.nodeId === nodeId) {
            try {
              if (agentControl?.state(executionId) === "CANCEL_REQUESTED" && response.status !== "cancelled") agentControlUncertain = true;
              if (!evidenceRun || !roleReceiptStore) throw new Error("role receipt store is unavailable");
              const canonicalResponse = canonicalizeDelegationResponse(route, response, { attempt, schema: result.kind === "structured" ? result.schema : undefined });
              if (attemptStarted && canonicalResponse.status === "cancelled" && canonicalResponse.launchStatus === "not_launched") {
                canonicalResponse.launchStatus = "launched";
                canonicalResponse.modelCalls = null;
              }
              const receiptResponse = { ...canonicalResponse, provider: canonicalResponse.routeAttested === true ? route.provider : null };
              const receipt = makeRoleReceipt({ runId: evidenceRun.runId, taskId: digest, protocolNonce, executionId, sequence: assignedReceiptSequence, role: agent, round, iteration, attempt, nodeId, ownerRunId, response: receiptResponse });
              const reference = writeRoleReceipt(roleReceiptStore, receipt);
              agentControl?.terminal(executionId, receipt.status);
              try { publishHub(roleReceiptMetadata(receipt, reference)); } catch {}
              const normalized = { ...canonicalResponse, status: receipt.status, provider: route.provider, usage: receipt.usage, fallbackIndex: route.fallbackIndex, callNumber, retryCount: attempt - 1, workflowReceipt: { ...reference, executionId, sequence: assignedReceiptSequence } };
              delegationAudit.push({ agent, role: policyRole, attempt, retryCount: attempt - 1, callNumber, status: receipt.status, failureCategory: receipt.failure_category, failureReason: canonicalResponse.failureReason, failureMetadata: receipt.failure_metadata, launchStatus: receipt.launch_status, modelCalls: receipt.model_calls, provider: receipt.provider, model: receipt.model, thinking: receipt.thinking, usage: receipt.usage, fallbackIndex: route.fallbackIndex, preset: activeRoutingStrategy.preset, qualityRequested: activeRoutingStrategy.qualityRequested, effectiveQuality: activeRoutingStrategy.effectiveQuality, difficulty: activeRoutingStrategy.difficulty, launchContractDigest: receipt.launch_contract_digest, policyDigest: activeModelPolicy.digest, runId: response.runId, nodeId, ownerRunId, executionId, receiptSequence: assignedReceiptSequence, receiptSha256: reference.sha256, errorDigest: receipt.error_digest, exitCode: receipt.exit_code });
              if (receipt.status === "completed") {
                finish(resolve, normalized, receipt.status);
              } else {
                const failure = new Error(`${agent} delegation ended with ${receipt.status}: ${String(canonicalResponse.error ?? "")}`);
                Object.assign(failure, { delegationReceiptRecorded: true, failureCategory: receipt.failure_category, delegationStatus: receipt.status });
                finish(reject, failure, receipt.status);
              }
            } catch (error) {
              if (error && typeof error === "object") {
                try { Object.assign(error, { delegationLaunched: true }); } catch {}
              }
              finish(reject, error, "failed");
            }
          }
        });
        const failWithReceipt = (status: string, message: string) => {
          let receiptRecorded = false;
          try {
            if (evidenceRun && roleReceiptStore) {
              const failureCategory = classifyDelegationFailure({ status, error: message });
              const receipt = makeRoleReceipt({ runId: evidenceRun.runId, taskId: digest, protocolNonce, executionId, sequence: assignedReceiptSequence, role: agent, round, iteration, attempt, nodeId, ownerRunId, response: { status, agent, nodeId, ownerRunId, error: message, failureCategory, launchStatus: "launched" } });
              const reference = writeRoleReceipt(roleReceiptStore, receipt);
              agentControl?.terminal(executionId, receipt.status);
              try { publishHub(roleReceiptMetadata(receipt, reference)); } catch {}
              delegationAudit.push({ agent, attempt, status, failureCategory, launchStatus: receipt.launch_status, modelCalls: receipt.model_calls, provider: receipt.provider, model: receipt.model, thinking: receipt.thinking, usage: receipt.usage, nodeId, ownerRunId, executionId, receiptSequence: assignedReceiptSequence, receiptSha256: reference.sha256, errorDigest: receipt.error_digest });
              receiptRecorded = true;
            }
          } catch {}
          const failure = new Error(message);
          Object.assign(failure, { delegationReceiptRecorded: receiptRecorded, failureCategory: classifyDelegationFailure({ status, error: message }), delegationStatus: status });
          finish(reject, failure, status);
        };
        const abort = () => {
          pi.events.emit(CANCEL_EVENT, { requestId, ownerRunId, nodeId });
          failWithReceipt("cancelled", `${agent} delegation cancelled`);
        };
        const timer = setTimeout(() => {
          pi.events.emit(CANCEL_EVENT, { requestId, ownerRunId, nodeId });
          failWithReceipt("timed_out", `${agent} delegation timed out`);
        }, 20 * 60 * 1000);
        signal?.addEventListener("abort", abort, { once: true });
          pi.events.emit(REQUEST_EVENT, {
          requestId, ownerRunId, nodeId, agent, task, context: "fresh", cwd,
          model: route.model,
          thinking: route.thinking,
          timeoutMs: 18 * 60 * 1000,
          toolBudget: { soft: 24, hard: 40, block: ["subagent", "bash"] },
          harnessProfile: modelHarnessProfileMetadata(harnessProfile, harnessSelection),
          artifacts: false,
            result,
          });
      });
      const delegate = async (input: DelegationInput): Promise<Record<string, any>> => executeDelegationWithRetry(async (attempt: number) => {
        if (signal?.aborted) throw new Error(`${input.agent} delegation cancelled`);
        let beforeMutation: any;
        if (input.agent === "worker") {
          try { beforeMutation = snapshotWorktree(input.cwd); } catch {}
        }
        try {
          return await delegateOnce(input, attempt);
        } catch (error) {
          let failureCategory = (error as any)?.failureCategory ?? classifyDelegationFailure(error);
          if (input.agent === "worker" && beforeMutation) {
            try {
              const afterMutation = snapshotWorktree(input.cwd);
              if (afterMutation.diffSha256 !== beforeMutation.diffSha256 || JSON.stringify(afterMutation.changedFiles) !== JSON.stringify(beforeMutation.changedFiles)) {
                failureCategory = "DETERMINISTIC";
                if (error && typeof error === "object") (error as any).failureCategory = failureCategory;
              }
            } catch {
              failureCategory = "DETERMINISTIC";
              if (error && typeof error === "object") (error as any).failureCategory = failureCategory;
            }
          }
          if (!(error instanceof Error && (error as Error & { delegationReceiptRecorded?: boolean }).delegationReceiptRecorded)) {
            const prelaunchResourceLimit = failureCategory === "RESOURCE_LIMIT";
            const launchStatus = (error as any)?.delegationLaunched === true ? "launched" : "not_launched";
            delegationAudit.push({
              agent: input.agent,
              attempt,
              status: prelaunchResourceLimit ? "prelaunch-rejected" : "transport-failed",
              failureCategory,
              launchStatus,
              modelCalls: launchStatus === "not_launched" ? 0 : null,
              usage: normalizeProviderUsage(undefined),
              ...(prelaunchResourceLimit ? { failureReason: "SUBAGENT_SPAWN_BUDGET_EXHAUSTED" } : {}),
            });
          }
          throw error;
        }
      });
      try {
        const sourceRepository = fs.realpathSync(ctx.cwd);
        recovery = {
          workflows: recoverInterruptedWorkflowRuns(),
          runtime: recoverStaleRuntimeAllocations(),
        };
        let resumable: ReturnType<typeof findResumableWorkflow> | undefined;
        const explicitRunId = process.env.PI_OVERDRIVE_EVIDENCE_RUN_ID;
        if (explicitRunId) {
          try {
            const explicitRun = openEvidenceRun({ runId: explicitRunId });
            const explicitJournal = readWorkflowJournal(explicitRun);
            if (explicitJournal.status === "INTERRUPTED" && explicitJournal.task_id === digest && explicitJournal.source_repository === sourceRepository && !fs.existsSync(explicitRun.receiptFile)) resumable = { run: explicitRun, journal: explicitJournal, updated: Date.parse(explicitJournal.timestamps?.updated_at ?? "") || 0 };
          } catch {}
        }
        resumable ??= findResumableWorkflow({ taskDigest: digest, sourceRepository });
        if (resumable) {
          evidenceRun = resumable.run;
          journal = resumable.journal;
          ownerRunId = journal.owner_run_id;
          protocolNonce = journal.protocol_nonce;
          if (!/^[0-9a-f]{64}$/u.test(protocolNonce ?? "")) throw new Error("interrupted workflow has no valid role-receipt protocol nonce");
          roleReceiptStore = openRoleReceiptStore(evidenceRun);
          const priorRoleReceipts = listRoleReceipts(roleReceiptStore);
          delegationAudit.push(...priorRoleReceipts.map((entry: any) => usageAttemptFromReceipt(entry.receipt)));
          receiptSequence = priorRoleReceipts.length === 0 ? 0 : Math.max(...priorRoleReceipts.map((entry: any) => entry.receipt.sequence)) + 1;
          latestState = journal.workflow_state;
          if (!latestState || latestState.workflowVersion !== WORKFLOW_VERSION) throw new Error("interrupted workflow has no compatible resumable state");
          activeModelPolicy = validateResolvedModelPolicy(availableModels, latestState.modelPolicy, modelCapabilityOptions);
          activeRoutingStrategy = validateTokenGovernor(latestState.routingStrategy);
          if (latestState.taskPolicy) activeTaskPolicy = validateTaskPolicy(latestState.taskPolicy);
          sequence = Math.max(0, ...((latestState.evidence?.roles ?? []).map((entry: any) => Number.parseInt(String(entry.nodeId ?? "0").split("-")[0] ?? "0", 10)).filter(Number.isFinite)));
          if (fs.existsSync(evidenceRun.executionFile)) {
            const loaded = readEvidenceExecution(evidenceRun, digest);
            priorExecution = loaded.execution;
            priorExecutionSha256 = loaded.sha256;
            allocation = priorExecution.allocation;
            latestState = priorExecution;
          } else if (["PASS", "FAIL"].includes(latestState.status) && latestState.evidence?.transitions?.some((entry: any) => entry.state === "FINAL")) {
            allocation = latestState.allocation;
          } else {
            allocation = await resumeRuntimeResources(journal.allocation_id);
            latestState.allocation = allocation;
          }
          checkpointJournal({ ...journalUpdate(latestState), allocation_id: allocation?.allocationId ?? journal.allocation_id });
          for (const entry of priorRoleReceipts) {
            try { publishHub(roleReceiptMetadata(entry.receipt, entry)); } catch {}
          }
        } else {
          evidenceRun = createEvidenceRun();
          roleReceiptStore = openRoleReceiptStore(evidenceRun);
          journal = initialWorkflowJournal(evidenceRun, { taskDigest: digest, protocolNonce, workflowVersion: WORKFLOW_VERSION, sourceRepository, ownerRunId });
          writeWorkflowJournal(evidenceRun, journal);
          publishJournal();
          allocation = await createRuntimeWorktree(ctx.cwd, { evidenceRunId: evidenceRun.runId, ownerRunId });
          checkpointJournal({ allocation_id: allocation.allocationId, current_phase: "RUNTIME_ALLOCATED" });
        }
        if (resumable) {
          const priorBudget = latestState?.spawnBudget;
          if (!Number.isSafeInteger(priorBudget?.used) || !Number.isSafeInteger(priorBudget?.retriesUsed)) throw new Error("interrupted workflow has no valid spawn budget state");
          spawnBudgetGuard = createWorkflowSpawnBudgetGuard({ configuredSpawnLimit, plan: spawnBudgetPlan, initialUsed: priorBudget.used, initialRetriesUsed: priorBudget.retriesUsed });
        }
        agentControl = new AgentAttemptController({ sessionId: ctx.sessionManager.getSessionId(), runId: evidenceRun.runId, taskDigest: digest });
        const verify = async ({ cwd }: { cwd: string }) => {
          const result = await pi.exec(process.execPath, [verifyScript, "--json", "--full", "--cwd", cwd], { cwd, ...(signal ? { signal } : {}), timeout: 16 * 60 * 1000 });
          let parsed;
          try { parsed = JSON.parse(result.stdout.trim()); } catch { parsed = { status: "FAIL", parseError: true, exitCode: result.code, stderr: result.stderr.slice(-4000) }; }
          if (result.code !== 0 && parsed.status === "PASS") parsed = { ...parsed, status: "FAIL", exitMismatch: true };
          return { ...parsed, processExitCode: result.code };
        };
        if (!priorExecution) {
          if (!(["PASS", "FAIL"].includes(latestState?.status) && latestState?.evidence?.transitions?.some((entry: any) => entry.state === "FINAL"))) {
            const prewalkStarted = performance.now();
            const prewalk = allocation?.worktree
              ? await buildLocalPrewalk(allocation.worktree, params.task, activeTaskPolicy)
              : { status: "UNAVAILABLE_WORKTREE", text: "", candidateCount: 0, scannedCount: 0, digest: null };
            try { pi.events.emit("pi-overdrive:agent-prewalk-metadata", { status: prewalk.status, candidateCount: prewalk.candidateCount, scannedCount: prewalk.scannedCount, selectedChars: prewalk.text.length, durationMs: Math.round(performance.now() - prewalkStarted), modelCalls: 0, digest: prewalk.digest }); } catch {}
            const state: any = await runEnforcedWorkflow({
              task: params.task,
              allocation,
              delegate,
              verify,
              includeOracle: params.includeOracle ?? false,
              includeSecurity: params.includeSecurity ?? true,
              ownerRunId,
              runId: evidenceRun.runId,
              taskId: digest,
              modelPolicy: activeModelPolicy,
              routingStrategy: activeRoutingStrategy,
              taskPolicy: activeTaskPolicy,
              sharedMemoryPack,
              sharedMemoryMetadata,
              localPrewalk: prewalk.text,
              spawnBudgetGuard,
              receiptVerifier: (response: any, expected: any) => {
                if (!roleReceiptStore || !response?.workflowReceipt) throw new Error(`${expected.agent} has no durable role receipt reference`);
                const policyRole = AGENT_TO_ROLE[expected.agent as keyof typeof AGENT_TO_ROLE];
                const expectedRoute = policyRole ? activeModelPolicy.roles[policyRole] : undefined;
                if (!expectedRoute) throw new Error(`${expected.agent} has no active receipt route`);
                return admitRoleReceipt(roleReceiptStore, response.workflowReceipt, {
                  run_id: evidenceRun!.runId,
                  task_id: digest,
                  protocol_nonce: protocolNonce,
                  execution_id: response.workflowReceipt.executionId,
                  sequence: response.workflowReceipt.sequence,
                  role: expected.agent,
                  round: expected.round,
                  iteration: expected.iteration,
                  owner_run_id: ownerRunId,
                  node_id: response.nodeId,
                  status: "completed",
                  model: expectedRoute.model,
                  thinking: expectedRoute.thinking,
                }, admittedExecutionIds);
              },
              resumeState: resumable ? latestState : undefined,
              policyReview: ({ cwd }: { cwd: string }) => localReviewPolicy(cwd),
              onCheckpoint: (checkpoint: any) => {
                latestState = checkpoint;
                checkpointJournal(journalUpdate(checkpoint));
                try {
                  const observation = watchdogObservationFromWorkflow(checkpoint, activeTaskPolicy, evidenceRun!.runId);
                  activeWatchdogRunDigest = observation.runDigest;
                  pi.events.emit(WATCHDOG_EVENT, observation);
                } catch {}
              },
              watchdogAdvisory: () => {
                const advice = pendingWatchdogAdvice;
                pendingWatchdogAdvice = null;
                return advice;
              },
            });
            latestState = state;
          }
          if (allocation?.worktree && fs.existsSync(allocation.worktree)) repositoryEvidence = snapshotWorktree(allocation.worktree);
          if (latestState.status !== "PASS") workflowError = new Error("Enforced workflow exhausted its correction budget without a passing final state.");
        }
      } catch (error) {
        workflowError = error;
        if (error && typeof error === "object" && "workflowState" in error) latestState = (error as any).workflowState;
        if (allocation?.worktree && fs.existsSync(allocation.worktree)) {
          try { repositoryEvidence = snapshotWorktree(allocation.worktree); } catch {}
        }
      } finally {
        if (agentControlUncertain) workflowError ??= new Error("Exact attempt cancellation was not acknowledged by the delegated controller.");
        let execution: any = priorExecution;
        let executionSha256: string | undefined = priorExecutionSha256;
        let evidenceStatus = priorExecution ? "PASS" : "FAIL";
        if (evidenceRun) {
          try {
            if (!execution) {
              latestState ??= { workflowVersion: WORKFLOW_VERSION, status: "FAIL", ownerRunId, allocation };
              latestState.evidenceStatus = "RUNNING";
              if (journal) checkpointJournal({ ...journalUpdate(latestState), current_phase: "EVIDENCE_FINALIZATION" });
              const safeState = sanitizeState(latestState);
              if (workflowError) safeState.status = "FAIL";
              execution = {
                runId: evidenceRun.runId,
                taskDigest: digest,
                ...safeState,
                repositoryEvidence,
                delegationAttempts: delegationAudit,
                usageAccounting: {
                  workflow: aggregateUsageAttempts(delegationAudit),
                  council: aggregateUsageAttempts(delegationAudit, { roles: ["council-1", "council-2", "council-3", "council-judge"] }),
                },
                recovery,
                failure: workflowError ? { type: workflowError instanceof Error ? workflowError.name : "UnknownError", digest: taskDigest(workflowError instanceof Error ? workflowError.message : String(workflowError)) } : undefined,
              };
              writeEvidenceExecution(evidenceRun, execution);
              executionSha256 = createHash("sha256").update(fs.readFileSync(evidenceRun.executionFile)).digest("hex");
              evidenceStatus = "PASS";
              latestState.evidenceStatus = "EXECUTION_WRITTEN";
              if (journal) checkpointJournal({ ...journalUpdate(latestState), current_phase: "EVIDENCE_FINALIZATION" });
            }
          } catch (error) {
            workflowError ??= error;
          }
        }

        let cleanup = { status: "NOT_ALLOCATED", mode: "none", resourcesAbsent: false };
        if (allocation?.allocationId) {
          try {
            if (latestState) {
              latestState.cleanupStatus = "RUNNING";
              if (evidenceRun && journal) checkpointJournal({ ...journalUpdate(latestState), current_phase: "CLEANUP" });
            }
            if (process.env.PI_OVERDRIVE_CLEANUP_WORKFLOW === "1") {
              const allocationRoot = path.dirname(allocation.stateDir);
              const alreadyAbsent = !fs.existsSync(allocation.worktree) && !fs.existsSync(allocationRoot) && !fs.existsSync(allocation.portReservation);
              if (!alreadyAbsent) cleanupRuntimeResources(allocation.allocationId);
              const resourcesAbsent = !fs.existsSync(allocation.worktree) && !fs.existsSync(allocationRoot) && !fs.existsSync(allocation.portReservation);
              cleanup = { status: resourcesAbsent ? "PASS" : "FAIL", mode: alreadyAbsent ? "already-destroyed" : "destroy", resourcesAbsent };
            } else {
              releaseRuntimeResources(allocation.allocationId);
              cleanup = { status: "RELEASED", mode: "retain-worktree", resourcesAbsent: !fs.existsSync(allocation.portReservation) };
            }
            if (latestState) latestState.cleanupStatus = cleanup.status;
            if (evidenceRun && journal && latestState) checkpointJournal({ ...journalUpdate(latestState), current_phase: "CLEANUP" });
          } catch (error) {
            cleanup = { status: "FAIL", mode: process.env.PI_OVERDRIVE_CLEANUP_WORKFLOW === "1" ? "destroy" : "retain-worktree", resourcesAbsent: false };
            workflowError ??= error;
            if (latestState) latestState.cleanupStatus = "FAIL";
          }
        }

        if (evidenceRun && execution && executionSha256) {
          try {
            const verdict = finalVerdict(execution, cleanup.status, evidenceStatus);
            finalReceipt = {
              ...execution,
              executionStatus: execution.status,
              status: verdict.status,
              currentPhase: "FINALIZED",
              cleanupStatus: cleanup.status,
              evidenceStatus: "PASS",
              executionSha256,
              cleanup,
              finalVerdict: verdict,
            };
            writeEvidenceReceipt(evidenceRun, finalReceipt);
            if (latestState && journal) {
              latestState.cleanupStatus = cleanup.status;
              latestState.evidenceStatus = "PASS";
              checkpointJournal({ ...journalUpdate(latestState, finalReceipt.status === "PASS" ? "COMPLETED" : "FAILED", true), current_phase: "FINALIZED" });
            }
          } catch (error) {
            workflowError ??= error;
            finalReceipt = undefined;
            if (latestState && journal && evidenceRun) {
              try {
                latestState.evidenceStatus = "FAIL";
                checkpointJournal(journalUpdate(latestState, "FAILED", true));
              } catch {}
            }
          }
        }
        agentControl?.close();
        agentControl = undefined;
        running = false;
        activeWatchdogRunDigest = null;
        pendingWatchdogAdvice = null;
      }

      if (!finalReceipt) throw new WorkflowFailure(JSON.stringify({ status: "FAIL", runId: evidenceRun?.runId, error: "workflow evidence finalization failed" }), false);
      if (workflowError || finalReceipt.status !== "PASS" || finalReceipt.cleanup.status === "FAIL") {
        throw new WorkflowFailure(JSON.stringify({ status: "FAIL", runId: finalReceipt.runId, finalVerdict: finalReceipt.finalVerdict }), true);
      }
      const publicState = { ...finalReceipt, evidence: finalReceipt.evidence };
      return { content: [{ type: "text", text: JSON.stringify(publicState) }], details: publicState };
    },
  });
}
