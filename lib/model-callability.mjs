import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MODEL_CALLABILITY_VERSION = 1;
export const RUNTIME_STATUSES = Object.freeze(["RUNTIME_CALLABLE", "RUNTIME_REJECTED", "RUNTIME_UNKNOWN"]);
const trackedDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../config/model-callability.json");
const DIGEST = /^[0-9a-f]{64}$/u;
const RUN_ID = /^[0-9a-f-]{36}$/iu;

export function modelCallabilityPath(environment = process.env) {
  return environment.PI_OVERDRIVE_MODEL_CALLABILITY ?? path.join(environment.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "pi-overdrive", "model-callability.json");
}

export function modelIdentity(model) {
  return model && typeof model.provider === "string" && typeof model.id === "string" ? `${model.provider}/${model.id}` : "";
}

export function validateCallabilityCache(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== MODEL_CALLABILITY_VERSION) throw new Error("model_callability_version");
  if (!value.entries || typeof value.entries !== "object" || Array.isArray(value.entries)) throw new Error("model_callability_entries");
  if (Object.keys(value).some((key) => !["version", "provider", "updatedAt", "source", "entries"].includes(key))) throw new Error("model_callability_unknown_field");
  const entries = {};
  for (const [identity, entry] of Object.entries(value.entries)) {
    if (!/^[^/\s]+\/[^/\s]+$/u.test(identity) || !entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("model_callability_entry");
    if (!RUNTIME_STATUSES.includes(entry.runtimeStatus) || entry.runtimeStatus === "RUNTIME_UNKNOWN") throw new Error("model_callability_status");
    if (typeof entry.reasonCode !== "string" || !/^[A-Z0-9_]{3,96}$/u.test(entry.reasonCode)) throw new Error("model_callability_reason");
    if (entry.evidenceRunId !== undefined && !RUN_ID.test(entry.evidenceRunId)) throw new Error("model_callability_run_id");
    if (entry.evidenceDigest !== undefined && !DIGEST.test(entry.evidenceDigest)) throw new Error("model_callability_evidence_digest");
    if (Object.keys(entry).some((key) => !["runtimeStatus", "reasonCode", "evidenceRunId", "evidenceDigest"].includes(key))) throw new Error("model_callability_entry_unknown_field");
    entries[identity] = { ...entry };
  }
  return { ...value, entries };
}

function readOwnerOnlyJson(file) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("model_callability_permissions");
    return JSON.parse(fs.readFileSync(descriptor, "utf8"));
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function readModelCallability(file = modelCallabilityPath(), fallback = trackedDefault) {
  try { return validateCallabilityCache(readOwnerOnlyJson(file)); }
  catch (error) {
    if (error?.code !== "ENOENT") {
      if (error instanceof SyntaxError) throw new Error("model_callability_invalid_json");
      throw error;
    }
  }
  return validateCallabilityCache(JSON.parse(fs.readFileSync(fallback, "utf8")));
}

export function callabilityDigest(cache) {
  return createHash("sha256").update(JSON.stringify(validateCallabilityCache(cache))).digest("hex");
}

export function assessModelCapability(identity, { registeredModels = [], authenticatedModels = [], callability }) {
  const registered = new Set(registeredModels.map(modelIdentity).filter(Boolean));
  const authenticated = new Map(authenticatedModels.map((model) => [modelIdentity(model), model]).filter(([id]) => id));
  const entry = callability?.entries?.[identity];
  const runtimeStatus = entry?.runtimeStatus ?? "RUNTIME_UNKNOWN";
  const registryStatus = registered.has(identity) || authenticated.has(identity) ? "REGISTRY_AVAILABLE" : "REGISTRY_MISSING";
  const authenticationStatus = authenticated.has(identity) ? "AUTHENTICATED" : "AUTH_MISSING";
  return Object.freeze({
    model: identity,
    registryStatus,
    authenticationStatus,
    runtimeStatus,
    usable: registryStatus === "REGISTRY_AVAILABLE" && authenticationStatus === "AUTHENTICATED" && runtimeStatus === "RUNTIME_CALLABLE",
    reasonCode: entry?.reasonCode ?? (runtimeStatus === "RUNTIME_CALLABLE" ? "RUNTIME_FIXTURE_ATTESTED" : runtimeStatus === "RUNTIME_REJECTED" ? "RUNTIME_FIXTURE_REJECTED" : "NO_RUNTIME_EVIDENCE"),
    evidenceRunId: entry?.evidenceRunId ?? null,
    evidenceDigest: entry?.evidenceDigest ?? null,
  });
}

export function capabilityMap(authenticatedModels, options = {}) {
  const callability = options.callability ?? readModelCallability();
  const registeredModels = options.registeredModels ?? authenticatedModels;
  const identities = new Set([...registeredModels, ...authenticatedModels].map(modelIdentity).filter(Boolean));
  for (const identity of Object.keys(callability.entries)) identities.add(identity);
  return new Map([...identities].sort().map((identity) => [identity, assessModelCapability(identity, { registeredModels, authenticatedModels, callability })]));
}
