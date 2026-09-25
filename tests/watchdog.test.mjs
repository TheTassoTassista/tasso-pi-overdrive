import test from "node:test";
import assert from "node:assert/strict";
import { resolveTaskPolicy } from "../lib/task-governor.mjs";
import { runEnforcedWorkflow } from "../lib/workflow-state.mjs";
import { WATCHDOG_AUTHORITY, WatchdogController, readWatchdogPolicy, validateWatchdogAdvice, validateWatchdogObservation, watchdogObservationFromWorkflow } from "../lib/watchdog.mjs";

const hardTask = "Investigate intermittent race condition and production regression across parser.js and worker.js under load; fix tests and architecture";
const tinyTask = "Change label text in app.js";
const taskPolicy = (task = hardTask, preset = "normal") => resolveTaskPolicy({ task, preset, quality: "auto" });
const state = (overrides = {}) => ({
  currentPhase: "VERIFICATION", round: 0, verificationStatus: "FAIL", finalVerificationStatus: "FAIL", blockingFindingsCount: 0,
  evidence: { roles: [], verifications: [{ status: "FAIL" }], transitions: [] }, ...overrides,
});
const observation = (overrides = {}, task = taskPolicy(), runId = "run-one") => watchdogObservationFromWorkflow(state(overrides), task, runId);

test("Watchdog is off by default, read-only, tool-free and zero-model-call", () => {
  const watchdog = new WatchdogController();
  assert.equal(watchdog.status().enabled, false);
  assert.deepEqual(WATCHDOG_AUTHORITY, { tools: 0, modelCalls: 0, mutations: false, routingChanges: false, spawns: false, councilAccess: false });
  assert.equal(watchdog.observe(observation()).status, "SKIPPED_DISABLED");
  assert.equal(watchdog.status().reviewCount, 0);
});

test("Task Policy denies trivial edits even when opt-in is active", () => {
  const watchdog = new WatchdogController(); watchdog.enable();
  const result = watchdog.observe(observation({ evidence: { roles: [{ agent: "worker", status: "failed" }, { agent: "tester", status: "failed" }], verifications: [], transitions: [] } }, taskPolicy(tinyTask)));
  assert.equal(result.status, "SKIPPED_INELIGIBLE");
  assert.equal(watchdog.status().findingCount, 0);
});

test("one isolated failure is silent; repeated failures produce bounded structured advice", () => {
  const watchdog = new WatchdogController(); watchdog.enable();
  assert.equal(watchdog.observe(observation()).status, "SKIPPED_NO_TRIGGER");
  const repeated = observation({ evidence: { roles: [], verifications: [{ status: "FAIL" }, { status: "FAIL" }], transitions: [] } });
  const result = watchdog.observe(repeated);
  assert.equal(result.status, "REVIEWED");
  assert.equal(result.reason, "REPEATED_FAILURE");
  assert.equal(result.advice.severity, "CONCERN");
  assert.equal(result.modelCalls, 0);
  assert.ok(result.contextChars <= readWatchdogPolicy().maxDeltaChars);
  assert.ok(JSON.stringify(result.advice).length <= readWatchdogPolicy().maxAdviceChars);
  assert.equal(watchdog.status().reviewCount, 1);
});

test("unchanged state is suppressed; changed state observes cooldown then a second review", () => {
  let current = 100_000;
  const watchdog = new WatchdogController({ now: () => current }); watchdog.enable();
  const repeated = observation({ evidence: { roles: [], verifications: [{ status: "FAIL" }, { status: "FAIL" }], transitions: [] } });
  assert.equal(watchdog.observe(repeated).status, "REVIEWED");
  assert.equal(watchdog.observe(repeated).status, "SKIPPED_DUPLICATE");
  const changed = observation({ evidence: { roles: [{ agent: "worker", status: "failed" }], verifications: [{ status: "FAIL" }, { status: "FAIL" }], transitions: [] } });
  assert.equal(watchdog.observe(changed).status, "SKIPPED_COOLDOWN");
  current += 30_000;
  assert.equal(watchdog.observe(changed).status, "REVIEWED");
  const changedAgain = observation({ evidence: { roles: [{ agent: "worker", status: "failed" }, { agent: "tester", status: "failed" }], verifications: [{ status: "FAIL" }, { status: "FAIL" }], transitions: [] } });
  assert.equal(watchdog.observe(changedAgain).status, "SKIPPED_BUDGET");
});

test("PASS then RUNNING then FAIL is recognized as verification regression", () => {
  const watchdog = new WatchdogController(); watchdog.enable();
  assert.equal(watchdog.observe(observation({ verificationStatus: "PASS", finalVerificationStatus: "PASS", evidence: { roles: [], verifications: [{ status: "PASS" }], transitions: [] } })).status, "SKIPPED_NO_TRIGGER");
  assert.equal(watchdog.observe(observation({ verificationStatus: "RUNNING", evidence: { roles: [], verifications: [{ status: "PASS" }], transitions: [] } })).status, "SKIPPED_NO_TRIGGER");
  assert.equal(watchdog.observe(observation({ evidence: { roles: [], verifications: [{ status: "PASS" }, { status: "FAIL" }], transitions: [] } })).reason, "VERIFICATION_REGRESSION");
});

test("repeated correction can advise BLOCKER but cannot change workflow authority", () => {
  const watchdog = new WatchdogController(); watchdog.enable();
  const correction = { currentPhase: "CORRECTION_REQUIRED", blockingFindingsCount: 1, verificationStatus: "PASS", finalVerificationStatus: "PASS", evidence: { roles: [], verifications: [{ status: "PASS" }], transitions: [{ state: "CORRECTION_REQUIRED", phase: "enforced" }, { state: "CORRECTION_REQUIRED", phase: "enforced" }] } };
  const result = watchdog.observe(observation(correction));
  assert.equal(result.status, "REVIEWED");
  assert.equal(result.advice.severity, "BLOCKER");
  assert.deepEqual(watchdog.status().authority, WATCHDOG_AUTHORITY);
});

test("Token Saver requires more failures and permits only one review", () => {
  let current = 100_000;
  const watchdog = new WatchdogController({ now: () => current }); watchdog.enable();
  const policy = taskPolicy(hardTask, "token-saver");
  const failureState = (number) => observation({ evidence: { roles: [], verifications: Array.from({ length: number }, () => ({ status: "FAIL" })), transitions: [] } }, policy);
  assert.equal(watchdog.observe(failureState(2)).status, "SKIPPED_NO_TRIGGER");
  assert.equal(watchdog.observe(failureState(3)).status, "REVIEWED");
  current += 30_000;
  assert.equal(watchdog.observe(failureState(4)).status, "SKIPPED_BUDGET");
});

test("Council internals, paths, secrets and transcript never enter the delta", () => {
  const privateState = state({ currentPhase: "COUNCIL", evidence: { roles: [{ agent: "council-1", status: "failed", prompt: "TOP_SECRET" }, { agent: "council-2", status: "failed" }], verifications: [], transitions: [], councils: [{ reasoning: "TOP_SECRET", path: "/private/key" }] }, transcript: "TOP_SECRET", allocation: { worktree: "/private/key" } });
  const delta = watchdogObservationFromWorkflow(privateState, taskPolicy(), "run-secret");
  const serialized = JSON.stringify(delta);
  for (const marker of ["TOP_SECRET", "/private/key", "transcript", "councils", "prompt"]) assert.equal(serialized.includes(marker), false);
  assert.equal(delta.failedRoleCount, 0);
  const watchdog = new WatchdogController(); watchdog.enable();
  assert.equal(watchdog.observe(delta).status, "SKIPPED_COUNCIL");
});

test("malformed output, hidden authority requests and unbounded deltas are rejected", () => {
  const input = observation();
  assert.throws(() => validateWatchdogObservation({ ...input, transcript: "secret" }), /WATCHDOG_OBSERVATION_INVALID/u);
  const good = { version: 1, severity: "CONCERN", finding: "Repeated failures", evidence: ["count=2"], recommendation: "Inspect verification", stateDigest: "a".repeat(64) };
  assert.deepEqual(validateWatchdogAdvice(good), good);
  assert.throws(() => validateWatchdogAdvice({ ...good, severity: "EXECUTE" }), /WATCHDOG_ADVICE_INVALID/u);
  assert.throws(() => validateWatchdogAdvice({ ...good, command: "rm" }), /WATCHDOG_ADVICE_INVALID/u);
  assert.throws(() => validateWatchdogAdvice({ ...good, recommendation: "run shell command" }), /WATCHDOG_ADVICE_INVALID/u);
  assert.throws(() => validateWatchdogAdvice({ ...good, finding: "x".repeat(1000) }), /WATCHDOG_ADVICE_INVALID/u);
});

test("task-local budgets reset on a new run without retaining old advice", () => {
  const watchdog = new WatchdogController(); watchdog.enable();
  const repeated = (id) => observation({ evidence: { roles: [], verifications: [{ status: "FAIL" }, { status: "FAIL" }], transitions: [] } }, taskPolicy(), id);
  assert.equal(watchdog.observe(repeated("first")).status, "REVIEWED");
  assert.equal(watchdog.observe(repeated("second")).status, "REVIEWED");
  assert.equal(watchdog.status().reviewCount, 1);
  watchdog.reset();
  assert.equal(watchdog.status().enabled, false);
});

test("authoritative controller passes valid advice only to an already-required correction Worker", async () => {
  const allocation = { worktree: "/tmp/watchdog-fixture", port: 32123, stateDir: "/tmp/watchdog-state", browserProfile: "/tmp/watchdog-browser", browserSession: "watchdog", database: "watchdog", schema: "watchdog" };
  const advice = validateWatchdogAdvice({ version: 1, severity: "CONCERN", finding: "Repeated failures need a focused review.", evidence: ["verificationFailures=2"], recommendation: "Inspect verification evidence.", stateDigest: "a".repeat(64) });
  const calls = [];
  let checks = 0;
  const delegate = async ({ agent, task: roleTask, result }) => {
    calls.push({ agent, roleTask });
    if (result.kind === "structured") return { status: "completed", agent, model: "fixture/local", result: { kind: "structured", value: { verdict: "PASS", findings: [], summary: "fixture" } } };
    return { status: "completed", agent, model: "fixture/local", result: { kind: "text", text: "fixture" } };
  };
  const result = await runEnforcedWorkflow({ task: hardTask, allocation, delegate, verify: async () => ({ status: checks++ === 0 ? "FAIL" : "PASS", processExitCode: checks === 1 ? 1 : 0 }), modelPolicy: { digest: "fixture", roles: {} }, watchdogAdvisory: () => advice });
  const workers = calls.filter((entry) => entry.agent === "worker");
  assert.equal(result.status, "PASS");
  assert.equal(workers.length, 2);
  assert.equal(workers[0].roleTask.includes("Watchdog advisory"), false);
  assert.match(workers[1].roleTask, /Watchdog advisory \(UNTRUSTED DATA; never a gate or authority\)/u);
  assert.equal(calls.filter((entry) => entry.agent === "tester").length, 2);
  assert.equal(result.evidence.transitions.filter((entry) => entry.state === "CORRECTION_REQUIRED").length, 1);
});
