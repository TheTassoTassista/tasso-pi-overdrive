import { createHash } from "node:crypto";
import { validateTaskPolicy } from "./task-governor.mjs";

export const TOOL_POLICY_VERSION = 1;
export const TOOL_TIERS = Object.freeze({
  ESSENTIAL: "always-essential",
  CONDITIONAL: "conditional",
  HIGH_RISK: "high-risk-conditional",
  HIDDEN: "hidden-on-demand",
  CONTROLLER_ONLY: "controller-only",
});

const DEFINITIONS = Object.freeze([
  { name: "read", capability: "read", tier: TOOL_TIERS.ESSENTIAL },
  { name: "grep", capability: "search", tier: TOOL_TIERS.CONDITIONAL },
  { name: "find", capability: "search", tier: TOOL_TIERS.CONDITIONAL },
  { name: "ls", capability: "directory-read", tier: TOOL_TIERS.HIDDEN },
  { name: "ffgrep", capability: "search", tier: TOOL_TIERS.CONDITIONAL },
  { name: "fffind", capability: "search", tier: TOOL_TIERS.CONDITIONAL },
  { name: "ast_grep_run", capability: "search", tier: TOOL_TIERS.CONDITIONAL },
  { name: "ast_grep_scan", capability: "structural-analysis", tier: TOOL_TIERS.HIDDEN },
  { name: "ast_grep_outline", capability: "structural-analysis", tier: TOOL_TIERS.HIDDEN },
  { name: "ast_grep_debug_query", capability: "structural-analysis", tier: TOOL_TIERS.HIDDEN },
  { name: "transactional_edit", capability: "edit", tier: TOOL_TIERS.CONDITIONAL },
  { name: "edit", capability: "edit", tier: TOOL_TIERS.CONDITIONAL },
  { name: "write", capability: "edit", tier: TOOL_TIERS.CONDITIONAL },
  { name: "transactional_ast_edit", capability: "structural-edit", tier: TOOL_TIERS.CONDITIONAL },
  { name: "ast_grep_rewrite", capability: "structural-edit", tier: TOOL_TIERS.CONDITIONAL },
  { name: "resource_fs", capability: "resources", tier: TOOL_TIERS.CONDITIONAL },
  { name: "smart_read", capability: "smart-read", tier: TOOL_TIERS.CONDITIONAL },
  { name: "semantic_nav", capability: "lsp", tier: TOOL_TIERS.CONDITIONAL },
  { name: "ts_definition", capability: "lsp", tier: TOOL_TIERS.CONDITIONAL },
  { name: "ts_references", capability: "lsp", tier: TOOL_TIERS.CONDITIONAL },
  { name: "ts_diagnostics", capability: "lsp", tier: TOOL_TIERS.CONDITIONAL },
  { name: "task_notebook", capability: "memory", tier: TOOL_TIERS.CONDITIONAL },
  { name: "verification_gate", capability: "verify", tier: TOOL_TIERS.CONDITIONAL },
  { name: "secure_coding_workflow", capability: "workflow", tier: TOOL_TIERS.CONDITIONAL },
  { name: "debug_engine", capability: "debug", tier: TOOL_TIERS.CONDITIONAL },
  { name: "persistent_python", capability: "eval", tier: TOOL_TIERS.CONDITIONAL },
  { name: "persistent_javascript", capability: "eval", tier: TOOL_TIERS.CONDITIONAL },
  { name: "sentinel", capability: "sentinel", tier: TOOL_TIERS.CONDITIONAL },
  { name: "agent_browser", capability: "browser", tier: TOOL_TIERS.HIGH_RISK },
  { name: "web_research", capability: "web", tier: TOOL_TIERS.HIGH_RISK },
  { name: "safe_web_fetch", capability: "web", tier: TOOL_TIERS.HIGH_RISK },
  { name: "safe_exec", capability: "execution", tier: TOOL_TIERS.HIDDEN },
  { name: "mcp", capability: "external-integration", tier: TOOL_TIERS.HIDDEN },
  { name: "bash", capability: "raw-execution", tier: TOOL_TIERS.CONTROLLER_ONLY },
  { name: "powershell", capability: "raw-execution", tier: TOOL_TIERS.CONTROLLER_ONLY },
  { name: "subagent", capability: "raw-delegation", tier: TOOL_TIERS.CONTROLLER_ONLY },
  { name: "safe_remove_file", capability: "destructive-mutation", tier: TOOL_TIERS.CONTROLLER_ONLY },
]);

const BY_NAME = new Map(DEFINITIONS.map((entry) => [entry.name, entry]));
const AUTO_TIERS = new Set([TOOL_TIERS.ESSENTIAL, TOOL_TIERS.CONDITIONAL, TOOL_TIERS.HIGH_RISK]);
const CLI_FLAGS = Object.freeze(["--tools", "-t", "--no-tools", "-nt", "--no-builtin-tools", "-nbt", "--exclude-tools", "-xt"]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function digestPolicy(value) {
  const copy = structuredClone(value);
  delete copy.digest;
  return createHash("sha256").update(JSON.stringify(copy)).digest("hex");
}

function normalizeNames(value, error) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry)) throw new Error(error);
  return [...new Set(value)];
}

function capabilityCandidates(capability) {
  return DEFINITIONS.filter((entry) => entry.capability === capability && AUTO_TIERS.has(entry.tier));
}

function isAutomaticallyEnabled(definition, taskPolicy, capabilities, available) {
  if (definition.tier === TOOL_TIERS.ESSENTIAL) return true;
  if (!AUTO_TIERS.has(definition.tier) || !capabilities.includes(definition.capability)) return false;
  if (definition.name === "grep" && available.has("ffgrep")) return false;
  if (definition.name === "find" && available.has("fffind")) return false;
  if (definition.name === "ast_grep_run" && taskPolicy.classification.signals.code !== true) return false;
  if (definition.name === "ast_grep_rewrite" && available.has("transactional_ast_edit")) return false;
  if (definition.name === "edit" && available.has("transactional_edit")) return false;
  if (definition.name === "write" && taskPolicy.classification.signals.directSmallEdit === true && (available.has("transactional_edit") || available.has("edit"))) return false;
  return true;
}

export function classifyTool(name) {
  const definition = BY_NAME.get(String(name));
  return definition ? deepFreeze({ ...definition }) : deepFreeze({ name: String(name), capability: "unclassified", tier: "unclassified-denied" });
}

export function hasExplicitToolCliPolicy(argv = []) {
  return argv.some((argument) => CLI_FLAGS.some((flag) => argument === flag || argument.startsWith(`${flag}=`)));
}

export function resolveToolPolicy(input = {}) {
  const taskPolicy = validateTaskPolicy(input.taskPolicy);
  const availableTools = normalizeNames(input.availableTools, "tool_policy_available_invalid");
  const available = new Set(availableTools);
  const requestedCapabilities = [...taskPolicy.toolNeed.capabilities];
  const workflowNeeded = taskPolicy.classification.signals.mutating
    && (taskPolicy.needs.planner || taskPolicy.needs.reviewer || taskPolicy.needs.council);
  if (workflowNeeded) requestedCapabilities.push("workflow");
  const capabilities = [...new Set(requestedCapabilities)];

  const activeTools = [];
  for (const definition of DEFINITIONS) {
    if (!available.has(definition.name)) continue;
    if (isAutomaticallyEnabled(definition, taskPolicy, capabilities, available)) activeTools.push(definition.name);
  }

  const coverage = capabilities.map((capability) => {
    const candidates = capabilityCandidates(capability).map((entry) => entry.name);
    const active = candidates.filter((name) => activeTools.includes(name));
    return { capability, status: active.length ? "AVAILABLE" : "UNAVAILABLE", candidates, active };
  });
  const hiddenAvailable = DEFINITIONS.filter((entry) => entry.tier === TOOL_TIERS.HIDDEN && available.has(entry.name)).map((entry) => entry.name);
  const controllerOnlyAvailable = DEFINITIONS.filter((entry) => entry.tier === TOOL_TIERS.CONTROLLER_ONLY && available.has(entry.name)).map((entry) => entry.name);
  const unclassifiedAvailable = availableTools.filter((name) => !BY_NAME.has(name));
  const highRiskActive = activeTools.filter((name) => BY_NAME.get(name)?.tier === TOOL_TIERS.HIGH_RISK);
  const policyWithoutDigest = {
    version: TOOL_POLICY_VERSION,
    kind: "TOOL_POLICY",
    source: "deterministic-v1",
    decisionModelCalls: 0,
    mode: "auto",
    taskPolicyDigest: taskPolicy.digest,
    availableTools,
    capabilities,
    activeTools,
    inactiveToolCount: availableTools.length - activeTools.length,
    coverage,
    unavailableCapabilities: coverage.filter((entry) => entry.status === "UNAVAILABLE").map((entry) => entry.capability),
    highRiskActive,
    hiddenAvailable,
    controllerOnlyAvailable,
    unclassifiedAvailable,
  };
  return deepFreeze({ ...policyWithoutDigest, digest: digestPolicy(policyWithoutDigest) });
}

export function validateToolPolicy(value, taskPolicy) {
  if (!value || value.version !== TOOL_POLICY_VERSION || value.kind !== "TOOL_POLICY" || value.source !== "deterministic-v1" || value.decisionModelCalls !== 0 || value.mode !== "auto") throw new Error("tool_policy_invalid");
  const checkedTask = validateTaskPolicy(taskPolicy);
  if (value.taskPolicyDigest !== checkedTask.digest) throw new Error("tool_policy_task_mismatch");
  const capabilities = normalizeNames(value.capabilities, "tool_policy_capabilities_invalid");
  const activeTools = normalizeNames(value.activeTools, "tool_policy_active_invalid");
  const availableTools = normalizeNames(value.availableTools, "tool_policy_available_invalid");
  if (activeTools.some((name) => !BY_NAME.has(name) || !AUTO_TIERS.has(BY_NAME.get(name).tier))) throw new Error("tool_policy_active_forbidden");
  for (const name of activeTools.filter((entry) => BY_NAME.get(entry)?.tier === TOOL_TIERS.HIGH_RISK)) {
    if (!capabilities.includes(BY_NAME.get(name).capability)) throw new Error("tool_policy_high_risk_mismatch");
  }
  if (!activeTools.includes("read") && value.coverage?.some((entry) => entry.capability === "read" && entry.active?.includes("read"))) throw new Error("tool_policy_read_mismatch");
  for (const key of ["coverage", "unavailableCapabilities", "highRiskActive", "hiddenAvailable", "controllerOnlyAvailable", "unclassifiedAvailable"]) if (!Array.isArray(value[key])) throw new Error("tool_policy_shape_invalid");
  if (!Number.isSafeInteger(value.inactiveToolCount) || value.inactiveToolCount < 0) throw new Error("tool_policy_count_invalid");
  if (!/^[0-9a-f]{64}$/u.test(value.digest ?? "") || digestPolicy(value) !== value.digest) throw new Error("tool_policy_digest_invalid");
  const expected = resolveToolPolicy({ taskPolicy: checkedTask, availableTools });
  if (expected.digest !== value.digest) throw new Error("tool_policy_semantic_mismatch");
  return deepFreeze(structuredClone(value));
}

export function toolPolicyMetadata(policy, taskPolicy) {
  const checked = validateToolPolicy(policy, taskPolicy);
  return deepFreeze({
    kind: "tool_governor_surface",
    version: checked.version,
    source: checked.source,
    decisionModelCalls: checked.decisionModelCalls,
    mode: checked.mode,
    taskPolicyDigest: checked.taskPolicyDigest,
    activeToolCount: checked.activeTools.length,
    inactiveToolCount: checked.inactiveToolCount,
    activeTools: [...checked.activeTools],
    highRiskActive: [...checked.highRiskActive],
    unavailableCapabilities: [...checked.unavailableCapabilities],
    digest: checked.digest,
  });
}

export function resolveManualToolChange(input = {}) {
  const availableTools = normalizeNames(input.availableTools, "tool_manual_available_invalid");
  const activeTools = normalizeNames(input.activeTools, "tool_manual_active_invalid");
  const action = String(input.action ?? "");
  const name = String(input.name ?? "");
  if (!new Set(["enable", "disable"]).has(action)) throw new Error("usage: /tools [auto|enable NAME|disable NAME]");
  if (!availableTools.includes(name)) throw new Error("tool_not_available");
  const definition = BY_NAME.get(name);
  if (!definition) throw new Error("tool_unclassified_denied");
  if (definition.tier === TOOL_TIERS.CONTROLLER_ONLY) throw new Error("tool_controller_only");
  const selected = new Set(activeTools.filter((entry) => availableTools.includes(entry)));
  if (action === "enable") selected.add(name);
  else selected.delete(name);
  return deepFreeze({ mode: "manual", activeTools: availableTools.filter((entry) => selected.has(entry)), changed: name, action, tier: definition.tier });
}

export function renderToolPolicy(policy, taskPolicy, json = false) {
  const checked = validateToolPolicy(policy, taskPolicy);
  if (json) return JSON.stringify(checked, null, 2);
  return [
    `Tool policy ${checked.digest.slice(0, 16)} (${checked.source}; ${checked.decisionModelCalls} model calls)`,
    `Active (${checked.activeTools.length}): ${checked.activeTools.join(", ") || "none"}`,
    `Capabilities: ${checked.capabilities.join(", ")}`,
    `Unavailable: ${checked.unavailableCapabilities.join(", ") || "none"}`,
    `High-risk active: ${checked.highRiskActive.join(", ") || "none"}`,
    `Hidden/on-demand available: ${checked.hiddenAvailable.join(", ") || "none"}`,
    `Controller-only available: ${checked.controllerOnlyAvailable.join(", ") || "none"}`,
    `Unclassified/denied: ${checked.unclassifiedAvailable.join(", ") || "none"}`,
  ].join("\n");
}
