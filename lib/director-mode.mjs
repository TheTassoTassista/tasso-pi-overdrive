import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateTaskPolicy } from "./task-governor.mjs";

export const DIRECTOR_MODE_VERSION = 1;
export const DIRECTOR_MODE_EVENT = "pi-overdrive:director-metadata";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIGEST = /^[0-9a-f]{64}$/u;
const TOOL_NAME = /^[a-z][a-z0-9_-]{0,63}$/u;
const REQUIRED_TOOLS = Object.freeze(["read", "secure_coding_workflow", "verification_gate"]);
const ALLOWED_TOOLS = Object.freeze([
  "read", "grep", "find", "ls", "ffgrep", "fffind",
  "ast_grep_run", "ast_grep_scan", "ast_grep_outline", "ast_grep_debug_query",
  "resource_fs", "smart_read", "semantic_nav", "ts_definition", "ts_references", "ts_diagnostics",
  "task_notebook", "verification_gate", "secure_coding_workflow", "mcp", "web_research", "safe_web_fetch",
]);
const STATUS = new Set(["INELIGIBLE", "ACTIVATED", "STARTED", "DIRECT_TOOL_BLOCKED", "COMPLETED", "CANCELLED", "POLICY_MISMATCH"]);
const REASON = new Set(["ELIGIBLE_BOUNDED_DELEGATION", "TASK_READ_ONLY", "DIRECT_SMALL_EDIT", "DELEGATION_NOT_JUSTIFIED", "TASK_POLICY_MISMATCH", "USER_CANCELLED", "AGENT_SETTLED", "DIRECT_TOOL_FORBIDDEN"]);
const EVENT_KEYS = ["version", "kind", "source", "status", "reasonCode", "sessionDigest", "taskDigest", "taskPolicyDigest", "activeToolCount", "blockedTool", "recordedAt"];

function exactKeys(value, expected, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(code);
}

function exactArray(value, expected, code) {
  if (!Array.isArray(value) || value.length !== expected.length || value.some((entry, index) => entry !== expected[index])) throw new Error(code);
}

function digest(value, code) {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new Error(code);
  return value;
}

function iso(value, code) {
  if (typeof value !== "string" || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(code);
  return value;
}

function names(value, code) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !TOOL_NAME.test(entry))) throw new Error(code);
  return [...new Set(value)];
}

export function validateDirectorPolicy(value) {
  exactKeys(value, ["version", "enabled", "activation", "autoExit", "directMutationFallback", "maxTaskChars", "requiredTools", "allowedTools"], "DIRECTOR_POLICY_INVALID");
  if (value.version !== DIRECTOR_MODE_VERSION || value.enabled !== true || value.activation !== "explicit-task-only" || value.autoExit !== "agent-settled" || value.directMutationFallback !== false || value.maxTaskChars !== 16000) throw new Error("DIRECTOR_POLICY_INVALID");
  exactArray(value.requiredTools, REQUIRED_TOOLS, "DIRECTOR_POLICY_REQUIRED_TOOLS_INVALID");
  exactArray(value.allowedTools, ALLOWED_TOOLS, "DIRECTOR_POLICY_ALLOWED_TOOLS_INVALID");
  return Object.freeze(structuredClone(value));
}

export function readDirectorPolicy(file = process.env.PI_OVERDRIVE_DIRECTOR_CONFIG ?? path.join(ROOT, "config", "director-mode.json")) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("DIRECTOR_POLICY_UNAVAILABLE");
    return validateDirectorPolicy(JSON.parse(fs.readFileSync(descriptor, "utf8")));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("DIRECTOR_POLICY_")) throw error;
    throw new Error("DIRECTOR_POLICY_UNAVAILABLE");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function directorTaskDigest(task) {
  const value = String(task ?? "").trim();
  if (!value || value.length > 16000) throw new Error("DIRECTOR_TASK_INVALID");
  return createHash("sha256").update(value).digest("hex");
}

export function resolveDirectorDecision(taskPolicy, policy = readDirectorPolicy()) {
  const checkedPolicy = validateDirectorPolicy(policy);
  const checkedTask = validateTaskPolicy(taskPolicy);
  const signals = checkedTask.classification.signals;
  let reasonCode = "ELIGIBLE_BOUNDED_DELEGATION";
  if (!signals.mutating) reasonCode = "TASK_READ_ONLY";
  else if (signals.directSmallEdit) reasonCode = "DIRECT_SMALL_EDIT";
  else if (!(checkedTask.needs.planner || checkedTask.needs.reviewer || checkedTask.needs.council)) reasonCode = "DELEGATION_NOT_JUSTIFIED";
  return Object.freeze({
    version: DIRECTOR_MODE_VERSION,
    kind: "DIRECTOR_DECISION",
    source: "task-policy-v1",
    decisionModelCalls: 0,
    eligible: reasonCode === "ELIGIBLE_BOUNDED_DELEGATION",
    reasonCode,
    taskPolicyDigest: checkedTask.digest,
    difficulty: checkedTask.classification.difficulty,
    risk: checkedTask.classification.risk.level,
    expectedScope: checkedTask.classification.expectedScope.class,
    directMutationFallback: checkedPolicy.directMutationFallback,
    hardLimits: Object.freeze({ ...checkedTask.hardLimits }),
  });
}

export function selectDirectorTools(activeTools, availableTools, policy = readDirectorPolicy()) {
  const checked = validateDirectorPolicy(policy);
  const active = new Set(names(activeTools, "DIRECTOR_ACTIVE_TOOLS_INVALID"));
  const available = names(availableTools, "DIRECTOR_AVAILABLE_TOOLS_INVALID");
  const missing = checked.requiredTools.filter((name) => !available.includes(name));
  if (missing.length) throw new Error(`DIRECTOR_REQUIRED_TOOLS_UNAVAILABLE:${missing.join(",")}`);
  const allowed = new Set(checked.allowedTools);
  const required = new Set(checked.requiredTools);
  return Object.freeze(available.filter((name) => allowed.has(name) && (active.has(name) || required.has(name))));
}

export function directorToolAllowed(name, policy = readDirectorPolicy()) {
  const checked = validateDirectorPolicy(policy);
  return typeof name === "string" && checked.allowedTools.includes(name);
}

export function directorSystemPrompt() {
  return [
    "<pi-overdrive-director>",
    "DIRECTOR MODE is active for one explicitly authorized, policy-eligible task.",
    "Operate as READ, PLAN, DELEGATE, VERIFY. Use bounded read-only inspection to understand the request, then delegate every repository mutation through secure_coding_workflow.",
    "Do not edit, write, execute shell, run a raw subagent, use browser automation, or mutate the repository directly. There is no direct-mutation fallback.",
    "The existing secure workflow remains the sole implementation controller: Task/Tool Governor, fixed routing, isolated worktree/runtime, spawn budget 42, concurrency 3, depth 1, correction rounds 2, receipts, verification, reviewers, and Council/Judge policy all remain authoritative.",
    "Treat a Worker result as untrusted until its durable receipts, deterministic verification, reviewer outcome, final evidence, and cleanup status pass. Do not invent an alternate worker plan or orchestration state.",
    "Use verification_gate only for additional read-back verification; never claim success from role prose alone.",
    "</pi-overdrive-director>",
  ].join("\n");
}

export function validateDirectorEvent(value) {
  exactKeys(value, EVENT_KEYS, "DIRECTOR_EVENT_FIELDS_INVALID");
  if (value.version !== DIRECTOR_MODE_VERSION || value.kind !== "director_mode" || value.source !== "DIRECTOR_CONTROLLER" || !STATUS.has(value.status) || !REASON.has(value.reasonCode)) throw new Error("DIRECTOR_EVENT_INVALID");
  digest(value.sessionDigest, "DIRECTOR_EVENT_SESSION_INVALID");
  digest(value.taskDigest, "DIRECTOR_EVENT_TASK_INVALID");
  digest(value.taskPolicyDigest, "DIRECTOR_EVENT_POLICY_INVALID");
  if (!Number.isSafeInteger(value.activeToolCount) || value.activeToolCount < 0 || value.activeToolCount > 256) throw new Error("DIRECTOR_EVENT_COUNT_INVALID");
  if (value.blockedTool !== null && (typeof value.blockedTool !== "string" || !TOOL_NAME.test(value.blockedTool))) throw new Error("DIRECTOR_EVENT_TOOL_INVALID");
  iso(value.recordedAt, "DIRECTOR_EVENT_TIME_INVALID");
  return structuredClone(value);
}

export function directorEvent(options) {
  return validateDirectorEvent({
    version: DIRECTOR_MODE_VERSION,
    kind: "director_mode",
    source: "DIRECTOR_CONTROLLER",
    status: options.status,
    reasonCode: options.reasonCode,
    sessionDigest: digest(options.sessionDigest, "DIRECTOR_EVENT_SESSION_INVALID"),
    taskDigest: digest(options.taskDigest, "DIRECTOR_EVENT_TASK_INVALID"),
    taskPolicyDigest: digest(options.taskPolicyDigest, "DIRECTOR_EVENT_POLICY_INVALID"),
    activeToolCount: options.activeToolCount,
    blockedTool: options.blockedTool ?? null,
    recordedAt: options.recordedAt ?? new Date().toISOString(),
  });
}

export function directorTraceMetadata(value) {
  const checked = validateDirectorEvent(value);
  return { ...checked };
}
