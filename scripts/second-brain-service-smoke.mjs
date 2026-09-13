#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryEnrichmentCache } from "../lib/memory-enrichment-cache.mjs";
import { readSecondBrainConfig } from "../lib/memory-config.mjs";
import { HindsightAdapter, OpenVikingAdapter } from "../lib/memory-backends.mjs";
import { routeMemoryEnrichment } from "../lib/memory-model-router.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = readSecondBrainConfig();
const results = [];
const check = (name, condition, detail = undefined) => {
  results.push({ name, status: condition ? "PASS" : "FAIL", ...(detail === undefined ? {} : { detail }) });
  if (!condition) throw new Error(name);
};

async function json(url, options = {}, timeoutMs = 60_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`http_${response.status}`);
    return body;
  } finally { clearTimeout(timer); }
}

function cosine(left, right) {
  let dot = 0; let aa = 0; let bb = 0;
  for (let index = 0; index < left.length; index += 1) { dot += left[index] * right[index]; aa += left[index] ** 2; bb += right[index] ** 2; }
  return dot / Math.sqrt(aa * bb);
}

const fixtureId = "pi-overdrive-service-smoke-v1";
const fixtureUri = `viking://~/resources/${fixtureId}/content.md`;
const fixtureDirectory = `viking://~/resources/${fixtureId}`;
const l2 = "Decisione verificata: Pi Overdrive conserva la memoria durevole in servizi locali su CPU. Verified decision: Pi Overdrive keeps durable memory in local CPU services. Il collaudo temporale è datato 13 settembre 2026.";
const reusedL0 = "Memoria durevole Pi Overdrive locale su CPU; local CPU durable memory.";
const reusedL1 = "Pi Overdrive usa embedding multilingue locali per italiano e inglese. OpenViking conserva L0, L1 e l'originale L2; Hindsight conserva eventi temporali. No paid model is used by this fixture.";
const headers = { "content-type": "application/json" };

try {
  const health = await json(`${config.localEmbeddings.endpoint}/health`, {}, 5_000);
  check("local-embedding-health-cpu-multilingual", health.status === "ok" && health.model === config.localEmbeddings.model && health.dimensions === 384 && health.device === "cpu", health);
  const texts = ["memoria durevole locale", "local durable memory", "ricetta di cucina distante"];
  const embedded = await json(`${config.localEmbeddings.endpoint}/v1/embeddings`, { method: "POST", headers, body: JSON.stringify({ model: config.localEmbeddings.model, input: texts, encoding_format: "float", dimensions: 384 }) });
  const vectors = embedded.data.map((entry) => entry.embedding);
  check("local-embedding-it-en-384", vectors.length === 3 && vectors.every((vector) => vector.length === 384) && cosine(vectors[0], vectors[1]) > cosine(vectors[0], vectors[2]), { dimensions: vectors.map((vector) => vector.length), related: cosine(vectors[0], vectors[1]), unrelated: cosine(vectors[0], vectors[2]) });

  const events = [];
  const cache = new MemoryEnrichmentCache(path.join(config.root, "enrichment"), { emit: (event) => events.push(event) });
  const enrichment = cache.put({ sourceId: fixtureId, content: l2, reusedL0, reusedL1 });
  check("durable-enrichment-cache-provenance", ["STORED", "REUSED"].includes(enrichment.status) && enrichment.entry.provenance === "task-output:reuse" && events.every((event) => !JSON.stringify(event).includes(l2)), { status: enrichment.status, provenance: enrichment.entry.provenance, metadataOnly: true });
  check("memory-model-router-prefers-local-zero-call", routeMemoryEnrichment({ localAvailable: true }).tier === "LOCAL", { modelCalls: 0, remoteCalls: 0 });

  const openViking = new OpenVikingAdapter(config.openViking);
  check("openviking-health", (await openViking.health()).available === true);
  const existingL2 = await openViking.retrieve({ query: "existing", level: 2, selectedUri: fixtureUri });
  if (enrichment.status === "STORED" || existingL2.items[0]?.content !== l2) {
    const published = await openViking.publishResource({ uri: fixtureUri, content: l2, l0: enrichment.entry.l0, l1: enrichment.entry.l1, tags: ["project=pi-overdrive", "fixture=second-brain"] });
    check("openviking-real-index-l0-l1-l2", published.status === "OK", published);
  } else {
    check("openviking-duplicate-write-prevented", true, { cacheStatus: enrichment.status, writes: 0 });
  }
  const itSearch = await openViking.retrieve({ query: "memoria durevole locale CPU", level: 0, limit: 8 });
  const enSearch = await openViking.retrieve({ query: "local CPU durable memory", level: 0, limit: 8 });
  check("openviking-semantic-search-italian", itSearch.status === "OK" && itSearch.items.some((item) => item.source.includes(fixtureId)), { candidates: itSearch.candidateCount });
  check("openviking-semantic-search-english", enSearch.status === "OK" && enSearch.items.some((item) => item.source.includes(fixtureId)), { candidates: enSearch.candidateCount });
  const abstractRaw = await json(`${config.openViking.endpoint}/api/v1/content/abstract?uri=${encodeURIComponent(fixtureDirectory)}`);
  const l1Result = await openViking.retrieve({ query: "overview", level: 1, selectedUri: fixtureDirectory });
  const l2Result = await openViking.retrieve({ query: "original", level: 2, selectedUri: fixtureUri });
  const abstract = abstractRaw?.result?.content ?? abstractRaw?.result ?? abstractRaw?.content;
  check("openviking-exact-l0", typeof abstract === "string" && abstract.includes("Memoria durevole"));
  check("openviking-exact-l1", l1Result.status === "OK" && l1Result.items[0]?.content.includes("embedding multilingue"));
  check("openviking-exact-l2-original", l2Result.status === "OK" && l2Result.items[0]?.content === l2);

  const hindsight = new HindsightAdapter(config.hindsight);
  check("hindsight-health", (await hindsight.health()).available === true);
  const bankId = "pi-overdrive-service-smoke";
  const retained = await hindsight.retain({ bankId, items: [
    { content: "Il 10 settembre 2026 la squadra ha scelto embedding locali CPU.", context: "decisione architetturale", timestamp: "2026-09-10T10:00:00Z", documentId: `${fixtureId}-it`, tags: ["project:pi-overdrive"] },
    { content: "On 12 September 2026 the final local memory validation passed.", context: "architecture decision", timestamp: "2026-09-12T10:00:00Z", documentId: `${fixtureId}-en`, tags: ["project:pi-overdrive"] }
  ] });
  check("hindsight-real-retain-temporal-it-en", retained.status === "OK" && retained.retained >= 2, retained);
  const recallIt = await hindsight.recall({ bankId, query: "Quando sono stati scelti gli embedding locali CPU?", budget: "low", maxTokens: 500, tags: ["project:pi-overdrive"] });
  const recallEn = await hindsight.recall({ bankId, query: "What local memory validation passed on 12 September 2026?", budget: "low", maxTokens: 500, tags: ["project:pi-overdrive"] });
  check("hindsight-recall-temporal-italian", recallIt.status === "OK" && recallIt.items.some((item) => /10 settembre 2026|embedding locali CPU/iu.test(item.content)), { candidates: recallIt.candidateCount });
  check("hindsight-recall-temporal-english", recallEn.status === "OK" && recallEn.items.some((item) => /12 September 2026|validation passed/iu.test(item.content)), { candidates: recallEn.candidateCount });
  const suppressed = await hindsight.reflect({ bankId, query: "Synthesize all history" });
  check("hindsight-reflect-default-gate", suppressed.status === "SUPPRESSED" && suppressed.reason === "explicit_authorization_required");
  const explicit = await hindsight.reflect({ bankId, query: "Synthesize all history", explicitlyAuthorized: true });
  check("hindsight-reflect-llm-none-fail-closed", explicit.status === "DEGRADED", { status: explicit.status, reason: explicit.reason });
} catch (error) {
  results.push({ name: "service-smoke-harness", status: "FAIL", detail: error instanceof Error ? error.message : String(error) });
}

const status = results.length >= 17 && results.every((entry) => entry.status === "PASS") ? "PASS" : "FAIL";
process.stdout.write(`${JSON.stringify({ status, packageRoot, modelCalls: 0, paidProviderCalls: 0, guiLaunches: 0, results }, null, 2)}\n`);
process.exit(status === "PASS" ? 0 : 1);
