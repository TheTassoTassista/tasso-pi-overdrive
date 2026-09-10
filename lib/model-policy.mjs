import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { callabilityDigest, capabilityMap, modelIdentity, readModelCallability } from "./model-callability.mjs";

export const MODEL_POLICY_VERSION = 1;
export const MODEL_PRESETS = Object.freeze(["budget", "efficient", "balanced", "max-quality", "custom"]);
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

const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const PREFERENCES = Object.freeze([
  "openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-terra", "openai-codex/gpt-5.6-sol", "openai-codex/gpt-6-astra",
  "openai-codex/gpt-5.5", "openai-codex/gpt-5.4", "openai-codex/gpt-5.4-mini", "openai-codex/gpt-5.3-codex-spark",
]);

export function modelPolicyPath(environment = process.env) {
  return environment.PI_OVERDRIVE_MODEL_POLICY ?? path.join(environment.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "pi-overdrive", "model-policy.json");
}

function identity(model) { return modelIdentity(model); }

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

function choose(context, preferred, excluded = new Set(), purpose = "route", decisions = []) {
  const candidates = [...new Set([...preferred, ...PREFERENCES, ...[...context.map.keys()].sort()])];
  const skipped = [];
  for (const id of candidates) {
    if (excluded.has(id)) { skipped.push({ model: id, reason: "EXCLUDED_FOR_DIVERSITY" }); continue; }
    const capability = context.capabilities.get(id);
    if (context.map.has(id) && capability?.usable) {
      if (skipped.length > 0) decisions.push(Object.freeze({ purpose, selected: id, skipped: Object.freeze(skipped) }));
      return id;
    }
    skipped.push({ model: id, reason: blockedReason(capability) });
  }
  for (const id of candidates) {
    const capability = context.capabilities.get(id);
    if (excluded.has(id) && context.map.has(id) && capability?.usable) {
      decisions.push(Object.freeze({ purpose, selected: id, diversityRelaxed: true, skipped: Object.freeze(skipped) }));
      return id;
    }
  }
  throw new Error(`BLOCKED_BY_MODEL:${purpose}:${skipped.map((item) => `${item.model}=${item.reason}`).join(",")}`);
}

function costScore(model) {
  const input = Number(model?.cost?.input);
  const output = Number(model?.cost?.output);
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return Number.POSITIVE_INFINITY;
  return input + (3 * output);
}

function cheapest(context, decisions) {
  const candidates = [...context.map.entries()].filter(([id]) => context.capabilities.get(id)?.usable).map(([id, model]) => ({ id, score: costScore(model) })).filter((entry) => Number.isFinite(entry.score)).sort((a, b) => a.score - b.score || a.id.localeCompare(b.id));
  return candidates[0]?.id ?? choose(context, ["openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.4-mini", "openai-codex/gpt-5.3-codex-spark"], new Set(), "budget", decisions);
}

export function supportedThinkingLevels(model) {
  if (model?.reasoning !== true) return ["off"];
  const mapping = model.thinkingLevelMap && typeof model.thinkingLevelMap === "object" ? model.thinkingLevelMap : {};
  return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].filter((level) => {
    if (mapping[level] === null) return false;
    if (["xhigh", "max"].includes(level)) return mapping[level] !== undefined;
    return true;
  });
}

function route(context, model, thinking) {
  const metadata = context.map.get(model);
  const capability = context.capabilities.get(model);
  if (!metadata || !capability?.usable) throw new Error(`BLOCKED_BY_MODEL:route:${model}:${blockedReason(capability)}`);
  const supported = supportedThinkingLevels(metadata);
  const requested = supported.includes(thinking) ? thinking : [...supported].reverse()[0];
  if (!requested) throw new Error(`model_has_no_supported_thinking_level:${model}`);
  return Object.freeze({ model, thinking: requested });
}

function presetRoutes(name, context) {
  if (!MODEL_PRESETS.includes(name) || name === "custom") throw new Error("invalid_concrete_preset");
  const decisions = [];
  const pick = (purpose, ...ids) => choose(context, ids, new Set(), purpose, decisions);
  const budget = cheapest(context, decisions);
  const fast = pick("fast", "openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.4-mini", "openai-codex/gpt-5.3-codex-spark");
  const worker = pick("worker", "openai-codex/gpt-5.6-terra", "openai-codex/gpt-5.6-sol", "openai-codex/gpt-5.5");
  const reasoning = pick("reasoning", "openai-codex/gpt-5.6-sol", "openai-codex/gpt-6-astra", "openai-codex/gpt-5.5");
  const strongest = pick("strongest", "openai-codex/gpt-6-astra", "openai-codex/gpt-5.6-sol", "openai-codex/gpt-5.6-terra");
  const critic1 = choose(context, ["openai-codex/gpt-5.5", "openai-codex/gpt-5.4", reasoning], new Set([worker]), "critic-1", decisions);
  const critic2 = choose(context, ["openai-codex/gpt-5.4", "openai-codex/gpt-5.6-luna", "openai-codex/gpt-6-astra", reasoning], new Set([worker, critic1]), "critic-2", decisions);
  const critic3 = choose(context, ["openai-codex/gpt-5.6-sol", "openai-codex/gpt-5.5", fast], new Set([worker, critic1, critic2]), "critic-3", decisions);
  const r = (model, thinking) => route(context, model, thinking);

  if (name === "budget") return { roles: Object.fromEntries(MODEL_ROLES.map((role) => [role, r(budget, ["scout", "tester", "simplicity"].includes(role) ? "low" : "medium")])), decisions };
  if (name === "efficient") return { roles: {
    scout: r(fast, "low"), planner: r(reasoning, "high"), oracle: r(strongest, "high"), worker: r(worker, "high"), tester: r(fast, "medium"),
    correctness: r(reasoning, "high"), security: r(reasoning, "high"), simplicity: r(fast, "medium"),
    "council-1": r(reasoning, "high"), "council-2": r(critic1, "high"), "council-3": r(critic2, "high"), "council-judge": r(strongest, "high"),
  }, decisions
  };
  if (name === "balanced") return { roles: {
    scout: r(fast, "low"), planner: r(reasoning, "high"), oracle: r(strongest, "high"), worker: r(worker, "high"), tester: r(fast, "medium"),
    correctness: r(critic1, "high"), security: r(critic2, "high"), simplicity: r(fast, "medium"),
    "council-1": r(reasoning, "high"), "council-2": r(critic1, "high"), "council-3": r(critic2, "high"), "council-judge": r(strongest, "high"),
  }, decisions
  };
  return { roles: {
    scout: r(worker, "medium"), planner: r(strongest, "max"), oracle: r(strongest, "max"), worker: r(worker, "max"), tester: r(reasoning, "high"),
    correctness: r(critic1, "max"), security: r(critic2, "max"), simplicity: r(critic3, "high"),
    "council-1": r(reasoning, "max"), "council-2": r(critic1, "max"), "council-3": r(critic2, "max"), "council-judge": r(strongest, "max"),
  }, decisions };
}

export function readModelPolicy(file = modelPolicyPath()) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("model_policy_permissions");
    const parsed = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    return validateStoredPolicy(parsed);
  } catch (error) {
    if (error?.code === "ENOENT") return { version: MODEL_POLICY_VERSION, preset: "efficient", basePreset: "efficient", overrides: {} };
    if (error instanceof SyntaxError) throw new Error("model_policy_invalid_json");
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function validateStoredPolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== MODEL_POLICY_VERSION) throw new Error("model_policy_version");
  if (!MODEL_PRESETS.includes(value.preset)) throw new Error("model_policy_preset");
  if (!MODEL_PRESETS.includes(value.basePreset) || value.basePreset === "custom") throw new Error("model_policy_base_preset");
  if (!value.overrides || typeof value.overrides !== "object" || Array.isArray(value.overrides)) throw new Error("model_policy_overrides");
  if (Object.keys(value).some((key) => !["version", "preset", "basePreset", "overrides", "updatedAt"].includes(key))) throw new Error("model_policy_unknown_field");
  for (const [role, candidate] of Object.entries(value.overrides)) {
    if (!MODEL_ROLES.includes(role) || !candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("model_policy_role");
    if (Object.keys(candidate).some((key) => !["model", "thinking"].includes(key)) || typeof candidate.model !== "string" || !candidate.model.includes("/") || !THINKING.has(candidate.thinking)) throw new Error("model_policy_route");
  }
  return structuredClone(value);
}

export function resolveModelPolicy(models, stored = readModelPolicy(), options = {}) {
  const context = runtimeContext(models, options);
  const map = context.map;
  if (map.size === 0) throw new Error("no_authenticated_models_available");
  const concrete = stored.preset === "custom" ? stored.basePreset : stored.preset;
  const resolvedPreset = presetRoutes(concrete, context);
  const roles = resolvedPreset.roles;
  for (const [role, override] of Object.entries(stored.overrides)) {
    const capability = context.capabilities.get(override.model);
    if (!map.has(override.model) || !capability?.usable) throw new Error(`BLOCKED_BY_MODEL:${role}:${override.model}:${blockedReason(capability)}`);
    const metadata = map.get(override.model);
    if (!supportedThinkingLevels(metadata).includes(override.thinking)) throw new Error(`thinking_unavailable:${role}:${override.model}:${override.thinking}`);
    roles[role] = Object.freeze({ model: override.model, thinking: override.thinking });
  }
  for (const role of MODEL_ROLES) if (!map.has(roles[role]?.model) || !context.capabilities.get(roles[role]?.model)?.usable) throw new Error(`BLOCKED_BY_MODEL:${role}`);
  const providers = new Set(Object.values(roles).map((entry) => entry.model.split("/")[0]));
  const modelIds = new Set(Object.values(roles).map((entry) => entry.model));
  const digest = createHash("sha256").update(JSON.stringify({ version: MODEL_POLICY_VERSION, preset: stored.preset, basePreset: concrete, roles })).digest("hex");
  return Object.freeze({ version: MODEL_POLICY_VERSION, preset: stored.preset, basePreset: concrete, roles: Object.freeze(roles), routingDecisions: Object.freeze(resolvedPreset.decisions), capabilityDigest: callabilityDigest(context.callability), diversity: { providers: providers.size, models: modelIds.size, heterogeneousProviders: providers.size > 1 }, digest });
}

export function validateResolvedModelPolicy(models, candidate, options = {}) {
  if (!candidate || candidate.version !== MODEL_POLICY_VERSION || !candidate.roles || typeof candidate.roles !== "object") throw new Error("resolved_model_policy_invalid");
  if (!MODEL_PRESETS.includes(candidate.preset) || !MODEL_PRESETS.includes(candidate.basePreset) || candidate.basePreset === "custom") throw new Error("resolved_model_policy_preset_invalid");
  if (candidate.preset !== "custom" && candidate.preset !== candidate.basePreset) throw new Error("resolved_model_policy_base_mismatch");
  const context = runtimeContext(models, options);
  const map = context.map;
  const roles = {};
  for (const role of MODEL_ROLES) {
    const value = candidate.roles[role];
    if (!value || typeof value.model !== "string" || !map.has(value.model) || !context.capabilities.get(value.model)?.usable || !THINKING.has(value.thinking)) throw new Error(`resumed_model_route_unavailable:${role}`);
    roles[role] = route(context, value.model, value.thinking);
  }
  const expected = createHash("sha256").update(JSON.stringify({ version: MODEL_POLICY_VERSION, preset: candidate.preset, basePreset: candidate.basePreset, roles })).digest("hex");
  if (candidate.digest !== expected) throw new Error("resolved_model_policy_digest_mismatch");
  const providers = new Set(Object.values(roles).map((entry) => entry.model.split("/")[0]));
  const modelIds = new Set(Object.values(roles).map((entry) => entry.model));
  return Object.freeze({ version: MODEL_POLICY_VERSION, preset: candidate.preset, basePreset: candidate.basePreset, roles: Object.freeze(roles), routingDecisions: Object.freeze(candidate.routingDecisions ?? []), capabilityDigest: candidate.capabilityDigest ?? callabilityDigest(context.callability), diversity: { providers: providers.size, models: modelIds.size, heterogeneousProviders: providers.size > 1 }, digest: expected });
}

export function publicModelCatalog(registeredModels, authenticatedModels = registeredModels, options = {}) {
  const capabilities = capabilityMap(authenticatedModels, { ...options, registeredModels });
  return [...availableMap(registeredModels).values()].sort((a, b) => identity(a).localeCompare(identity(b))).map((model) => ({
    model: identity(model), contextWindow: model.contextWindow ?? null, maxTokens: model.maxTokens ?? null,
    reasoning: model.reasoning === true, input: Array.isArray(model.input) ? model.input : [],
    cost: model.cost && typeof model.cost === "object" ? { input: model.cost.input ?? null, output: model.cost.output ?? null, cacheRead: model.cost.cacheRead ?? null, cacheWrite: model.cost.cacheWrite ?? null } : null,
    ...capabilities.get(identity(model)),
  }));
}

export function parseModelSelection(value, models, options = {}) {
  const trimmed = String(value ?? "").trim();
  const match = /^(.*?)(?::(off|minimal|low|medium|high|xhigh|max))?$/u.exec(trimmed);
  const model = match?.[1];
  const thinking = match?.[2] ?? "medium";
  const metadata = model ? availableMap(models).get(model) : undefined;
  if (!model || !metadata) throw new Error("selected_model_not_available");
  const capability = capabilityMap(models, options).get(model);
  if (!capability?.usable) throw new Error(`selected_model_not_runtime_callable:${blockedReason(capability)}`);
  if (!supportedThinkingLevels(metadata).includes(thinking)) throw new Error("selected_thinking_not_supported");
  return { model, thinking };
}

export function assertModelRoute(routeValue, response) {
  const reported = typeof response?.model === "string" ? response.model : "";
  const match = /^([^/\s]+)\/([^/:\s]+)(?::(off|minimal|low|medium|high|xhigh|max))?$/u.exec(reported);
  if (!match || !routeValue || (match[3] && match[3] !== response?.thinking) || `${match[1]}/${match[2]}` !== routeValue.model || response?.thinking !== routeValue.thinking) throw new Error("runtime_model_route_mismatch");
  return true;
}

export function canonicalExecutedRoute(routeValue, response) {
  assertModelRoute(routeValue, response);
  return { ...response, model: routeValue.model, thinking: routeValue.thinking };
}

export function policyWithPreset(stored, preset) {
  if (!MODEL_PRESETS.includes(preset)) throw new Error("unknown_model_preset");
  if (preset === "custom") return { ...stored, preset: "custom", updatedAt: new Date().toISOString() };
  return { version: MODEL_POLICY_VERSION, preset, basePreset: preset, overrides: {}, updatedAt: new Date().toISOString() };
}

export function policyWithRole(stored, role, routeValue) {
  if (!MODEL_ROLES.includes(role)) throw new Error("unknown_model_role");
  return { ...stored, preset: "custom", basePreset: stored.preset === "custom" ? stored.basePreset : stored.preset, overrides: { ...stored.overrides, [role]: routeValue }, updatedAt: new Date().toISOString() };
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
