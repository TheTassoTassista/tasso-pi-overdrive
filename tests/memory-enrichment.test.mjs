import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryEnrichmentCache, deterministicMemoryEnrichment } from "../lib/memory-enrichment-cache.mjs";
import { readMemoryModelPolicy, routeMemoryEnrichment } from "../lib/memory-model-router.mjs";

test("deterministic L0/L1 enrichment is bounded, multilingual, and secret rejecting", () => {
  const result = deterministicMemoryEnrichment({ sourceId: "fixture-it-en", content: "Decisione italiana verificata. English verified decision. Additional durable details." });
  assert.ok(result.l0.length <= 256);
  assert.ok(result.l1.length <= 1400);
  assert.match(result.l1, /Decisione italiana.*English verified/u);
  assert.throws(() => deterministicMemoryEnrichment({ sourceId: "secret", content: "password=do-not-store" }), /secret/u);
});

test("enrichment cache reuses identical hashes and supersedes changed content", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-enrichment-"));
  try {
    const cache = new MemoryEnrichmentCache(root, { clock: () => new Date("2026-09-13T12:00:00Z") });
    assert.equal(cache.put({ sourceId: "architecture", content: "First current fact." }).status, "STORED");
    const reused = cache.put({ sourceId: "architecture", content: "First current fact." });
    assert.equal(reused.status, "REUSED");
    assert.equal(cache.needsPublication(reused.entry, "openviking"), true);
    const published = cache.markPublished(reused.entry.sourceId, reused.entry.sourceHash, "openviking");
    assert.equal(cache.needsPublication(published, "openviking"), false);
    assert.equal(cache.put({ sourceId: "architecture", content: "Changed current fact." }).status, "STORED");
    const state = JSON.parse(fs.readFileSync(path.join(root, "enrichment-cache.json"), "utf8"));
    assert.equal(state.entries.length, 2);
    assert.equal(state.entries.filter((entry) => entry.current).length, 1);
    assert.equal(state.entries.filter((entry) => entry.superseded).length, 1);
    assert.equal(fs.statSync(path.join(root, "enrichment-cache.json")).mode & 0o077, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("memory model router is single-route, fail-closed, and isolated from Council", () => {
  const policy = readMemoryModelPolicy();
  assert.equal(policy.fanout, false);
  assert.equal(policy.maxRemoteCallsPerOperation, 1);
  assert.doesNotMatch(JSON.stringify(policy), /council/iu);
  assert.equal(routeMemoryEnrichment({ localAvailable: true }).tier, "LOCAL");
  assert.equal(routeMemoryEnrichment({ localAvailable: false, allowRemote: true }).tier, "UNAVAILABLE");
  const callable = { "omniroute/groq/qwen/qwen3-32b": "RUNTIME_CALLABLE" };
  assert.deepEqual(routeMemoryEnrichment({ localAvailable: false, allowRemote: true, remoteRuntime: callable }), { tier: "REMOTE_FREE", source: "omniroute/groq/qwen/qwen3-32b", remoteCalls: 1 });
  assert.equal(routeMemoryEnrichment({ localAvailable: false, allowSubscription: true, importance: "normal" }).tier, "UNAVAILABLE");
  assert.equal(routeMemoryEnrichment({ localAvailable: false, allowSubscription: true, importance: "durable-critical" }).tier, "SUBSCRIPTION_LAST_RESORT");
});
