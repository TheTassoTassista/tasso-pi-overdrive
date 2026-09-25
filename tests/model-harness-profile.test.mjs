import test from "node:test";
import assert from "node:assert/strict";
import { contextModelForProfile, constrainToolsForModelProfile, EVIDENCE_LEVELS, modelHarnessProfileMetadata, resolveEditContract, resolveModelHarnessProfile, validateModelHarnessProfileConfig } from "../lib/model-harness-profile.mjs";
import { resolveEditBenchmarkPreference } from "../lib/edit-benchmark-evidence.mjs";

const model = { provider: "openai-codex", id: "gpt-5.6-terra", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" }, contextWindow: 278528, maxTokens: 131072 };
const callability = { version: 1, entries: { "openai-codex/gpt-5.6-terra": { runtimeStatus: "RUNTIME_CALLABLE", reasonCode: "FIXTURE", evidenceRunId: "0789657a-a21f-4614-8919-ad88089050b8" } } };
const profile = () => resolveModelHarnessProfile({ model, registeredModels: [model], authenticatedModels: [model], callability });

test("evidence vocabulary is explicit and closed", () => assert.deepEqual(EVIDENCE_LEVELS, ["DECLARED", "VERIFIED", "BENCHMARKED", "INFERRED", "UNKNOWN"]));
test("provider profile resolves after model selection without routing output", () => {
  const value = profile();
  assert.equal(value.match.identity, "openai-codex/gpt-5.6-terra");
  assert.equal(value.id, "openai-codex-native-v1");
  assert.equal(value.capabilities.runtimeCallability.level, "VERIFIED");
  assert.equal("route" in value, false);
  assert.equal(value.decisionModelCalls, 0);
});
test("family then provider then exact precedence is deterministic and inspectable", () => {
  const config = { version: 1, generic: { id: "generic", toolConstraints: { deniedTools: ["write"] }, editContracts: { ordinary: ["REPLACE"], structural: ["AST_STRUCTURAL"], maxFallbacks: 1 } }, families: { OpenAI: { id: "family" } }, providers: { "openai-codex": { id: "provider", toolConstraints: { deniedTools: ["edit"] } } }, models: { "openai-codex/gpt-5.6-terra": { id: "exact", toolConstraints: { deniedTools: [] } } } };
  const first = resolveModelHarnessProfile({ config, model, registeredModels: [model], authenticatedModels: [model], callability });
  const second = resolveModelHarnessProfile({ config, model, registeredModels: [model], authenticatedModels: [model], callability });
  assert.equal(first.id, "exact");
  assert.deepEqual(first.provenance.map((entry) => entry.scope), ["generic", "family", "provider", "model"]);
  assert.equal(first.digest, second.digest);
});
test("unknown models fail soft to the generic safe profile", () => {
  const unknown = { provider: "fixture", id: "unknown", contextWindow: 8192, maxTokens: 1024 };
  const value = resolveModelHarnessProfile({ model: unknown, registeredModels: [unknown], authenticatedModels: [unknown], callability: { version: 1, entries: {} } });
  assert.equal(value.id, "generic-safe-v1");
  assert.equal(value.match.known, false);
  assert.equal(value.capabilities.runtimeCallability.level, "UNKNOWN");
  assert.ok(value.toolConstraints.deniedTools.includes("write"));
});
test("missing context and reasoning evidence stays UNKNOWN rather than guessed", () => {
  const value = resolveModelHarnessProfile({ identity: "fixture/missing", provider: "fixture", callability: { version: 1, entries: {} } });
  assert.equal(value.capabilities.contextWindow.level, "UNKNOWN");
  assert.equal(value.capabilities.maxOutputTokens.level, "UNKNOWN");
  assert.equal(value.capabilities.reasoningLevels.level, "UNKNOWN");
});
test("ordinary edits select hash-anchored then at most one replacement fallback", () => {
  assert.deepEqual(resolveEditContract(profile(), { activeTools: ["transactional_edit", "edit", "write"] }), { mode: "ordinary", selected: "HASH_ANCHORED", fallback: "REPLACE", maxFallbacks: 1, activeTools: ["transactional_edit", "edit"] });
});
test("structural edits select transactional AST then one hash-anchored fallback", () => {
  assert.deepEqual(resolveEditContract(profile(), { activeTools: ["transactional_ast_edit", "transactional_edit", "edit"], structural: true }), { mode: "structural", selected: "AST_STRUCTURAL", fallback: "HASH_ANCHORED", maxFallbacks: 1, activeTools: ["transactional_ast_edit", "transactional_edit"] });
});
test("unsupported edit contracts are never invented", () => {
  const result = resolveEditContract(profile(), { activeTools: ["read", "write"] });
  assert.equal(result.selected, null);
  assert.deepEqual(result.activeTools, []);
});
test("profile constraints can only subtract tools", () => {
  const active = ["read", "transactional_edit", "edit", "write"];
  const result = constrainToolsForModelProfile(active, profile());
  assert.ok(result.activeTools.every((entry) => active.includes(entry)));
  assert.deepEqual(result.activeTools, ["read", "transactional_edit", "edit"]);
});
test("generic safe profile removes mutation and high-risk tools", () => {
  const unknown = { provider: "fixture", id: "unknown", contextWindow: 8192, maxTokens: 1024 };
  const value = resolveModelHarnessProfile({ model: unknown, registeredModels: [unknown], authenticatedModels: [unknown], callability: { version: 1, entries: {} } });
  const result = constrainToolsForModelProfile(["read", "write", "agent_browser", "safe_exec"], value);
  assert.deepEqual(result.activeTools, ["read"]);
});
test("context governor input only narrows authoritative numeric metadata", () => {
  assert.deepEqual(contextModelForProfile(model, profile()), model);
});
test("metadata excludes prompts, contents, credentials, and raw evidence", () => {
  const value = profile();
  const selected = constrainToolsForModelProfile(["read", "transactional_edit"], value);
  const metadata = JSON.stringify(modelHarnessProfileMetadata(value, selected));
  for (const marker of ["prompt", "content", "credential", "evidenceRunId"]) assert.equal(metadata.includes(marker), false, marker);
});
test("malformed config and unbounded fallback fail closed", () => {
  assert.throws(() => validateModelHarnessProfileConfig({ version: 1 }), /model_profile_config_invalid/u);
  assert.throws(() => validateModelHarnessProfileConfig({ version: 1, generic: { id: "x", toolConstraints: { deniedTools: [] }, editContracts: { ordinary: ["REPLACE"], structural: ["AST_STRUCTURAL"], maxFallbacks: 2 } }, families: {}, providers: {}, models: {} }), /model_profile_edit_invalid/u);
});
test("profile provenance names only stable configuration sources", () => {
  assert.ok(profile().provenance.every((entry) => entry.source === "config/model-harness-profiles.json"));
});
test("native tool support is declared, not promoted to verified", () => {
  assert.equal(profile().capabilities.nativeTools.level, "DECLARED");
});
test("structured output support names the actual harness contract", () => {
  assert.equal(profile().capabilities.structuredOutput.source, "native-json-schema-v1");
});
test("runtime rejected evidence remains UNKNOWN for compatibility", () => {
  const rejected = { version: 1, entries: { "openai-codex/gpt-5.6-terra": { runtimeStatus: "RUNTIME_REJECTED", reasonCode: "REJECTED", evidenceRunId: "0789657a-a21f-4614-8919-ad88089050b8" } } };
  assert.equal(resolveModelHarnessProfile({ model, registeredModels: [model], authenticatedModels: [model], callability: rejected }).capabilities.runtimeCallability.level, "UNKNOWN");
});
test("a registry declaration does not fabricate authenticated callability", () => {
  const value = resolveModelHarnessProfile({ model, registeredModels: [model], authenticatedModels: [], callability });
  assert.equal(value.dynamicEvidence.authenticationStatus, "AUTH_MISSING");
  assert.equal(value.dynamicEvidence.runtimeStatus, "RUNTIME_CALLABLE");
});
test("apply-patch is selected only when both configured and actually exposed", () => {
  const config = { version: 1, generic: { id: "patch", toolConstraints: { deniedTools: [] }, editContracts: { ordinary: ["APPLY_PATCH", "HASH_ANCHORED"], structural: ["AST_STRUCTURAL"], maxFallbacks: 1 } }, families: {}, providers: {}, models: {} };
  const unknown = { provider: "fixture", id: "patch", contextWindow: 8192, maxTokens: 1024 };
  const value = resolveModelHarnessProfile({ config, model: unknown, registeredModels: [unknown], authenticatedModels: [unknown], callability: { version: 1, entries: {} } });
  assert.equal(resolveEditContract(value, { activeTools: ["transactional_edit"] }).selected, "HASH_ANCHORED");
  assert.equal(resolveEditContract(value, { activeTools: ["apply_patch", "transactional_edit"] }).selected, "APPLY_PATCH");
});
test("model profile metadata is deterministic", () => {
  const value = profile();
  assert.deepEqual(modelHarnessProfileMetadata(value), modelHarnessProfileMetadata(value));
});
test("tampered profile digests cannot drive edit selection", () => {
  const forged = structuredClone(profile());
  forged.id = "forged";
  assert.throws(() => resolveEditContract(forged, { activeTools: ["edit"] }), /model_profile_invalid/u);
});
test("profile context cannot increase a model limit", () => {
  const value = structuredClone(profile());
  value.capabilities.contextWindow.value = 999999;
  value.capabilities.maxOutputTokens.value = 999999;
  assert.equal(contextModelForProfile(model, value).contextWindow, model.contextWindow);
  assert.equal(contextModelForProfile(model, value).maxTokens, model.maxTokens);
});

test("GPT-6 models use the safe OpenAI family/provider profile without invented exact-model edit preference", () => {
  for (const id of ["gpt-6-luna", "gpt-6-sol", "gpt-6-astra"]) {
    const next = { ...model, id };
    const value = resolveModelHarnessProfile({ model: next, registeredModels: [next], authenticatedModels: [next], callability: { version: 1, entries: {} } });
    assert.equal(value.match.known, true);
    assert.equal(value.provenance.some((entry) => entry.scope === "model"), false);
    assert.equal(value.dynamicEvidence.runtimeStatus, "RUNTIME_UNKNOWN");
    assert.equal(resolveEditContract(value, { activeTools: ["transactional_edit", "edit"] }).selected, "HASH_ANCHORED");
  }
});

const benchmarkNow = Date.parse("2026-09-24T12:00:00.000Z");
const benchmarkRecord = {
  scope: "family", key: "OpenAI", mode: "ordinary", fixtureCount: 20, costBasis: "SUBSCRIPTION_BACKED",
  sourceDigest: "a".repeat(64), measuredAt: "2026-09-23T12:00:00.000Z",
  results: [
    { contract: "HASH_ANCHORED", attempts: 20, exactSuccesses: 15, formatFailures: 2, retries: 4, unsafeOutcomes: 0, modelCalls: 24, inputTokens: 1000, outputTokens: 500 },
    { contract: "REPLACE", attempts: 20, exactSuccesses: 18, formatFailures: 1, retries: 3, unsafeOutcomes: 0, modelCalls: 23, inputTokens: 1000, outputTokens: 500 },
  ],
};

test("qualified comparative family evidence can reorder only configured, active edit contracts", () => {
  const value = resolveModelHarnessProfile({ model, registeredModels: [model], authenticatedModels: [model], callability, editBenchmarkEvidence: { version: 1, records: [benchmarkRecord] }, now: benchmarkNow });
  assert.equal(value.editBenchmark.ordinary.level, "BENCHMARKED");
  assert.deepEqual(resolveEditContract(value, { activeTools: ["transactional_edit", "edit"] }).selected, "REPLACE");
  assert.deepEqual(resolveEditContract(value, { activeTools: ["transactional_edit"] }).selected, "HASH_ANCHORED");
  assert.deepEqual(resolveEditContract(value, { activeTools: ["transactional_ast_edit", "transactional_edit"], structural: true }).selected, "AST_STRUCTURAL");
  assert.deepEqual(constrainToolsForModelProfile(["read", "transactional_edit"], value).activeTools, ["read", "transactional_edit"]);
  assert.equal("route" in value, false);
});

test("single-sample, stale, unsafe, malformed and inconclusive evidence cannot alter a profile", () => {
  const variants = [
    { ...benchmarkRecord, results: benchmarkRecord.results.map((entry) => ({ ...entry, attempts: 1, modelCalls: 1 })) },
    { ...benchmarkRecord, measuredAt: "2026-01-01T12:00:00.000Z" },
    { ...benchmarkRecord, results: [{ ...benchmarkRecord.results[0], unsafeOutcomes: 1 }, benchmarkRecord.results[1]] },
    { ...benchmarkRecord, sourceDigest: "not-a-digest" },
    { ...benchmarkRecord, results: [{ ...benchmarkRecord.results[0], exactSuccesses: 17 }, benchmarkRecord.results[1]] },
  ];
  for (const record of variants) {
    const evidence = { version: 1, records: [record] };
    assert.equal(resolveEditBenchmarkPreference({ evidence, scope: "family", key: "OpenAI", mode: "ordinary", candidates: ["HASH_ANCHORED", "REPLACE"], now: benchmarkNow }).level, "UNKNOWN");
    const value = resolveModelHarnessProfile({ model, registeredModels: [model], authenticatedModels: [model], callability, editBenchmarkEvidence: evidence, now: benchmarkNow });
    assert.equal(resolveEditContract(value, { activeTools: ["transactional_edit", "edit"] }).selected, "HASH_ANCHORED");
  }
});
