import test from "node:test";
import assert from "node:assert/strict";
import { OpenVikingAdapter, HindsightAdapter } from "../lib/memory-backends.mjs";
import { resolveMemoryPolicy } from "../lib/memory-policy.mjs";
import { SharedMemoryPackController } from "../lib/shared-memory-pack.mjs";

function json(value, ok = true, status = 200) { return { ok, status, async json() { return value; } }; }
const ovConfig = { endpoint: "http://127.0.0.1:1933", timeoutMs: 100, candidateLimit: 8, targetUri: "viking://~/resources" };
const hsConfig = { endpoint: "http://127.0.0.1:8889", timeoutMs: 100, writeTimeoutMs: 100, reflect: "explicit-only" };

test("OpenViking retrieval is L0-first and scoped", async () => {
  const calls = [];
  const adapter = new OpenVikingAdapter(ovConfig, { fetch: async (url, options) => { calls.push({ url, options }); return json({ status: "ok", result: { resources: [{ uri: "viking://~/resources/project/architecture.md", abstract: "Current project architecture", score: 0.9 }], memories: [] } }); } });
  const result = await adapter.retrieve({ query: "project architecture", level: 0 });
  assert.equal(result.status, "OK");
  assert.equal(result.items[0].level, 0);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/v1\/search\/find$/u);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.target_uri, "viking://~/resources");
  assert.equal(body.limit, 8);
});

test("secret-like query fragments are redacted before any backend request", async () => {
  const bodies = [];
  const fetch = async (_url, options) => { bodies.push(options.body); return json({ result: { resources: [], memories: [] }, results: [] }); };
  const secret = ["Bearer", "backend-secret-123"].join(" ");
  await new OpenVikingAdapter(ovConfig, { fetch }).retrieve({ query: `project architecture ${secret}` });
  await new HindsightAdapter(hsConfig, { fetch }).recall({ bankId: "pi-overdrive", query: `What happened before ${secret}?` });
  assert.equal(bodies.some((body) => String(body).includes("backend-secret-123")), false);
  assert.equal(bodies.every((body) => String(body).includes("[REDACTED]")), true);
});

test("OpenViking L1 escalation opens one exact overview", async () => {
  const calls = [];
  const adapter = new OpenVikingAdapter(ovConfig, { fetch: async (url) => { calls.push(url); return json({ result: { content: "Structured project overview" } }); } });
  const result = await adapter.retrieve({ query: "architecture", level: 1, selectedUri: "viking://~/resources/project" });
  assert.equal(result.items[0].level, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /content\/overview\?uri=/u);
});

test("OpenViking selected L2 opens exactly one resource and forbids broad L2", async () => {
  const calls = [];
  const adapter = new OpenVikingAdapter(ovConfig, { fetch: async (url) => { calls.push(url); return json({ result: { content: "Exact full resource" } }); } });
  const exact = await adapter.retrieve({ query: "exact source", level: 2, selectedUri: "viking://~/resources/project/file.md" });
  assert.equal(exact.items.length, 1);
  assert.equal(exact.items[0].level, 2);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /content\/read\?uri=/u);
  const broad = await adapter.retrieve({ query: "everything", level: 2 });
  assert.equal(broad.status, "DEGRADED");
  assert.equal(calls.length, 1);
});

test("OpenViking outage degrades without throwing", async () => {
  const adapter = new OpenVikingAdapter(ovConfig, { fetch: async () => { throw new Error("offline"); } });
  assert.equal((await adapter.health()).available, false);
  const result = await adapter.retrieve({ query: "project source" });
  assert.equal(result.status, "DEGRADED");
  assert.deepEqual(result.items, []);
});

test("Hindsight Recall uses the official project bank endpoint and bounded budget", async () => {
  const calls = [];
  const adapter = new HindsightAdapter(hsConfig, { fetch: async (url, options) => { calls.push({ url, options }); return json({ results: [{ id: "1", text: "The prior release failed because of a stale lock.", type: "experience", score: 0.8, document_id: "release-1" }] }); } });
  const result = await adapter.recall({ bankId: "pi-overdrive", query: "What happened before?", budget: "low", maxTokens: 500 });
  assert.equal(result.status, "OK");
  assert.equal(result.operation, "recall");
  assert.match(calls[0].url, /\/v1\/default\/banks\/pi-overdrive\/memories\/recall$/u);
  assert.equal(JSON.parse(calls[0].options.body).max_tokens, 500);
});

test("Hindsight retain is synchronous, temporal, tagged, and document-upsertable", async () => {
  const calls = [];
  const adapter = new HindsightAdapter(hsConfig, { fetch: async (url, options) => { calls.push({ url, options }); return json({ items_count: 1 }); } });
  const result = await adapter.retain({ bankId: "pi-overdrive", items: [{ content: "Il rilascio è riuscito.", context: "release", timestamp: "2026-09-13T10:00:00Z", documentId: "release-1", tags: ["project:pi-overdrive"] }] });
  assert.equal(result.status, "OK");
  assert.match(calls[0].url, /\/v1\/default\/banks\/pi-overdrive\/memories$/u);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.async, false);
  assert.equal(body.items[0].document_id, "release-1");
  assert.equal(body.items[0].timestamp, "2026-09-13T10:00:00.000Z");
});

test("durable backend writes reject secret-like payloads before HTTP", async () => {
  let calls = 0;
  const fetch = async () => { calls += 1; return json({}); };
  const hindsight = await new HindsightAdapter(hsConfig, { fetch }).retain({ bankId: "pi-overdrive", items: [{ content: "password=never-store-this", documentId: "secret" }] });
  const openViking = await new OpenVikingAdapter(ovConfig, { fetch }).publishResource({ uri: "viking://~/resources/secret/content.md", content: "Bearer never-store-this", l0: "safe", l1: "safe" });
  assert.equal(hindsight.reason, "secret_rejected");
  assert.equal(openViking.reason, "secret_rejected");
  assert.equal(calls, 0);
});

test("OpenViking publishing creates original L2 then deterministic L0/L1 sidecars", async () => {
  const calls = [];
  const adapter = new OpenVikingAdapter({ ...ovConfig, writeTimeoutMs: 100 }, { fetch: async (_url, options) => { calls.push(JSON.parse(options.body)); return json({ status: "ok", result: {} }); } });
  const result = await adapter.publishResource({ uri: "viking://~/resources/fixture/content.md", content: "Original full content.", l0: "Short abstract.", l1: "Detailed overview.", tags: ["project=fixture"] });
  assert.equal(result.status, "OK");
  assert.deepEqual(calls.map((call) => call.uri), ["viking://~/resources/fixture/content.md", "viking://~/resources/fixture/.abstract.md", "viking://~/resources/fixture/.overview.md"]);
  assert.equal(calls[0].processing_mode, "semantic_and_vectors");
  assert.equal(calls[1].processing_mode, "vectors_only");
});

test("Hindsight Reflect is never default and requires explicit authorization", async () => {
  let calls = 0;
  const adapter = new HindsightAdapter(hsConfig, { fetch: async () => { calls += 1; return json({ text: "synthesis" }); } });
  const suppressed = await adapter.reflect({ bankId: "pi-overdrive", query: "Synthesize history" });
  assert.equal(suppressed.status, "SUPPRESSED");
  assert.equal(calls, 0);
  const allowed = await adapter.reflect({ bankId: "pi-overdrive", query: "Synthesize history", explicitlyAuthorized: true });
  assert.equal(allowed.status, "OK");
  assert.equal(calls, 1);
});

test("history queries trigger Recall while ordinary exact edits do not", async () => {
  let recallCalls = 0;
  const controller = new SharedMemoryPackController({
    projectId: "pi-overdrive",
    policy: resolveMemoryPolicy({ preset: "normal", qualityRequested: "medium" }),
    hindsight: { async recall() { recallCalls += 1; return { backend: "hindsight", operation: "recall", status: "OK", items: [], candidateCount: 0 }; } },
  });
  await controller.build("Why did this fail before?");
  await controller.build("Change src/a.ts line 4");
  assert.equal(recallCalls, 1);
});

test("Token Saver uses cheap Recall but suppresses automatic Reflect", async () => {
  let recalls = 0;
  let reflects = 0;
  const controller = new SharedMemoryPackController({
    projectId: "pi-overdrive",
    policy: resolveMemoryPolicy({ preset: "token-saver", qualityRequested: "low" }),
    hindsight: {
      async recall() { recalls += 1; return { backend: "hindsight", operation: "recall", status: "OK", items: [], candidateCount: 0 }; },
      async reflect() { reflects += 1; return { backend: "hindsight", operation: "reflect", status: "OK", items: [], candidateCount: 0 }; },
    },
  });
  await controller.build("Synthesize the recurring pattern across multiple historical failures", { reflectExplicit: true });
  assert.equal(recalls, 1);
  assert.equal(reflects, 0);
});

test("one task-scoped pack is cached and reused without duplicate backend calls", async () => {
  let calls = 0;
  const controller = new SharedMemoryPackController({
    projectId: "pi-overdrive",
    policy: resolveMemoryPolicy({ preset: "normal", qualityRequested: "medium" }),
    openViking: { async retrieve() { calls += 1; return { backend: "openviking", status: "OK", candidateCount: 1, items: [{ id: "ov-1", type: "resource", project: "pi-overdrive", content: "Verified architecture resource", source: "viking://project/architecture", trustLevel: "PROJECT_DOC", confidence: 0.9, verified: true, current: true, level: 0, backend: "openviking", score: 1 }] }; } },
  });
  const first = await controller.build("project architecture");
  const second = await controller.build("project architecture");
  assert.strictEqual(first, second);
  assert.equal(calls, 1);
  assert.equal(Object.isFrozen(first), true);
});

test("Shared Memory Pack identity changes when retrieved evidence changes", async () => {
  const make = (content) => new SharedMemoryPackController({
    projectId: "pi-overdrive",
    policy: resolveMemoryPolicy(),
    openViking: { async retrieve() { return { backend: "openviking", status: "OK", candidateCount: 1, items: [{ id: "ov-1", type: "resource", project: "pi-overdrive", content, source: "viking://project/architecture", trustLevel: "PROJECT_DOC", confidence: 0.9, verified: false, current: true, level: 0, backend: "openviking", score: 1 }] }; } },
  });
  const first = await make("First architecture evidence").build("project architecture");
  const second = await make("Changed architecture evidence").build("project architecture");
  assert.notEqual(first.id, second.id);
});

test("Shared Memory Pack is bounded, provenance-bearing, and trust-delimited", async () => {
  const items = Array.from({ length: 30 }, (_, index) => ({ id: `ov-${index}`, type: "resource", project: "pi-overdrive", content: `Architecture fact ${index} ${"x".repeat(180)}`, source: `viking://project/${index}`, trustLevel: "PROJECT_DOC", confidence: 0.8, verified: false, current: true, level: 0, backend: "openviking", score: 30 - index }));
  const policy = resolveMemoryPolicy({ preset: "token-saver", qualityRequested: "low" });
  const controller = new SharedMemoryPackController({ projectId: "pi-overdrive", policy, openViking: { async retrieve() { return { backend: "openviking", status: "OK", candidateCount: items.length, items }; } } });
  const pack = await controller.build("project architecture");
  assert.ok(pack.text.length <= policy.packCharLimit);
  assert.match(pack.text, /UNTRUSTED DATA|source/u);
  assert.ok(pack.items.length < items.length);
  assert.equal(pack.metadata.approximateTokens, Math.ceil(pack.text.length / 4));
});

test("role-targeted retrieval can open one additional exact resource", async () => {
  const calls = [];
  const controller = new SharedMemoryPackController({
    projectId: "pi-overdrive",
    policy: resolveMemoryPolicy(),
    openViking: { async retrieve(input) { calls.push(input); return { backend: "openviking", status: "OK", items: [], candidateCount: 0, level: input.level }; } },
  });
  await controller.targeted("exact detail", { source: "openviking", selectedUri: "viking://~/resources/exact.md", detailLevel: 2 });
  assert.deepEqual(calls, [{ query: "exact detail", level: 2, selectedUri: "viking://~/resources/exact.md", limit: 1 }]);
});

test("targeted Reflect is still fail-closed under a policy that suppresses it", async () => {
  let calls = 0;
  const controller = new SharedMemoryPackController({
    projectId: "pi-overdrive",
    policy: resolveMemoryPolicy({ preset: "token-saver", qualityRequested: "medium" }),
    hindsight: { async reflect() { calls += 1; return { backend: "hindsight", operation: "reflect", status: "OK", items: [], candidateCount: 0 }; } },
  });
  const result = await controller.targeted("Synthesize history", { source: "hindsight", reflectExplicit: true });
  assert.equal(result.status, "SUPPRESSED");
  assert.equal(calls, 0);
});

test("backend observability emits metadata values without retrieved content", async () => {
  const events = [];
  const secretContent = "Architecture payload must never enter metadata.";
  const controller = new SharedMemoryPackController({
    projectId: "pi-overdrive",
    policy: resolveMemoryPolicy(),
    emit: (event) => events.push(event),
    openViking: { async retrieve() { return { backend: "openviking", status: "OK", level: 0, latencyMs: 7, candidateCount: 1, items: [{ id: "ov-1", type: "resource", project: "pi-overdrive", content: secretContent, source: "viking://project/architecture", trustLevel: "PROJECT_DOC", confidence: 0.9, verified: false, current: true, level: 0, backend: "openviking", score: 1 }] }; } },
  });
  await controller.build("project architecture");
  const backend = events.find((event) => event.kind === "memory_backend_result");
  assert.deepEqual({ backend: backend.backend, status: backend.status, level: backend.retrievalLevel, candidates: backend.retrievedCandidateCount, items: backend.retrievedItemCount, latency: backend.latencyMs }, { backend: "openviking", status: "OK", level: 0, candidates: 1, items: 1, latency: 7 });
  assert.equal(JSON.stringify(events).includes(secretContent), false);
});

test("all unavailable backends yield an honest degraded empty pack", async () => {
  const controller = new SharedMemoryPackController({
    projectId: "pi-overdrive",
    policy: resolveMemoryPolicy(),
    ledger: { search() { throw new Error("down"); } },
    openViking: { async retrieve() { return { backend: "openviking", status: "DEGRADED", items: [], candidateCount: 0, reason: "unavailable" }; } },
  });
  const pack = await controller.build("project architecture");
  assert.equal(pack.metadata.status, "DEGRADED");
  assert.equal(pack.metadata.itemCount, 0);
  assert.equal(pack.text, "");
});
