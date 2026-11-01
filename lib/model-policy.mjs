import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import routingPolicy from "../config/routing-policy.json" with { type: "json" };
import { callabilityDigest, capabilityMap, modelIdentity, readModelCallability } from "./model-callability.mjs";
import { QUALITY_LEVELS } from "./routing-session.mjs";

export const MODEL_POLICY_VERSION = 2;
export const MODEL_PRESETS = Object.freeze(["normal", "token-saver", "custom"]);
export const MODEL_ROLES = Object.freeze([
  "scout", "planner", "oracle", "worker", "tester", "correctness", "security", "simplicity",
  "council-1", "council-2", "council-3", "council-judge",
]);
export const ROLE_TO_AGENT = Object.freeze({
  scout: "scout", planner: "planner", oracle: "oracle", worker: "worker", tester: "tester",
  correctness: "correctness-reviewer", security: "security-reviewer", simplicity: "simplicity-reviewer",
  "council-1": "council-1", "council-2": "council-2", "council-3": "council-3", "council-judge": "council-judge",
});
export const AGENT_TO_ROLE = Object.freeze(Object.fromEntries(Object.entries(ROLE_TO_AGENT).map(([role, agent]) => [agent, role])));
export const LEGACY_PRESET_ALIASES = Object.freeze({ budget: "token-saver", efficient: "normal", balanced: "normal", "max-quality": "normal" });
export const ROUTING_POLICY = Object.freeze(routingPolicy);

const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const THINKING_ORDER = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function validateRoutingDefinition(value) {
  if (!value || value.version !== 1 || !value.models || !value.presets) throw new Error("routing_policy_invalid");
  for (const preset of ["normal", "token-saver"]) {
    if (!value.presets[preset]?.roles) throw new Error(`routing_policy_missing_preset:${preset}`);
    for (const role of MODEL_ROLES) {
      const definition = value.presets[preset].roles[role];
      if (!definition || !Array.isArray(definition.chain) || definition.chain.length === 0) throw new Error(`routing_policy_missing_role:${preset}:${role}`);
      for (const candidate of definition.chain) {
        if (!Array.isArray(candidate) || candidate.length !== 2 || !value.models[candidate[0]] || !THINKING.has(candidate[1])) throw new Error(`routing_policy_candidate_invalid:${preset}:${role}`);
      }
    }
  }
  return value;
}
validateRoutingDefinition(routingPolicy);

export function parsePreset(value) {
  const requested = String(value ?? "").trim().toLowerCase();
  const normalized = LEGACY_PRESET_ALIASES[requested] ?? requested;
  if (!MODEL_PRESETS.includes(normalized)) throw new Error("unknown_model_preset");
  return normalized;
}

export function modelPolicyPath(environment = process.env) {
  return environment.PI_OVERDRIVE_MODEL_POLICY ?? path.join(environment.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "pi-overdrive", "model-policy.json");
}

function identity(model) { return modelIdentity(model); }
function modelParts(model) {
  const separator = model.indexOf("/");
  return separator < 1 ? { provider: model, id: "" } : { provider: model.slice(0, separator), id: model.slice(separator + 1) };
}
function availableMap(models) {
  return new Map((models ?? []).filter((model) => model && typeof model.provider === "string" && typeof model.id === "string").map((model) => [identity(model), model]));
}
function runtimeContext(models, options = {}) {
  const callability = options.callability ?? readModelCallability();
  return { models, map: availableMap(models), capabilities: capabilityMap(models, { ...options, callability }), callability };
}
function blockedReason(capability) {
  if (!capability || capability.registryStatus !== "REGISTRY_AVAILABLE") return "REGISTRY_MISSING";
  if (capability.authenticationStatus !== "AUTHENTICATED") return "AUTH_MISSING";
  return `${capability.runtimeStatus}:${capability.reasonCode}`;
}
function modelDefinitionByIdentity(model) {
  return Object.entries(routingPolicy.models).find(([, definition]) => definition.identity === model);
}
function zeroExtraCostAttested(registry, model) {
  if (registry?.kind !== "PROVIDER_CAPABILITY_REGISTRY") return false;
  const record = registry.models?.find((entry) => entry.identity === model);
  return record?.zeroExtraCost === true && record.availability?.selectable === true &&
    record.availability?.runtime?.state === "VERIFIED" && record.pricing?.state === "VERIFIED" &&
    record.pricing?.value?.input === 0 && record.pricing?.value?.output === 0;
}

export function supportedThinkingLevels(model) {
  if (model?.reasoning !== true) return ["off"];
  const mapping = model.thinkingLevelMap && typeof model.thinkingLevelMap === "object" ? model.thinkingLevelMap : {};
  return THINKING_ORDER.filter((level) => {
    if (mapping[level] === null) return false;
    if (["xhigh", "max"].includes(level)) return mapping[level] !== undefined;
    return true;
  });
}

function requestedEffort(role, configured, modelDefinition, options) {
  if (modelDefinition.source !== "direct") return configured;
  const requestedQuality = QUALITY_LEVELS.includes(options.qualityRequested) ? options.qualityRequested : "auto";
  const profile = requestedQuality === "auto" ? "medium" : requestedQuality;
  const overlay = routingPolicy.quality.directEffort[profile] ?? {};
  return overlay[role] ?? overlay.default ?? configured;
}

function resolvedCandidate(context, role, alias, configuredThinking, fallbackIndex, options) {
  const definition = routingPolicy.models[alias];
  const model = definition.identity;
  const capability = context.capabilities.get(model);
  const metadata = context.map.get(model);
  const parts = modelParts(model);
  const base = {
    alias, model, provider: parts.provider, modelId: parts.id,
    source: definition.source, family: definition.family, configuredThinking, fallbackIndex,
    callability: capability ? {
      registryStatus: capability.registryStatus,
      authenticationStatus: capability.authenticationStatus,
      runtimeStatus: capability.runtimeStatus,
      reasonCode: capability.reasonCode,
      usable: capability.usable,
    } : { registryStatus: "REGISTRY_MISSING", authenticationStatus: "AUTH_MISSING", runtimeStatus: "RUNTIME_UNKNOWN", reasonCode: "NO_EVIDENCE", usable: false },
  };
  // Gateway catalog presence and runtime callability do not attest zero extra cost.
  // Only the trusted, read-only Provider Capability Registry may approve an automatic gateway route.
  if (definition.source !== "direct" && !zeroExtraCostAttested(options.providerRegistry, model)) return { ...base, usable: false, reason: "COST_NOT_ATTESTED" };
  if (!metadata || !capability?.usable) return { ...base, usable: false, reason: blockedReason(capability) };
  const desired = requestedEffort(role, configuredThinking, definition, options);
  const supported = supportedThinkingLevels(metadata);
  let thinking = desired;
  if (!supported.includes(thinking)) {
    const wasQualityOverlay = desired !== configuredThinking;
    if (!wasQualityOverlay) return { ...base, usable: false, reason: `THINKING_UNAVAILABLE:${desired}` };
    const desiredRank = THINKING_ORDER.indexOf(desired);
    thinking = [...supported].reverse().find((level) => THINKING_ORDER.indexOf(level) <= desiredRank);
    if (!thinking) return { ...base, usable: false, reason: `THINKING_UNAVAILABLE:${desired}` };
  }
  return { ...base, usable: true, thinking, desiredThinking: desired };
}

function resolvePresetRoles(preset, context, options, overrides = {}) {
  const roles = {};
  const routeChains = {};
  const decisions = [];
  for (const role of MODEL_ROLES) {
    const definition = routingPolicy.presets[preset].roles[role];
    const candidates = definition.chain.map(([alias, thinking], index) => resolvedCandidate(context, role, alias, thinking, index, options));
    routeChains[role] = Object.freeze(candidates.map((candidate) => Object.freeze(candidate)));
    const selected = candidates.find((candidate) => candidate.usable);
    if (!selected && Object.hasOwn(overrides, role)) {
      decisions.push(Object.freeze({ role, selected: null, thinking: null, fallbackIndex: -1, skipped: Object.freeze(candidates.map((candidate) => Object.freeze({ model: candidate.model, reason: candidate.reason }))) }));
      continue;
    }
    if (!selected) throw new Error(`BLOCKED_BY_MODEL:${role}:${candidates.map((candidate) => `${candidate.model}=${candidate.reason}`).join(",")}`);
    roles[role] = Object.freeze({
      model: selected.model,
      thinking: selected.thinking,
      provider: selected.provider,
      modelId: selected.modelId,
      source: selected.source,
      family: selected.family,
      fallbackIndex: selected.fallbackIndex,
      mode: definition.mode,
    });
    decisions.push(Object.freeze({
      role,
      selected: selected.model,
      thinking: selected.thinking,
      fallbackIndex: selected.fallbackIndex,
      skipped: Object.freeze(candidates.slice(0, selected.fallbackIndex).map((candidate) => Object.freeze({ model: candidate.model, reason: candidate.reason }))),
    }));
  }
  return { roles, routeChains, decisions };
}

function defaultPolicy() { return { version: MODEL_POLICY_VERSION, preset: "normal", basePreset: "normal", overrides: {} }; }

function normalizeStoredPolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("model_policy_version");
  if (![1, MODEL_POLICY_VERSION].includes(value.version)) throw new Error("model_policy_version");
  const originalPreset = String(value.preset ?? "");
  const originalBase = String(value.basePreset ?? originalPreset);
  const preset = originalPreset === "custom" ? "custom" : parsePreset(originalPreset);
  const basePreset = parsePreset(originalBase === "custom" ? "normal" : originalBase);
  if (basePreset === "custom") throw new Error("model_policy_base_preset");
  return { ...value, version: MODEL_POLICY_VERSION, preset, basePreset, overrides: value.overrides ?? {} };
}

export function readModelPolicy(file = modelPolicyPath()) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("model_policy_permissions");
    return validateStoredPolicy(JSON.parse(fs.readFileSync(descriptor, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return defaultPolicy();
    if (error instanceof SyntaxError) throw new Error("model_policy_invalid_json");
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function validateStoredPolicy(value) {
  const normalized = normalizeStoredPolicy(value);
  if (!MODEL_PRESETS.includes(normalized.preset)) throw new Error("model_policy_preset");
  if (!MODEL_PRESETS.includes(normalized.basePreset) || normalized.basePreset === "custom") throw new Error("model_policy_base_preset");
  if (!normalized.overrides || typeof normalized.overrides !== "object" || Array.isArray(normalized.overrides)) throw new Error("model_policy_overrides");
  if (Object.keys(normalized).some((key) => !["version", "preset", "basePreset", "overrides", "updatedAt"].includes(key))) throw new Error("model_policy_unknown_field");
  for (const [role, candidate] of Object.entries(normalized.overrides)) {
    if (!MODEL_ROLES.includes(role) || !candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("model_policy_role");
    if (Object.keys(candidate).some((key) => !["model", "thinking"].includes(key)) || typeof candidate.model !== "string" || !candidate.model.includes("/") || !THINKING.has(candidate.thinking)) throw new Error("model_policy_route");
  }
  return structuredClone(normalized);
}

function resolvedDigest(candidate) {
  return createHash("sha256").update(JSON.stringify({
    version: MODEL_POLICY_VERSION,
    preset: candidate.preset,
    basePreset: candidate.basePreset,
    qualityRequested: candidate.qualityRequested,
    effectiveQuality: candidate.effectiveQuality,
    roles: candidate.roles,
  })).digest("hex");
}

export function resolveModelPolicy(models, stored = readModelPolicy(), options = {}) {
  const normalized = validateStoredPolicy(stored);
  const context = runtimeContext(models, options);
  if (context.map.size === 0) throw new Error("no_authenticated_models_available");
  const concrete = normalized.preset === "custom" ? normalized.basePreset : normalized.preset;
  const qualityRequested = QUALITY_LEVELS.includes(options.qualityRequested) ? options.qualityRequested : "auto";
  const effectiveQuality = QUALITY_LEVELS.includes(options.effectiveQuality) && options.effectiveQuality !== "auto" ? options.effectiveQuality : (qualityRequested === "auto" ? "medium" : qualityRequested);
  const resolved = resolvePresetRoles(concrete, context, { ...options, qualityRequested, effectiveQuality }, normalized.overrides);
  const roles = { ...resolved.roles };
  for (const [role, override] of Object.entries(normalized.overrides)) {
    const capability = context.capabilities.get(override.model);
    const metadata = context.map.get(override.model);
    if (!metadata || !capability?.usable) throw new Error(`BLOCKED_BY_MODEL:${role}:${override.model}:${blockedReason(capability)}`);
    if (!supportedThinkingLevels(metadata).includes(override.thinking)) throw new Error(`thinking_unavailable:${role}:${override.model}:${override.thinking}`);
    const parts = modelParts(override.model);
    const definition = modelDefinitionByIdentity(override.model)?.[1];
    roles[role] = Object.freeze({ model: override.model, thinking: override.thinking, provider: parts.provider, modelId: parts.id, source: definition?.source ?? (parts.provider === "omniroute" ? "OmniRoute" : "direct"), family: definition?.family ?? "custom", fallbackIndex: -1, mode: routingPolicy.presets[concrete].roles[role].mode, override: true });
  }
  const candidate = {
    version: MODEL_POLICY_VERSION,
    preset: normalized.preset,
    basePreset: concrete,
    qualityRequested,
    effectiveQuality,
    roles: Object.freeze(roles),
  };
  const providers = new Set(Object.values(roles).map((entry) => entry.provider));
  const families = new Set(Object.values(roles).map((entry) => entry.family));
  const modelIds = new Set(Object.values(roles).map((entry) => entry.model));
  return Object.freeze({
    ...candidate,
    displayName: routingPolicy.presets[concrete].displayName,
    description: routingPolicy.presets[concrete].description,
    routeChains: Object.freeze(resolved.routeChains),
    routingDecisions: Object.freeze(resolved.decisions),
    capabilityDigest: callabilityDigest(context.callability),
    diversity: Object.freeze({ providers: providers.size, families: families.size, models: modelIds.size, heterogeneousProviders: providers.size > 1, sharedGatewayFamilies: [...families].filter((family) => !["OpenAI", "custom", "automatic"].includes(family)).length }),
    digest: resolvedDigest(candidate),
  });
}

export function validateResolvedModelPolicy(models, candidate, options = {}) {
  if (!candidate || candidate.version !== MODEL_POLICY_VERSION || !candidate.roles || typeof candidate.roles !== "object") throw new Error("resolved_model_policy_invalid");
  if (!MODEL_PRESETS.includes(candidate.preset) || !MODEL_PRESETS.includes(candidate.basePreset) || candidate.basePreset === "custom") throw new Error("resolved_model_policy_preset_invalid");
  if (candidate.preset !== "custom" && candidate.preset !== candidate.basePreset) throw new Error("resolved_model_policy_base_mismatch");
  if (!QUALITY_LEVELS.includes(candidate.qualityRequested) || !QUALITY_LEVELS.includes(candidate.effectiveQuality) || candidate.effectiveQuality === "auto") throw new Error("resolved_model_policy_quality_invalid");
  const context = runtimeContext(models, options);
  const roles = {};
  for (const role of MODEL_ROLES) {
    const value = candidate.roles[role];
    const metadata = context.map.get(value?.model);
    const capability = context.capabilities.get(value?.model);
    const definition = modelDefinitionByIdentity(value?.model)?.[1];
    if (definition?.source !== "direct" && value?.override !== true && !zeroExtraCostAttested(options.providerRegistry, value?.model)) throw new Error(`resumed_model_route_cost_unattested:${role}`);
    if (!value || !metadata || !capability?.usable || !THINKING.has(value.thinking) || !supportedThinkingLevels(metadata).includes(value.thinking)) throw new Error(`resumed_model_route_unavailable:${role}`);
    const parts = modelParts(value.model);
    roles[role] = Object.freeze({ ...value, provider: parts.provider, modelId: parts.id });
  }
  const digestCandidate = { version: MODEL_POLICY_VERSION, preset: candidate.preset, basePreset: candidate.basePreset, qualityRequested: candidate.qualityRequested, effectiveQuality: candidate.effectiveQuality, roles };
  const expected = resolvedDigest(digestCandidate);
  if (candidate.digest !== expected) throw new Error("resolved_model_policy_digest_mismatch");
  const providers = new Set(Object.values(roles).map((entry) => entry.provider));
  const families = new Set(Object.values(roles).map((entry) => entry.family));
  const modelIds = new Set(Object.values(roles).map((entry) => entry.model));
  return Object.freeze({ ...candidate, roles: Object.freeze(roles), diversity: Object.freeze({ providers: providers.size, families: families.size, models: modelIds.size, heterogeneousProviders: providers.size > 1, sharedGatewayFamilies: [...families].filter((family) => !["OpenAI", "custom", "automatic"].includes(family)).length }), digest: expected });
}

export function publicModelCatalog(registeredModels, authenticatedModels = registeredModels, options = {}) {
  const capabilities = capabilityMap(authenticatedModels, { ...options, registeredModels });
  return [...availableMap(registeredModels).values()].sort((a, b) => identity(a).localeCompare(identity(b))).map((model) => {
    const modelId = identity(model);
    const definition = modelDefinitionByIdentity(modelId)?.[1];
    const pricingUnavailable = definition?.source === "OmniRoute" && definition.pricing === null;
    return {
      model: modelId, contextWindow: model.contextWindow ?? null, maxTokens: model.maxTokens ?? null,
      reasoning: model.reasoning === true, input: Array.isArray(model.input) ? model.input : [],
      cost: pricingUnavailable ? null : model.cost && typeof model.cost === "object" ? { input: model.cost.input ?? null, output: model.cost.output ?? null, cacheRead: model.cost.cacheRead ?? null, cacheWrite: model.cost.cacheWrite ?? null } : null,
      costMetadata: pricingUnavailable ? "NOT_REPORTED_BY_OMNIROUTE_CATALOG" : "PROVIDER_REPORTED",
      source: definition?.source ?? (model.provider === "omniroute" ? "OmniRoute" : "direct"),
      ...capabilities.get(modelId),
    };
  });
}

export function parseModelSelection(value, models, options = {}) {
  const trimmed = String(value ?? "").trim();
  const separator = trimmed.lastIndexOf(":");
  const possibleThinking = separator >= 0 ? trimmed.slice(separator + 1) : "";
  const hasThinking = THINKING.has(possibleThinking);
  const model = hasThinking ? trimmed.slice(0, separator) : trimmed;
  const thinking = hasThinking ? possibleThinking : "medium";
  const metadata = availableMap(models).get(model);
  if (!model || !metadata) throw new Error("selected_model_not_available");
  const capability = capabilityMap(models, options).get(model);
  if (!capability?.usable) throw new Error(`selected_model_not_runtime_callable:${blockedReason(capability)}`);
  if (!supportedThinkingLevels(metadata).includes(thinking)) throw new Error("selected_thinking_not_supported");
  return { model, thinking };
}

export function assertModelRoute(routeValue, response) {
  const reported = typeof response?.model === "string" ? response.model : "";
  const thinking = response?.thinking;
  const exact = reported === routeValue?.model;
  const annotated = reported === `${routeValue?.model}:${thinking}`;
  if (!routeValue || !THINKING.has(thinking) || (!exact && !annotated) || thinking !== routeValue.thinking) throw new Error("runtime_model_route_mismatch");
  return true;
}
export function canonicalExecutedRoute(routeValue, response) {
  assertModelRoute(routeValue, response);
  return { ...response, model: routeValue.model, thinking: routeValue.thinking };
}

export function policyWithPreset(stored, preset) {
  const normalized = validateStoredPolicy(stored);
  const selected = parsePreset(preset);
  if (selected === "custom") return { ...normalized, preset: "custom", updatedAt: new Date().toISOString() };
  return { version: MODEL_POLICY_VERSION, preset: selected, basePreset: selected, overrides: {}, updatedAt: new Date().toISOString() };
}
export function policyWithRole(stored, role, routeValue) {
  const normalized = validateStoredPolicy(stored);
  if (!MODEL_ROLES.includes(role)) throw new Error("unknown_model_role");
  return { ...normalized, preset: "custom", basePreset: normalized.preset === "custom" ? normalized.basePreset : normalized.preset, overrides: { ...normalized.overrides, [role]: routeValue }, updatedAt: new Date().toISOString() };
}
export function writeModelPolicy(file, value) {
  const validated = validateStoredPolicy(value);
  writePrivateJsonAtomic(file, validated);
  return validated;
}
export function writePrivateJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const directory = fs.realpathSync(path.dirname(file));
  const destination = path.join(directory, path.basename(file));
  try {
    const stat = fs.lstatSync(destination);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("model_policy_target_unsafe");
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const temporary = `${destination}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, destination);
    fs.chmodSync(destination, 0o600);
    const dirFd = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch (error) {
    if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {}
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}
export function settingsAgentOverrides(resolved) {
  return Object.fromEntries(Object.entries(resolved.roles).map(([role, value]) => [ROLE_TO_AGENT[role], { model: value.model, thinking: value.thinking }]));
}
