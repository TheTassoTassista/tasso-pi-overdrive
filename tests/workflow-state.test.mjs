import test from "node:test";
import assert from "node:assert/strict";
import { MAX_SUBAGENT_DEPTH, MAX_WORKFLOW_CONCURRENCY, runEnforcedWorkflow } from "../lib/workflow-state.mjs";

const allocation = { worktree: "/tmp/worktree", port: 32123, stateDir: "/tmp/state", browserProfile: "/tmp/profile", browserSession: "pi-test", database: "pi_test", schema: "pi_schema" };

function textResponse(agent) {
  return { status: "completed", agent, model: `model-for-${agent}`, result: { kind: "text", text: `${agent} evidence` } };
}

test("blocking review mechanically forces Worker correction and complete re-verification", async () => {
  const calls = [];
  let correctnessRound = 0;
  const delegate = async ({ agent, result }) => {
    calls.push(agent);
    if (result.kind !== "structured") return textResponse(agent);
    if (agent === "correctness-reviewer") correctnessRound += 1;
    const block = agent === "correctness-reviewer" && correctnessRound === 1;
    return { status: "completed", agent, model: `model-for-${agent}`, result: { kind: "structured", value: { verdict: block ? "BLOCKING" : "PASS", summary: "review", findings: block ? [{ severity: "BLOCKING", title: "defect", evidence: "fixture" }] : [] } } };
  };
  let verificationRound = 0;
  const state = await runEnforcedWorkflow({ task: "fix fixture", allocation, delegate, verify: async () => ({ status: "PASS", round: verificationRound++ }), includeOracle: true });
  assert.equal(state.status, "PASS");
  assert.equal(calls.filter((role) => role === "worker").length, 2);
  assert.equal(calls.filter((role) => role === "tester").length, 2);
  assert.equal(calls.filter((role) => role === "correctness-reviewer").length, 2);
  assert.equal(state.evidence.verifications.length, 2);
  assert.equal(state.evidence.transitions.some((entry) => entry.state === "CORRECTION_REQUIRED"), true);
});

test("failed verification can never become PASS and stops after bounded correction", async () => {
  const delegate = async ({ agent, result }) => result.kind === "structured"
    ? { status: "completed", result: { kind: "structured", value: { verdict: "PASS", summary: "clean", findings: [] } } }
    : textResponse(agent);
  const state = await runEnforcedWorkflow({ task: "unfixable", allocation, delegate, verify: async () => ({ status: "FAIL", exitCode: 1 }) });
  assert.equal(state.status, "FAIL");
  assert.equal(state.evidence.verifications.length, 3);
  assert.equal(state.evidence.roles.filter((entry) => entry.agent === "worker").length, 3);
  assert.equal(state.evidence.transitions.at(-1).status, "FAIL");
});

test("reviewer fanout is exactly hard-capped at three and depth is one", async () => {
  let active = 0;
  let maximum = 0;
  const delegate = async ({ agent, result }) => {
    if (result.kind !== "structured") return textResponse(agent);
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active -= 1;
    return { status: "completed", result: { kind: "structured", value: { verdict: "PASS", summary: "clean", findings: [] } } };
  };
  const state = await runEnforcedWorkflow({ task: "bounded", allocation, delegate, verify: async () => ({ status: "PASS" }) });
  assert.equal(state.status, "PASS");
  assert.equal(maximum, MAX_WORKFLOW_CONCURRENCY);
  assert.equal(MAX_WORKFLOW_CONCURRENCY, 3);
  assert.equal(MAX_SUBAGENT_DEPTH, 1);
});

test("callers cannot raise correction or concurrency semantics", async () => {
  await assert.rejects(() => runEnforcedWorkflow({ task: "override", allocation, delegate: async () => {}, verify: async () => {}, maxCorrections: 99 }), /override rejected/u);
});

test("a failed role exposes and checkpoints partial structured evidence", async () => {
  let checkpoint;
  let thrown;
  try {
    await runEnforcedWorkflow({
      task: "capture failure",
      allocation,
      delegate: async ({ agent }) => agent === "planner" ? { status: "failed" } : textResponse(agent),
      verify: async () => ({ status: "PASS" }),
      onCheckpoint: (value) => { checkpoint = value; },
    });
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown.workflowState.status, "FAIL");
  assert.equal(checkpoint.status, "FAIL");
  assert.equal(checkpoint.evidence.roles.some((entry) => entry.agent === "scout" && entry.status === "completed"), true);
  assert.equal(checkpoint.evidence.roles.some((entry) => entry.agent === "planner" && entry.status === "failed"), true);
  assert.equal(checkpoint.evidence.transitions.at(-1).state, "FINAL");
});
