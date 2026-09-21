import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aggregateUsageAttempts, validateNormalizedUsage } from "./usage-accounting.mjs";
import { MAX_CORRECTION_ITERATIONS, MAX_SUBAGENT_DEPTH, MAX_WORKFLOW_CONCURRENCY } from "./workflow-spawn-budget.mjs";

export const AGENT_HUB_EVENT = "pi-overdrive:agent-hub-metadata";
export const AGENT_HUB_VERSION = 1;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DIGEST = /^[0-9a-f]{64}$/u;
const ROLE = /^[a-z][a-z0-9-]{0,63}$/u;
const ROUTE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const JOURNAL_STATUS = new Set(["RUNNING", "INTERRUPTED", "FAILED", "COMPLETED", "INCONSISTENT"]);
const TERMINAL_ROLE_STATUS = new Set(["completed", "failed", "timed_out", "cancelled", "interrupted", "tool_budget_exhausted", "structured_output_failed", "acceptance_failed", "invalid_request", "unavailable_context", "duplicate_node", "transport_failed", "protocol_rejected"]);
const FAILURE_CATEGORY = new Set(["TRANSIENT", "DETERMINISTIC", "POLICY", "RESOURCE_LIMIT", "AUTH", "UNSUPPORTED_MODEL", "STRUCTURED_OUTPUT_POLICY_ERROR", "STRUCTURED_OUTPUT_MODEL_INVALID", "STRUCTURED_OUTPUT"]);
const ROLES = new Set(["scout", "planner", "oracle", "worker", "tester", "correctness-reviewer", "security-reviewer", "simplicity-reviewer", "council-1", "council-2", "council-3", "council-judge"]);
const EVENT_KEYS = Object.freeze({
  workflow_journal: ["version", "kind", "source", "runId", "taskDigest", "checkpointSequence", "lifecycleStatus", "workflowStatus", "currentPhase", "round", "workerStatus", "testerStatus", "verificationStatus", "reviewStatus", "blockingFindingsCount", "correctionPerformed", "finalVerificationStatus", "cleanupStatus", "evidenceStatus", "hardLimits", "spawnBudget", "allocationStatus", "updatedAt"],
  role_reserved: ["version", "kind", "source", "runId", "taskDigest", "executionId", "sequence", "role", "round", "iteration", "attempt", "nodeIdDigest", "provider", "model", "thinking", "fallbackIndex", "callNumber", "retryCount", "spawnBudgetUsed", "recordedAt"],
  role_started: ["version", "kind", "source", "runId", "taskDigest", "executionId", "sequence", "role", "round", "iteration", "attempt", "nodeIdDigest", "recordedAt"],
  role_receipt: ["version", "kind", "source", "runId", "taskDigest", "executionId", "sequence", "role", "round", "iteration", "attempt", "nodeIdDigest", "status", "failureCategory", "failureReason", "launchStatus", "modelCalls", "provider", "model", "thinking", "responseRunId", "exitCode", "usage", "receiptDigest", "recordedAt"],
});

export class AgentHubError extends Error {
  constructor(code) {
    super(code);
    this.name = "AgentHubError";
    this.code = code;
  }
}

function exactKeys(value, expected, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AgentHubError(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new AgentHubError(code);
  return value;
}

function integer(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new AgentHubError(code);
  return value;
}

function boundedString(value, maximum, code) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\0\r\n\u2028\u2029]/u.test(value)) throw new AgentHubError(code);
  return value;
}

function nullableString(value, maximum, pattern, code) {
  if (value === null) return null;
  const checked = boundedString(value, maximum, code);
  if (pattern && !pattern.test(checked)) throw new AgentHubError(code);
  return checked;
}

function iso(value, code) {
  const checked = boundedString(value, 40, code);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(checked) || !Number.isFinite(Date.parse(checked))) throw new AgentHubError(code);
  return checked;
}

function digest(value, code) {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new AgentHubError(code);
  return value;
}

function uuid(value, code) {
  if (typeof value !== "string" || !UUID.test(value)) throw new AgentHubError(code);
  return value;
}

function role(value) {
  if (typeof value !== "string" || !ROLE.test(value) || !ROLES.has(value)) throw new AgentHubError("AGENT_HUB_ROLE_INVALID");
  return value;
}

function routeValue(value, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !ROUTE_VALUE.test(value)) throw new AgentHubError("AGENT_HUB_ROUTE_INVALID");
  return value;
}

function thinking(value, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !THINKING.has(value)) throw new AgentHubError("AGENT_HUB_THINKING_INVALID");
  return value;
}

function hardLimits(value) {
  exactKeys(value, ["concurrency", "subagentDepth", "correctionIterations"], "AGENT_HUB_LIMITS_INVALID");
  if (value.concurrency !== MAX_WORKFLOW_CONCURRENCY || value.subagentDepth !== MAX_SUBAGENT_DEPTH || value.correctionIterations !== MAX_CORRECTION_ITERATIONS) throw new AgentHubError("AGENT_HUB_LIMITS_INVALID");
  return { concurrency: value.concurrency, subagentDepth: value.subagentDepth, correctionIterations: value.correctionIterations };
}

function spawnBudget(value, maximum) {
  exactKeys(value, ["configuredSpawnLimit", "workflowLimit", "used", "remaining", "retriesUsed", "retryReserveRemaining"], "AGENT_HUB_SPAWN_BUDGET_INVALID");
  for (const key of Object.keys(value)) integer(value[key], 0, maximum, "AGENT_HUB_SPAWN_BUDGET_INVALID");
  if (value.configuredSpawnLimit !== maximum || value.workflowLimit > maximum || value.used + value.remaining !== value.workflowLimit) throw new AgentHubError("AGENT_HUB_SPAWN_BUDGET_INVALID");
  return { ...value };
}

export function validateAgentHubPolicy(value) {
  exactKeys(value, ["version", "enabled", "maxRoleAttempts", "maxRenderedRoleAttempts"], "AGENT_HUB_POLICY_INVALID");
  if (value.version !== AGENT_HUB_VERSION || value.enabled !== true) throw new AgentHubError("AGENT_HUB_POLICY_INVALID");
  integer(value.maxRoleAttempts, 1, 42, "AGENT_HUB_POLICY_INVALID");
  integer(value.maxRenderedRoleAttempts, 1, value.maxRoleAttempts, "AGENT_HUB_POLICY_INVALID");
  if (value.maxRoleAttempts !== 42) throw new AgentHubError("AGENT_HUB_POLICY_INVALID");
  return Object.freeze({ ...value });
}

export function readAgentHubPolicy(file = process.env.PI_OVERDRIVE_AGENT_HUB_CONFIG ?? path.join(ROOT, "config", "agent-hub.json")) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new AgentHubError("AGENT_HUB_POLICY_INVALID");
    return validateAgentHubPolicy(JSON.parse(fs.readFileSync(descriptor, "utf8")));
  } catch (error) {
    if (error instanceof AgentHubError) throw error;
    throw new AgentHubError("AGENT_HUB_POLICY_UNAVAILABLE");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function budgetProjection(value, maximum = 42) {
  const candidate = value && typeof value === "object" ? value : {};
  const workflowLimit = Number.isSafeInteger(candidate.workflowLimit) ? candidate.workflowLimit : maximum;
  const used = Number.isSafeInteger(candidate.used) ? candidate.used : 0;
  return spawnBudget({
    configuredSpawnLimit: Number.isSafeInteger(candidate.configuredSpawnLimit) ? candidate.configuredSpawnLimit : maximum,
    workflowLimit,
    used,
    remaining: Number.isSafeInteger(candidate.remaining) ? candidate.remaining : Math.max(0, workflowLimit - used),
    retriesUsed: Number.isSafeInteger(candidate.retriesUsed) ? candidate.retriesUsed : 0,
    retryReserveRemaining: Number.isSafeInteger(candidate.retryReserveRemaining) ? candidate.retryReserveRemaining : 0,
  }, maximum);
}

export function workflowJournalMetadata(journal, maximum = 42) {
  if (!journal || typeof journal !== "object") throw new AgentHubError("AGENT_HUB_JOURNAL_INVALID");
  const state = journal.workflow_state && typeof journal.workflow_state === "object" ? journal.workflow_state : {};
  const limits = state.hardLimits ?? { concurrency: MAX_WORKFLOW_CONCURRENCY, subagentDepth: MAX_SUBAGENT_DEPTH, correctionIterations: MAX_CORRECTION_ITERATIONS };
  return validateAgentHubEvent({
    version: AGENT_HUB_VERSION,
    kind: "workflow_journal",
    source: "DURABLE_WORKFLOW_JOURNAL",
    runId: journal.run_id,
    taskDigest: journal.task_id,
    checkpointSequence: journal.checkpoint_seq,
    lifecycleStatus: journal.status,
    workflowStatus: journal.workflow_status,
    currentPhase: journal.current_phase,
    round: journal.round,
    workerStatus: journal.worker_status,
    testerStatus: journal.tester_status,
    verificationStatus: journal.verification_status,
    reviewStatus: journal.review_status,
    blockingFindingsCount: journal.blocking_findings_count,
    correctionPerformed: journal.correction_performed,
    finalVerificationStatus: journal.final_verification_status,
    cleanupStatus: journal.cleanup_status,
    evidenceStatus: journal.evidence_status,
    hardLimits: limits,
    spawnBudget: budgetProjection(state.spawnBudget, maximum),
    allocationStatus: journal.allocation_id ? "ALLOCATED" : "NOT_ALLOCATED",
    updatedAt: journal.timestamps?.updated_at,
  }, { maxRoleAttempts: maximum });
}

export function roleReservationMetadata(options) {
  const now = options.recordedAt ?? new Date().toISOString();
  return validateAgentHubEvent({
    version: AGENT_HUB_VERSION,
    kind: "role_reserved",
    source: "CONTROLLER_RESERVATION",
    runId: options.runId,
    taskDigest: options.taskDigest,
    executionId: options.executionId,
    sequence: options.sequence,
    role: options.role,
    round: options.round ?? 0,
    iteration: options.iteration ?? 0,
    attempt: options.attempt,
    nodeIdDigest: createHash("sha256").update(options.nodeId).digest("hex"),
    provider: options.route.provider,
    model: options.route.model,
    thinking: options.route.thinking,
    fallbackIndex: options.route.fallbackIndex,
    callNumber: options.callNumber,
    retryCount: options.retryCount,
    spawnBudgetUsed: options.spawnBudgetUsed,
    recordedAt: now,
  }, { maxRoleAttempts: options.maxRoleAttempts ?? 42 });
}

export function roleStartedMetadata(reservation, recordedAt = new Date().toISOString()) {
  const checked = validateAgentHubEvent(reservation);
  if (checked.kind !== "role_reserved") throw new AgentHubError("AGENT_HUB_RESERVATION_INVALID");
  return validateAgentHubEvent({
    version: AGENT_HUB_VERSION,
    kind: "role_started",
    source: "PI_SUBAGENTS_STARTED",
    runId: checked.runId,
    taskDigest: checked.taskDigest,
    executionId: checked.executionId,
    sequence: checked.sequence,
    role: checked.role,
    round: checked.round,
    iteration: checked.iteration,
    attempt: checked.attempt,
    nodeIdDigest: checked.nodeIdDigest,
    recordedAt,
  });
}

export function roleReceiptMetadata(receipt, reference) {
  return validateAgentHubEvent({
    version: AGENT_HUB_VERSION,
    kind: "role_receipt",
    source: "DURABLE_ROLE_RECEIPT",
    runId: receipt.run_id,
    taskDigest: receipt.task_id,
    executionId: receipt.execution_id,
    sequence: receipt.sequence,
    role: receipt.role,
    round: receipt.round,
    iteration: receipt.iteration,
    attempt: receipt.attempt,
    nodeIdDigest: createHash("sha256").update(receipt.node_id).digest("hex"),
    status: receipt.status,
    failureCategory: receipt.failure_category ?? null,
    failureReason: receipt.failure_reason ?? null,
    launchStatus: receipt.launch_status ?? null,
    modelCalls: receipt.model_calls ?? null,
    provider: receipt.provider ?? null,
    model: receipt.model ?? null,
    thinking: receipt.thinking ?? null,
    responseRunId: receipt.response_run_id ?? null,
    exitCode: receipt.exit_code ?? null,
    usage: receipt.usage,
    receiptDigest: reference.sha256,
    recordedAt: receipt.recorded_at,
  });
}

export function validateAgentHubEvent(value, options = {}) {
  const maximum = options.maxRoleAttempts ?? 42;
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(EVENT_KEYS, value.kind)) throw new AgentHubError("AGENT_HUB_EVENT_INVALID");
  exactKeys(value, EVENT_KEYS[value.kind], "AGENT_HUB_EVENT_FIELDS_INVALID");
  if (value.version !== AGENT_HUB_VERSION) throw new AgentHubError("AGENT_HUB_EVENT_VERSION_INVALID");
  uuid(value.runId, "AGENT_HUB_RUN_ID_INVALID");
  digest(value.taskDigest, "AGENT_HUB_TASK_DIGEST_INVALID");
  if (value.kind === "workflow_journal") {
    if (value.source !== "DURABLE_WORKFLOW_JOURNAL" || !JOURNAL_STATUS.has(value.lifecycleStatus)) throw new AgentHubError("AGENT_HUB_JOURNAL_INVALID");
    integer(value.checkpointSequence, 0, Number.MAX_SAFE_INTEGER, "AGENT_HUB_JOURNAL_INVALID");
    for (const key of ["workflowStatus", "currentPhase", "workerStatus", "testerStatus", "verificationStatus", "reviewStatus", "finalVerificationStatus", "cleanupStatus", "evidenceStatus"]) boundedString(value[key], 64, "AGENT_HUB_JOURNAL_INVALID");
    integer(value.round, 0, MAX_CORRECTION_ITERATIONS, "AGENT_HUB_JOURNAL_INVALID");
    integer(value.blockingFindingsCount, 0, 10_000, "AGENT_HUB_JOURNAL_INVALID");
    if (typeof value.correctionPerformed !== "boolean" || !["ALLOCATED", "NOT_ALLOCATED"].includes(value.allocationStatus)) throw new AgentHubError("AGENT_HUB_JOURNAL_INVALID");
    hardLimits(value.hardLimits);
    spawnBudget(value.spawnBudget, maximum);
    iso(value.updatedAt, "AGENT_HUB_JOURNAL_INVALID");
    return structuredClone(value);
  }
  if (!UUID.test(value.executionId) || !ROLES.has(value.role) || !DIGEST.test(value.nodeIdDigest)) throw new AgentHubError("AGENT_HUB_ROLE_EVENT_INVALID");
  integer(value.sequence, 0, maximum - 1, "AGENT_HUB_ROLE_EVENT_INVALID");
  role(value.role);
  integer(value.round, 0, MAX_CORRECTION_ITERATIONS, "AGENT_HUB_ROLE_EVENT_INVALID");
  integer(value.iteration, 0, MAX_CORRECTION_ITERATIONS, "AGENT_HUB_ROLE_EVENT_INVALID");
  integer(value.attempt, 1, 2, "AGENT_HUB_ROLE_EVENT_INVALID");
  iso(value.recordedAt, "AGENT_HUB_ROLE_EVENT_INVALID");
  if (value.kind === "role_reserved") {
    if (value.source !== "CONTROLLER_RESERVATION") throw new AgentHubError("AGENT_HUB_RESERVATION_INVALID");
    routeValue(value.provider); routeValue(value.model); thinking(value.thinking);
    integer(value.fallbackIndex, 0, 32, "AGENT_HUB_ROUTE_INVALID");
    integer(value.callNumber, 1, maximum, "AGENT_HUB_ROLE_EVENT_INVALID");
    integer(value.retryCount, 0, 1, "AGENT_HUB_ROLE_EVENT_INVALID");
    integer(value.spawnBudgetUsed, 1, maximum, "AGENT_HUB_SPAWN_BUDGET_INVALID");
  } else if (value.kind === "role_started") {
    if (value.source !== "PI_SUBAGENTS_STARTED") throw new AgentHubError("AGENT_HUB_STARTED_INVALID");
  } else {
    if (value.source !== "DURABLE_ROLE_RECEIPT" || !TERMINAL_ROLE_STATUS.has(value.status)) throw new AgentHubError("AGENT_HUB_RECEIPT_INVALID");
    if (value.failureCategory !== null && !FAILURE_CATEGORY.has(value.failureCategory)) throw new AgentHubError("AGENT_HUB_RECEIPT_INVALID");
    nullableString(value.failureReason, 64, /^[A-Z0-9_]+$/u, "AGENT_HUB_RECEIPT_INVALID");
    if (value.launchStatus !== null && !["launched", "not_launched"].includes(value.launchStatus)) throw new AgentHubError("AGENT_HUB_RECEIPT_INVALID");
    if (value.modelCalls !== null && value.modelCalls !== 0) throw new AgentHubError("AGENT_HUB_RECEIPT_INVALID");
    routeValue(value.provider, true); routeValue(value.model, true); thinking(value.thinking, true);
    if (value.responseRunId !== null) boundedString(value.responseRunId, 256, "AGENT_HUB_RECEIPT_INVALID");
    if (value.exitCode !== null) integer(value.exitCode, -4096, 4096, "AGENT_HUB_RECEIPT_INVALID");
    validateNormalizedUsage(value.usage);
    digest(value.receiptDigest, "AGENT_HUB_RECEIPT_INVALID");
  }
  return structuredClone(value);
}

function sameIdentity(left, right) {
  return left.runId === right.runId && left.taskDigest === right.taskDigest && left.executionId === right.executionId && left.sequence === right.sequence && left.role === right.role && left.round === right.round && left.iteration === right.iteration && left.attempt === right.attempt && left.nodeIdDigest === right.nodeIdDigest;
}

function terminalProjection(event, previous) {
  if (previous && !sameIdentity(previous, event)) throw new AgentHubError("AGENT_HUB_ROLE_IDENTITY_MISMATCH");
  if (event.status === "completed" && previous && (event.provider !== previous.provider || event.model !== previous.model || event.thinking !== previous.thinking)) throw new AgentHubError("AGENT_HUB_ROUTE_ATTESTATION_FAILED");
  return {
    sequence: event.sequence, role: event.role, round: event.round, iteration: event.iteration, attempt: event.attempt,
    status: event.status.toUpperCase(), lifecycleSource: event.source,
    provider: event.provider ?? previous?.provider ?? null,
    model: event.model ?? previous?.model ?? null,
    thinking: event.thinking ?? previous?.thinking ?? null,
    fallbackIndex: previous?.fallbackIndex ?? null,
    callNumber: previous?.callNumber ?? null,
    retryCount: previous?.retryCount ?? Math.max(0, event.attempt - 1),
    launchStatus: event.launchStatus,
    modelCalls: event.modelCalls,
    failureCategory: event.failureCategory,
    failureReason: event.failureReason,
    responseRunId: event.responseRunId,
    exitCode: event.exitCode,
    usage: structuredClone(event.usage),
    usageSource: "DURABLE_ROLE_RECEIPT",
    receiptDigest: event.receiptDigest,
    routeAttested: event.status === "completed" ? true : event.provider !== null && event.model !== null && event.thinking !== null,
    recordedAt: event.recordedAt,
    runId: event.runId, taskDigest: event.taskDigest, executionId: event.executionId, nodeIdDigest: event.nodeIdDigest,
    terminal: true,
  };
}

export class AgentHubProjection {
  constructor(options = {}) {
    this.policy = validateAgentHubPolicy(options.policy ?? readAgentHubPolicy());
    this.workflow = null;
    this.roles = new Map();
    this.degraded = null;
  }

  failSoft(error) {
    this.degraded = error instanceof AgentHubError ? error.code : "AGENT_HUB_UNAVAILABLE";
    return this.snapshot();
  }

  ingest(raw) {
    const event = validateAgentHubEvent(raw, this.policy);
    if (event.kind === "workflow_journal") {
      if (!this.workflow || this.workflow.runId !== event.runId) {
        if (this.workflow && !["COMPLETED", "FAILED", "INTERRUPTED", "INCONSISTENT"].includes(this.workflow.lifecycleStatus)) throw new AgentHubError("AGENT_HUB_CONCURRENT_WORKFLOW_REJECTED");
        this.roles.clear();
      } else if (event.checkpointSequence < this.workflow.checkpointSequence) {
        throw new AgentHubError("AGENT_HUB_STALE_JOURNAL_REJECTED");
      } else if (event.checkpointSequence === this.workflow.checkpointSequence) {
        if (JSON.stringify(event) !== JSON.stringify(this.workflow)) throw new AgentHubError("AGENT_HUB_CONFLICTING_JOURNAL_REJECTED");
        return this.snapshot();
      }
      this.workflow = event;
      this.degraded = null;
      return this.snapshot();
    }
    if (!this.workflow || this.workflow.runId !== event.runId || this.workflow.taskDigest !== event.taskDigest) throw new AgentHubError("AGENT_HUB_WORKFLOW_BINDING_INVALID");
    const previous = this.roles.get(event.executionId);
    if (event.kind === "role_reserved") {
      if (previous) {
        if (JSON.stringify(previous._event) !== JSON.stringify(event)) throw new AgentHubError("AGENT_HUB_DUPLICATE_RESERVATION_REJECTED");
        return this.snapshot();
      }
      if (this.roles.size >= this.policy.maxRoleAttempts) throw new AgentHubError("AGENT_HUB_ROLE_CAPACITY_EXHAUSTED");
      this.roles.set(event.executionId, {
        sequence: event.sequence, role: event.role, round: event.round, iteration: event.iteration, attempt: event.attempt,
        status: "RESERVED", lifecycleSource: event.source, provider: event.provider, model: event.model, thinking: event.thinking,
        fallbackIndex: event.fallbackIndex, callNumber: event.callNumber, retryCount: event.retryCount, launchStatus: "not_launched",
        modelCalls: 0, failureCategory: null, failureReason: null, responseRunId: null, exitCode: null, usage: null,
        usageSource: "UNAVAILABLE_UNTIL_DURABLE_RECEIPT", receiptDigest: null, routeAttested: false, recordedAt: event.recordedAt,
        runId: event.runId, taskDigest: event.taskDigest, executionId: event.executionId, nodeIdDigest: event.nodeIdDigest,
        terminal: false, _event: event,
      });
    } else if (event.kind === "role_started") {
      if (!previous || previous.terminal || !sameIdentity(previous, event)) throw new AgentHubError("AGENT_HUB_STARTED_WITHOUT_RESERVATION");
      previous.status = "RUNNING";
      previous.lifecycleSource = event.source;
      previous.launchStatus = "launched";
      previous.modelCalls = null;
      previous.recordedAt = event.recordedAt;
    } else {
      if (previous?.terminal) {
        if (previous.receiptDigest !== event.receiptDigest) throw new AgentHubError("AGENT_HUB_CONFLICTING_RECEIPT_REJECTED");
        return this.snapshot();
      }
      if (!previous && this.roles.size >= this.policy.maxRoleAttempts) throw new AgentHubError("AGENT_HUB_ROLE_CAPACITY_EXHAUSTED");
      this.roles.set(event.executionId, terminalProjection(event, previous));
    }
    this.degraded = null;
    return this.snapshot();
  }

  reset() {
    this.workflow = null;
    this.roles.clear();
    this.degraded = null;
  }

  snapshot() {
    const roles = [...this.roles.values()].sort((left, right) => left.sequence - right.sequence).slice(-this.policy.maxRenderedRoleAttempts).map(({ _event, runId, taskDigest, executionId, nodeIdDigest, ...entry }) => structuredClone(entry));
    const terminalAttempts = [...this.roles.values()].filter((entry) => entry.terminal).map((entry) => ({
      agent: entry.role, executionId: entry.executionId, launchStatus: entry.launchStatus, usage: entry.usage,
    }));
    const usage = aggregateUsageAttempts(terminalAttempts);
    const active = roles.filter((entry) => !entry.terminal).length;
    return {
      version: AGENT_HUB_VERSION,
      enabled: this.policy.enabled,
      mode: "READ_ONLY_METADATA",
      authority: { modelCalls: 0, tools: 0, steering: false, revive: false, kill: false, spawn: false },
      status: this.degraded ? "DEGRADED" : this.workflow ? "AVAILABLE" : "EMPTY",
      errorCode: this.degraded,
      workflow: this.workflow ? {
        runId: this.workflow.runId,
        taskDigest: this.workflow.taskDigest,
        checkpointSequence: this.workflow.checkpointSequence,
        lifecycleStatus: this.workflow.lifecycleStatus,
        workflowStatus: this.workflow.workflowStatus,
        currentPhase: this.workflow.currentPhase,
        round: this.workflow.round,
        workerStatus: this.workflow.workerStatus,
        testerStatus: this.workflow.testerStatus,
        verificationStatus: this.workflow.verificationStatus,
        reviewStatus: this.workflow.reviewStatus,
        blockingFindingsCount: this.workflow.blockingFindingsCount,
        correctionPerformed: this.workflow.correctionPerformed,
        finalVerificationStatus: this.workflow.finalVerificationStatus,
        cleanupStatus: this.workflow.cleanupStatus,
        evidenceStatus: this.workflow.evidenceStatus,
        hardLimits: structuredClone(this.workflow.hardLimits),
        spawnBudget: structuredClone(this.workflow.spawnBudget),
        allocationStatus: this.workflow.allocationStatus,
        updatedAt: this.workflow.updatedAt,
      } : null,
      roster: { total: roles.length, active, terminal: roles.length - active, roles },
      usage,
      isolation: { councilOutputsVisible: false, promptsVisible: false, transcriptsVisible: false, fileContentVisible: false, toolOutputVisible: false },
    };
  }
}

function displayMetric(value, formatter = String) {
  return typeof value === "number" && Number.isFinite(value) ? formatter(value) : "UNAVAILABLE";
}

export function renderAgentHubSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") throw new AgentHubError("AGENT_HUB_SNAPSHOT_INVALID");
  if (snapshot.status === "DEGRADED") return `Agent Hub: DEGRADED (${snapshot.errorCode ?? "AGENT_HUB_UNAVAILABLE"})\nRead-only observability failed; workflow execution is unaffected.`;
  if (!snapshot.workflow) return "Agent Hub: EMPTY\nNo authoritative workflow journal is active in this session. Model calls: 0; control authority: none.";
  const workflow = snapshot.workflow;
  const lines = [
    `Agent Hub: ${workflow.lifecycleStatus}/${workflow.workflowStatus} · phase ${workflow.currentPhase} · round ${workflow.round}`,
    `Run ${workflow.runId} · checkpoint ${workflow.checkpointSequence} · spawn ${workflow.spawnBudget.used}/${workflow.spawnBudget.workflowLimit} · limits c${workflow.hardLimits.concurrency}/d${workflow.hardLimits.subagentDepth}/r${workflow.hardLimits.correctionIterations}`,
    "ROLE | STATE | ROUTE | TOKENS | COST_USD | RECEIPT",
  ];
  for (const entry of snapshot.roster.roles) {
    const route = entry.provider && entry.model ? (entry.model.startsWith(`${entry.provider}/`) ? entry.model : `${entry.provider}/${entry.model}`) : "UNAVAILABLE";
    const tokens = displayMetric(entry.usage?.totalTokens, (value) => String(value));
    const cost = displayMetric(entry.usage?.costUsd, (value) => value.toFixed(6));
    const receipt = typeof entry.receiptDigest === "string" ? entry.receiptDigest.slice(0, 12) : "UNAVAILABLE";
    lines.push(`${entry.role}#${entry.sequence} | ${entry.status} | ${route}:${entry.thinking ?? "UNAVAILABLE"} | ${tokens} | ${cost} | ${receipt}`);
  }
  if (snapshot.roster.roles.length === 0) lines.push("(no authoritative role reservations or receipts yet)");
  lines.push(`Usage ${snapshot.usage.status}; attempts ${snapshot.usage.attemptCount}; active ${snapshot.roster.active}; terminal ${snapshot.roster.terminal}.`);
  lines.push("Read-only metadata projection: no transcripts, prompts, tool payloads, Council outputs, steering, cancellation, spawning, or model calls.");
  return lines.join("\n");
}

export function agentHubTraceMetadata(value) {
  const event = validateAgentHubEvent(value);
  return {
    kind: event.kind,
    source: event.source,
    runId: event.runId,
    taskDigest: event.taskDigest,
    checkpointSequence: event.kind === "workflow_journal" ? event.checkpointSequence : undefined,
    lifecycleStatus: event.kind === "workflow_journal" ? event.lifecycleStatus : undefined,
    workflowStatus: event.kind === "workflow_journal" ? event.workflowStatus : undefined,
    currentPhase: event.kind === "workflow_journal" ? event.currentPhase : undefined,
    role: event.kind !== "workflow_journal" ? event.role : undefined,
    sequence: event.kind !== "workflow_journal" ? event.sequence : undefined,
    attempt: event.kind !== "workflow_journal" ? event.attempt : undefined,
    status: event.kind === "role_receipt" ? event.status : event.kind === "role_started" ? "RUNNING" : event.kind === "role_reserved" ? "RESERVED" : undefined,
    provider: event.kind === "role_reserved" || event.kind === "role_receipt" ? event.provider : undefined,
    model: event.kind === "role_reserved" || event.kind === "role_receipt" ? event.model : undefined,
    thinking: event.kind === "role_reserved" || event.kind === "role_receipt" ? event.thinking : undefined,
    receiptDigest: event.kind === "role_receipt" ? event.receiptDigest : undefined,
  };
}
