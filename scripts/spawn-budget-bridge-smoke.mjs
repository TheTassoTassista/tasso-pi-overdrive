#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { canonicalizeDelegationResponse } from "../lib/delegation-response.mjs";
import { executeDelegationWithRetry } from "../lib/delegation-retry.mjs";
import { runEnforcedWorkflow } from "../lib/workflow-state.mjs";
import { calculateRequiredSpawnBudget, createWorkflowSpawnBudgetGuard } from "../lib/workflow-spawn-budget.mjs";

const agentDirectory = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const upstreamRoot = path.join(agentDirectory, "npm", "node_modules", "pi-subagents");
const requireFromUpstream = createRequire(path.join(upstreamRoot, "package.json"));
const { createJiti } = await import(requireFromUpstream.resolve("jiti"));
const jiti = createJiti(import.meta.url);
const bridgeModule = await jiti.import(path.join(upstreamRoot, "src", "slash", "prompt-template-bridge.ts"));
const budgetModule = await jiti.import(path.join(upstreamRoot, "src", "runs", "shared", "spawn-budget.ts"));
const packageMetadata = JSON.parse(fs.readFileSync(path.join(upstreamRoot, "package.json"), "utf8"));
const {
  PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT,
  PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT,
  registerPromptTemplateDelegationBridge,
} = bridgeModule;
const { preflightSpawnBudget, reserveSpawnBudget } = budgetModule;

class EventBus {
  handlers = new Map();
  on(event, handler) {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return () => handlers.delete(handler);
  }
  emit(event, value) {
    for (const handler of [...(this.handlers.get(event) ?? [])]) handler(value);
  }
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-spawn-bridge-"));
const fixtureFile = path.join(temporary, "fixture.txt");
fs.writeFileSync(fixtureFile, "initial\n");
const plan = calculateRequiredSpawnBudget();
const configuredSpawnLimit = plan.requiredTotalSpawns;
const guard = createWorkflowSpawnBudgetGuard({ configuredSpawnLimit, plan });
const bus = new EventBus();
const sessionId = "deterministic-bridge-session";
const upstreamConfig = { maxSubagentSpawnsPerSession: configuredSpawnLimit };
const upstreamState = {
  currentSessionId: sessionId,
  subagentSpawns: { sessionId, count: 0, configuredLimit: configuredSpawnLimit, granted: 0, grantHistory: [] },
};
const executions = [];
let localProviderInvocations = 0;
let nodeSequence = 0;
let transientFixtureAttempts = 0;
let repeatedCouncilTwoInvalidAttempts = 0;
let structuredFailureProjection;

function reviewRound(task) {
  const match = /Review round (\d+)/u.exec(task);
  return match ? Number(match[1]) : 0;
}

function structuredValue(agent, task) {
  if (agent.startsWith("council-") && agent !== "council-judge") {
    return { conclusion: `${agent} deterministic conclusion`, recommendation: "proceed", confidence: "HIGH", evidence: ["local bridge fixture"], risks: [], blockingConcerns: [] };
  }
  if (agent === "council-judge") {
    return { decision: "proceed", decisionBasis: "three deterministic structured reports", confidence: "HIGH", agreements: ["fixture"], disagreements: [], requiredActions: [] };
  }
  const round = reviewRound(task);
  const blocking = round === 0 || (round === 1 && agent === "correctness-reviewer");
  return {
    verdict: blocking ? "BLOCKING" : "PASS",
    summary: blocking ? `deterministic blocker for round ${round}` : `round ${round} passed`,
    findings: blocking ? [{ severity: "BLOCKING", title: `round-${round}-fixture`, evidence: "deterministic local provider" }] : [],
  };
}

function deterministicProvider(params, slot) {
  localProviderInvocations += 1;
  if (params.agent === "worker") fs.appendFileSync(fixtureFile, `worker:${slot}:${params.task.includes("Correction iteration 2") ? 2 : params.task.includes("Correction iteration 1") ? 1 : 0}\n`);
  const modelInvalid = params.agent === "council-2"
    && params.task.includes("Council purpose: repeated-failure")
    && repeatedCouncilTwoInvalidAttempts++ === 0;
  const structuredOutput = params.outputSchema ? structuredValue(params.agent, params.task ?? "") : undefined;
  const finalOutput = params.outputSchema ? undefined : `${params.agent} completed by deterministic local provider`;
  const launchContractDigest = createHash("sha256").update(`${slot}:${params.agent}:${params.model}:${params.delegatedThinkingOverride}`).digest("hex");
  executions.push({ slot, agent: params.agent, task: params.task, model: params.model, thinking: params.delegatedThinkingOverride, structured: Boolean(params.outputSchema), outcome: modelInvalid ? "STRUCTURED_OUTPUT_MODEL_INVALID" : "completed", launchContractDigest });
  if (modelInvalid) {
    const syntheticSensitiveOutput = ["API", "_TOKEN=", "sk", "-test-never-project-this-raw-output", "\nconst hidden = process.env.SECRET;"].join("");
    return {
      isError: true,
      content: [{ type: "text", text: "deterministic structured-output failure" }],
      details: {
        mode: "single",
        runId: randomUUID(),
        results: [{
          agent: params.agent,
          finalOutput: syntheticSensitiveOutput,
          structuredOutputFailed: true,
          error: "Missing structured output call; missing required property recommendation at path /recommendation",
          exitCode: 1,
          model: params.model,
          thinking: params.delegatedThinkingOverride,
          launchContractDigest,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
          progressSummary: { toolCount: 0, durationMs: 0, tokens: 0 },
        }],
      },
    };
  }
  if (params.task.includes("TRANSIENT_RETRY_ACCOUNTING") && transientFixtureAttempts++ === 0) {
    return {
      isError: true,
      content: [{ type: "text", text: "429 deterministic transient fixture" }],
      details: {
        mode: "single",
        runId: randomUUID(),
        results: [{
          agent: params.agent,
          error: "429 deterministic transient fixture",
          exitCode: 1,
          model: params.model,
          thinking: params.delegatedThinkingOverride,
          launchContractDigest,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
          progressSummary: { toolCount: 0, durationMs: 0, tokens: 0 },
        }],
      },
    };
  }
  return {
    content: [{ type: "text", text: "deterministic local completion" }],
    details: {
      mode: "single",
      runId: randomUUID(),
      results: [{
        agent: params.agent,
        finalOutput,
        structuredOutput,
        exitCode: 0,
        model: params.model,
        thinking: params.delegatedThinkingOverride,
        launchContractDigest,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
        progressSummary: { toolCount: 0, durationMs: 0, tokens: 0 },
      }],
    },
  };
}

const bridge = registerPromptTemplateDelegationBridge({
  events: bus,
  getContext: () => ({ cwd: temporary }),
  execute: async () => { throw new Error("legacy bridge path must not run"); },
  executeStructured: async (_requestId, params) => {
    const checked = preflightSpawnBudget(upstreamState, upstreamConfig, sessionId, 1);
    if (checked.error) return { isError: true, content: [{ type: "text", text: checked.error }], details: { mode: "single", results: [] } };
    const reserved = reserveSpawnBudget(upstreamState, upstreamConfig, sessionId, 1);
    if (reserved.error) return { isError: true, content: [{ type: "text", text: reserved.error }], details: { mode: "single", results: [] } };
    return deterministicProvider(params, reserved.snapshot.used);
  },
});

const route = { model: "fixture/deterministic", thinking: "low" };
const bridgeRequest = (input) => new Promise((resolve) => {
  const requestId = randomUUID();
  const ownerRunId = input.ownerRunId ?? "deterministic-bridge-owner";
  const nodeId = input.nodeId;
  const unsubscribe = bus.on(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, (raw) => {
    if (raw?.requestId !== requestId || raw?.nodeId !== nodeId || raw?.ownerRunId !== ownerRunId) return;
    unsubscribe();
    resolve(raw);
  });
  bus.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, {
    requestId,
    ownerRunId,
    nodeId,
    agent: input.agent,
    task: input.task,
    context: "fresh",
    cwd: temporary,
    model: route.model,
    thinking: route.thinking,
    timeoutMs: 30_000,
    toolBudget: { hard: 2, block: ["subagent", "bash"] },
    artifacts: false,
    result: input.result ?? { kind: "text" },
  });
});
const delegate = (input) => executeDelegationWithRetry((attempt) => new Promise((resolve, reject) => {
  guard.claimSpawn(input.agent, { retry: attempt > 1 });
  const requestId = randomUUID();
  const nodeId = `${String(nodeSequence += 1).padStart(2, "0")}-${input.agent}`;
  const ownerRunId = "deterministic-bridge-owner";
  const unsubscribe = bus.on(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, (raw) => {
    if (raw?.requestId !== requestId || raw?.nodeId !== nodeId || raw?.ownerRunId !== ownerRunId) return;
    unsubscribe();
    const response = canonicalizeDelegationResponse(route, raw, { attempt, schema: input.result?.kind === "structured" ? input.result.schema : undefined });
    if (response.status === "completed") resolve(response);
    else {
      if (response.failureCategory === "STRUCTURED_OUTPUT_MODEL_INVALID") {
        const serialized = JSON.stringify(response);
        structuredFailureProjection = {
          status: !serialized.includes("never-project-this-raw-output")
            && response.failureMetadata?.outputLength === null
            && response.failureMetadata?.rawOutputDigest === null
            && response.failureMetadata?.missingRequiredFields?.includes("recommendation")
            ? "PASS"
            : "FAIL",
          failureMetadata: response.failureMetadata,
        };
      }
      reject(Object.assign(new Error(response.error ?? `${input.agent} failed`), { delegationStatus: response.status, failureCategory: response.failureCategory }));
    }
  });
  bus.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, {
    requestId,
    ownerRunId,
    nodeId,
    agent: input.agent,
    task: input.task,
    context: "fresh",
    cwd: temporary,
    model: route.model,
    thinking: route.thinking,
    timeoutMs: 30_000,
    toolBudget: { hard: 2, block: ["subagent", "bash"] },
    artifacts: false,
    result: input.result,
  });
}));

let state;
let cleanup = "FAIL";
let negative;
let atomic;
let bridgePrelaunch;
let schemaPrelaunch;
let retryAccounting;
let longPathExecutions;
let longPathProviderInvocations;
let longPathUpstreamCount;
let longPathControllerCount;
try {
  state = await runEnforcedWorkflow({
    task: "exercise the complete deterministic spawn-budget path",
    allocation: { worktree: temporary, port: 32123, stateDir: path.join(temporary, "state"), browserProfile: path.join(temporary, "browser"), browserSession: "spawn-budget-smoke", database: "spawn_budget", schema: "spawn_budget" },
    delegate,
    verify: async ({ round }) => ({ status: "PASS", processExitCode: 0, round }),
    includeOracle: true,
    includeSecurity: true,
    modelPolicy: { digest: "deterministic-bridge-policy", roles: {} },
    ownerRunId: "deterministic-bridge-owner",
    spawnBudgetGuard: guard,
  });

  longPathExecutions = executions.slice();
  longPathProviderInvocations = localProviderInvocations;
  longPathUpstreamCount = upstreamState.subagentSpawns.count;
  longPathControllerCount = guard.snapshot().used;

  const retryGuard = createWorkflowSpawnBudgetGuard({ configuredSpawnLimit, plan });
  const beforeRetryUpstreamCount = upstreamState.subagentSpawns.count;
  retryGuard.claimSpawn("scout");
  const transientRaw = await bridgeRequest({ agent: "scout", nodeId: "retry-accounting-1", task: "TRANSIENT_RETRY_ACCOUNTING" });
  const transientCanonical = canonicalizeDelegationResponse(route, transientRaw);
  retryGuard.claimSpawn("scout", { retry: true });
  const retryRaw = await bridgeRequest({ agent: "scout", nodeId: "retry-accounting-2", task: "TRANSIENT_RETRY_ACCOUNTING" });
  const retryCanonical = canonicalizeDelegationResponse(route, retryRaw);
  retryAccounting = {
    status: transientCanonical.failureCategory === "TRANSIENT"
      && retryCanonical.status === "completed"
      && upstreamState.subagentSpawns.count - beforeRetryUpstreamCount === 2
      && retryGuard.snapshot().used === 2
      && retryGuard.snapshot().retriesUsed === 1
      && retryGuard.snapshot().retryReserveRemaining === plan.retryReserve - 1
      ? "PASS"
      : "FAIL",
    upstreamSlotsConsumed: upstreamState.subagentSpawns.count - beforeRetryUpstreamCount,
    controllerSlotsConsumed: retryGuard.snapshot().used,
    retriesUsed: retryGuard.snapshot().retriesUsed,
    retryReserveRemaining: retryGuard.snapshot().retryReserveRemaining,
  };

  const beforeSchemaProviderCalls = localProviderInvocations;
  const beforeSchemaUpstreamCount = upstreamState.subagentSpawns.count;
  const malformedSchemaRaw = await bridgeRequest({
    agent: "council-2",
    nodeId: "schema-prelaunch-council-2",
    task: "deterministic invalid schema configuration",
    result: { kind: "structured", schema: "not-an-object" },
  });
  const malformedSchema = canonicalizeDelegationResponse(route, malformedSchemaRaw, { attempt: 1 });
  schemaPrelaunch = {
    status: malformedSchema.status === "invalid_request"
      && malformedSchema.failureCategory === "STRUCTURED_OUTPUT_POLICY_ERROR"
      && malformedSchema.launchStatus === "not_launched"
      && malformedSchema.modelCalls === 0
      && localProviderInvocations === beforeSchemaProviderCalls
      && upstreamState.subagentSpawns.count === beforeSchemaUpstreamCount
      ? "PASS"
      : "FAIL",
    failureCategory: malformedSchema.failureCategory,
    launchStatus: malformedSchema.launchStatus,
    modelCalls: malformedSchema.modelCalls,
    providerInvocationsAdded: localProviderInvocations - beforeSchemaProviderCalls,
    upstreamSlotsAdded: upstreamState.subagentSpawns.count - beforeSchemaUpstreamCount,
  };

  const beforePrelaunchProviderCalls = localProviderInvocations;
  const savedUpstreamCount = upstreamState.subagentSpawns.count;
  upstreamState.subagentSpawns.count = configuredSpawnLimit;
  const prelaunchOwnerRunId = "deterministic-prelaunch-owner";
  const prelaunchNodeId = "prelaunch-council-3";
  const prelaunchRaw = await bridgeRequest({
    agent: "council-3",
    ownerRunId: prelaunchOwnerRunId,
    nodeId: prelaunchNodeId,
    task: "deterministic pre-launch budget exhaustion",
    result: { kind: "structured", schema: { type: "object" } },
  });
  const prelaunchCanonical = canonicalizeDelegationResponse(route, prelaunchRaw);
  bridgePrelaunch = {
    status: prelaunchCanonical.status === "failed"
      && prelaunchCanonical.failureCategory === "RESOURCE_LIMIT"
      && prelaunchCanonical.failureReason === "SUBAGENT_SPAWN_BUDGET_EXHAUSTED"
      && prelaunchCanonical.launchStatus === "not_launched"
      && prelaunchCanonical.modelCalls === 0
      && prelaunchCanonical.model === undefined
      && prelaunchCanonical.thinking === undefined
      && !/runtime_model_route_mismatch/u.test(prelaunchCanonical.error ?? "")
      && localProviderInvocations === beforePrelaunchProviderCalls
      ? "PASS"
      : "FAIL",
    failureCategory: prelaunchCanonical.failureCategory,
    failureReason: prelaunchCanonical.failureReason,
    launchStatus: prelaunchCanonical.launchStatus,
    modelCalls: prelaunchCanonical.modelCalls,
    providerInvocationsAdded: localProviderInvocations - beforePrelaunchProviderCalls,
  };
  upstreamState.subagentSpawns.count = savedUpstreamCount;

  let negativeDelegations = 0;
  try {
    await runEnforcedWorkflow({
      task: "limit 24 negative control",
      allocation: { worktree: temporary },
      delegate: async () => { negativeDelegations += 1; return {}; },
      verify: async () => ({ status: "PASS" }),
      includeOracle: true,
      includeSecurity: true,
      modelPolicy: { digest: "negative-policy", roles: {} },
      configuredSpawnLimit: 24,
    });
    negative = { status: "FAIL", reason: "preflight unexpectedly passed", delegations: negativeDelegations };
  } catch (error) {
    negative = { status: error?.code === "INSUFFICIENT_SUBAGENT_SPAWN_BUDGET" && negativeDelegations === 0 ? "PASS" : "FAIL", code: error?.code, delegations: negativeDelegations, modelCalls: 0 };
  }

  const atomicState = {
    currentSessionId: "atomic-session",
    subagentSpawns: { sessionId: "atomic-session", count: 40, configuredLimit: 42, granted: 0, grantHistory: [] },
  };
  const atomicCheck = preflightSpawnBudget(atomicState, { maxSubagentSpawnsPerSession: 42 }, "atomic-session", 4);
  atomic = { status: Boolean(atomicCheck.error) && atomicState.subagentSpawns.count === 40 ? "PASS" : "FAIL", used: atomicState.subagentSpawns.count, requested: 4, remaining: atomicCheck.snapshot.remaining };
} finally {
  bridge.dispose();
  fs.rmSync(temporary, { recursive: true, force: true });
  cleanup = fs.existsSync(temporary) ? "FAIL" : "PASS";
}

const repeatedCouncilThree = longPathExecutions?.find((entry) => entry.agent === "council-3" && entry.task.includes("repeated-failure"));
const repeatedCouncilTwo = (longPathExecutions ?? []).filter((entry) => entry.agent === "council-2" && entry.task.includes("repeated-failure"));
const repeatedCouncilJudge = longPathExecutions?.find((entry) => entry.agent === "council-judge" && entry.task.includes("repeated-failure"));
const workerSlots = (longPathExecutions ?? []).filter((entry) => entry.agent === "worker").map((entry) => entry.slot);
const testerSlots = (longPathExecutions ?? []).filter((entry) => entry.agent === "tester").map((entry) => entry.slot);
const councilPurposes = state?.evidence.councils.map((entry) => `${entry.purpose}:${entry.complete}`);
const finalTransition = state?.evidence.transitions.at(-1);
const longPathPassed = state?.status === "PASS"
  && finalTransition?.state === "FINAL"
  && finalTransition?.phase === "complete"
  && longPathExecutions?.length === 32
  && longPathUpstreamCount === 32
  && longPathControllerCount === 32
  && state.spawnBudget.retriesUsed === 1
  && repeatedCouncilThree?.slot === 25
  && repeatedCouncilTwo.length === 2
  && repeatedCouncilTwo[0]?.slot === 24
  && repeatedCouncilTwo[0]?.outcome === "STRUCTURED_OUTPUT_MODEL_INVALID"
  && repeatedCouncilTwo[1]?.slot === 26
  && repeatedCouncilTwo[1]?.outcome === "completed"
  && structuredFailureProjection?.status === "PASS"
  && repeatedCouncilJudge?.slot === 27
  && repeatedCouncilJudge?.outcome === "completed"
  && JSON.stringify(councilPurposes) === JSON.stringify(["high-risk-planning:true", "reviewer-disagreement:true", "repeated-failure:true"])
  && workerSlots.length === 3
  && testerSlots.length === 3
  && state.evidence.verifications.length === 3
  && state.evidence.reviews.at(-1)?.reviews.every((review) => review.verdict === "PASS")
  && cleanup === "PASS";
const status = longPathPassed && negative?.status === "PASS" && atomic?.status === "PASS" && bridgePrelaunch?.status === "PASS" && schemaPrelaunch?.status === "PASS" && retryAccounting?.status === "PASS" ? "PASS" : "FAIL";
process.stdout.write(`${JSON.stringify({
  status,
  providerExecution: "DETERMINISTIC_LOCAL_ONLY",
  paidModelCalls: 0,
  piSubagentsVersion: packageMetadata.version,
  budget: { requiredBaseSpawns: plan.requiredBaseSpawns, retryReserve: plan.retryReserve, requiredTotalSpawns: plan.requiredTotalSpawns, configuredSpawnLimit },
  longPath: { status: longPathPassed ? "PASS" : "FAIL", finalState: state?.status, finalPhase: finalTransition, delegations: longPathExecutions?.length, localProviderInvocations: longPathProviderInvocations, upstreamSpawnCount: longPathUpstreamCount, controllerSpawnCount: longPathControllerCount, retriesUsed: state?.spawnBudget?.retriesUsed, councilPurposes, repeatedFailureJudgeSlot: repeatedCouncilJudge?.slot, workerSlots, testerSlots },
  slot25: repeatedCouncilThree ? { status: "PASS", slot: repeatedCouncilThree.slot, agent: repeatedCouncilThree.agent, purpose: "repeated-failure", structured: repeatedCouncilThree.structured } : { status: "FAIL" },
  structuredRetry: { status: repeatedCouncilTwo.length === 2 && repeatedCouncilTwo[0]?.outcome === "STRUCTURED_OUTPUT_MODEL_INVALID" && repeatedCouncilTwo[1]?.outcome === "completed" ? "PASS" : "FAIL", attempts: repeatedCouncilTwo.map(({ slot, agent, model, thinking, outcome }) => ({ slot, agent, model, thinking, outcome })) },
  structuredFailureProjection,
  retryAccounting,
  schemaPrelaunch,
  bridgePrelaunch,
  negativeLimit24: negative,
  atomicFanout: atomic,
  cleanup,
}, null, 2)}\n`);
process.exit(status === "PASS" ? 0 : 1);
