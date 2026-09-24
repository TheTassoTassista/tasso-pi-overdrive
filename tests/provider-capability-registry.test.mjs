import test from "node:test";
import assert from "node:assert/strict";
import { buildProviderCapabilityRegistry } from "../lib/provider-capability-registry.mjs";

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
  const first = buildProviderCapabilityRegistry({ registeredModels, authenticatedModels, callability });
  const second = buildProviderCapabilityRegistry({ registeredModels, authenticatedModels, callability });
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
