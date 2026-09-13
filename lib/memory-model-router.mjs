import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MEMORY_MODEL_POLICY_FILE = path.join(root, "config", "memory-model-policy.json");

export function readMemoryModelPolicy(file = MEMORY_MODEL_POLICY_FILE) {
  const policy = JSON.parse(fs.readFileSync(file, "utf8"));
  if (policy.version !== 1 || policy.scope !== "durable-memory-enrichment-only" || policy.fanout !== false || policy.maxRemoteCallsPerOperation !== 1) throw new Error("memory_model_policy_invalid");
  return Object.freeze(policy);
}

/** Resolve one enrichment source without performing inference or changing normal Pi routing. */
export function routeMemoryEnrichment({ reusableOutput, localAvailable = true, remoteRuntime = {}, allowRemote = false, allowSubscription = false, importance = "normal", policy = readMemoryModelPolicy() } = {}) {
  if (typeof reusableOutput === "string" && reusableOutput.trim()) return Object.freeze({ tier: "REUSE", source: "task-output", remoteCalls: 0 });
  if (localAvailable) return Object.freeze({ tier: "LOCAL", source: "deterministic", remoteCalls: 0 });
  const free = "omniroute/groq/qwen/qwen3-32b";
  if (allowRemote && policy.models[free]?.costStatus === "ZERO_EXTRA_COST" && remoteRuntime[free] === "RUNTIME_CALLABLE") {
    return Object.freeze({ tier: "REMOTE_FREE", source: free, remoteCalls: 1 });
  }
  const last = "openai-codex/gpt-5.6-sol";
  if (allowSubscription && importance === "durable-critical" && policy.models[last]?.runtimeStatus === "RUNTIME_CALLABLE") {
    return Object.freeze({ tier: "SUBSCRIPTION_LAST_RESORT", source: last, remoteCalls: 1 });
  }
  return Object.freeze({ tier: "UNAVAILABLE", source: "none", remoteCalls: 0, reason: "fail_closed" });
}
