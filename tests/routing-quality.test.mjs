import test from "node:test";
import assert from "node:assert/strict";
import { createSessionQualityState, parseQuality, QUALITY_LEVELS } from "../lib/routing-session.mjs";
import { classifyTaskDifficulty, resolveTokenGovernor, validateTokenGovernor } from "../lib/token-governor.mjs";
import { runEnforcedWorkflow } from "../lib/workflow-state.mjs";

const allocation = { worktree: "/tmp/worktree", port: 32123, stateDir: "/tmp/state", browserProfile: "/tmp/profile", browserSession: "pi-routing-test", database: "pi_test", schema: "pi_schema" };
const modelPolicy = { digest: "routing-policy-fixture", roles: { worker: { model: "fixture/model", thinking: "low" } } };

function response(agent, structured = false) {
  if (agent.startsWith("council-") && agent !== "council-judge") return { status: "completed", agent, result: { kind: "structured", value: { conclusion: "ok", recommendation: "proceed", confidence: "HIGH", evidence: ["fixture"], risks: [], blockingConcerns: [] } } };
  if (agent === "council-judge") return { status: "completed", agent, result: { kind: "structured", value: { decision: "proceed", decisionBasis: "valid evidence", confidence: "HIGH", agreements: ["fixture"], disagreements: [], requiredActions: [] } } };
  if (structured) return { status: "completed", agent, result: { kind: "structured", value: { verdict: "PASS", summary: "ok", findings: [] } } };
  return { status: "completed", agent, result: { kind: "text", text: `${agent} compact evidence` } };
}

test("quality parsing accepts exactly the five supported values", () => {
  assert.deepEqual(QUALITY_LEVELS, ["auto", "low", "medium", "high", "max"]);
  for (const level of QUALITY_LEVELS) assert.equal(parseQuality(level.toUpperCase()), level);
  assert.throws(() => parseQuality("ultra"), /unknown_quality_level/u);
});

test("quality state is session-scoped and each new state defaults to auto", () => {
  const first = createSessionQualityState();
  const second = createSessionQualityState();
  assert.equal(first.get(), "auto");
  first.set("max");
  assert.equal(first.get(), "max");
  assert.equal(second.get(), "auto");
  assert.equal(first.reset(), "auto");
});

test("auto maps bounded deterministic difficulty to effective quality", () => {
  assert.equal(resolveTokenGovernor({ task: "Rename label.", preset: "normal", quality: "auto" }).effectiveQuality, "low");
  assert.equal(resolveTokenGovernor({ task: "Implement and test a parser change in src/parser.ts.", preset: "normal", quality: "auto" }).effectiveQuality, "medium");
  assert.equal(resolveTokenGovernor({ task: "Refactor the concurrent recovery state machine and its integration tests.", preset: "normal", quality: "auto" }).effectiveQuality, "high");
  assert.equal(resolveTokenGovernor({ task: "Production migration with data loss risk.", preset: "normal", quality: "auto" }).effectiveQuality, "max");
});

test("explicit quality outranks preset while security raises a low request", () => {
  const efficientMax = resolveTokenGovernor({ task: "Refactor concurrent state machine.", preset: "token-saver", quality: "max" });
  assert.equal(efficientMax.preset, "token-saver");
  assert.equal(efficientMax.effectiveQuality, "max");
  assert.equal(efficientMax.council.authorized, true);
  const secured = resolveTokenGovernor({ task: "Fix credential permission validation.", preset: "token-saver", quality: "low" });
  assert.equal(secured.qualityRequested, "low");
  assert.equal(secured.effectiveQuality, "high");
  assert.equal(secured.roles.security, true);
});

test("simple Normal Work is Worker then deterministic verification and stop", async () => {
  const strategy = resolveTokenGovernor({ task: "Rename label.", preset: "normal", quality: "auto" });
  const calls = [];
  const state = await runEnforcedWorkflow({
    task: "Rename label.", allocation, modelPolicy, routingStrategy: strategy,
    delegate: async ({ agent, result }) => { calls.push(agent); return response(agent, result.kind === "structured"); },
    verify: async () => ({ status: "PASS", processExitCode: 0 }),
  });
  assert.equal(state.status, "PASS");
  assert.deepEqual(calls, ["worker"]);
  assert.equal(state.evidence.verifications.length, 1);
  assert.equal(state.testerStatus, "NOT_RUN");
});

test("hard Normal Work runs compact planning and appropriate review without Council", async () => {
  const task = "Refactor the concurrent recovery state machine and integration tests.";
  const strategy = resolveTokenGovernor({ task, preset: "normal", quality: "auto" });
  const calls = [];
  const state = await runEnforcedWorkflow({
    task, allocation, modelPolicy, routingStrategy: strategy,
    delegate: async ({ agent, result }) => { calls.push(agent); return response(agent, result.kind === "structured"); },
    verify: async () => ({ status: "PASS", processExitCode: 0 }),
  });
  assert.equal(state.status, "PASS");
  for (const role of ["scout", "planner", "worker", "tester", "correctness-reviewer"]) assert.ok(calls.includes(role), role);
  assert.equal(calls.some((role) => role.startsWith("council-")), false);
  assert.equal(calls.includes("security-reviewer"), false);
});

test("Token Saver successful path performs the minimum one model call", async () => {
  const strategy = resolveTokenGovernor({ task: "Rename label.", preset: "token-saver", quality: "auto" });
  const calls = [];
  const state = await runEnforcedWorkflow({
    task: "Rename label.", allocation, modelPolicy, routingStrategy: strategy,
    delegate: async ({ agent, result }) => { calls.push(agent); return response(agent, result.kind === "structured"); },
    verify: async () => ({ status: "PASS", processExitCode: 0 }),
  });
  assert.equal(state.status, "PASS");
  assert.deepEqual(calls, ["worker"]);
  assert.equal(strategy.council.initial, false);
});

test("Token Saver escalates once after deterministic failure instead of repeating a cheap loop", async () => {
  const strategy = resolveTokenGovernor({ task: "Rename label.", preset: "token-saver", quality: "auto" });
  const calls = [];
  let verification = 0;
  const state = await runEnforcedWorkflow({
    task: "Rename label.", allocation, modelPolicy, routingStrategy: strategy,
    delegate: async ({ agent, result }) => { calls.push(agent); return response(agent, result.kind === "structured"); },
    verify: async () => ({ status: verification++ === 0 ? "FAIL" : "PASS", processExitCode: verification === 1 ? 1 : 0 }),
  });
  assert.equal(state.status, "PASS");
  assert.equal(calls.filter((role) => role === "worker").length, 2);
  assert.equal(calls.filter((role) => role === "tester").length, 2);
  assert.equal(calls.filter((role) => role === "correctness-reviewer").length, 2);
  assert.equal(state.correctionPerformed, true);
});

test("Council is disabled for cheap/default work and enabled only for justified critical/high risk", () => {
  const cheap = resolveTokenGovernor({ task: "Rename label.", preset: "token-saver", quality: "auto" });
  assert.deepEqual(cheap.council, { initial: false, disagreement: false, repeatedFailure: true, authorized: false });
  const critical = resolveTokenGovernor({ task: "Production migration with data loss risk.", preset: "normal", quality: "high" });
  assert.equal(critical.council.initial, true);
  assert.equal(critical.roles.oracle, true);
  const explicit = resolveTokenGovernor({ task: "Compare two designs.", preset: "token-saver", quality: "medium", includeOracle: true });
  assert.equal(explicit.council.initial, true);
});

test("max quality does not mean unconditional fan-out", () => {
  const simpleMax = resolveTokenGovernor({ task: "Rename label.", preset: "normal", quality: "max" });
  assert.equal(simpleMax.roles.worker, true);
  assert.equal(simpleMax.roles.scout, false);
  assert.equal(simpleMax.roles.planner, false);
  assert.equal(simpleMax.roles.tester, false);
  assert.equal(simpleMax.council.initial, false);
});

test("governor enforces bounded calls/retries/corrections and compact context", () => {
  for (const preset of ["normal", "token-saver"]) for (const quality of QUALITY_LEVELS) {
    const strategy = resolveTokenGovernor({ task: "Implement and test a bounded change.", preset, quality });
    assert.doesNotThrow(() => validateTokenGovernor(strategy));
    assert.ok(strategy.maxModelCalls >= 1 && strategy.maxModelCalls <= 42);
    assert.equal(strategy.maxRetriesPerDelegation, 1);
    assert.equal(strategy.maxCorrectionRounds, 2);
    assert.ok(strategy.context.handoffChars <= 12000);
  }
  assert.ok(resolveTokenGovernor({ task: "Implement a change.", preset: "token-saver", quality: "auto" }).context.handoffChars < resolveTokenGovernor({ task: "Implement a change.", preset: "normal", quality: "auto" }).context.handoffChars);
});

test("difficulty evidence is metadata-only and does not retain task text", () => {
  const task = "Fix secret credential handling in src/auth.ts.";
  const classified = classifyTaskDifficulty(task);
  assert.equal(classified.securitySensitive, true);
  assert.deepEqual(Object.keys(classified.evidence).sort(), ["characters", "fileReferences", "lines"]);
  assert.equal(JSON.stringify(classified).includes(task), false);
});
