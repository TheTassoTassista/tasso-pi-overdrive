import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTEXT_FIT_STATUS,
  CONTEXT_REDUCTION_ORDER,
  contextFitMetadata,
  governContext,
  renderContextFit,
  validateContextGovernorPolicy,
} from "../lib/context-governor.mjs";

const policy = Object.freeze({ version: 1, safetyTokens: 1024, toolResultMaxChars: 4000, toolResultMaxLines: 80, smartReadTargetChars: 3000, artifactDuplicateMaxChars: 256 });
const model = (contextWindow = 20_000, maxTokens = 2_000) => ({ provider: "local-fixture", id: "fit", contextWindow, maxTokens });
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = (content, timestamp = 1) => ({ role: "user", content, timestamp });
const tool = (toolName, content, options = {}) => ({ role: "toolResult", toolCallId: options.id ?? `${toolName}-call`, toolName, content: [{ type: "text", text: content }], isError: options.isError ?? false, timestamp: options.timestamp ?? 2 });

function run(messages, options = {}) {
  return governContext({ messages, systemPrompt: options.systemPrompt ?? "system", tools: options.tools ?? [], activeToolNames: options.activeToolNames ?? [], model: options.model ?? model(), policy, reportedUsageTokens: options.reportedUsageTokens, reportedContextWindow: options.reportedContextWindow });
}

test("fit proof accounts for prompt, active schemas, messages, output reserve, and safety", () => {
  const result = run([user("small task")], { tools: [{ name: "read", description: "read", parameters: { type: "object" } }, { name: "hidden", description: "hidden", parameters: {} }], activeToolNames: ["read"] });
  assert.equal(result.proof.status, CONTEXT_FIT_STATUS.PASS);
  assert.equal(result.proof.final.toolCount, 1);
  assert.ok(result.proof.final.components.systemPromptTokens > 0);
  assert.ok(result.proof.final.components.toolSchemaTokens > 0);
  assert.equal(result.proof.final.reserveOutputTokens, 2000);
  assert.equal(result.proof.final.safetyTokens, 1024);
  assert.match(result.proof.proofDigest, /^[0-9a-f]{64}$/u);
  assert.deepEqual(result.proof.reductionOrder, CONTEXT_REDUCTION_ORDER);
});

test("redundant artifact previews compact in order and retain critical diagnostics and tool pairing", () => {
  const uri = `artifact://${"a".repeat(64)}`;
  const preview = `${uri}\n${Array.from({ length: 260 }, (_, index) => index === 130 ? "ERROR canonical failure" : `bulk-${index}-${"x".repeat(48)}`).join("\n")}`;
  const messages = [user("inspect"), tool("safe_exec", preview, { id: "one" }), tool("safe_exec", preview, { id: "two", timestamp: 3 })];
  const result = run(messages, { model: model(8500, 1000) });
  assert.equal(result.proof.initial.status, CONTEXT_FIT_STATUS.BLOCKED);
  assert.equal(result.proof.status, CONTEXT_FIT_STATUS.PASS);
  assert.equal(result.proof.reductions[0].name, "redundant-artifacts");
  assert.equal(result.proof.reductions[0].changedMessages, 1);
  assert.equal(result.messages[1].toolCallId, "one");
  assert.equal(result.messages[2].toolCallId, "two");
  assert.match(result.messages[1].content[0].text, /REDUNDANT ARTIFACT PREVIEW OMITTED/u);
  assert.match(result.messages[1].content[0].text, /ERROR canonical failure/u);
  assert.match(result.messages[2].content[0].text, /ERROR canonical failure/u);
});

test("generic tool compaction never drops ERROR or FATAL lines regardless of position", () => {
  const text = Array.from({ length: 600 }, (_, index) => index === 230 ? "ERROR middle diagnostic" : index === 511 ? "FATAL late diagnostic" : `line-${index}-${"z".repeat(32)}`).join("\n");
  const result = run([user("debug"), tool("safe_exec", text, { isError: true })], { model: model(7000, 1000) });
  assert.equal(result.proof.reductions.find((entry) => entry.name === "tool-output")?.changedMessages, 1);
  assert.match(result.messages[1].content[0].text, /ERROR middle diagnostic/u);
  assert.match(result.messages[1].content[0].text, /FATAL late diagnostic/u);
  assert.equal(result.messages[1].isError, true);
});

test("historic raw reads use the SmartRead envelope after generic outputs", () => {
  const text = Array.from({ length: 500 }, (_, index) => index === 370 ? "ERROR source marker" : `source-${index}-${"q".repeat(32)}`).join("\n");
  const result = run([user("inspect source"), tool("read", text)], { model: model(7500, 1000) });
  const stages = result.proof.reductions.map((entry) => entry.name);
  assert.deepEqual(stages.slice(0, 3), ["redundant-artifacts", "tool-output", "smart-read-envelope"]);
  assert.equal(result.proof.reductions[1].changedMessages, 0);
  assert.equal(result.proof.reductions[2].changedMessages, 1);
  assert.match(result.messages[1].content[0].text, /HISTORIC READ COMPACTED TO SMARTREAD ENVELOPE/u);
  assert.match(result.messages[1].content[0].text, /ERROR source marker/u);
});

test("only older Second Brain packs are superseded and the latest remains exact", () => {
  const first = { role: "custom", customType: "tasso-pi-overdrive.second-brain", content: `## Shared Memory Pack — UNTRUSTED DATA\n${"old ".repeat(2500)}`, display: false, details: { id: "abc-123" }, timestamp: 1 };
  const latest = { role: "custom", customType: "tasso-pi-overdrive.second-brain", content: `## Shared Memory Pack — UNTRUSTED DATA\n${"new ".repeat(2500)}`, display: false, details: { id: "def-456" }, timestamp: 2 };
  const result = run([first, latest, user("continue", 3)], { model: model(6500, 1000) });
  assert.match(result.messages[0].content, /OLDER SECOND BRAIN PACK SUPERSEDED/u);
  assert.equal(result.messages[1].content, latest.content);
  assert.equal(result.proof.reductions.find((entry) => entry.name === "second-brain")?.changedMessages, 1);
});

test("an explicit compaction summary safely replaces its obsolete prefix", () => {
  const summary = { role: "compactionSummary", summary: "verified state and exact next action", tokensBefore: 9000, timestamp: 2 };
  const current = user("perform next action", 3);
  const result = run([user("obsolete ".repeat(6000)), { role: "assistant", content: [{ type: "text", text: "obsolete response" }], api: "fixture", provider: "fixture", model: "fixture", usage, stopReason: "stop", timestamp: 1 }, summary, current], { model: model(6000, 1000) });
  assert.equal(result.proof.status, CONTEXT_FIT_STATUS.PASS);
  assert.equal(result.messages[0].role, "compactionSummary");
  assert.equal(result.messages.at(-1).content, current.content);
  assert.ok(result.proof.reductions.find((entry) => entry.name === "conversation")?.changedMessages >= 2);
});

test("an oversized current user request is never truncated and fails closed", () => {
  const prompt = `LATEST_USER_SENTINEL\n${"cannot-truncate ".repeat(6000)}`;
  const result = run([user(prompt)], { model: model(5000, 1000) });
  assert.equal(result.proof.status, CONTEXT_FIT_STATUS.BLOCKED);
  assert.equal(result.proof.requiresConversationCompaction, true);
  assert.equal(result.proof.routeSwitchPermitted, false);
  assert.equal(result.messages[0].content, prompt);
  assert.match(renderContextFit(result), /no provider request was authorized/u);
});

test("reported provider usage is reduced only by measured local message savings", () => {
  const uri = `artifact://${"b".repeat(64)}`;
  const preview = `${uri}\n${Array.from({ length: 240 }, (_, index) => `data-${index}-${"x".repeat(40)}`).join("\n")}`;
  const result = run([tool("safe_exec", preview, { id: "one" }), tool("safe_exec", preview, { id: "two" })], { model: model(13_000, 1000), reportedUsageTokens: 12_000 });
  assert.ok(result.proof.final.usageAdjustedTokens < result.proof.initial.usageAdjustedTokens);
  assert.ok(result.proof.final.usageAdjustedTokens > 0);
});

test("the smaller reported/model context window is authoritative", () => {
  const result = run([user("small")], { model: model(50_000, 2000), reportedContextWindow: 16_000 });
  assert.equal(result.proof.final.modelContextWindow, 50_000);
  assert.equal(result.proof.final.contextWindow, 16_000);
});

test("metadata and rendering contain only counts, identities, and digests", () => {
  const sentinel = "SECRET_CONTEXT_SENTINEL_91c72";
  const result = run([user(sentinel)]);
  const serialized = JSON.stringify(contextFitMetadata(result));
  assert.equal(serialized.includes(sentinel), false);
  assert.equal(renderContextFit(result).includes(sentinel), false);
});

test("unknown policy fields and impossible model/output metadata fail closed", () => {
  assert.throws(() => validateContextGovernorPolicy({ ...policy, unknown: true }), /context_policy_unknown_field/u);
  assert.throws(() => run([user("x")], { model: { provider: "x", id: "y", contextWindow: 1000, maxTokens: 10 } }), /context_model_window_invalid/u);
  assert.equal(governContext({ messages: [user("x")], systemPrompt: "", tools: [], activeToolNames: [], model: { provider: "x", id: "y", contextWindow: 5000, maxTokens: 9000 }, policy }).proof.status, CONTEXT_FIT_STATUS.BLOCKED);
});
