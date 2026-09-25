#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTaskPolicy } from "../../lib/task-governor.mjs";
import { runEnforcedWorkflow } from "../../lib/workflow-state.mjs";
import { WatchdogController, watchdogObservationFromWorkflow } from "../../lib/watchdog.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const task = resolveTaskPolicy({ task: "Investigate intermittent race condition and production regression across parser.js and worker.js under load; fix tests and architecture", preset: "normal", quality: "auto" });
const hash = (value) => createHash("sha256").update(value).digest("hex");
const state = (phase, status, failures, failedRoles = 0) => ({
  currentPhase: phase, round: failures, verificationStatus: status, finalVerificationStatus: status,
  blockingFindingsCount: 0,
  evidence: { roles: Array.from({ length: failedRoles }, () => ({ agent: "worker", status: "failed" })), verifications: Array.from({ length: failures }, () => ({ status: "FAIL" })), transitions: [] },
});
const workflows = Object.freeze({
  successful: [state("WORKER", "NOT_RUN", 0), state("VERIFICATION", "PASS", 0), state("REVIEW", "PASS", 0), state("FINAL", "PASS", 0)],
  repeatedError: [state("VERIFICATION", "FAIL", 1), state("VERIFICATION", "FAIL", 2), state("VERIFICATION", "FAIL", 2), state("REVIEW", "FAIL", 2, 1)],
  regression: [state("VERIFICATION", "PASS", 0), state("WORKER", "RUNNING", 0), state("VERIFICATION", "FAIL", 1)],
});

const allocation = Object.freeze({ worktree: "/tmp/watchdog-benchmark-fixture", port: 32123, stateDir: "/tmp/watchdog-state", browserProfile: "/tmp/watchdog-browser", browserSession: "watchdog", database: "watchdog", schema: "watchdog" });
function structuredResponse(agent, block) {
  if (agent.startsWith("council-") && agent !== "council-judge") return { status: "completed", agent, model: "fixture/local", result: { kind: "structured", value: { conclusion: "fixture", recommendation: "fixture", confidence: "HIGH", evidence: ["fixture"], risks: [], blockingConcerns: [] } } };
  if (agent === "council-judge") return { status: "completed", agent, model: "fixture/local", result: { kind: "structured", value: { decision: "proceed", decisionBasis: "fixture evidence", confidence: "HIGH", agreements: ["fixture"], disagreements: [], requiredActions: [] } } };
  return { status: "completed", agent, model: "fixture/local", result: { kind: "structured", value: { verdict: block ? "BLOCKING" : "PASS", findings: block ? [{ severity: "BLOCKING", title: "fixture", evidence: "fixture" }] : [], summary: "fixture" } } };
}

async function runActualWorkflow(scenario, enabled) {
  let clock = 100_000;
  const watchdog = new WatchdogController({ now: () => clock });
  if (enabled) watchdog.enable();
  const reports = [];
  const calls = [];
  let pendingAdvice = null;
  let verificationCount = 0;
  const verificationPlan = scenario === "successful" ? ["PASS"] : scenario === "repeatedError" ? ["FAIL", "FAIL", "PASS"] : ["PASS", "FAIL", "PASS"];
  const workflow = await runEnforcedWorkflow({
    task: "Watchdog deterministic workflow fixture", allocation, modelPolicy: { digest: "watchdog-benchmark", roles: {} },
    delegate: async ({ agent, task: roleTask, result }) => {
      calls.push({ agent, adviceIncluded: agent === "worker" && roleTask.includes("Watchdog advisory") });
      if (result.kind === "structured") return structuredResponse(agent, scenario === "regression" && agent === "correctness-reviewer" && verificationCount === 1);
      return { status: "completed", agent, model: "fixture/local", result: { kind: "text", text: "fixture" } };
    },
    verify: async () => {
      const status = verificationPlan[verificationCount++] ?? "FAIL";
      return { status, processExitCode: status === "PASS" ? 0 : 1 };
    },
    onCheckpoint: (checkpoint) => {
      const delta = watchdogObservationFromWorkflow(checkpoint, task, `actual-${scenario}`);
      const result = watchdog.observe(delta);
      reports.push({ status: result.status, reason: result.reason ?? null, contextChars: result.contextChars ?? 0 });
      if (result.status === "REVIEWED") pendingAdvice = result.advice;
      clock += 31_000;
    },
    watchdogAdvisory: () => { const advice = pendingAdvice; pendingAdvice = null; return advice; },
  });
  return {
    status: workflow.status, verificationCount, mainTaskCalls: calls.length,
    workerCalls: calls.filter((entry) => entry.agent === "worker").length,
    correctionAdviceDeliveries: calls.filter((entry) => entry.adviceIncluded).length,
    watchdogInvocations: reports.filter((entry) => entry.status === "REVIEWED").length,
    duplicateSuppressions: reports.filter((entry) => entry.status === "SKIPPED_DUPLICATE").length,
    maxContextChars: Math.max(0, ...reports.map((entry) => entry.contextChars)),
    reasons: reports.filter((entry) => entry.status === "REVIEWED").map((entry) => entry.reason),
    localFixtureDelegations: calls.length, externalProviderCalls: 0, modelCalls: 0, toolCalls: 0,
  };
}

async function arm(name, enabled) {
  let now = 100_000;
  const watchdog = new WatchdogController({ now: () => now });
  if (enabled) watchdog.enable();
  const reports = [];
  for (const [scenario, transitions] of Object.entries(workflows)) {
    for (const [index, item] of transitions.entries()) {
      const observation = watchdogObservationFromWorkflow(item, task, `benchmark-${scenario}`);
      const started = performance.now();
      const result = watchdog.observe(observation);
      reports.push({ scenario, index, status: result.status, reason: result.reason ?? null, severity: result.advice?.severity ?? null, contextChars: result.contextChars ?? 0, modelCalls: result.modelCalls, durationMs: Number((performance.now() - started).toFixed(3)), stateDigest: result.stateDigest ?? null });
      now += index === 2 ? 30_000 : 100;
    }
  }
  const actualWorkflows = {};
  for (const scenario of Object.keys(workflows)) actualWorkflows[scenario] = await runActualWorkflow(scenario, enabled);
  return { name, reports, actualWorkflows, invocations: reports.filter((entry) => entry.status === "REVIEWED").length, duplicateSuppressions: reports.filter((entry) => entry.status === "SKIPPED_DUPLICATE").length, modelCalls: reports.reduce((sum, entry) => sum + entry.modelCalls, 0), toolCalls: 0, finalStatus: watchdog.status() };
}

const control = await arm("CONTROL", false);
const observed = await arm("WATCHDOG", true);
const assertions = {
  controlNoReview: control.invocations === 0,
  successfulSilent: observed.reports.filter((entry) => entry.scenario === "successful").every((entry) => entry.status !== "REVIEWED"),
  repeatedFailureCaught: observed.reports.some((entry) => entry.scenario === "repeatedError" && entry.status === "REVIEWED" && entry.reason === "REPEATED_FAILURE"),
  unchangedSuppressed: observed.duplicateSuppressions >= 1,
  regressionCaught: observed.reports.some((entry) => entry.scenario === "regression" && entry.status === "REVIEWED" && entry.reason === "VERIFICATION_REGRESSION"),
  boundedInput: observed.reports.every((entry) => entry.contextChars <= 768),
  noExtraAuthority: observed.modelCalls === 0 && observed.toolCalls === 0 && control.modelCalls === 0,
  workflowParity: Object.keys(workflows).every((name) => control.actualWorkflows[name].status === observed.actualWorkflows[name].status && control.actualWorkflows[name].mainTaskCalls === observed.actualWorkflows[name].mainTaskCalls),
  actualRepeatedFailure: observed.actualWorkflows.repeatedError.reasons.includes("REPEATED_FAILURE") && observed.actualWorkflows.repeatedError.correctionAdviceDeliveries >= 1,
  actualRegression: observed.actualWorkflows.regression.reasons.includes("VERIFICATION_REGRESSION") && observed.actualWorkflows.regression.correctionAdviceDeliveries >= 1,
  actualSuccessSilent: observed.actualWorkflows.successful.watchdogInvocations === 0,
  actualControlSilent: Object.values(control.actualWorkflows).every((entry) => entry.watchdogInvocations === 0),
  actualBoundedNoCost: Object.values(observed.actualWorkflows).every((entry) => entry.maxContextChars <= 768 && entry.externalProviderCalls === 0 && entry.modelCalls === 0 && entry.toolCalls === 0),
};
const report = { version: 1, status: Object.values(assertions).every(Boolean) ? "PASS" : "FAIL", measurementMode: "deterministic-local-watchdog-controller", fixtureDigest: hash(JSON.stringify(workflows)), control, watchdog: observed, assertions, accounting: { externalProviderCalls: 0, paidModelCalls: 0, costEur: 0 }, limitations: { fullSecureWorkflowE2E: "NOT_RUN" }, ompReference: { executableStatus: "NOT_RUN" } };
if (process.argv.includes("--write-results")) fs.writeFileSync(path.join(root, "watchdog-results.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.status === "PASS" ? 0 : 1;
