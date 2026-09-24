import { createHash } from "node:crypto";
import fs from "node:fs";
import profileConfig from "../config/model-harness-profiles.json" with { type: "json" };
import routingPolicy from "../config/routing-policy.json" with { type: "json" };
import { assessModelCapability, readModelCallability } from "./model-callability.mjs";
import { resolveProfileEditBenchmarks } from "./edit-benchmark-evidence.mjs";

export const MODEL_HARNESS_PROFILE_VERSION = 1;
export const EVIDENCE_LEVELS = Object.freeze(["DECLARED", "VERIFIED", "BENCHMARKED", "INFERRED", "UNKNOWN"]);
export const EDIT_CONTRACT_TOOLS = Object.freeze({
  HASH_ANCHORED: "transactional_edit",
  APPLY_PATCH: "apply_patch",
  REPLACE: "edit",
  AST_STRUCTURAL: "transactional_ast_edit",
});
const CONTRACTS = new Set(Object.keys(EDIT_CONTRACT_TOOLS));
const LEVELS = new Set(EVIDENCE_LEVELS);

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function digest(value) {
  const copy = structuredClone(value);
  delete copy.digest;
  return createHash("sha256").update(JSON.stringify(copy)).digest("hex");
}

function identityOf(model) {
  return model && typeof model.provider === "string" && typeof model.id === "string" ? `${model.provider}/${model.id}` : "";
}

function routingDefinition(identity) {
  return Object.values(routingPolicy.models).find((entry) => entry.identity === identity);
}

function evidence(level, source, value = null) {
  if (!LEVELS.has(level) || typeof source !== "string" || !source) throw new Error("model_profile_evidence_invalid");
  return freeze({ level, source, value });
}

function validateLayer(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.id !== "string" || !value.id) throw new Error(`model_profile_layer_invalid:${name}`);
  if (Object.keys(value).some((key) => !["id", "toolConstraints", "editContracts", "declaredCapabilities"].includes(key))) throw new Error(`model_profile_layer_field:${name}`);
  if (value.toolConstraints) {
    if (!Array.isArray(value.toolConstraints.deniedTools) || value.toolConstraints.deniedTools.some((entry) => typeof entry !== "string" || !entry) || Object.keys(value.toolConstraints).some((key) => key !== "deniedTools")) throw new Error(`model_profile_tools_invalid:${name}`);
  }
  if (value.editContracts) {
    for (const key of ["ordinary", "structural"]) if (!Array.isArray(value.editContracts[key]) || value.editContracts[key].length < 1 || value.editContracts[key].length > 2 || value.editContracts[key].some((entry) => !CONTRACTS.has(entry))) throw new Error(`model_profile_edit_invalid:${name}`);
    if (value.editContracts.maxFallbacks !== 1 || Object.keys(value.editContracts).some((key) => !["ordinary", "structural", "maxFallbacks"].includes(key))) throw new Error(`model_profile_edit_invalid:${name}`);
  }
  if (value.declaredCapabilities) {
    for (const [capability, record] of Object.entries(value.declaredCapabilities)) {
      if (!capability || !record || !LEVELS.has(record.level) || typeof record.source !== "string" || Object.keys(record).some((key) => !["level", "source"].includes(key))) throw new Error(`model_profile_capability_invalid:${name}`);
    }
  }
  return value;
}

export function validateModelHarnessProfileConfig(value = profileConfig) {
  if (!value || value.version !== MODEL_HARNESS_PROFILE_VERSION || !value.generic || !value.families || !value.providers || !value.models) throw new Error("model_profile_config_invalid");
  if (Object.keys(value).some((key) => !["version", "generic", "families", "providers", "models"].includes(key))) throw new Error("model_profile_config_field");
  validateLayer(value.generic, "generic");
  for (const [group, layers] of [["family", value.families], ["provider", value.providers], ["model", value.models]]) {
    if (!layers || typeof layers !== "object" || Array.isArray(layers)) throw new Error(`model_profile_${group}_invalid`);
    for (const [name, layer] of Object.entries(layers)) validateLayer(layer, `${group}:${name}`);
  }
  return value;
}

export function readModelHarnessProfileConfig(environment = process.env) {
  const file = environment.PI_OVERDRIVE_MODEL_HARNESS_PROFILES;
  if (!file) return validateModelHarnessProfileConfig(profileConfig);
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) throw new Error("model_profile_config_permissions");
    return validateModelHarnessProfileConfig(JSON.parse(fs.readFileSync(descriptor, "utf8")));
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function mergeLayer(target, layer, provenance, match) {
  if (!layer) return target;
  provenance.push({ scope: match.scope, key: match.key, id: layer.id, source: "config/model-harness-profiles.json" });
  return {
    ...target,
    id: layer.id,
    ...(layer.toolConstraints ? { toolConstraints: structuredClone(layer.toolConstraints) } : {}),
    ...(layer.editContracts ? { editContracts: structuredClone(layer.editContracts) } : {}),
    declaredCapabilities: { ...(target.declaredCapabilities ?? {}), ...(structuredClone(layer.declaredCapabilities ?? {})) },
  };
}

function thinkingLevels(model) {
  if (model?.reasoning !== true) return ["off"];
  const mapping = model.thinkingLevelMap && typeof model.thinkingLevelMap === "object" ? model.thinkingLevelMap : {};
  return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].filter((level) => !(["xhigh", "max"].includes(level) && mapping[level] === undefined) && mapping[level] !== null);
}

export function resolveModelHarnessProfile(input = {}) {
  const config = validateModelHarnessProfileConfig(input.config ?? readModelHarnessProfileConfig(input.environment));
  const model = input.model;
  const identity = input.identity ?? identityOf(model);
  const provider = input.provider ?? model?.provider ?? identity.split("/")[0] ?? "";
  const definition = routingDefinition(identity);
  const family = input.family ?? definition?.family ?? "UNKNOWN";
  const provenance = [];
  let merged = mergeLayer({}, config.generic, provenance, { scope: "generic", key: "*" });
  merged = mergeLayer(merged, config.families[family], provenance, { scope: "family", key: family });
  merged = mergeLayer(merged, config.providers[provider], provenance, { scope: "provider", key: provider });
  merged = mergeLayer(merged, config.models[identity], provenance, { scope: "model", key: identity });

  const callability = input.callability ?? readModelCallability();
  const capability = identity ? assessModelCapability(identity, {
    registeredModels: input.registeredModels ?? (model ? [model] : []),
    authenticatedModels: input.authenticatedModels ?? (model ? [model] : []),
    callability,
  }) : { registryStatus: "REGISTRY_MISSING", authenticationStatus: "AUTH_MISSING", runtimeStatus: "RUNTIME_UNKNOWN", usable: false, reasonCode: "NO_RUNTIME_EVIDENCE", evidenceRunId: null };
  const runtimeLevel = capability.runtimeStatus === "RUNTIME_CALLABLE" && capability.evidenceRunId ? "VERIFIED" : "UNKNOWN";
  const known = provenance.some((entry) => entry.scope !== "generic");
  const result = {
    version: MODEL_HARNESS_PROFILE_VERSION,
    kind: "MODEL_HARNESS_PROFILE",
    id: merged.id,
    match: { identity: identity || "UNKNOWN", provider: provider || "UNKNOWN", family, known },
    provenance,
    capabilities: {
      runtimeCallability: evidence(runtimeLevel, runtimeLevel === "VERIFIED" ? `workflow-receipt:${capability.evidenceRunId}` : "model-callability", capability.runtimeStatus),
      contextWindow: Number.isSafeInteger(model?.contextWindow) && model.contextWindow > 0 ? evidence("DECLARED", "pi-model-registry", model.contextWindow) : evidence("UNKNOWN", "pi-model-registry"),
      maxOutputTokens: Number.isSafeInteger(model?.maxTokens) && model.maxTokens > 0 ? evidence("DECLARED", "pi-model-registry", model.maxTokens) : evidence("UNKNOWN", "pi-model-registry"),
      reasoningLevels: model ? evidence("DECLARED", "pi-model-registry", thinkingLevels(model)) : evidence("UNKNOWN", "pi-model-registry"),
      ...Object.fromEntries(Object.entries(merged.declaredCapabilities ?? {}).map(([name, record]) => [name, evidence(record.level, record.source)])),
    },
    toolConstraints: structuredClone(merged.toolConstraints),
    editContracts: structuredClone(merged.editContracts),
    editBenchmark: resolveProfileEditBenchmarks({ evidence: input.editBenchmarkEvidence, identity, provider, family, editContracts: merged.editContracts, now: input.now }),
    dynamicEvidence: {
      registryStatus: capability.registryStatus,
      authenticationStatus: capability.authenticationStatus,
      runtimeStatus: capability.runtimeStatus,
      reasonCode: capability.reasonCode,
    },
    decisionModelCalls: 0,
  };
  result.digest = digest(result);
  return freeze(result);
}

export function resolveEditContract(profile, input = {}) {
  if (!profile || profile.kind !== "MODEL_HARNESS_PROFILE" || profile.version !== MODEL_HARNESS_PROFILE_VERSION || digest(profile) !== profile.digest) throw new Error("model_profile_invalid");
  const available = new Set(Array.isArray(input.activeTools) ? input.activeTools : []);
  const mode = input.structural === true ? "structural" : "ordinary";
  const candidates = profile.editContracts[mode].slice(0, profile.editContracts.maxFallbacks + 1);
  const preferred = profile.editBenchmark?.[mode]?.level === "BENCHMARKED" ? profile.editBenchmark[mode].preferred : null;
  if (preferred && candidates.includes(preferred)) candidates.sort((left, right) => Number(right === preferred) - Number(left === preferred));
  const usable = candidates.filter((contract) => available.has(EDIT_CONTRACT_TOOLS[contract]));
  return freeze({ mode, selected: usable[0] ?? null, fallback: usable[1] ?? null, maxFallbacks: profile.editContracts.maxFallbacks, activeTools: usable.map((contract) => EDIT_CONTRACT_TOOLS[contract]) });
}

export function constrainToolsForModelProfile(activeTools, profile, options = {}) {
  const active = [...new Set(activeTools ?? [])];
  const denied = new Set(profile.toolConstraints.deniedTools);
  const permitted = active.filter((name) => !denied.has(name));
  const edit = resolveEditContract(profile, { activeTools: permitted, structural: options.structural });
  const editTools = new Set([...Object.values(EDIT_CONTRACT_TOOLS), "write"]);
  const selectedEditTools = new Set(edit.activeTools);
  const constrained = permitted.filter((name) => !editTools.has(name) || selectedEditTools.has(name));
  return freeze({ activeTools: constrained, deniedTools: active.filter((name) => !constrained.includes(name)), editContract: edit, profileDigest: profile.digest });
}

export function contextModelForProfile(model, profile) {
  if (!model || !profile || profile.kind !== "MODEL_HARNESS_PROFILE") throw new Error("model_profile_context_invalid");
  const window = profile.capabilities.contextWindow;
  const output = profile.capabilities.maxOutputTokens;
  return freeze({
    ...model,
    contextWindow: ["VERIFIED", "BENCHMARKED", "DECLARED"].includes(window.level) && Number.isSafeInteger(window.value) ? Math.min(model.contextWindow, window.value) : model.contextWindow,
    maxTokens: ["VERIFIED", "BENCHMARKED", "DECLARED"].includes(output.level) && Number.isSafeInteger(output.value) ? Math.min(model.maxTokens, output.value) : model.maxTokens,
  });
}

export function modelHarnessProfileMetadata(profile, selection) {
  return freeze({
    kind: "model_harness_profile",
    version: profile.version,
    profileId: profile.id,
    identity: profile.match.identity,
    known: profile.match.known,
    runtimeEvidence: profile.capabilities.runtimeCallability.level,
    editContract: selection?.editContract?.selected ?? null,
    deniedToolCount: selection?.deniedTools?.length ?? profile.toolConstraints.deniedTools.length,
    decisionModelCalls: 0,
    digest: profile.digest,
  });
}
