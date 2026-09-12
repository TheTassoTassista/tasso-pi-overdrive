import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { aggregateUsageAttempts, normalizeProviderUsage, validateNormalizedUsage } from "../lib/usage-accounting.mjs";
import { makeRoleReceipt } from "../lib/workflow-receipts.mjs";
import { taskDigest } from "../lib/workflow-evidence.mjs";

const fullUsage = (overrides = {}) => ({
  input: 100,
  output: 20,
  cacheRead: 40,
  cacheWrite: 5,
  cost: 0.0125,
  turns: 2,
  toolCalls: 3,
  durationMs: 900,
  ...overrides,
});

function attempt(agent, usage, overrides = {}) {
  return {
    agent,
    executionId: randomUUID(),
    launchStatus: "launched",
    status: "completed",
    provider: "openai-codex",
    model: "openai-codex/fixture",
    thinking: "high",
    usage,
    ...overrides,
  };
}

function receipt(status, usage) {
  const nodeId = `node-${status}`;
  const ownerRunId = "usage-owner";
  return makeRoleReceipt({
    runId: randomUUID(),
    taskId: taskDigest("usage task"),
    protocolNonce: taskDigest("usage nonce"),
    executionId: randomUUID(),
    sequence: 0,
    role: "worker",
    round: 0,
    iteration: 0,
    attempt: 1,
    nodeId,
    ownerRunId,
    response: {
      status,
      agent: "worker",
      nodeId,
      ownerRunId,
      runId: randomUUID(),
      provider: "openai-codex",
      model: "openai-codex/fixture",
      thinking: "high",
      usage,
      ...(status === "completed" ? { result: { kind: "text", text: "ok" } } : { error: "sanitized failure" }),
    },
  });
}

test("successful and streamed terminal usage preserve provider numbers without estimating", () => {
  const success = normalizeProviderUsage(fullUsage());
  assert.equal(validateNormalizedUsage(success), success);
  assert.equal(success.status, "REPORTED");
  assert.equal(success.inputTokens, 100);
  assert.equal(success.outputTokens, 20);
  assert.equal(success.cacheReadTokens, 40);
  assert.equal(success.cacheWriteTokens, 5);
  assert.equal(success.totalTokens, 165);
  assert.equal(success.totalTokensSource, "DERIVED_FROM_REPORTED_COMPONENTS");
  assert.equal(success.costUsd, 0.0125);
  assert.deepEqual(success.estimated, { status: "NOT_COMPUTED" });

  const streamedTerminal = normalizeProviderUsage(fullUsage({ totalTokens: 170, reasoningTokens: 7, output: 25 }));
  assert.equal(streamedTerminal.status, "REPORTED");
  assert.equal(streamedTerminal.totalTokens, 170);
  assert.equal(streamedTerminal.totalTokensSource, "PROVIDER_REPORTED");
  assert.equal(streamedTerminal.reasoningTokens, 7);
});

test("retry accounting includes failed and successful launched attempts exactly once", () => {
  const first = attempt("council-2", fullUsage({ input: 60, output: 4 }), { status: "structured_output_failed" });
  const second = attempt("council-2", fullUsage({ input: 70, output: 8 }));
  const aggregate = aggregateUsageAttempts([first, second, { ...first }]);
  assert.equal(aggregate.attemptCount, 2);
  assert.equal(aggregate.launchedAttempts, 2);
  assert.equal(aggregate.duplicateExecutionIdsIgnored, 1);
  assert.equal(aggregate.reportedUsageAttempts, 2);
  assert.deepEqual(aggregate.totals.inputTokens, { status: "COMPLETE", value: 130, reportedAttempts: 2 });
  assert.deepEqual(aggregate.totals.outputTokens, { status: "COMPLETE", value: 12, reportedAttempts: 2 });
  assert.equal(aggregate.totals.totalTokens.source, "INCLUDES_DERIVED_COMPONENT_TOTALS");
});

test("failed receipts preserve reported usage and mark absent usage unavailable rather than zero", () => {
  const withUsage = receipt("failed", fullUsage({ input: 11, output: 2, cacheRead: 9, cost: 0.004 }));
  assert.equal(withUsage.status, "failed");
  assert.equal(withUsage.provider, "openai-codex");
  assert.equal(withUsage.usage.status, "REPORTED");
  assert.equal(withUsage.usage.inputTokens, 11);
  assert.equal(withUsage.usage.costUsd, 0.004);

  const withoutUsage = receipt("failed", undefined);
  assert.equal(withoutUsage.usage.status, "UNAVAILABLE");
  for (const field of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens", "costUsd"]) assert.equal(withoutUsage.usage[field], null);
});

test("partial or hostile usage is bounded to numeric accounting fields", () => {
  const partial = normalizeProviderUsage({ input: 4, output: "5", secret: "do-not-retain", cost: { total: 0 } });
  assert.equal(partial.status, "PARTIAL");
  assert.equal(partial.inputTokens, 4);
  assert.equal(partial.outputTokens, null);
  assert.equal(partial.costUsd, 0);
  assert.deepEqual(partial.invalidFields, ["outputTokens"]);
  assert.equal(JSON.stringify(partial).includes("do-not-retain"), false);
});

test("multi-agent and Council aggregation retain per-attempt role routes without double counting", () => {
  const attempts = [
    attempt("scout", fullUsage({ input: 10 })),
    attempt("worker", fullUsage({ input: 20 })),
    attempt("council-1", fullUsage({ input: 30 })),
    attempt("council-2", fullUsage({ input: 40 })),
    attempt("council-3", fullUsage({ input: 50 })),
    attempt("council-judge", fullUsage({ input: 60 })),
    { agent: "planner", launchStatus: "not_launched", status: "prelaunch-rejected", usage: normalizeProviderUsage(undefined) },
  ];
  const all = aggregateUsageAttempts(attempts);
  const council = aggregateUsageAttempts(attempts, { roles: ["council-1", "council-2", "council-3", "council-judge"] });
  assert.equal(all.attemptCount, 7);
  assert.equal(all.launchedAttempts, 6);
  assert.equal(all.notLaunchedAttempts, 1);
  assert.equal(all.totals.inputTokens.value, 210);
  assert.equal(council.attemptCount, 4);
  assert.equal(council.launchedAttempts, 4);
  assert.equal(council.totals.inputTokens.value, 180);
  assert.equal(council.status, "REPORTED");
});
