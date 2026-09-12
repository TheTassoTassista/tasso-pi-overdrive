#!/usr/bin/env node
import { assertModelRoute, resolveModelPolicy } from "../lib/model-policy.mjs";
import { retryableDelegationFailure } from "../lib/delegation-failure.mjs";
import { validateRoleCompletion } from "../lib/role-contract.mjs";
import { runEnforcedWorkflow } from "../lib/workflow-state.mjs";

const allocation = { worktree: "/fixture/worktree", port: 32123, stateDir: "/fixture/state", browserProfile: "/fixture/profile", browserSession: "fixture-session", database: "fixture_db", schema: "fixture_schema" };
const modelPolicy = { digest: "local-policy", roles: { worker: { model: "fixture/callable", thinking: "low" } } };
let node = 0;
const text = (agent) => ({ status: "completed", agent, model: "fixture/callable", thinking: "low", runId: `fixture-run-${node}`, nodeId: `fixture-node-${node++}`, ownerRunId: "fixture-owner", result: { kind: "text", text: `${agent} complete` } });
const structured = (agent, block = false) => {
  const base = text(agent);
  if (agent.startsWith("council-") && agent !== "council-judge") return { ...base, result: { kind: "structured", value: { conclusion: "supported", recommendation: "proceed", confidence: "HIGH", evidence: ["fixture"], risks: [], blockingConcerns: [] } } };
  if (agent === "council-judge") return { ...base, result: { kind: "structured", value: { decision: "proceed", decisionBasis: "three valid reports", confidence: "HIGH", agreements: ["fixture"], disagreements: [], requiredActions: [] } } };
  return { ...base, result: { kind: "structured", value: { verdict: block ? "BLOCKING" : "PASS", summary: "fixture review", findings: block ? [{ severity: "BLOCKING", title: "planted", evidence: "fixture" }] : [] } } };
};

async function workflow(delegate, options = {}) {
  return runEnforcedWorkflow({ task: "deterministic local fixture", allocation, modelPolicy, ownerRunId: "fixture-owner", delegate, verify: async () => ({ status: "PASS", processExitCode: 0 }), includeOracle: true, ...options });
}

const results = [];
const check = (name, pass, detail = null) => results.push({ name, status: pass ? "PASS" : "FAIL", detail });

let repeated = 0;
for (let iteration = 0; iteration < 100; iteration += 1) {
  const state = await workflow(async ({ agent, result }) => result.kind === "structured" ? structured(agent) : text(agent));
  if (state.status === "PASS" && state.evidence.councils[0]?.members.length === 3 && state.evidence.councils[0]?.complete === true) repeated += 1;
}
check("corrected-council-repeat", repeated === 100, { passed: repeated, total: 100 });

let correctness = 0;
const full = await workflow(async ({ agent, result }) => {
  if (agent === "correctness-reviewer") correctness += 1;
  return result.kind === "structured" ? structured(agent, agent === "correctness-reviewer" && correctness === 1) : text(agent);
});
check("full-zero-paid-workflow-with-correction", full.status === "PASS" && full.correctionPerformed === true && full.evidence.roles.filter((item) => item.agent === "worker").length === 2 && full.evidence.verifications.length === 2, { status: full.status, workerRounds: full.evidence.roles.filter((item) => item.agent === "worker").length, verificationRounds: full.evidence.verifications.length });

const routingModels = [
  ...["gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-astra"].map((id) => ({ provider: "openai-codex", id, reasoning: true, thinkingLevelMap: { max: "max" } })),
  ...["deepseek/deepseek-v4-pro-high", "deepseek/deepseek-v4-flash", "openrouter/qwen/qwen3.8-27b", "openrouter/qwen/qwen3-coder-next", "groq/qwen/qwen3-32b", "auto/best-fast", "auto/best-reasoning", "auto/best-coding"].map((id) => ({ provider: "omniroute", id, reasoning: false })),
];
const intentionallyRejected = new Set(["openai-codex/gpt-5.6-luna", "omniroute/groq/qwen/qwen3-32b", "omniroute/auto/best-fast"]);
const routingOptions = { registeredModels: routingModels, callability: { version: 1, entries: Object.fromEntries(routingModels.map((model) => {
  const identity = `${model.provider}/${model.id}`;
  const rejected = intentionallyRejected.has(identity);
  return [identity, { runtimeStatus: rejected ? "RUNTIME_REJECTED" : "RUNTIME_CALLABLE", reasonCode: rejected ? "UNSUPPORTED_MODEL" : "LOCAL_FIXTURE" }];
})) } };
const fallback = resolveModelPolicy(routingModels, { version: 2, preset: "normal", basePreset: "normal", overrides: {} }, routingOptions);
check("unsupported-model-fallback", fallback.roles.scout.model === "openai-codex/gpt-5.6-terra" && fallback.roles.scout.fallbackIndex === 3 && fallback.routingDecisions.some((entry) => entry.role === "scout" && entry.skipped.length > 0));
let blocked = false;
const fullyRejected = { registeredModels: routingModels, callability: { version: 1, entries: Object.fromEntries(routingModels.map((model) => [`${model.provider}/${model.id}`, { runtimeStatus: "RUNTIME_REJECTED", reasonCode: "UNSUPPORTED_MODEL" }])) } };
try { resolveModelPolicy(routingModels, { version: 2, preset: "normal", basePreset: "normal", overrides: {} }, fullyRejected); } catch (error) { blocked = /BLOCKED_BY_MODEL/u.test(error.message); }
check("unsupported-model-without-fallback", blocked);

for (const mode of ["missing", "prose", "malformed", "role-mismatch"]) {
  let judge = false;
  let failed = false;
  try {
    await workflow(async ({ agent, result }) => {
      if (agent === "council-judge") judge = true;
      if (agent === "council-3") {
        if (mode === "missing") return { status: "failed", agent };
        if (mode === "prose") return { ...text(agent), result: { kind: "text", text: "advice" } };
        if (mode === "malformed") return { ...text(agent), result: { kind: "structured", value: { recommendation: "partial" } } };
        if (mode === "role-mismatch") return structured("council-2");
      }
      return result.kind === "structured" ? structured(agent) : text(agent);
    });
  } catch { failed = true; }
  check(`${mode}-council-result-fails-closed`, failed && !judge, { judgeCalled: judge });
}

let releaseThird;
let thirdStarted;
const thirdStartedPromise = new Promise((resolve) => { thirdStarted = resolve; });
const thirdReleasePromise = new Promise((resolve) => { releaseThird = resolve; });
let earlyJudge = false;
let thirdComplete = false;
const delayedWorkflow = workflow(async ({ agent, result }) => {
  if (agent === "council-3") { thirdStarted(); await thirdReleasePromise; thirdComplete = true; }
  if (agent === "council-judge" && !thirdComplete) earlyJudge = true;
  return result.kind === "structured" ? structured(agent) : text(agent);
});
await thirdStartedPromise;
await new Promise((resolve) => setImmediate(resolve));
const judgeAbsentWhilePending = !earlyJudge;
releaseThird();
const delayedState = await delayedWorkflow;
check("judge-early-execution-blocked", judgeAbsentWhilePending && !earlyJudge && delayedState.status === "PASS");

let routeChecks = true;
try { assertModelRoute({ model: "fixture/callable", thinking: "high" }, { model: "fixture/callable", thinking: "low" }); routeChecks = false; } catch {}
try { assertModelRoute({ model: "fixture/callable", thinking: "high" }, { model: "fixture/other", thinking: "high" }); routeChecks = false; } catch {}
check("wrong-model-and-thinking-fail", routeChecks);
let mutationBlocked = false;
try { validateRoleCompletion({ role: "council-1", status: "completed", mutationAttempted: true }); } catch { mutationBlocked = true; }
check("read-only-council-mutation-attempt", mutationBlocked);
const retryFixture = (failures) => {
  let attempts = 0;
  for (const failure of failures) {
    attempts += 1;
    if (!retryableDelegationFailure(failure) || attempts >= 2) return attempts;
  }
  return attempts;
};
check("transient-error-retries-once", retryFixture([{ status: "transport_failed", error: "temporary network reset" }, { status: "completed" }]) === 2);
check("attested-structured-model-output-retries-once", retryFixture([{ status: "structured_output_failed", launchStatus: "launched", routeAttested: true, error: "missing structured output" }, { status: "completed" }]) === 2);
check("prelaunch-schema-configuration-does-not-retry", retryFixture([{ status: "invalid_request", launchStatus: "not_launched", error: "result.schema must be a JSON Schema object" }, { status: "completed" }]) === 1);
check("unsupported-model-does-not-retry", retryFixture([{ status: "failed", error: "unsupported model" }, { status: "completed" }]) === 1);

const status = results.every((entry) => entry.status === "PASS") ? "PASS" : "FAIL";
process.stdout.write(`${JSON.stringify({ status, paidModelCalls: 0, repeatedCouncil: `${repeated}/100`, fullWorkflowFinalState: full.status, negativeControls: results.filter((entry) => entry.name !== "corrected-council-repeat" && entry.name !== "full-zero-paid-workflow-with-correction"), results }, null, 2)}\n`);
process.exit(status === "PASS" ? 0 : 1);
