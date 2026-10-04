import test from "node:test";
import assert from "node:assert/strict";
import { availableContextFromPiUsage, renderTaskPolicy, resolveTaskPolicy, taskPolicyMetadata, validateTaskPolicy } from "../lib/task-governor.mjs";
import { resolveTokenGovernor } from "../lib/token-governor.mjs";
import { runEnforcedWorkflow } from "../lib/workflow-state.mjs";

const allocation = { worktree: "/tmp/worktree", port: 32123, stateDir: "/tmp/state", browserProfile: "/tmp/profile", browserSession: "pi-task-policy-test", database: "pi_test", schema: "pi_schema" };
const modelPolicy = { digest: "task-policy-model-fixture", roles: { worker: { model: "fixture/model", thinking: "low" } } };

test("simple string change selects a minimal policy with no expensive systems", () => {
  const policy = resolveTaskPolicy({ task: "Change one string value.", preset: "normal", quality: "auto" });
  assert.equal(policy.decisionModelCalls, 0);
  assert.equal(policy.needs.planner, false);
  assert.equal(policy.needs.secondBrain, false);
  assert.equal(policy.needs.debugger, false);
  assert.equal(policy.needs.browser, false);
  assert.equal(policy.classification.signals.directSmallEdit, true);
  assert.equal(policy.memory.reflect, false);
  assert.equal(policy.needs.council, false);
  assert.ok(policy.toolNeed.capabilities.length <= 4, policy.toolNeed.capabilities.join(","));
});

test("CREATE task is a mutation, while a read-only description of creation is not", () => {
  for (const task of ["Create one fixture and verify it", "Crea un file di test e verificalo"]) {
    const policy = resolveTaskPolicy({ task });
    assert.equal(policy.classification.signals.mutating, true, task);
    assert.ok(policy.toolNeed.capabilities.includes("edit"), task);
    assert.ok(policy.toolNeed.capabilities.includes("verify"), task);
  }
  const readOnly = resolveTaskPolicy({ task: "Explain how file creation works without changing files." });
  assert.equal(readOnly.classification.signals.mutating, false);
  assert.equal(readOnly.toolNeed.capabilities.includes("edit"), false);
});

test("intermittent race under load activates focused debugging capabilities", () => {
  const policy = resolveTaskPolicy({ task: "Find and fix the intermittent race condition under load in src/queue.ts.", preset: "normal", quality: "auto" });
  for (const key of ["planner", "secondBrain", "smartRead", "lsp", "debugger", "eval", "sentinel", "reviewer"]) assert.equal(policy.needs[key], true, key);
  for (const capability of ["read", "search", "edit", "lsp", "memory", "debug", "eval", "sentinel", "verify"]) assert.ok(policy.toolNeed.capabilities.includes(capability), capability);
  assert.ok(policy.reviewNeed.roles.includes("correctness"));
});

test("bounded calculation activates eval while a trivial edit remains eval-free", () => {
  const calculation = resolveTaskPolicy({ task: "Use persistent TypeScript to parse JSON and calculate a histogram." });
  assert.equal(calculation.needs.eval, true);
  assert.ok(calculation.toolNeed.capabilities.includes("eval"));
  const trivial = resolveTaskPolicy({ task: "Change one string value." });
  assert.equal(trivial.needs.eval, false);
  assert.equal(trivial.toolNeed.capabilities.includes("eval"), false);
});

test("structural edit intent is semantic and cannot be activated by a tool name alone", () => {
  const structural = resolveTaskPolicy({ task: "Replace every call expression to legacyApi with modernApi across TypeScript source files." });
  assert.equal(structural.classification.signals.structuralEdit, true);
  assert.ok(structural.toolNeed.capabilities.includes("structural-edit"));
  const superficial = resolveTaskPolicy({ task: "Use ast_grep_rewrite to change one string value." });
  assert.equal(superficial.classification.signals.structuralEdit, false);
  assert.equal(superficial.toolNeed.capabilities.includes("structural-edit"), false);
});

test("ResourceFS activates only for an explicit supported URI", () => {
  const explicit = resolveTaskPolicy({ task: "Inspect repo://root/src/parser.ts without changing it." });
  assert.equal(explicit.classification.signals.resources, true);
  assert.equal(explicit.needs.resources, true);
  assert.ok(explicit.toolNeed.capabilities.includes("resources"));
  const ordinary = resolveTaskPolicy({ task: "Inspect src/parser.ts without changing it." });
  assert.equal(ordinary.classification.signals.resources, false);
  assert.equal(ordinary.needs.resources, false);
  assert.equal(ordinary.toolNeed.capabilities.includes("resources"), false);
  const memory = resolveTaskPolicy({ task: "Inspect memory://root/prior%20decision." });
  assert.equal(memory.needs.resources, true);
  assert.equal(memory.classification.signals.memoryResource, true);
  assert.equal(memory.needs.secondBrain, false);
  assert.equal(memory.toolNeed.capabilities.includes("memory"), false);
  const artifact = resolveTaskPolicy({ task: `Inspect artifact://${"a".repeat(64)} without changing files.` });
  assert.equal(artifact.needs.resources, true);
  assert.ok(artifact.toolNeed.capabilities.includes("resources"));
});

test("atomic commit planning is deterministic, proposal-only policy intent", () => {
  const policy = resolveTaskPolicy({ task: "Plan atomic commits for these explicit changed files." });
  assert.equal(policy.classification.signals.commitPlan, true);
  assert.equal(policy.classification.signals.mutating, false);
  assert.ok(policy.toolNeed.capabilities.includes("commit-plan"));
  assert.equal(policy.toolNeed.capabilities.includes("edit"), false);
  assert.equal(policy.needs.verification, false);
  assert.equal(policy.decisionModelCalls, 0);
});

test("SmartRead is selected for source inspection but omitted for a direct small edit", () => {
  const inspection = resolveTaskPolicy({ task: "Inspect src/router.ts and explain the implementation." });
  assert.equal(inspection.needs.smartRead, true);
  assert.ok(inspection.toolNeed.capabilities.includes("smart-read"));
  const direct = resolveTaskPolicy({ task: "Change one string value." });
  assert.equal(direct.needs.smartRead, false);
  assert.equal(direct.toolNeed.capabilities.includes("smart-read"), false);
});

test("default Task Policy preserves Token Governor routing exactly", () => {
  const input = { task: "Refactor the concurrent recovery state machine and integration tests.", preset: "token-saver", quality: "high", includeSecurity: true };
  const policy = resolveTaskPolicy(input);
  assert.deepEqual(policy.tokenGovernor, resolveTokenGovernor(input));
  assert.deepEqual(policy.routingStrategy, resolveTokenGovernor(input));
});

test("explicit user choices are honored unless they weaken a mandatory high-risk control", () => {
  const bounded = resolveTaskPolicy({ task: "Update parser behavior in src/parser.ts.", quality: "high", userChoices: { planner: false, secondBrain: false, browser: true } });
  assert.equal(bounded.needs.planner, false);
  assert.equal(bounded.needs.secondBrain, false);
  assert.equal(bounded.needs.browser, true);
  assert.deepEqual(bounded.explicitChoices.blocked, []);
  const critical = resolveTaskPolicy({ task: "Production migration with data loss risk.", quality: "low", userChoices: { planner: false, reviewer: false, council: false } });
  assert.equal(critical.needs.planner, true);
  assert.equal(critical.needs.reviewer, true);
  assert.equal(critical.needs.council, true);
  assert.deepEqual(critical.explicitChoices.blocked, ["planner:mandatory-high-risk-control", "reviewer:mandatory-high-risk-control", "council:mandatory-high-risk-control"]);
});

test("security risk elevates quality and cannot disable its reviewer", () => {
  const policy = resolveTaskPolicy({ task: "Fix credential permission validation in src/auth.ts.", preset: "token-saver", quality: "low", includeSecurity: false, userChoices: { reviewer: false } });
  assert.equal(policy.qualityRequested, "low");
  assert.equal(policy.effectiveQuality, "high");
  assert.equal(policy.routingStrategy.roles.security, true);
  assert.equal(policy.needs.reviewer, true);
  assert.ok(policy.explicitChoices.blocked.includes("reviewer:mandatory-high-risk-control"));
});

test("available context is bounded and pressure is deterministic", () => {
  assert.deepEqual(availableContextFromPiUsage({ contextWindow: 25_000, tokens: 22_750 }), { maxChars: 100_000, usedChars: 91_000 });
  assert.equal(availableContextFromPiUsage({ contextWindow: 25_000, tokens: null }), undefined);
  const policy = resolveTaskPolicy({ task: "Inspect src/a.ts.", availableContext: { maxChars: 100_000, usedChars: 91_000 } });
  assert.deepEqual(policy.availableContext, { status: "known", maxChars: 100_000, usedChars: 91_000, remainingChars: 9_000, pressure: "critical" });
  assert.equal(policy.contextBudget.reserveChars, 9_000);
  assert.throws(() => resolveTaskPolicy({ task: "Inspect.", availableContext: { maxChars: 1000, usedChars: 1001 } }), /task_policy_context_invalid/u);
});

test("policy, metadata, and rendering contain no task text", () => {
  const task = "Fix SECRET_SENTINEL_6bb10c credential handling in src/auth.ts.";
  const policy = resolveTaskPolicy({ task });
  const serialized = JSON.stringify(policy);
  assert.equal(serialized.includes(task), false);
  assert.equal(serialized.includes("SECRET_SENTINEL_6bb10c"), false);
  assert.equal(JSON.stringify(taskPolicyMetadata(policy)).includes("SECRET_SENTINEL_6bb10c"), false);
  assert.equal(renderTaskPolicy(policy).includes("SECRET_SENTINEL_6bb10c"), false);
});

test("policy digest is deterministic and tampering fails closed", () => {
  const input = { task: "Implement and test a bounded change in src/a.ts.", preset: "normal", quality: "medium" };
  const first = resolveTaskPolicy(input);
  const second = resolveTaskPolicy(input);
  assert.equal(first.digest, second.digest);
  assert.doesNotThrow(() => validateTaskPolicy(first));
  const tampered = structuredClone(first);
  tampered.needs.council = !tampered.needs.council;
  assert.throws(() => validateTaskPolicy(tampered), /task_policy_digest_invalid/u);
});

test("unsupported override keys and values fail closed", () => {
  assert.throws(() => resolveTaskPolicy({ task: "Change label.", userChoices: { shell: true } }), /task_policy_choice_unknown/u);
  assert.throws(() => resolveTaskPolicy({ task: "Change label.", userChoices: { planner: "yes" } }), /task_policy_choice_invalid/u);
});

test("token-saver reduces Task Policy memory and context budgets", () => {
  const task = "Research the project architecture and previous implementation decisions.";
  const normal = resolveTaskPolicy({ task, preset: "normal", quality: "high" });
  const saver = resolveTaskPolicy({ task, preset: "token-saver", quality: "high" });
  assert.ok(saver.memory.packCharLimit < normal.memory.packCharLimit);
  assert.ok(saver.contextBudget.handoffChars < normal.contextBudget.handoffChars);
  assert.ok(saver.contextBudget.smartReadTargetChars < normal.contextBudget.smartReadTargetChars);
});

test("workflow persists Task Policy and rejects a mismatched resume", async () => {
  const task = "Rename label.";
  const policy = resolveTaskPolicy({ task, preset: "normal", quality: "auto" });
  const state = await runEnforcedWorkflow({
    task,
    allocation,
    modelPolicy,
    routingStrategy: policy.routingStrategy,
    taskPolicy: policy,
    delegate: async ({ agent }) => ({ status: "completed", agent, result: { kind: "text", text: "done" } }),
    verify: async () => ({ status: "PASS", processExitCode: 0 }),
  });
  assert.equal(state.taskPolicy.digest, policy.digest);
  const different = resolveTaskPolicy({ task, preset: "normal", quality: "auto", userChoices: { browser: true } });
  await assert.rejects(() => runEnforcedWorkflow({
    task,
    allocation,
    modelPolicy,
    routingStrategy: policy.routingStrategy,
    taskPolicy: different,
    resumeState: state,
    delegate: async () => { throw new Error("must not run"); },
    verify: async () => ({ status: "PASS" }),
  }), /resumed workflow task policy mismatch/u);
});
