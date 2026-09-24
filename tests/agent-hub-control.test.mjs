import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { AgentAttemptController, requestExactUserCancellation } from "../lib/agent-hub-control.mjs";

const runId = randomUUID();
const taskDigest = "a".repeat(64);
const sessionId = "controller-session";

function fixture(role = "worker") {
  const controller = new AgentAttemptController({ sessionId, runId, taskDigest });
  const executionId = randomUUID();
  let cancels = 0;
  controller.reserve({ executionId, role, sequence: 0, attempt: 1, cancel: () => { cancels += 1; } });
  const input = () => ({ requestId: randomUUID(), sessionId, ...controller.identity(executionId) });
  return { controller, executionId, input, cancels: () => cancels };
}

test("exact active Worker cancellation is one-shot and does not create an attempt", () => {
  const item = fixture();
  assert.equal(item.controller.cancel(item.input()).code, "STALE_STATE");
  assert.equal(item.controller.started(item.executionId), true);
  const request = item.input();
  const accepted = item.controller.cancel(request);
  assert.equal(accepted.code, "CANCEL_REQUESTED");
  assert.equal(accepted.stateBefore, "RUNNING");
  assert.equal(accepted.stateAfter, "CANCEL_REQUESTED");
  assert.equal(item.cancels(), 1);
  assert.equal(item.controller.cancel(request).code, "REPLAY_DENIED");
  assert.equal(item.controller.cancel(item.input()).code, "STALE_STATE");
  assert.equal(item.cancels(), 1);
  assert.equal(item.controller.terminal(item.executionId, "cancelled"), true);
  assert.equal(item.controller.cancel(item.input()).code, "STALE_STATE");
});

test("unknown, malformed, wrong-session, stale identity and terminal targets fail closed", () => {
  const item = fixture("tester");
  item.controller.started(item.executionId);
  assert.equal(item.controller.cancel({ ...item.input(), executionId: "bad" }).code, "MALFORMED_REQUEST");
  assert.equal(item.controller.cancel({ ...item.input(), executionId: randomUUID() }).code, "UNKNOWN_ATTEMPT");
  assert.equal(item.controller.cancel({ ...item.input(), sessionId: "other-session" }).code, "WRONG_SESSION");
  assert.equal(item.controller.cancel({ ...item.input(), runId: randomUUID() }).code, "IDENTITY_MISMATCH");
  assert.equal(item.controller.cancel({ ...item.input(), role: "worker" }).code, "IDENTITY_MISMATCH");
  assert.equal(item.controller.cancel({ ...item.input(), sequence: 1 }).code, "IDENTITY_MISMATCH");
  assert.equal(item.controller.cancel({ ...item.input(), expectedVersion: 0 }).code, "STALE_STATE");
  assert.equal(item.cancels(), 0);
  item.controller.terminal(item.executionId, "completed");
  assert.equal(item.controller.cancel(item.input()).code, "STALE_STATE");
  assert.equal(item.cancels(), 0);
});

test("completion before cancel and synchronous completion during cancel are deterministic", () => {
  const completed = fixture();
  completed.controller.started(completed.executionId);
  completed.controller.terminal(completed.executionId, "completed");
  assert.equal(completed.controller.cancel(completed.input()).code, "STALE_STATE");
  const controller = new AgentAttemptController({ sessionId, runId, taskDigest });
  const executionId = randomUUID();
  controller.reserve({ executionId, role: "worker", sequence: 0, attempt: 1, cancel: () => controller.terminal(executionId, "cancelled") });
  controller.started(executionId);
  const accepted = controller.cancel({ requestId: randomUUID(), sessionId, ...controller.identity(executionId) });
  assert.equal(accepted.code, "CANCEL_REQUESTED");
  assert.equal(controller.cancel({ requestId: randomUUID(), sessionId, ...controller.identity(executionId) }).code, "STALE_STATE");
});

test("Council and Judge remain read-only, and user command cannot steer or spawn", () => {
  for (const role of ["council-1", "council-2", "council-3", "council-judge", "correctness-reviewer", "scout"]) {
    const item = fixture(role);
    item.controller.started(item.executionId);
    assert.equal(item.controller.cancel(item.input()).code, "POLICY_DENIED");
    assert.equal(item.cancels(), 0);
  }
  const workflow = fs.readFileSync(new URL("../extensions/secure-workflow.ts", import.meta.url), "utf8");
  assert.match(workflow, /registerCommand\("agent-cancel"/u);
  assert.doesNotMatch(workflow, /registerCommand\("agent-(?:steer|spawn|revive|pause|resume|message)"/u);
  assert.match(workflow, /createWorkflowSpawnBudgetGuard/u);
});

test("closed session and duplicate reservations are rejected without touching owned work", () => {
  const item = fixture();
  item.controller.started(item.executionId);
  assert.throws(() => item.controller.reserve({ executionId: item.executionId, role: "worker", sequence: 1, attempt: 1, cancel: () => {} }), /AGENT_CONTROL_DUPLICATE_OR_CAPACITY/u);
  item.controller.close();
  assert.equal(item.controller.cancel(item.input()).code, "SESSION_CLOSED");
  assert.equal(item.cancels(), 0);
});

test("uncertain dispatch is never reported as a completed cancellation", () => {
  const controller = new AgentAttemptController({ sessionId, runId, taskDigest });
  const executionId = randomUUID();
  controller.reserve({ executionId, role: "worker", sequence: 0, attempt: 1, cancel: () => { throw new Error("bridge failed after dispatch"); } });
  controller.started(executionId);
  const decision = requestExactUserCancellation(controller, { requestId: randomUUID(), sessionId, executionId });
  assert.equal(decision.code, "DISPATCH_UNCERTAIN");
  assert.equal(controller.state(executionId), "CANCEL_REQUESTED");
  assert.equal(requestExactUserCancellation(controller, { requestId: randomUUID(), sessionId, executionId }).code, "STALE_STATE");
  const workflow = fs.readFileSync(new URL("../extensions/secure-workflow.ts", import.meta.url), "utf8");
  assert.match(workflow, /if \(agentControlUncertain\) workflowError/u);
  assert.match(workflow, /response\.status !== "cancelled"/u);
});
