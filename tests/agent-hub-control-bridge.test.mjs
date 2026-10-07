import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { AgentAttemptController, requestExactUserCancellation } from "../lib/agent-hub-control.mjs";
import { AgentHubProjection, roleReceiptMetadata, roleReservationMetadata, roleStartedMetadata, workflowJournalMetadata } from "../lib/agent-hub.mjs";
import { makeRoleReceipt, openRoleReceiptStore, writeRoleReceipt } from "../lib/workflow-receipts.mjs";
import { ensureProtectedDirectory } from "../lib/protected-artifact.mjs";

const upstreamRoot = path.join(process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"), "npm", "node_modules", "pi-subagents");
const requireFromUpstream = createRequire(path.join(upstreamRoot, "package.json"));
const { createJiti } = await import(requireFromUpstream.resolve("jiti"));
const jiti = createJiti(import.meta.url);
const bridgeModule = await jiti.import(path.join(upstreamRoot, "src", "slash", "prompt-template-bridge.ts"));
const { PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, registerPromptTemplateDelegationBridge } = bridgeModule;

class EventBus {
  handlers = new Map();
  on(event, handler) {
    const listeners = this.handlers.get(event) ?? new Set();
    listeners.add(handler);
    this.handlers.set(event, listeners);
    return () => listeners.delete(handler);
  }
  emit(event, value) { for (const handler of [...(this.handlers.get(event) ?? [])]) handler(value); }
}

test("installed pi-subagents bridge cancels only the exact owned attempt and supplies a durable terminal receipt", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-agent-control-bridge-"));
  const bus = new EventBus();
  const runId = randomUUID();
  const taskDigest = "a".repeat(64);
  const sessionId = "bridge-test-session";
  const ownerRunId = `owner-${randomUUID()}`;
  const nodeId = "01-worker";
  const executionId = randomUUID();
  const unrelatedRequestId = randomUUID();
  const unrelatedOwner = `unrelated-${randomUUID()}`;
  const pending = new Map();
  const responses = new Map();
  const controller = new AgentAttemptController({ sessionId, runId, taskDigest });
  const projection = new AgentHubProjection({ policy: { version: 1, enabled: true, maxRoleAttempts: 42, maxRenderedRoleAttempts: 42 } });
  const route = { provider: "fixture", model: "fixture/deterministic", thinking: "low", fallbackIndex: 0 };
  projection.ingest(workflowJournalMetadata({
    run_id: runId, task_id: taskDigest, checkpoint_seq: 1, status: "RUNNING", workflow_status: "RUNNING", current_phase: "WORKER", round: 0,
    worker_status: "RUNNING", tester_status: "NOT_RUN", verification_status: "NOT_RUN", review_status: "NOT_RUN", blocking_findings_count: 0,
    correction_performed: false, final_verification_status: "NOT_RUN", cleanup_status: "NOT_RUN", evidence_status: "NOT_RUN", allocation_id: "test-allocation",
    timestamps: { updated_at: new Date().toISOString() }, workflow_state: { hardLimits: { concurrency: 3, subagentDepth: 1, correctionIterations: 2 }, spawnBudget: { configuredSpawnLimit: 42, workflowLimit: 42, used: 1, remaining: 41, retriesUsed: 0, retryReserveRemaining: 3 } },
  }));
  const reservation = roleReservationMetadata({ runId, taskDigest, executionId, sequence: 0, role: "worker", round: 0, iteration: 0, attempt: 1, nodeId, route, callNumber: 1, retryCount: 0, spawnBudgetUsed: 1 });
  projection.ingest(reservation);
  const bridge = registerPromptTemplateDelegationBridge({
    events: bus,
    getContext: () => ({ cwd: temporary }),
    execute: async () => { throw new Error("legacy delegation forbidden"); },
    executeStructured: async (requestId, params, signal) => new Promise((resolve) => {
      pending.set(requestId, { params, signal, resolve });
      signal.addEventListener("abort", () => resolve({ content: [], details: { mode: "single", runId: randomUUID(), results: [{ agent: params.agent, model: params.model, thinking: params.delegatedThinkingOverride, usage: { input: 7, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 }, progressSummary: { toolCount: 0, durationMs: 10 } }] } }), { once: true });
    }),
  });
  const send = (requestId, owner, node) => bus.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, { requestId, ownerRunId: owner, nodeId: node, agent: "worker", task: "bounded local test", context: "fresh", cwd: temporary, model: route.model, thinking: route.thinking, timeoutMs: 30_000, toolBudget: { hard: 2, block: ["subagent", "bash"] }, artifacts: false, result: { kind: "text" } });
  bus.on(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, (value) => {
    if (value.requestId === executionId) { controller.started(executionId); projection.ingest(roleStartedMetadata(reservation)); }
  });
  bus.on(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, (value) => { responses.set(value.requestId, value); });
  try {
    controller.reserve({ executionId, role: "worker", sequence: 0, attempt: 1, cancel: () => bus.emit(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, { requestId: executionId, ownerRunId, nodeId }) });
    send(executionId, ownerRunId, nodeId);
    send(unrelatedRequestId, unrelatedOwner, "02-worker");
    assert.equal(projection.snapshot().roster.roles[0].status, "RUNNING");
    assert.equal(requestExactUserCancellation(controller, { requestId: randomUUID(), sessionId, executionId }).code, "CANCEL_REQUESTED");
    for (let attempt = 0; attempt < 20 && !responses.has(executionId); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(responses.get(executionId)?.status, "cancelled");
    assert.equal(pending.get(executionId)?.signal.aborted, true);
    assert.equal(pending.get(unrelatedRequestId)?.signal.aborted, false);
    const receipt = makeRoleReceipt({ runId, taskId: taskDigest, protocolNonce: "b".repeat(64), executionId, sequence: 0, role: "worker", round: 0, iteration: 0, attempt: 1, nodeId, ownerRunId, response: { ...responses.get(executionId), launchStatus: "launched" } });
    const receiptDirectory = process.platform === "win32" ? path.join(temporary, "protected") : temporary;
    if (process.platform === "win32") ensureProtectedDirectory(receiptDirectory);
    const reference = writeRoleReceipt(openRoleReceiptStore({ runId, directory: receiptDirectory }), receipt);
    controller.terminal(executionId, receipt.status);
    projection.ingest(roleReceiptMetadata(receipt, reference));
    assert.equal(projection.snapshot().roster.roles[0].status, "CANCELLED");
    assert.equal(projection.snapshot().roster.roles[0].usage.costUsd, 0);
    assert.equal(controller.cancel({ requestId: randomUUID(), sessionId, ...controller.identity(executionId) }).code, "STALE_STATE");
    pending.get(unrelatedRequestId).resolve({ content: [], details: { mode: "single", runId: randomUUID(), results: [{ agent: "worker", model: route.model, thinking: route.thinking, finalOutput: "unrelated completed", exitCode: 0 }] } });
  } finally {
    bridge.dispose();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
