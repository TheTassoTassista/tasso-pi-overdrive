import { createHash } from "node:crypto";
import { assessModelCapability, modelIdentity, readModelCallability } from "./model-callability.mjs";
import { resolveModelHarnessProfile } from "./model-harness-profile.mjs";

export const PROVIDER_CAPABILITY_REGISTRY_VERSION = 1;
const UNKNOWN = Object.freeze({ state: "UNKNOWN", value: null, source: null });
const evidence = (value, source, state = "DECLARED") => value === null || value === undefined ? UNKNOWN : Object.freeze({ state, value, source });
const positive = (value) => Number.isSafeInteger(value) && value > 0 ? value : null;
const nonnegative = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const allowedPriceKeys = ["input", "output", "cacheRead", "cacheWrite"];

function pricing(model) {
  // OmniRoute's Pi adapter may fill zero defaults even when its catalog omits price.
  if (model.provider === "omniroute") return UNKNOWN;
  if (!model.cost || typeof model.cost !== "object") return UNKNOWN;
  const values = Object.fromEntries(allowedPriceKeys.map((key) => [key, nonnegative(model.cost[key])]));
  if (values.input === null || values.output === null || (values.input === 0 && values.output === 0 && !model.pricingSource)) return UNKNOWN;
  return evidence(values, "pi-model-registry");
}

function reasoning(model) {
  if (model.reasoning === false) return evidence(["off"], "pi-model-registry");
  if (model.reasoning !== true) return UNKNOWN;
  const mapping = model.thinkingLevelMap && typeof model.thinkingLevelMap === "object" ? model.thinkingLevelMap : {};
  return evidence(["off", "minimal", "low", "medium", "high", "xhigh", "max"].filter((level) => !(["xhigh", "max"].includes(level) && mapping[level] === undefined) && mapping[level] !== null), "pi-model-registry");
}

/** Read-only intelligence. No catalog request, callability probe, route change, or provider call. */
export function buildProviderCapabilityRegistry(input = {}) {
  const registered = input.registeredModels ?? [];
  const authenticated = input.authenticatedModels ?? [];
  if (!Array.isArray(registered) || !Array.isArray(authenticated)) throw new Error("provider_registry_models_invalid");
  const callability = input.callability ?? readModelCallability();
  const byIdentity = new Map();
  for (const model of registered) {
    const identity = modelIdentity(model);
    if (!/^[^/\s]+\/(?:[^/\s]+\/)*[^/\s]+$/u.test(identity) || byIdentity.has(identity)) throw new Error("provider_registry_identity_invalid");
    byIdentity.set(identity, model);
  }
  const records = [...byIdentity.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([identity, model]) => {
    const availability = assessModelCapability(identity, { registeredModels: registered, authenticatedModels: authenticated, callability });
    const profile = resolveModelHarnessProfile({ model, identity, registeredModels: registered, authenticatedModels: authenticated, callability });
    const runtime = availability.runtimeStatus === "RUNTIME_UNKNOWN" ? UNKNOWN : evidence(availability.runtimeStatus, availability.evidenceRunId ? `workflow-receipt:${availability.evidenceRunId}` : "model-callability-cache", availability.evidenceRunId ? "VERIFIED" : "DECLARED");
    const supportedInput = Array.isArray(model.input) && model.input.every((entry) => typeof entry === "string") ? model.input : null;
    const structured = profile.capabilities.structuredOutput;
    const record = {
      identity, provider: model.provider,
      availability: Object.freeze({ registry: availability.registryStatus, authentication: availability.authenticationStatus, runtime, selectable: availability.usable }),
      contextWindow: evidence(positive(model.contextWindow), "pi-model-registry"),
      maxOutputTokens: evidence(positive(model.maxTokens), "pi-model-registry"),
      reasoningModes: reasoning(model),
      toolSupport: typeof model.supportsTools === "boolean" ? evidence(model.supportsTools, "pi-model-registry") : UNKNOWN,
      vision: supportedInput ? evidence(supportedInput.includes("image"), "pi-model-registry") : UNKNOWN,
      structuredOutput: structured && structured.level !== "UNKNOWN" ? evidence(true, structured.source, structured.level === "VERIFIED" || structured.level === "BENCHMARKED" ? structured.level : "DECLARED") : UNKNOWN,
      pricing: pricing(model),
      rateLimit: UNKNOWN,
      harness: evidence({ profileId: profile.id, known: profile.match.known, digest: profile.digest }, "model-harness-profile"),
    };
    return Object.freeze(record);
  });
  const body = { version: PROVIDER_CAPABILITY_REGISTRY_VERSION, kind: "PROVIDER_CAPABILITY_REGISTRY", models: records, decisionModelCalls: 0, catalogFetches: 0, routingMutations: 0 };
  return Object.freeze({ ...body, digest: createHash("sha256").update(JSON.stringify(body)).digest("hex") });
}
