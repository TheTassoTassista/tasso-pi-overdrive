import test from "node:test";
import assert from "node:assert/strict";
import { buildProviderCapabilityRegistry, contextModelWithRegistryCap } from "../lib/provider-capability-registry.mjs";
import { normalizeOpenRouterCatalog } from "../lib/provider-catalog-snapshot.mjs";

const now = Date.parse("2026-09-24T12:00:00Z");
const snapshot = (observedAt = "2026-09-24T11:00:00Z") => normalizeOpenRouterCatalog({ fetchedAt: observedAt, data: [
  { id: "example/model", context_length: 64000, top_provider: { max_completion_tokens: 2048 }, supported_parameters: ["tools", "response_format"], architecture: { input_modalities: ["text", "image"] }, pricing: { prompt: "0.001", completion: "0.002" }, secret: "SHOULD_NEVER_APPEAR" },
  { id: "catalog/only", context_length: 128000, supported_parameters: [], architecture: { input_modalities: ["text"] } },
] }, now);

const callability = {
  version: 1, provider: "fixture", updatedAt: "2026-09-24T00:00:00Z", source: "test",
  entries: {
    "openai-codex/gpt-5.6-sol": { runtimeStatus: "RUNTIME_CALLABLE", reasonCode: "COMPLETED", evidenceRunId: "179bb6f7-414c-4529-baa2-709630b9bac9" },
    "omniroute/openrouter/example": { runtimeStatus: "RUNTIME_REJECTED", reasonCode: "UNSUPPORTED_MODEL" },
  },
};

test("registry combines local Pi, receipt callability and harness without making a model or catalog call", () => {
  const direct = { provider: "openai-codex", id: "gpt-5.6-sol", contextWindow: 200000, maxTokens: 4000, reasoning: true, input: ["text", "image"], supportsTools: true, cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 } };
  const gateway = { provider: "omniroute", id: "openrouter/example", contextWindow: 100000, maxTokens: 2048, reasoning: false, input: ["text"], cost: { input: 0, output: 0 } };
  const unknown = { provider: "unverified", id: "mystery", cost: { input: 0, output: 0 } };
  const registeredModels = [unknown, gateway, direct];
  const authenticatedModels = [direct, gateway];
  const before = JSON.stringify({ registeredModels, authenticatedModels, callability });
  const first = buildProviderCapabilityRegistry({ registeredModels, authenticatedModels, callability, now });
  const second = buildProviderCapabilityRegistry({ registeredModels, authenticatedModels, callability, now });
  assert.equal(first.digest, second.digest);
  assert.equal(JSON.stringify({ registeredModels, authenticatedModels, callability }), before);
  assert.deepEqual([first.decisionModelCalls, first.catalogFetches, first.routingMutations], [0, 0, 0]);
  assert.deepEqual(first.models.map((entry) => entry.identity), ["omniroute/openrouter/example", "openai-codex/gpt-5.6-sol", "unverified/mystery"]);
  const selected = first.models.find((entry) => entry.identity === "openai-codex/gpt-5.6-sol");
  assert.equal(selected.availability.selectable, true);
  assert.equal(selected.availability.runtime.state, "VERIFIED");
  assert.equal(selected.contextWindow.value, 200000);
  assert.equal(selected.reasoningModes.state, "DECLARED");
  assert.equal(selected.toolSupport.value, true);
  assert.equal(selected.vision.value, true);
  assert.equal(selected.structuredOutput.state, "DECLARED");
  assert.equal(selected.pricing.value.input, 1);
  const rejected = first.models.find((entry) => entry.provider === "omniroute");
  assert.equal(rejected.availability.selectable, false);
  assert.equal(rejected.availability.runtime.value, "RUNTIME_REJECTED");
  assert.equal(rejected.pricing.state, "UNKNOWN");
  assert.equal(rejected.rateLimit.state, "UNKNOWN");
  const missing = first.models.find((entry) => entry.provider === "unverified");
  assert.equal(missing.availability.selectable, false);
  assert.equal(missing.availability.runtime.state, "UNKNOWN");
  assert.equal(missing.contextWindow.state, "UNKNOWN");
  assert.equal(missing.toolSupport.state, "UNKNOWN");
  assert.equal(missing.vision.state, "UNKNOWN");
  assert.equal(missing.structuredOutput.state, "UNKNOWN");
  assert.equal(missing.pricing.state, "UNKNOWN");
});

test("duplicate and malformed Pi model identities are rejected before capability publication", () => {
  assert.throws(() => buildProviderCapabilityRegistry({ registeredModels: [{ provider: "p", id: "m" }, { provider: "p", id: "m" }], authenticatedModels: [], callability }), /identity_invalid/u);
  assert.throws(() => buildProviderCapabilityRegistry({ registeredModels: [{ provider: "p" }], authenticatedModels: [], callability }), /identity_invalid/u);
});

test("fresh catalog has field-level provenance but catalog-only models are not callable or free", () => {
  const catalogSnapshot = snapshot();
  const registry = buildProviderCapabilityRegistry({ registeredModels: [], authenticatedModels: [], callability, catalogSnapshot, now });
  assert.equal(registry.catalog.status, "FRESH");
  assert.equal(registry.models.length, 2);
  const known = registry.models.find((item) => item.identity.endsWith("example/model"));
  assert.equal(known.contextWindow.state, "CACHED");
  assert.equal(known.toolSupport.value, true);
  assert.equal(known.vision.value, true);
  assert.equal(known.structuredOutput.value, true);
  assert.equal(known.pricing.state, "UNKNOWN");
  assert.equal(known.zeroExtraCost, null);
  assert.equal(known.rateLimit.state, "UNKNOWN");
  assert.equal(known.availability.selectable, false);
  assert.equal(known.availability.registry, "REGISTRY_MISSING");
  assert.equal(registry.models.find((item) => item.identity.endsWith("catalog/only")).availability.selectable, false);
  assert.doesNotMatch(JSON.stringify(registry), /SHOULD_NEVER_APPEAR|secret|api.key/iu);
  assert.deepEqual([registry.decisionModelCalls, registry.catalogFetches, registry.routingMutations], [0, 0, 0]);
});

test("stale catalog remains stale; conflicting context chooses smaller cap and never expands the governor model", () => {
  const model = { provider: "omniroute", id: "openrouter/example/model", contextWindow: 128000, maxTokens: 4096, reasoning: false, input: ["text"], supportsTools: false };
  const registry = buildProviderCapabilityRegistry({ registeredModels: [model], authenticatedModels: [model], callability, catalogSnapshot: snapshot("2026-09-13T00:00:00Z"), now });
  assert.equal(registry.catalog.status, "STALE");
  const record = registry.models.find((item) => item.identity === "omniroute/openrouter/example/model");
  assert.equal(record.contextWindow.value, 64000);
  assert.equal(record.contextWindow.state, "STALE");
  assert.equal(record.maxOutputTokens.value, 2048);
  assert.equal(registry.conflicts.some((item) => item.identity === record.identity && item.field === "contextWindow"), true);
  assert.equal(registry.conflicts.some((item) => item.identity === record.identity && item.field === "toolSupport"), true);
  const cap = contextModelWithRegistryCap(model, record);
  assert.equal(cap.contextWindow, 64000);
  assert.equal(cap.maxTokens, 2048);
  assert.deepEqual(model, { provider: "omniroute", id: "openrouter/example/model", contextWindow: 128000, maxTokens: 4096, reasoning: false, input: ["text"], supportsTools: false });
  assert.throws(() => contextModelWithRegistryCap({ ...model, id: "wrong" }, record), /identity_invalid/u);
});

test("fresh verified evidence wins ordinary fields, while safety context always chooses the smaller trustworthy number", () => {
  const model = { provider: "openai-codex", id: "gpt-5.6-sol", contextWindow: 128000, maxTokens: 4096, supportsTools: false, cost: { input: 1, output: 2 } };
  const verifiedCapabilities = { "openai-codex/gpt-5.6-sol": {
    contextWindow: { value: 256000, source: "local-fixture", observedAt: "2026-09-24T11:00:00Z" },
    toolSupport: { value: true, source: "local-fixture", observedAt: "2026-09-24T11:00:00Z" },
    pricing: { value: { input: 3, output: 6, currency: "USD", unit: "PER_MILLION_TOKENS" }, source: "local-fixture", observedAt: "2026-09-24T11:00:00Z" },
  } };
  const registry = buildProviderCapabilityRegistry({ registeredModels: [model], authenticatedModels: [model], callability, verifiedCapabilities, now });
  const record = registry.models[0];
  assert.equal(record.contextWindow.value, 128000);
  assert.equal(record.toolSupport.value, true);
  assert.equal(record.toolSupport.state, "VERIFIED");
  assert.equal(record.pricing.value.input, 3);
  assert.equal(record.pricing.value.unit, "PER_MILLION_TOKENS");
  assert.equal(record.zeroExtraCost, false);
  assert.equal(registry.conflicts.length >= 2, true);
  assert.equal(contextModelWithRegistryCap(model, record).contextWindow, 128000);
});

test("stale callability is visible but not freshly verified and does not alter routing", () => {
  const model = { provider: "openai-codex", id: "gpt-5.6-sol", contextWindow: 128000, maxTokens: 4096 };
  const old = { ...callability, updatedAt: "2026-09-01T00:00:00Z" };
  const first = buildProviderCapabilityRegistry({ registeredModels: [model], authenticatedModels: [model], callability: old, now });
  const second = buildProviderCapabilityRegistry({ registeredModels: [model], authenticatedModels: [model], callability: old, now });
  assert.equal(first.models[0].availability.runtime.state, "STALE");
  assert.equal(first.models[0].availability.freshlyVerified, false);
  assert.equal(first.models[0].availability.selectable, second.models[0].availability.selectable);
  assert.equal(first.digest, second.digest);
});

test("malformed and secret-bearing catalog/verified evidence fail closed", () => {
  const base = snapshot();
  const malformed = { ...base, models: [{ ...base.models[0], secret: "LEAK" }] };
  assert.throws(() => buildProviderCapabilityRegistry({ registeredModels: [], authenticatedModels: [], callability, catalogSnapshot: malformed, now }), /digest_mismatch/u);
  const model = { provider: "p", id: "m", contextWindow: 128000 };
  assert.throws(() => buildProviderCapabilityRegistry({ registeredModels: [model], authenticatedModels: [], callability, now, verifiedCapabilities: { "p/m": { pricing: { value: { input: 1, output: 2, currency: "USD", unit: "PER_MILLION_TOKENS", secret: "LEAK" }, source: "fixture", observedAt: "2026-09-24T11:00:00Z" } } } }), /value_invalid/u);
  assert.throws(() => buildProviderCapabilityRegistry({ registeredModels: [model], authenticatedModels: [], callability, now, verifiedCapabilities: { "p/m": { vision: { value: true, source: "fixture secret", observedAt: "2026-09-24T11:00:00Z" } } } }), /evidence_invalid/u);
  assert.throws(() => buildProviderCapabilityRegistry({ registeredModels: [], authenticatedModels: [], callability, now: Date.parse("2026-09-01T00:00:00Z"), catalogSnapshot: base }), /age_invalid/u);
});

test("explicit unit-qualified positive catalog price cannot be represented as zero extra cost", () => {
  const catalogSnapshot = normalizeOpenRouterCatalog({ fetchedAt: "2026-09-24T11:00:00Z", data: [{ id: "example/paid", pricing: { prompt: "0.1", completion: "0.2", currency: "USD", unit: "PER_MILLION_TOKENS" } }] }, now);
  const record = buildProviderCapabilityRegistry({ registeredModels: [], authenticatedModels: [], callability, catalogSnapshot, now }).models[0];
  assert.equal(record.pricing.state, "CACHED");
  assert.equal(record.pricing.value.input, 0.1);
  assert.equal(record.zeroExtraCost, false);
});
