import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { canonicalizeDelegationResponse } from "../lib/delegation-response.mjs";
import { classifyDelegationFailure, retryableDelegationFailure } from "../lib/delegation-failure.mjs";
import { makeRoleReceipt } from "../lib/workflow-receipts.mjs";
import { runEnforcedWorkflow, WORKFLOW_VERSION } from "../lib/workflow-state.mjs";
import {
  assertConfiguredSpawnBudget,
  calculateRequiredSpawnBudget,
  createWorkflowSpawnBudgetGuard,
  EXTERNAL_SUBAGENT_QUOTA,
  workflowSpawnBudgetForRequest,
} from "../lib/workflow-spawn-budget.mjs";

const allocation = { worktree: "/tmp/worktree", port: 32123, stateDir: "/tmp/state", browserProfile: "/tmp/profile", browserSession: "pi-budget-test", database: "pi_budget", schema: "pi_budget" };
const modelPolicy = { digest: "spawn-budget-policy", roles: { worker: { model: "fixture/model", thinking: "low" } } };

test("current worst-case spawn budget is derived as base 39 plus bounded retry reserve 3", () => {
  const plan = calculateRequiredSpawnBudget();
  assert.equal(plan.requiredBaseSpawns, 39);
  assert.equal(plan.retryReserve, 3);
  assert.equal(plan.requiredTotalSpawns, 42);
  assert.deepEqual(plan.breakdown, {
    core: 3,
    initialEscalation: 5,
    verificationAndReview: 12,
    correctionWorkers: 2,
    reviewerDisagreementEscalations: 12,
    repeatedFailureEscalations: 5,
  });
});

test("unexposed upstream session quota stays explicitly unknown while the local bound remains authoritative", () => {
  const plan = calculateRequiredSpawnBudget();
  const guard = createWorkflowSpawnBudgetGuard({ configuredSpawnLimit: 42, plan, externalQuota: { status: "KNOWN", remaining: 999 } });
  assert.equal(Object.isFrozen(EXTERNAL_SUBAGENT_QUOTA), true);
  assert.deepEqual(guard.snapshot().externalQuota, {
    status: "UNKNOWN",
    authoritative: false,
    scope: "PI_SESSION",
    source: "pi-subagents-public-api",
    reason: "UPSTREAM_LIVE_COUNTER_NOT_EXPOSED",
    enforcement: "UPSTREAM_FAIL_CLOSED_BEFORE_PROVIDER_LAUNCH",
  });
  assert.equal(guard.snapshot().remaining, 42);
  for (let index = 0; index < 42; index += 1) guard.claimSpawn(`bounded-${index}`, { retry: index >= 39 });
  assert.throws(() => guard.claimSpawn("unbounded-43"), /ATOMIC_SUBAGENT_SPAWN_BUDGET_EXHAUSTED/u);
});

test("spawn formula follows correction, council, reviewer, and retry policy changes", () => {
  const baseline = calculateRequiredSpawnBudget();
  assert.ok(calculateRequiredSpawnBudget({ maxCorrectionRounds: 3 }).requiredTotalSpawns > baseline.requiredTotalSpawns);
  assert.ok(calculateRequiredSpawnBudget({ councilSize: 4 }).requiredBaseSpawns > baseline.requiredBaseSpawns);
  assert.ok(calculateRequiredSpawnBudget({ reviewerCount: 4 }).requiredBaseSpawns > baseline.requiredBaseSpawns);
  assert.equal(calculateRequiredSpawnBudget({ maxTransientRetriesPerWorkflow: 0 }).retryReserve, 0);
  assert.equal(calculateRequiredSpawnBudget({ maxTransientRetriesPerWorkflow: 7 }).retryReserve, 7);
  assert.equal(workflowSpawnBudgetForRequest({ includeOracle: false, includeSecurity: true }).requiredBaseSpawns, 34);
});

test("configured limit 24 fails before Scout with zero delegations and zero model calls", async () => {
  let delegations = 0;
  let modelCalls = 0;
  await assert.rejects(() => runEnforcedWorkflow({
    task: "long workflow must preflight",
    allocation,
    modelPolicy,
    includeOracle: true,
    configuredSpawnLimit: 24,
    delegate: async () => { delegations += 1; modelCalls += 1; return {}; },
    verify: async () => ({ status: "PASS" }),
  }), (error) => {
    assert.equal(error.code, "INSUFFICIENT_SUBAGENT_SPAWN_BUDGET");
    assert.equal(error.failureCategory, "RESOURCE_LIMIT");
    assert.deepEqual(error.metadata, {
      configured: 24,
      required: 42,
      requiredBaseSpawns: 39,
      retryReserve: 3,
      workflowVersion: WORKFLOW_VERSION,
      maxCorrections: 2,
    });
    return true;
  });
  assert.equal(delegations, 0);
  assert.equal(modelCalls, 0);
});

test("an atomic Council block is rejected when only two spawn slots remain", () => {
  const plan = calculateRequiredSpawnBudget();
  const guard = createWorkflowSpawnBudgetGuard({ configuredSpawnLimit: 42, plan, initialUsed: 40 });
  assert.throws(() => guard.assertBlock("repeated-failure-council", 4), (error) => {
    assert.equal(error.code, "ATOMIC_SUBAGENT_SPAWN_BUDGET_EXHAUSTED");
    assert.equal(error.metadata.remaining, 2);
    assert.equal(error.metadata.requested, 4);
    return true;
  });
  assert.equal(guard.snapshot().used, 40);
});

test("transient retries cannot consume slots reserved for an atomic Council", () => {
  const plan = calculateRequiredSpawnBudget();
  const guard = createWorkflowSpawnBudgetGuard({ configuredSpawnLimit: 42, plan, initialUsed: 38 });
  const release = guard.beginAtomicBlock("council", 4);
  assert.throws(() => guard.claimSpawn("council-1", { retry: true }), /ATOMIC_SUBAGENT_SPAWN_BUDGET_EXHAUSTED/u);
  for (const role of ["council-1", "council-2", "council-3", "council-judge"]) guard.claimSpawn(role);
  release();
  assert.equal(guard.snapshot().used, 42);
  assert.equal(guard.snapshot().reservedBaseSpawns, 0);
});

test("retry reserve permits total slots 40, 41, and 42 then rejects a fourth retry before spawn", () => {
  const plan = calculateRequiredSpawnBudget();
  const guard = createWorkflowSpawnBudgetGuard({ configuredSpawnLimit: 42, plan });
  for (let index = 0; index < plan.requiredBaseSpawns; index += 1) guard.claimSpawn(`base-${index}`);
  assert.deepEqual([1, 2, 3].map((retry) => {
    const snapshot = guard.claimSpawn(`retry-${retry}`, { retry: true });
    return { used: snapshot.used, retriesUsed: snapshot.retriesUsed };
  }), [
    { used: 40, retriesUsed: 1 },
    { used: 41, retriesUsed: 2 },
    { used: 42, retriesUsed: 3 },
  ]);
  const beforeRejected = guard.snapshot();
  assert.throws(() => guard.claimSpawn("retry-4", { retry: true }), (error) => {
    assert.equal(error.code, "TRANSIENT_RETRY_RESERVE_EXHAUSTED");
    assert.equal(error.failureCategory, "RESOURCE_LIMIT");
    return true;
  });
  assert.deepEqual(guard.snapshot(), beforeRejected, "reserve and total counters remain atomic on rejection");
});

test("pre-launch spawn exhaustion preserves the cause and never runs route attestation or retry", () => {
  const original = "Subagent spawn limit reached for this session (24/24 used, 1 requested).";
  const response = canonicalizeDelegationResponse(
    { model: "fixture/model", thinking: "high" },
    { status: "failed", agent: "council-3", nodeId: "25-council-3", ownerRunId: "owner", error: original },
  );
  assert.equal(response.status, "failed");
  assert.equal(response.error, original);
  assert.equal(response.failureCategory, "RESOURCE_LIMIT");
  assert.equal(response.failureReason, "SUBAGENT_SPAWN_BUDGET_EXHAUSTED");
  assert.equal(response.launchStatus, "not_launched");
  assert.equal(response.modelCalls, 0);
  assert.equal(response.model, undefined);
  assert.equal(response.thinking, undefined);
  assert.doesNotMatch(response.error, /runtime_model_route_mismatch/u);
  assert.equal(retryableDelegationFailure(response), false);
  assert.equal(classifyDelegationFailure(response), "RESOURCE_LIMIT");

  const receipt = makeRoleReceipt({
    runId: randomUUID(), taskId: "a".repeat(64), protocolNonce: "b".repeat(64), executionId: randomUUID(), sequence: 0,
    role: "council-3", round: 0, iteration: 2, attempt: 1, nodeId: "25-council-3", ownerRunId: "owner", response,
  });
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.failure_category, "RESOURCE_LIMIT");
  assert.equal(receipt.failure_reason, "SUBAGENT_SPAWN_BUDGET_EXHAUSTED");
  assert.equal(receipt.launch_status, "not_launched");
  assert.equal(receipt.model_calls, 0);
  assert.equal(receipt.model, null);
  assert.equal(receipt.thinking, null);
  assert.equal(receipt.launch_contract_digest, null);
});

test("configuration validation fails automatically when the derived policy outgrows it", () => {
  const current = calculateRequiredSpawnBudget();
  assert.doesNotThrow(() => assertConfiguredSpawnBudget(42, current));
  const expanded = calculateRequiredSpawnBudget({ councilSize: 4 });
  assert.throws(() => assertConfiguredSpawnBudget(42, expanded), /INSUFFICIENT_SUBAGENT_SPAWN_BUDGET/u);
});

test("resume restores durable spawn and retry accounting instead of resetting it", async () => {
  const plan = workflowSpawnBudgetForRequest({ includeOracle: false, includeSecurity: true });
  const firstGuard = createWorkflowSpawnBudgetGuard({ configuredSpawnLimit: 42, plan });
  const delegate = async ({ agent, result }) => {
    firstGuard.claimSpawn(agent);
    if (result.kind === "structured") {
      return { status: "completed", agent, result: { kind: "structured", value: { verdict: "PASS", summary: "pass", findings: [] } } };
    }
    return { status: "completed", agent, result: { kind: "text", text: "pass" } };
  };
  const completed = await runEnforcedWorkflow({
    task: "resume budget fixture",
    allocation,
    modelPolicy,
    delegate,
    verify: async () => ({ status: "PASS", processExitCode: 0 }),
    spawnBudgetGuard: firstGuard,
  });
  assert.equal(completed.spawnBudget.used, 7);
  const resumedGuard = createWorkflowSpawnBudgetGuard({
    configuredSpawnLimit: 42,
    plan,
    initialUsed: completed.spawnBudget.used,
    initialRetriesUsed: completed.spawnBudget.retriesUsed,
  });
  const resumed = await runEnforcedWorkflow({
    task: "resume budget fixture",
    allocation,
    modelPolicy,
    delegate: async () => { throw new Error("completed workflow must not delegate during resume"); },
    verify: async () => ({ status: "PASS", processExitCode: 0 }),
    resumeState: completed,
    spawnBudgetGuard: resumedGuard,
  });
  assert.equal(resumed.spawnBudget.used, 7);
  assert.equal(resumed.spawnBudget.retriesUsed, 0);
});
