import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MAX_WORKFLOW_CONCURRENCY = 3;
export const MAX_SUBAGENT_DEPTH = 1;
export const MAX_CORRECTION_ITERATIONS = 2;
export const MAX_TRANSIENT_RETRIES_PER_DELEGATION = 1;
export const MAX_TRANSIENT_RETRIES_PER_WORKFLOW = 3;

export const WORKFLOW_SPAWN_POLICY = Object.freeze({
  scoutCount: 1,
  plannerCount: 1,
  workerCount: 1,
  testerCountPerRound: 1,
  oracleCount: 1,
  councilSize: MAX_WORKFLOW_CONCURRENCY,
  judgeCountPerCouncil: 1,
  reviewerCount: MAX_WORKFLOW_CONCURRENCY,
  maxCorrectionRounds: MAX_CORRECTION_ITERATIONS,
  reviewerDisagreementCouncilPerRound: 1,
  repeatedFailureStartsAtCorrection: 2,
  repeatedFailureOracleCount: 1,
  repeatedFailureCouncilCount: 1,
  maxTransientRetriesPerDelegation: MAX_TRANSIENT_RETRIES_PER_DELEGATION,
  maxTransientRetriesPerWorkflow: MAX_TRANSIENT_RETRIES_PER_WORKFLOW,
});

export class WorkflowSpawnBudgetError extends Error {
  constructor(code, metadata) {
    super(`${code}: ${JSON.stringify(metadata)}`);
    this.name = "WorkflowSpawnBudgetError";
    this.code = code;
    this.failureCategory = "RESOURCE_LIMIT";
    this.failureReason = code === "INSUFFICIENT_SUBAGENT_SPAWN_BUDGET"
      ? "INSUFFICIENT_SUBAGENT_SPAWN_BUDGET"
      : "SUBAGENT_SPAWN_BUDGET_EXHAUSTED";
    this.metadata = metadata;
  }
}

function integer(name, value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
  return value;
}

export function calculateRequiredSpawnBudget(input = {}) {
  const policy = { ...WORKFLOW_SPAWN_POLICY, ...input };
  const scoutCount = integer("scoutCount", policy.scoutCount);
  const plannerCount = integer("plannerCount", policy.plannerCount);
  const workerCount = integer("workerCount", policy.workerCount);
  const testerCountPerRound = integer("testerCountPerRound", policy.testerCountPerRound);
  const oracleCount = integer("oracleCount", policy.oracleCount);
  const councilSize = integer("councilSize", policy.councilSize, 1);
  const judgeCountPerCouncil = integer("judgeCountPerCouncil", policy.judgeCountPerCouncil, 1);
  const reviewerCount = integer("reviewerCount", policy.reviewerCount, 1);
  const maxCorrectionRounds = integer("maxCorrectionRounds", policy.maxCorrectionRounds);
  const reviewerDisagreementCouncilPerRound = integer("reviewerDisagreementCouncilPerRound", policy.reviewerDisagreementCouncilPerRound);
  const repeatedFailureStartsAtCorrection = integer("repeatedFailureStartsAtCorrection", policy.repeatedFailureStartsAtCorrection, 1);
  const repeatedFailureOracleCount = integer("repeatedFailureOracleCount", policy.repeatedFailureOracleCount);
  const repeatedFailureCouncilCount = integer("repeatedFailureCouncilCount", policy.repeatedFailureCouncilCount);
  const maxTransientRetriesPerDelegation = integer("maxTransientRetriesPerDelegation", policy.maxTransientRetriesPerDelegation);
  const maxTransientRetriesPerWorkflow = integer("maxTransientRetriesPerWorkflow", policy.maxTransientRetriesPerWorkflow);
  const includeInitialOracle = policy.includeInitialOracle !== false;
  const includeInitialCouncil = policy.includeInitialCouncil !== false;

  const verificationRounds = maxCorrectionRounds + 1;
  const councilBlock = councilSize + judgeCountPerCouncil;
  const core = scoutCount + plannerCount + workerCount;
  const initialEscalation = includeInitialOracle
    ? oracleCount + (includeInitialCouncil ? councilBlock : 0)
    : 0;
  const verificationAndReview = verificationRounds * (testerCountPerRound + reviewerCount);
  const correctionWorkers = maxCorrectionRounds * workerCount;
  const reviewerDisagreementEscalations = verificationRounds * reviewerDisagreementCouncilPerRound * councilBlock;
  const repeatedFailureCorrections = maxCorrectionRounds >= repeatedFailureStartsAtCorrection
    ? maxCorrectionRounds - repeatedFailureStartsAtCorrection + 1
    : 0;
  const repeatedFailureEscalations = repeatedFailureCorrections
    * (repeatedFailureOracleCount + repeatedFailureCouncilCount * councilBlock);
  const requiredBaseSpawns = core
    + initialEscalation
    + verificationAndReview
    + correctionWorkers
    + reviewerDisagreementEscalations
    + repeatedFailureEscalations;
  const retryReserve = Math.min(
    requiredBaseSpawns * maxTransientRetriesPerDelegation,
    maxTransientRetriesPerWorkflow,
  );
  const requiredTotalSpawns = requiredBaseSpawns + retryReserve;

  return Object.freeze({
    requiredBaseSpawns,
    retryReserve,
    requiredTotalSpawns,
    workflowPolicy: Object.freeze({
      maxCorrectionRounds,
      councilSize,
      reviewerCount,
      verificationRounds,
      maxTransientRetriesPerDelegation,
      maxTransientRetriesPerWorkflow,
      includeInitialOracle,
      includeInitialCouncil,
    }),
    breakdown: Object.freeze({
      core,
      initialEscalation,
      verificationAndReview,
      correctionWorkers,
      reviewerDisagreementEscalations,
      repeatedFailureEscalations,
    }),
  });
}

export function workflowSpawnBudgetForRequest({ includeOracle = false, includeSecurity = true } = {}) {
  return calculateRequiredSpawnBudget({
    includeInitialOracle: includeOracle,
    includeInitialCouncil: includeOracle,
    reviewerCount: includeSecurity ? WORKFLOW_SPAWN_POLICY.reviewerCount : WORKFLOW_SPAWN_POLICY.reviewerCount - 1,
  });
}

export function subagentConfigPath() {
  const agentDirectory = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  return path.join(agentDirectory, "extensions", "subagent", "config.json");
}

export function readConfiguredSpawnLimit(configFile = subagentConfigPath()) {
  let descriptor;
  try {
    descriptor = fs.openSync(configFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("subagent spawn configuration is not a regular file");
    const parsed = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    return integer("maxSubagentSpawnsPerSession", parsed?.maxSubagentSpawnsPerSession, 1);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function assertConfiguredSpawnBudget(configuredSpawnLimit, plan, metadata = {}) {
  integer("configuredSpawnLimit", configuredSpawnLimit, 1);
  if (!plan || !Number.isSafeInteger(plan.requiredTotalSpawns)) throw new Error("valid workflow spawn budget plan is required");
  if (configuredSpawnLimit < plan.requiredTotalSpawns) {
    throw new WorkflowSpawnBudgetError("INSUFFICIENT_SUBAGENT_SPAWN_BUDGET", {
      configured: configuredSpawnLimit,
      required: plan.requiredTotalSpawns,
      requiredBaseSpawns: plan.requiredBaseSpawns,
      retryReserve: plan.retryReserve,
      ...metadata,
    });
  }
  return {
    requiredBaseSpawns: plan.requiredBaseSpawns,
    retryReserve: plan.retryReserve,
    requiredTotalSpawns: plan.requiredTotalSpawns,
    configuredSpawnLimit,
  };
}

/**
 * @param {{ configuredSpawnLimit: number, plan: ReturnType<typeof calculateRequiredSpawnBudget>, initialUsed?: number, initialRetriesUsed?: number }} options
 */
export function createWorkflowSpawnBudgetGuard({ configuredSpawnLimit, plan, initialUsed = 0, initialRetriesUsed = 0 }) {
  const preflight = assertConfiguredSpawnBudget(configuredSpawnLimit, plan);
  const workflowLimit = plan.requiredTotalSpawns;
  let used = integer("initialUsed", initialUsed);
  if (used > workflowLimit) throw new Error("initialUsed exceeds the derived workflow spawn limit");
  let retriesUsed = integer("initialRetriesUsed", initialRetriesUsed);
  if (retriesUsed > plan.retryReserve || retriesUsed > used) throw new Error("initialRetriesUsed is inconsistent with the derived workflow spawn budget");
  const atomicBlocks = [];
  const reservedBaseSpawns = () => atomicBlocks.reduce((total, block) => total + block.remaining, 0);

  const snapshot = () => Object.freeze({
    ...preflight,
    workflowLimit,
    used,
    remaining: Math.max(0, workflowLimit - used),
    retriesUsed,
    retryReserveRemaining: Math.max(0, plan.retryReserve - retriesUsed),
    reservedBaseSpawns: reservedBaseSpawns(),
  });
  const assertBlock = (block, requested) => {
    integer("requested", requested, 1);
    const current = snapshot();
    if (requested > current.remaining) {
      throw new WorkflowSpawnBudgetError("ATOMIC_SUBAGENT_SPAWN_BUDGET_EXHAUSTED", {
        block,
        configured: configuredSpawnLimit,
        workflowLimit,
        used,
        remaining: current.remaining,
        requested,
      });
    }
    return current;
  };
  const beginAtomicBlock = (block, requested) => {
    assertBlock(block, requested);
    const reservation = { block, remaining: requested, released: false };
    atomicBlocks.push(reservation);
    return () => {
      if (reservation.released) return;
      reservation.released = true;
      const index = atomicBlocks.indexOf(reservation);
      if (index >= 0) atomicBlocks.splice(index, 1);
    };
  };
  const claimSpawn = (label, { retry = false } = {}) => {
    if (retry) {
      if (retriesUsed >= plan.retryReserve) {
        throw new WorkflowSpawnBudgetError("TRANSIENT_RETRY_RESERVE_EXHAUSTED", {
          configured: configuredSpawnLimit,
          used,
          retryReserve: plan.retryReserve,
          retriesUsed,
        });
      }
      const unreservedRemaining = workflowLimit - used - reservedBaseSpawns();
      if (unreservedRemaining < 1) {
        throw new WorkflowSpawnBudgetError("ATOMIC_SUBAGENT_SPAWN_BUDGET_EXHAUSTED", {
          block: atomicBlocks.at(-1)?.block ?? label,
          configured: configuredSpawnLimit,
          workflowLimit,
          used,
          remaining: Math.max(0, workflowLimit - used),
          reservedBaseSpawns: reservedBaseSpawns(),
          requested: 1,
        });
      }
      retriesUsed += 1;
    } else {
      const activeReservation = atomicBlocks.at(-1);
      if (activeReservation?.remaining > 0) activeReservation.remaining -= 1;
      else assertBlock(label, 1);
    }
    used += 1;
    return snapshot();
  };
  return Object.freeze({ snapshot, assertBlock, beginAtomicBlock, claimSpawn });
}
