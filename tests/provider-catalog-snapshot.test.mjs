import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyEvidenceFreshness, normalizeOpenRouterCatalog, readLocalOpenRouterCatalog } from "../lib/provider-catalog-snapshot.mjs";

const now = Date.parse("2026-09-24T12:00:00Z");
const fixture = { fetchedAt: "2026-09-24T11:00:00Z", data: [
  { id: "example/model", context_length: 128000, top_provider: { max_completion_tokens: 4096 }, supported_parameters: ["tools"], architecture: { input_modalities: ["text", "image"] }, pricing: { prompt: "0.1", completion: "0.2" }, description: "PRIVATE_FIXTURE_SENTINEL" },
] };

test("local catalog normalization whitelists fields, retains exact identity and withholds prices lacking units", () => {
  const before = JSON.stringify(fixture);
  const snapshot = normalizeOpenRouterCatalog(fixture, now);
  assert.equal(JSON.stringify(fixture), before);
  assert.equal(snapshot.models[0].identity, "omniroute/openrouter/example/model");
  assert.equal(snapshot.models[0].pricing, null);
  assert.equal(snapshot.models[0].toolSupport, true);
  assert.equal(snapshot.models[0].vision, true);
  assert.equal(snapshot.models[0].structuredOutput, null);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_FIXTURE_SENTINEL|description|prompt/u);
  assert.equal(normalizeOpenRouterCatalog(fixture, now).digest, snapshot.digest);
});

test("explicitly unit-qualified positive prices remain positive; default zeros do not imply free", () => {
  const priced = structuredClone(fixture);
  priced.data[0].pricing = { prompt: "0.1", completion: "0.2", currency: "USD", unit: "PER_MILLION_TOKENS" };
  assert.deepEqual(normalizeOpenRouterCatalog(priced, now).models[0].pricing, { input: 0.1, output: 0.2, currency: "USD", unit: "PER_MILLION_TOKENS" });
  const zero = structuredClone(fixture);
  zero.data[0].pricing = { prompt: "0", completion: "0" };
  assert.equal(normalizeOpenRouterCatalog(zero, now).models[0].pricing, null);
});

test("fresh, stale, future and malformed timestamps have distinct classifications", () => {
  assert.equal(classifyEvidenceFreshness(fixture.fetchedAt, now), "FRESH");
  assert.equal(classifyEvidenceFreshness("2026-09-13T00:00:00Z", now), "STALE");
  assert.equal(classifyEvidenceFreshness("2027-01-01T00:00:00Z", now), "UNKNOWN_AGE");
  assert.equal(classifyEvidenceFreshness("bad", now), "UNKNOWN_AGE");
  assert.throws(() => normalizeOpenRouterCatalog({ ...fixture, fetchedAt: "bad" }, now), /provider_catalog_invalid/u);
});

test("malformed duplicate model identities are rejected and absent optional fields remain null", () => {
  assert.throws(() => normalizeOpenRouterCatalog({ ...fixture, data: [fixture.data[0], fixture.data[0]] }, now), /provider_catalog_model_invalid/u);
  assert.throws(() => normalizeOpenRouterCatalog({ ...fixture, data: [{ id: "../bad", context_length: 128000 }] }, now), /provider_catalog_model_invalid/u);
  const partial = normalizeOpenRouterCatalog({ ...fixture, data: [{ id: "example/partial" }] }, now).models[0];
  assert.deepEqual([partial.contextWindow, partial.maxOutputTokens, partial.toolSupport, partial.vision, partial.structuredOutput, partial.pricing], [null, null, null, null, null, null]);
});

test("local ingest refuses symlinks and world-writable cache files without network", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "overdrive-catalog-"));
  const file = path.join(directory, "catalog.json");
  const link = path.join(directory, "link.json");
  try {
    fs.writeFileSync(file, JSON.stringify(fixture), { mode: 0o600 });
    fs.symlinkSync(file, link);
    assert.equal(readLocalOpenRouterCatalog(file).status, "AVAILABLE");
    assert.equal(readLocalOpenRouterCatalog(link).status, "INVALID");
    fs.chmodSync(file, 0o666);
    assert.equal(readLocalOpenRouterCatalog(file).status, "INVALID");
    assert.equal(readLocalOpenRouterCatalog(path.join(directory, "missing.json")).status, "UNAVAILABLE");
  } finally {
    fs.rmSync(link, { force: true });
    fs.rmSync(file, { force: true });
    fs.rmdirSync(directory);
  }
});
