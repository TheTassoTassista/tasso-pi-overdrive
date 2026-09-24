#!/usr/bin/env node
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { buildProviderCapabilityRegistry } from "../../lib/provider-capability-registry.mjs";
import { normalizeOpenRouterCatalog } from "../../lib/provider-catalog-snapshot.mjs";

const now = Date.parse("2026-09-24T12:00:00Z");
const registeredModels = [
  { provider: "openai-codex", id: "known", contextWindow: 128000, maxTokens: 8192, reasoning: true, input: ["text", "image"], supportsTools: true, cost: { input: 1, output: 2 } },
  { provider: "omniroute", id: "openrouter/example/partial", contextWindow: 128000, maxTokens: 4096, reasoning: false, input: ["text"], cost: { input: 0, output: 0 } },
  { provider: "unknown", id: "opaque" },
];
const callability = { version: 1, provider: "fixture", updatedAt: "2026-09-24T11:00:00Z", source: "test", entries: {
  "openai-codex/known": { runtimeStatus: "RUNTIME_CALLABLE", reasonCode: "COMPLETED", evidenceRunId: "179bb6f7-414c-4529-baa2-709630b9bac9" },
} };
const catalogSnapshot = normalizeOpenRouterCatalog({ fetchedAt: "2026-09-13T00:00:00Z", data: [
  { id: "example/partial", context_length: 64000, top_provider: { max_completion_tokens: 2048 }, supported_parameters: ["tools"] },
  { id: "example/catalog-only", context_length: 32000 },
] }, now);
const input = { registeredModels, authenticatedModels: registeredModels.slice(0, 2), callability, catalogSnapshot, now };
const original = JSON.stringify(input);
const runs = 1000;
const started = performance.now();
let result;
for (let index = 0; index < runs; index += 1) result = buildProviderCapabilityRegistry(input);
const elapsedMs = performance.now() - started;
assert.equal(JSON.stringify(input), original);
assert.equal(result.models.length, 4);
assert.equal(result.catalog.status, "STALE");
assert.equal(result.models.find((item) => item.identity === "omniroute/openrouter/example/partial").contextWindow.value, 64000);
assert.equal(result.models.find((item) => item.identity === "omniroute/openrouter/example/catalog-only").availability.selectable, false);
assert.equal(result.models.find((item) => item.identity === "openai-codex/known").pricing.value.input > 0, true);
assert.equal(result.models.find((item) => item.identity === "unknown/opaque").pricing.state, "UNKNOWN");
assert.deepEqual([result.decisionModelCalls, result.catalogFetches, result.routingMutations], [0, 0, 0]);
const unknownFields = result.models.reduce((count, item) => count + ["contextWindow", "maxOutputTokens", "reasoningModes", "toolSupport", "vision", "structuredOutput", "pricing", "rateLimit"].filter((field) => item[field].state === "UNKNOWN").length, 0);
console.log(JSON.stringify({ status: "PASS", kind: "local-metadata-resolution-only", runs, models: result.models.length, candidates: registeredModels.length + catalogSnapshot.models.length, conflicts: result.conflicts.length, unknownFields, freshCallability: result.models.filter((item) => item.availability.runtime.state === "VERIFIED").length, staleCatalogModels: catalogSnapshot.models.length, elapsedMs: Number(elapsedMs.toFixed(3)), meanMs: Number((elapsedMs / runs).toFixed(4)), externalCalls: 0, paidModelCalls: 0, routingMutations: result.routingMutations, digest: result.digest }));
