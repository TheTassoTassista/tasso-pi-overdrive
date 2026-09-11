import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executeDelegationWithRetry } from "../lib/delegation-retry.mjs";
import { canonicalizeDelegationResponse } from "../lib/delegation-response.mjs";
import { createEvidenceRun, taskDigest } from "../lib/workflow-evidence.mjs";
import { makeRoleReceipt, openRoleReceiptStore, writeRoleReceipt } from "../lib/workflow-receipts.mjs";
import { runEnforcedWorkflow } from "../lib/workflow-state.mjs";
import { createWorkflowSpawnBudgetGuard, workflowSpawnBudgetForRequest } from "../lib/workflow-spawn-budget.mjs";

const route = { model: "fixture/model", thinking: "low" };
const allocation = { worktree: "/tmp/structured-output-worktree", port: 32123, stateDir: "/tmp/structured-output-state", browserProfile: "/tmp/structured-output-profile", browserSession: "structured-output", database: "structured_output", schema: "structured_output" };
const modelPolicy = { digest: "structured-output-policy", roles: {} };

function completed(agent, result) {
  return canonicalizeDelegationResponse(route, {
    status: "completed",
    agent,
    runId: randomUUID(),
    nodeId: `completed-${agent}`,
    ownerRunId: "structured-output-owner",
    model: route.model,
    thinking: route.thinking,
    result,
  });
}

function valueFor(agent) {
  if (agent.startsWith("council-") && agent !== "council-judge") return { kind: "structured", value: { conclusion: "supported", recommendation: "proceed", confidence: "HIGH", evidence: ["fixture"], risks: [], blockingConcerns: [] } };
  if (agent === "council-judge") return { kind: "structured", value: { decision: "proceed", decisionBasis: "three valid reports", confidence: "HIGH", agreements: ["fixture"], disagreements: [], requiredActions: [] } };
  if (agent.endsWith("reviewer")) return { kind: "structured", value: { verdict: "PASS", summary: "pass", findings: [] } };
  return { kind: "text", text: `${agent} complete` };
}

function invalidStructured(agent, attempt, error = "Missing structured output call; missing required property recommendation") {
  return canonicalizeDelegationResponse(route, {
    status: "structured_output_failed",
    agent,
    runId: randomUUID(),
    nodeId: `invalid-${agent}-${attempt}`,
    ownerRunId: "structured-output-owner",
    model: route.model,
    thinking: route.thinking,
    exitCode: 1,
    error,
  }, { attempt });
}

function asError(response) {
  return Object.assign(new Error(`${response.status}`), { failureCategory: response.failureCategory, delegationStatus: response.status });
}

test("Council-2 retries one attested model-invalid structured result on the identical route, then Judge runs", async () => {
  const plan = workflowSpawnBudgetForRequest({ includeOracle: true, includeSecurity: true });
  const guard = createWorkflowSpawnBudgetGuard({ configuredSpawnLimit: plan.requiredTotalSpawns, plan });
  const attempts = [];
  let councilTwoFailures = 0;
  let judgeCalls = 0;
  const state = await runEnforcedWorkflow({
    task: "structured retry success fixture",
    allocation,
    modelPolicy,
    includeOracle: true,
    spawnBudgetGuard: guard,
    verify: async () => ({ status: "PASS", processExitCode: 0 }),
    delegate: async (input) => executeDelegationWithRetry(async (attempt) => {
      guard.claimSpawn(input.agent, { retry: attempt > 1 });
      attempts.push({ agent: input.agent, attempt, model: route.model, thinking: route.thinking, nodeId: `${attempts.length + 1}-${input.agent}`, executionId: randomUUID() });
      if (input.agent === "council-2" && councilTwoFailures++ === 0) throw asError(invalidStructured(input.agent, attempt));
      if (input.agent === "council-judge") judgeCalls += 1;
      return completed(input.agent, valueFor(input.agent));
    }),
  });
  const councilTwo = attempts.filter((entry) => entry.agent === "council-2");
  assert.equal(state.status, "PASS");
  assert.equal(state.evidence.councils[0].complete, true);
  assert.equal(state.evidence.councils[0].members.length, 3);
  assert.equal(judgeCalls, 1);
  assert.equal(councilTwo.length, 2);
  assert.deepEqual(councilTwo.map(({ agent, model, thinking }) => ({ agent, model, thinking })), [
    { agent: "council-2", model: route.model, thinking: route.thinking },
    { agent: "council-2", model: route.model, thinking: route.thinking },
  ]);
  assert.notEqual(councilTwo[0].nodeId, councilTwo[1].nodeId);
  assert.notEqual(councilTwo[0].executionId, councilTwo[1].executionId);
  assert.equal(guard.snapshot().retriesUsed, 1);
});

test("two model-invalid structured results fail closed with two receipts and no third attempt or Judge", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "structured-double-invalid-"));
  const run = createEvidenceRun({ root });
  const store = openRoleReceiptStore(run);
  const plan = workflowSpawnBudgetForRequest({ includeOracle: true, includeSecurity: true });
  const guard = createWorkflowSpawnBudgetGuard({ configuredSpawnLimit: plan.requiredTotalSpawns, plan });
  let attempts = 0;
  let judgeCalls = 0;
  try {
    await assert.rejects(() => runEnforcedWorkflow({
      task: "structured retry failure fixture",
      allocation,
      modelPolicy,
      includeOracle: true,
      spawnBudgetGuard: guard,
      verify: async () => ({ status: "PASS", processExitCode: 0 }),
      delegate: async (input) => executeDelegationWithRetry(async (attempt) => {
        guard.claimSpawn(input.agent, { retry: attempt > 1 });
        if (input.agent === "council-judge") judgeCalls += 1;
        if (input.agent !== "council-2") return completed(input.agent, valueFor(input.agent));
        attempts += 1;
        const response = invalidStructured(input.agent, attempt);
        const receipt = makeRoleReceipt({
          runId: run.runId, taskId: taskDigest("structured retry failure fixture"), protocolNonce: taskDigest("structured retry nonce"), executionId: randomUUID(), sequence: attempt - 1,
          role: input.agent, round: 0, iteration: 0, attempt, nodeId: response.nodeId, ownerRunId: response.ownerRunId, response,
        });
        writeRoleReceipt(store, receipt);
        throw asError(response);
      }),
    }), /mandatory council members failed/u);
    const receipts = fs.readdirSync(store.directory).sort().map((name) => JSON.parse(fs.readFileSync(path.join(store.directory, name), "utf8")));
    assert.equal(attempts, 2);
    assert.equal(judgeCalls, 0);
    assert.equal(guard.snapshot().retriesUsed, 1);
    assert.deepEqual(receipts.map((entry) => entry.attempt), [1, 2]);
    assert.ok(receipts.every((entry) => entry.failure_category === "STRUCTURED_OUTPUT_MODEL_INVALID"));
    assert.ok(receipts.every((entry) => entry.model === route.model && entry.thinking === route.thinking));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pre-launch schema configuration error uses zero model calls and no retry reserve", async () => {
  const plan = workflowSpawnBudgetForRequest({ includeOracle: true, includeSecurity: true });
  const guard = createWorkflowSpawnBudgetGuard({ configuredSpawnLimit: plan.requiredTotalSpawns, plan });
  let attempts = 0;
  await assert.rejects(() => executeDelegationWithRetry(async (attempt) => {
    attempts += 1;
    guard.claimSpawn("council-2", { retry: attempt > 1 });
    const response = canonicalizeDelegationResponse(route, { status: "invalid_request", error: "result.schema must be a JSON Schema object" }, { attempt });
    assert.equal(response.modelCalls, 0);
    assert.equal(response.launchStatus, "not_launched");
    throw asError(response);
  }), (error) => error.failureCategory === "STRUCTURED_OUTPUT_POLICY_ERROR");
  assert.equal(attempts, 1);
  assert.equal(guard.snapshot().retriesUsed, 0);
});

test("structured failure receipts persist only bounded metadata and digests, never raw output", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "structured-privacy-"));
  const run = createEvidenceRun({ root });
  const store = openRoleReceiptStore(run);
  const secretMarker = ["sk", "-test-super-secret"].join("");
  const pseudoSecret = ["API", "_TOKEN=", secretMarker, "\nfunction dangerous(){ return process.env.SECRET; }\n```"].join("");
  const response = canonicalizeDelegationResponse(route, {
    status: "structured_output_failed", agent: "council-2", runId: randomUUID(), nodeId: "privacy-node", ownerRunId: "privacy-owner", model: route.model, thinking: route.thinking,
    error: `Missing structured output call; missing required property recommendation at path /recommendation; provider diagnostic ${pseudoSecret}`,
  }, { attempt: 1, rawOutput: pseudoSecret, schema: { type: "object", additionalProperties: false, required: ["recommendation"], properties: { recommendation: { type: "string" } } } });
  const receipt = makeRoleReceipt({
    runId: run.runId, taskId: taskDigest("privacy task"), protocolNonce: taskDigest("privacy nonce"), executionId: randomUUID(), sequence: 0,
    role: "council-2", round: 0, iteration: 2, attempt: 1, nodeId: "privacy-node", ownerRunId: "privacy-owner", response,
  });
  try {
    const reference = writeRoleReceipt(store, receipt);
    const persisted = fs.readFileSync(reference.file, "utf8");
    assert.equal(receipt.failure_category, "STRUCTURED_OUTPUT_MODEL_INVALID");
    assert.equal(receipt.failure_metadata.outputLength, Buffer.byteLength(pseudoSecret));
    assert.match(receipt.failure_metadata.rawOutputDigest, /^[0-9a-f]{64}$/u);
    assert.equal(receipt.failure_metadata.failureStage, "postlaunch_model_output_validation");
    assert.equal(receipt.failure_metadata.validationKeyword, "required");
    assert.deepEqual(receipt.failure_metadata.missingRequiredFields, ["recommendation"]);
    for (const forbidden of [secretMarker, "dangerous", "process.env", ["API", "_TOKEN"].join("")]) assert.equal(persisted.includes(forbidden), false);
    assert.throws(() => writeRoleReceipt(store, {
      ...receipt,
      execution_id: randomUUID(),
      sequence: 1,
      failure_metadata: { ...receipt.failure_metadata, rawOutput: pseudoSecret },
    }), /metadata shape/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a wrong-role response stays POLICY and cannot borrow the structured-output retry", () => {
  const response = invalidStructured("council-3", 1);
  const receipt = makeRoleReceipt({
    runId: randomUUID(), taskId: taskDigest("role task"), protocolNonce: taskDigest("role nonce"), executionId: randomUUID(), sequence: 0,
    role: "council-2", round: 0, iteration: 0, attempt: 1, nodeId: response.nodeId, ownerRunId: response.ownerRunId, response,
  });
  assert.equal(receipt.status, "protocol_rejected");
  assert.equal(receipt.failure_category, "POLICY");
});

test("bridge responses cannot inject controller-owned retry categories or failure metadata", () => {
  const response = canonicalizeDelegationResponse(route, {
    status: "failed", agent: "council-2", runId: randomUUID(), nodeId: "injected-node", ownerRunId: "injected-owner", model: route.model, thinking: route.thinking,
    error: "deterministic child failure",
    failureCategory: "STRUCTURED_OUTPUT_MODEL_INVALID",
    failureMetadata: { raw: "untrusted" },
  }, { attempt: 1 });
  assert.equal(response.failureCategory, "DETERMINISTIC");
  assert.equal(response.failureMetadata, undefined);
});

test("validation paths retain only schema-derived segments and never arbitrary provider text", () => {
  const schema = { type: "object", properties: { recommendation: { type: "array", items: { type: "object", properties: { evidence: { type: "string" } } } } } };
  const safe = invalidStructured("council-2", 1, "Schema validation failed at path /recommendation/0/evidence");
  const hostile = canonicalizeDelegationResponse(route, {
    status: "structured_output_failed", agent: "council-2", runId: randomUUID(), nodeId: "hostile-path", ownerRunId: "structured-output-owner", model: route.model, thinking: route.thinking,
    error: "Schema validation failed at path /recommendation/embeddedSecret",
  }, { attempt: 1, schema });
  const safeWithSchema = canonicalizeDelegationResponse(route, {
    status: safe.status, agent: "council-2", runId: randomUUID(), nodeId: "safe-path", ownerRunId: "structured-output-owner", model: route.model, thinking: route.thinking,
    error: "Schema validation failed at path /recommendation/0/evidence",
  }, { attempt: 1, schema });
  assert.equal(safeWithSchema.failureMetadata.validationPath, "/recommendation/0/evidence");
  assert.equal(hostile.failureMetadata.validationPath, null);
});
