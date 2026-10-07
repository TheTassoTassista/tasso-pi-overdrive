import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  AgentHubProjection,
  renderAgentHubSnapshot,
  roleReceiptMetadata,
  roleReservationMetadata,
  roleStartedMetadata,
  validateAgentHubEvent,
  validateAgentHubPolicy,
  workflowJournalMetadata,
} from "../lib/agent-hub.mjs";
import { makeRoleReceipt, openRoleReceiptStore, writeRoleReceipt } from "../lib/workflow-receipts.mjs";
import { ensureProtectedDirectory } from "../lib/protected-artifact.mjs";

const policy = { version: 1, enabled: true, maxRoleAttempts: 42, maxRenderedRoleAttempts: 42 };
const taskDigest = "a".repeat(64);

function journal(overrides = {}) {
  const now = new Date().toISOString();
  return workflowJournalMetadata({
    run_id: overrides.runId ?? randomUUID(),
    task_id: taskDigest,
    checkpoint_seq: overrides.checkpointSequence ?? 1,
    status: overrides.lifecycleStatus ?? "RUNNING",
    workflow_status: overrides.workflowStatus ?? "RUNNING",
    current_phase: overrides.currentPhase ?? "RUNTIME_ALLOCATED",
    round: overrides.round ?? 0,
    worker_status: "NOT_RUN",
    tester_status: "NOT_RUN",
    verification_status: "NOT_RUN",
    review_status: "NOT_RUN",
    blocking_findings_count: 0,
    correction_performed: false,
    final_verification_status: "NOT_RUN",
    cleanup_status: "NOT_RUN",
    evidence_status: "NOT_RUN",
    allocation_id: "metadata-only-allocation-id",
    timestamps: { updated_at: now },
    workflow_state: {
      hardLimits: { concurrency: 3, subagentDepth: 1, correctionIterations: 2 },
      spawnBudget: { configuredSpawnLimit: 42, workflowLimit: 42, used: overrides.used ?? 0, remaining: 42 - (overrides.used ?? 0), retriesUsed: 0, retryReserveRemaining: 3 },
    },
  });
}

function reservation(workflow, overrides = {}) {
  const role = overrides.role ?? "worker";
  const nodeId = overrides.nodeId ?? `01-${role}`;
  return roleReservationMetadata({
    runId: workflow.runId,
    taskDigest: workflow.taskDigest,
    executionId: overrides.executionId ?? randomUUID(),
    sequence: overrides.sequence ?? 0,
    role,
    round: overrides.round ?? 0,
    iteration: overrides.iteration ?? 0,
    attempt: overrides.attempt ?? 1,
    nodeId,
    route: { provider: "openai-codex", model: "openai-codex/gpt-6-astra", thinking: "high", fallbackIndex: 0 },
    callNumber: overrides.callNumber ?? 1,
    retryCount: overrides.retryCount ?? 0,
    spawnBudgetUsed: overrides.spawnBudgetUsed ?? 1,
  });
}

function durableReceipt(workflow, reserved, responseOverrides = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-agent-hub-test-"));
  const directory = process.platform === "win32" ? path.join(temporary, "protected") : temporary;
  if (process.platform === "win32") ensureProtectedDirectory(directory);
  const run = { runId: workflow.runId, directory };
  const store = openRoleReceiptStore(run);
  const receipt = makeRoleReceipt({
    runId: workflow.runId,
    taskId: workflow.taskDigest,
    protocolNonce: "b".repeat(64),
    executionId: reserved.executionId,
    sequence: reserved.sequence,
    role: reserved.role,
    round: reserved.round,
    iteration: reserved.iteration,
    attempt: reserved.attempt,
    nodeId: `01-${reserved.role}`,
    ownerRunId: "controller-owner",
    response: {
      status: "completed",
      agent: reserved.role,
      nodeId: `01-${reserved.role}`,
      ownerRunId: "controller-owner",
      runId: randomUUID(),
      provider: "openai-codex",
      model: "openai-codex/gpt-6-astra",
      thinking: "high",
      launchStatus: "launched",
      exitCode: 0,
      usage: { input: 123, output: 45, cacheRead: 6, cacheWrite: 0, cost: 0.0125, turns: 1, toolCalls: 2, durationMs: 900 },
      ...responseOverrides,
    },
  });
  const reference = writeRoleReceipt(store, receipt);
  const event = roleReceiptMetadata(receipt, reference);
  return { event, cleanup: () => fs.rmSync(temporary, { recursive: true, force: true }) };
}

test("Agent Hub policy is fixed to the authoritative 42-attempt workflow envelope", () => {
  assert.deepEqual(validateAgentHubPolicy(policy), policy);
  assert.throws(() => validateAgentHubPolicy({ ...policy, maxRoleAttempts: 43 }), /AGENT_HUB_POLICY_INVALID/u);
  assert.throws(() => validateAgentHubPolicy({ ...policy, control: true }), /AGENT_HUB_POLICY_INVALID/u);
});

test("authoritative reservation and correlated started event form a conservative live lifecycle", () => {
  const projection = new AgentHubProjection({ policy });
  const workflow = journal();
  const reserved = reservation(workflow);
  projection.ingest(workflow);
  projection.ingest(reserved);
  let snapshot = projection.snapshot();
  assert.equal(snapshot.roster.roles[0].status, "RESERVED");
  assert.equal(snapshot.roster.roles[0].usage, null);
  assert.equal(snapshot.roster.roles[0].usageSource, "UNAVAILABLE_UNTIL_DURABLE_RECEIPT");
  assert.equal(snapshot.usage.status, "UNAVAILABLE");
  projection.ingest(roleStartedMetadata(reserved));
  snapshot = projection.snapshot();
  assert.equal(snapshot.roster.roles[0].status, "RUNNING");
  assert.equal(snapshot.roster.roles[0].attemptId, reserved.executionId);
  assert.equal(snapshot.roster.roles[0].modelCalls, null);
  assert.match(renderAgentHubSnapshot(snapshot), /UNAVAILABLE \| UNAVAILABLE \| UNAVAILABLE/u);
});

test("a persisted terminal receipt closes lifecycle and is the sole token/cost source", () => {
  const projection = new AgentHubProjection({ policy });
  const workflow = journal();
  const reserved = reservation(workflow);
  projection.ingest(workflow);
  projection.ingest(reserved);
  projection.ingest(roleStartedMetadata(reserved));
  const terminal = durableReceipt(workflow, reserved);
  try {
    projection.ingest(terminal.event);
    const snapshot = projection.snapshot();
    const entry = snapshot.roster.roles[0];
    assert.equal(entry.status, "COMPLETED");
    assert.equal(entry.usage.totalTokens, 174);
    assert.equal(entry.usage.costUsd, 0.0125);
    assert.equal(entry.usageSource, "DURABLE_ROLE_RECEIPT");
    assert.equal(entry.routeAttested, true);
    assert.equal(snapshot.usage.totals.totalTokens.value, 174);
    assert.equal(snapshot.usage.totals.costUsd.value, 0.0125);
    assert.match(renderAgentHubSnapshot(snapshot), /174 \| 0\.012500/u);
  } finally { terminal.cleanup(); }
});

test("missing terminal usage stays UNAVAILABLE and is never projected as zero", () => {
  const projection = new AgentHubProjection({ policy });
  const workflow = journal();
  const reserved = reservation(workflow);
  projection.ingest(workflow);
  projection.ingest(reserved);
  const terminal = durableReceipt(workflow, reserved, { usage: undefined });
  try {
    projection.ingest(terminal.event);
    const snapshot = projection.snapshot();
    assert.equal(snapshot.roster.roles[0].usage.status, "UNAVAILABLE");
    assert.equal(snapshot.roster.roles[0].usage.totalTokens, null);
    assert.equal(snapshot.roster.roles[0].usage.costUsd, null);
    assert.equal(snapshot.usage.status, "UNAVAILABLE");
    assert.match(renderAgentHubSnapshot(snapshot), /UNAVAILABLE \| UNAVAILABLE/u);
    assert.doesNotMatch(renderAgentHubSnapshot(snapshot), /\| 0 \| 0\.000000/u);
  } finally { terminal.cleanup(); }
});

test("a durable failed receipt preserves bounded negative process exit metadata", () => {
  const projection = new AgentHubProjection({ policy });
  const workflow = journal();
  const reserved = reservation(workflow);
  projection.ingest(workflow);
  projection.ingest(reserved);
  const terminal = durableReceipt(workflow, reserved, {
    status: "failed",
    failureCategory: "TRANSIENT",
    failureReason: null,
    exitCode: -1,
    usage: undefined,
  });
  try {
    projection.ingest(terminal.event);
    const entry = projection.snapshot().roster.roles[0];
    assert.equal(entry.status, "FAILED");
    assert.equal(entry.exitCode, -1);
    assert.equal(entry.usage.status, "UNAVAILABLE");
  } finally { terminal.cleanup(); }
});

test("event allowlists reject transcript, prompt, tool, reasoning, Council output, secret, credential, and path fields", () => {
  const workflow = journal();
  const reserved = reservation(workflow);
  for (const key of ["transcript", "prompt", "toolArgs", "toolResult", "reasoning", "councilOutput", "secret", "credential", "arbitraryPath"]) {
    assert.throws(() => validateAgentHubEvent({ ...reserved, [key]: `PROTECTED_${key}` }), /AGENT_HUB_EVENT_FIELDS_INVALID/u);
  }
});

test("Council slots expose identity metadata but cannot carry member content across the Hub", () => {
  const projection = new AgentHubProjection({ policy });
  const workflow = journal();
  projection.ingest(workflow);
  const first = reservation(workflow, { role: "council-1", nodeId: "01-council-1" });
  const second = reservation(workflow, { role: "council-2", nodeId: "02-council-2", sequence: 1, callNumber: 2, spawnBudgetUsed: 2 });
  projection.ingest(first);
  projection.ingest(second);
  const hostile = { ...second, councilOutput: "MEMBER_B_PROTECTED_CONCLUSION" };
  assert.throws(() => projection.ingest(hostile), /AGENT_HUB_EVENT_FIELDS_INVALID/u);
  const serialized = JSON.stringify(projection.snapshot());
  assert.equal(projection.snapshot().roster.roles[0].attemptId, null);
  assert.equal(projection.snapshot().roster.roles[1].attemptId, null);
  assert.match(serialized, /council-1/u);
  assert.match(serialized, /council-2/u);
  assert.doesNotMatch(serialized, /MEMBER_B_PROTECTED_CONCLUSION|"councilOutput"|"conclusion"|"recommendation"|"transcript"|"toolArgs"|"toolResult"/u);
});

test("ambiguous, unreserved, stale, and conflicting lifecycle events never invent identity", () => {
  const projection = new AgentHubProjection({ policy });
  const workflow = journal({ checkpointSequence: 5 });
  const reserved = reservation(workflow);
  projection.ingest(workflow);
  assert.throws(() => projection.ingest(roleStartedMetadata(reserved)), /AGENT_HUB_STARTED_WITHOUT_RESERVATION/u);
  assert.equal(projection.snapshot().roster.total, 0);
  projection.ingest(reserved);
  const ambiguous = { ...roleStartedMetadata(reserved), executionId: randomUUID() };
  assert.throws(() => projection.ingest(ambiguous), /AGENT_HUB_STARTED_WITHOUT_RESERVATION/u);
  assert.throws(() => projection.ingest(journal({ runId: workflow.runId, checkpointSequence: 4 })), /AGENT_HUB_STALE_JOURNAL_REJECTED/u);
  assert.equal(projection.snapshot().roster.total, 1);
});

test("resume may replay a validated durable receipt without fabricating a live reservation", () => {
  const projection = new AgentHubProjection({ policy });
  const workflow = journal({ lifecycleStatus: "INTERRUPTED", workflowStatus: "INTERRUPTED" });
  const reserved = reservation(workflow);
  const terminal = durableReceipt(workflow, reserved);
  try {
    projection.ingest(workflow);
    projection.ingest(terminal.event);
    projection.ingest(terminal.event);
    const snapshot = projection.snapshot();
    assert.equal(snapshot.roster.total, 1);
    assert.equal(snapshot.roster.active, 0);
    assert.equal(snapshot.roster.roles[0].lifecycleSource, "DURABLE_ROLE_RECEIPT");
  } finally { terminal.cleanup(); }
});

test("projection failure is fail-soft and cannot become workflow control authority", () => {
  const projection = new AgentHubProjection({ policy });
  projection.failSoft(new Error("untrusted details must not surface"));
  const snapshot = projection.snapshot();
  assert.equal(snapshot.status, "DEGRADED");
  assert.deepEqual(snapshot.authority, { modelCalls: 0, tools: 0, steering: false, revive: false, kill: false, spawn: false });
  assert.doesNotMatch(renderAgentHubSnapshot(snapshot), /untrusted details/u);
});

test("the user command is schema-free/read-only and Judge still follows three Council results", () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const extension = fs.readFileSync(path.join(root, "extensions", "agent-hub.ts"), "utf8");
  const workflow = fs.readFileSync(path.join(root, "lib", "workflow-state.mjs"), "utf8");
  assert.match(extension, /registerCommand\("agents"/u);
  assert.doesNotMatch(extension, /pi\.registerTool|ctx\.modelRegistry|pi\.sendMessage|pi\.sendUserMessage|pi\.exec|node:child_process|prompt-template:subagent:cancel/u);
  assert.match(fs.readFileSync(path.join(root, "extensions", "secure-workflow.ts"), "utf8"), /registerCommand\("agent-cancel"/u);
  assert.ok(workflow.indexOf('members.length !== COUNCIL_MEMBERS.length') < workflow.indexOf('runRole("council-judge"'));
  assert.match(workflow, /COUNCIL_MEMBERS\.length !== MAX_WORKFLOW_CONCURRENCY/u);
});
