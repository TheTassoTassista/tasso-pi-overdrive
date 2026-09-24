import { createHash } from "node:crypto";
import { assessModelCapability, modelIdentity, readModelCallability, validateCallabilityCache } from "./model-callability.mjs";
import { resolveModelHarnessProfile } from "./model-harness-profile.mjs";
import { classifyEvidenceFreshness } from "./provider-catalog-snapshot.mjs";

export const PROVIDER_CAPABILITY_REGISTRY_VERSION = 2;
export const CALLABILITY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const UNKNOWN = Object.freeze({ state: "UNKNOWN", value: null, source: null, observedAt: null, freshness: "UNKNOWN_AGE" });
const ORDER = Object.freeze({ VERIFIED: 5, BENCHMARKED: 4, DECLARED: 3, CACHED: 2, STALE: 1, UNKNOWN: 0 });
const SAFE_SOURCE = /^[a-zA-Z0-9._:-]{1,120}$/u;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const ID = /^[^/\s]+\/(?:[^/\s]+\/)*[^/\s]+$/u;
const FIELDS = new Set(["contextWindow", "maxOutputTokens", "reasoningModes", "toolSupport", "vision", "structuredOutput", "pricing"]);
const evidence = (value, source, state = "DECLARED", observedAt = null, freshness = "UNKNOWN_AGE") => value === null || value === undefined ? UNKNOWN : Object.freeze({ state, value, source, observedAt, freshness });
const positive = (value) => Number.isSafeInteger(value) && value >= 1024 && value <= 100_000_000 ? value : null;
const nonnegative = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

function registryPricing(model) {
  // Zero/zero may be a Pi adapter placeholder; OmniRoute does not attest price units.
  if (!model || model.provider === "omniroute" || !model.cost || typeof model.cost !== "object") return UNKNOWN;
  const values = Object.fromEntries(["input", "output", "cacheRead", "cacheWrite"].map((key) => [key, nonnegative(model.cost[key])]));
  if (values.input === null || values.output === null || (values.input === 0 && values.output === 0 && !model.pricingSource)) return UNKNOWN;
  return evidence({ ...values, currency: null, unit: null }, "pi-model-registry");
}

function reasoning(model) {
  if (!model) return UNKNOWN;
  if (model.reasoning === false) return evidence(["off"], "pi-model-registry");
  if (model.reasoning !== true) return UNKNOWN;
  const mapping = model.thinkingLevelMap && typeof model.thinkingLevelMap === "object" ? model.thinkingLevelMap : {};
  return evidence(["off", "minimal", "low", "medium", "high", "xhigh", "max"].filter((level) => !(["xhigh", "max"].includes(level) && mapping[level] === undefined) && mapping[level] !== null), "pi-model-registry");
}

function verifiedEvidence(entry, field, now) {
  if (entry === undefined) return UNKNOWN;
  if (!entry || typeof entry !== "object" || Array.isArray(entry) || !SAFE_SOURCE.test(entry.source ?? "") || !FIELDS.has(field)) throw new Error("provider_registry_verified_evidence_invalid");
  const freshness = classifyEvidenceFreshness(entry.observedAt, now, CALLABILITY_MAX_AGE_MS);
  if (freshness === "UNKNOWN_AGE" || typeof entry.observedAt !== "string" || !ISO_UTC.test(entry.observedAt)) throw new Error("provider_registry_verified_evidence_age_invalid");
  if (["contextWindow", "maxOutputTokens"].includes(field) && positive(entry.value) === null) throw new Error("provider_registry_verified_evidence_value_invalid");
  if (["toolSupport", "vision", "structuredOutput"].includes(field) && typeof entry.value !== "boolean") throw new Error("provider_registry_verified_evidence_value_invalid");
  if (field === "pricing" && (!entry.value || typeof entry.value !== "object" || Array.isArray(entry.value) || Object.keys(entry.value).some((key) => !["input", "output", "currency", "unit"].includes(key)) || nonnegative(entry.value.input) === null || nonnegative(entry.value.output) === null || entry.value.currency !== "USD" || entry.value.unit !== "PER_MILLION_TOKENS")) throw new Error("provider_registry_verified_evidence_value_invalid");
  if (field === "reasoningModes" && (!Array.isArray(entry.value) || entry.value.some((item) => !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(item)))) throw new Error("provider_registry_verified_evidence_value_invalid");
  // Publish only schema fields; never serialize caller-owned objects into receipts/conflicts.
  const value = field === "pricing" ? { input: entry.value.input, output: entry.value.output, currency: "USD", unit: "PER_MILLION_TOKENS" } : field === "reasoningModes" ? [...entry.value] : entry.value;
  return evidence(value, entry.source, freshness === "STALE" ? "STALE" : "VERIFIED", entry.observedAt, freshness);
}

function choose(field, candidates, conflicts, identity) {
  const known = candidates.filter((item) => item.state !== "UNKNOWN");
  if (!known.length) return UNKNOWN;
  if (new Set(known.map((item) => JSON.stringify(item.value))).size > 1) conflicts.push(Object.freeze({ identity, field, sources: known.map((item) => ({ source: item.source, state: item.state, value: item.value })) }));
  if (["contextWindow", "maxOutputTokens"].includes(field)) {
    // Even stale evidence may lower a safe cap; it must never raise one.
    return [...known].sort((a, b) => a.value - b.value || ORDER[b.state] - ORDER[a.state])[0];
  }
  return [...known].sort((a, b) => ORDER[b.state] - ORDER[a.state] || String(a.source).localeCompare(String(b.source)))[0];
}

function catalogEvidence(value, snapshot, freshness) {
  return value === null || value === undefined ? UNKNOWN : evidence(value, `omniroute-openrouter-cache:${snapshot.digest}`, freshness === "STALE" ? "STALE" : "CACHED", snapshot.observedAt, freshness);
}

function runtimeEvidence(availability, cache, now) {
  if (availability.runtimeStatus === "RUNTIME_UNKNOWN") return UNKNOWN;
  const freshness = classifyEvidenceFreshness(cache.updatedAt, now, CALLABILITY_MAX_AGE_MS);
  const source = availability.evidenceRunId ? `workflow-receipt:${availability.evidenceRunId}` : "model-callability-cache";
  const state = freshness === "STALE" ? "STALE" : freshness === "FRESH" && availability.evidenceRunId ? "VERIFIED" : "CACHED";
  return evidence(availability.runtimeStatus, source, state, cache.updatedAt ?? null, freshness);
}

function catalogMap(snapshot) {
  if (snapshot === null) return new Map();
  if (!snapshot || snapshot.version !== 1 || snapshot.source !== "omniroute-openrouter-cache" || !/^[0-9a-f]{64}$/u.test(snapshot.digest ?? "") || !Array.isArray(snapshot.models) || snapshot.models.length > 1000) throw new Error("provider_registry_catalog_invalid");
  const body = { version: snapshot.version, source: snapshot.source, observedAt: snapshot.observedAt, models: snapshot.models };
  if (createHash("sha256").update(JSON.stringify(body)).digest("hex") !== snapshot.digest) throw new Error("provider_registry_catalog_digest_mismatch");
  const map = new Map();
  for (const entry of snapshot.models) {
    if (!entry || typeof entry.identity !== "string" || !/^omniroute\/openrouter\/[~A-Za-z0-9._:-]+(?:\/[~A-Za-z0-9._:-]+)+$/u.test(entry.identity) || entry.identity.split("/").some((segment) => segment === "." || segment === "..") || map.has(entry.identity) || Object.keys(entry).some((key) => !["identity", "contextWindow", "maxOutputTokens", "toolSupport", "vision", "structuredOutput", "pricing"].includes(key)) || [entry.contextWindow, entry.maxOutputTokens].some((value) => value !== null && positive(value) === null) || [entry.toolSupport, entry.vision, entry.structuredOutput].some((value) => value !== null && typeof value !== "boolean") || (entry.pricing !== null && (typeof entry.pricing !== "object" || Array.isArray(entry.pricing) || Object.keys(entry.pricing).some((key) => !["input", "output", "currency", "unit"].includes(key)) || nonnegative(entry.pricing.input) === null || nonnegative(entry.pricing.output) === null || entry.pricing.currency !== "USD" || entry.pricing.unit !== "PER_MILLION_TOKENS"))) throw new Error("provider_registry_catalog_model_invalid");
    map.set(entry.identity, entry);
  }
  return map;
}

/** Read-only intelligence. No provider request, callability probe, route change or pricing authority. */
export function buildProviderCapabilityRegistry(input = {}) {
  const registered = input.registeredModels ?? [];
  const authenticated = input.authenticatedModels ?? [];
  if (!Array.isArray(registered) || !Array.isArray(authenticated)) throw new Error("provider_registry_models_invalid");
  const callability = validateCallabilityCache(input.callability ?? readModelCallability());
  const now = input.now ?? Date.now();
  if (!Number.isFinite(now)) throw new Error("provider_registry_time_invalid");
  const snapshot = input.catalogSnapshot ?? null;
  const catalog = catalogMap(snapshot);
  const freshness = snapshot ? classifyEvidenceFreshness(snapshot.observedAt, now) : "UNKNOWN_AGE";
  if (snapshot && (freshness === "UNKNOWN_AGE" || !ISO_UTC.test(snapshot.observedAt))) throw new Error("provider_registry_catalog_age_invalid");
  const byIdentity = new Map();
  for (const model of registered) {
    const identity = modelIdentity(model);
    if (!ID.test(identity) || byIdentity.has(identity)) throw new Error("provider_registry_identity_invalid");
    byIdentity.set(identity, model);
  }
  const allIdentities = new Set([...byIdentity.keys(), ...catalog.keys()]);
  if (input.onlyIdentity !== undefined && (!ID.test(input.onlyIdentity) || !allIdentities.has(input.onlyIdentity))) throw new Error("provider_registry_identity_missing");
  const conflicts = [];
  const models = (input.onlyIdentity ? [input.onlyIdentity] : [...allIdentities].sort()).map((identity) => {
    const model = byIdentity.get(identity) ?? null;
    const declared = catalog.get(identity) ?? null;
    const availability = assessModelCapability(identity, { registeredModels: registered, authenticatedModels: authenticated, callability });
    const profile = resolveModelHarnessProfile({ model, identity, provider: identity.split("/")[0], registeredModels: registered, authenticatedModels: authenticated, callability });
    const verified = input.verifiedCapabilities?.[identity] ?? {};
    if (!verified || typeof verified !== "object" || Array.isArray(verified) || Object.keys(verified).some((field) => !FIELDS.has(field))) throw new Error("provider_registry_verified_evidence_invalid");
    const select = (field, piValue = UNKNOWN, catalogValue = null) => choose(field, [verifiedEvidence(verified[field], field, now), piValue, snapshot && declared ? catalogEvidence(catalogValue, snapshot, freshness) : UNKNOWN], conflicts, identity);
    const supportedInput = model && Array.isArray(model.input) && model.input.every((item) => typeof item === "string") ? model.input : null;
    const structured = profile.capabilities.structuredOutput;
    const contextWindow = select("contextWindow", model ? evidence(positive(model.contextWindow), "pi-model-registry") : UNKNOWN, declared?.contextWindow);
    const maxOutputTokens = select("maxOutputTokens", model ? evidence(positive(model.maxTokens), "pi-model-registry") : UNKNOWN, declared?.maxOutputTokens);
    const pricing = select("pricing", registryPricing(model), declared?.pricing);
    const pricePositive = pricing.state !== "UNKNOWN" && (pricing.value.input > 0 || pricing.value.output > 0);
    const runtime = runtimeEvidence(availability, callability, now);
    return Object.freeze({
      identity, provider: identity.split("/")[0], family: profile.match.family,
      availability: Object.freeze({ registry: availability.registryStatus, authentication: availability.authenticationStatus, catalog: declared ? catalogEvidence(true, snapshot, freshness) : UNKNOWN, runtime, selectable: availability.usable, freshlyVerified: availability.usable && runtime.state === "VERIFIED" }),
      contextWindow, maxOutputTokens, reasoningModes: select("reasoningModes", reasoning(model)),
      toolSupport: select("toolSupport", model && typeof model.supportsTools === "boolean" ? evidence(model.supportsTools, "pi-model-registry") : UNKNOWN, declared?.toolSupport),
      vision: select("vision", supportedInput ? evidence(supportedInput.includes("image"), "pi-model-registry") : UNKNOWN, declared?.vision),
      structuredOutput: select("structuredOutput", structured && structured.level !== "UNKNOWN" ? evidence(true, structured.source, "DECLARED") : UNKNOWN, declared?.structuredOutput),
      pricing, zeroExtraCost: pricePositive ? false : pricing.state === "VERIFIED" && pricing.value.input === 0 && pricing.value.output === 0 && verified.pricing?.zeroExtraCostAttested === true ? true : null,
      rateLimit: UNKNOWN,
      harness: evidence({ profileId: profile.id, known: profile.match.known, digest: profile.digest }, "model-harness-profile"),
    });
  });
  const body = { version: PROVIDER_CAPABILITY_REGISTRY_VERSION, kind: "PROVIDER_CAPABILITY_REGISTRY", models, conflicts, catalog: { status: snapshot ? freshness : input.catalogStatus ?? "UNAVAILABLE", source: snapshot?.source ?? null, observedAt: snapshot?.observedAt ?? null, digest: snapshot?.digest ?? null }, decisionModelCalls: 0, catalogFetches: 0, routingMutations: 0 };
  return Object.freeze({ ...body, digest: createHash("sha256").update(JSON.stringify(body)).digest("hex") });
}

/** Context Governor receives a non-increasing cap, never a guessed larger window. */
export function contextModelWithRegistryCap(model, record) {
  if (!model || !record || record.identity !== modelIdentity(model)) throw new Error("provider_registry_context_identity_invalid");
  const limit = record.contextWindow?.value;
  const output = record.maxOutputTokens?.value;
  return Object.freeze({ ...model, contextWindow: positive(limit) === null ? model.contextWindow : Math.min(model.contextWindow, limit), maxTokens: positive(output) === null ? model.maxTokens : Math.min(model.maxTokens, output) });
}
