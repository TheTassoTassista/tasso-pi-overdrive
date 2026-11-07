import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isAlwaysProtectedWritePath, isSecretPath } from "./safety.mjs";

export const STREAM_GUARD_VERSION = 1;
export const STREAM_GUARD_ENTRY_TYPE = "tasso-pi-overdrive.stream-guard";
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const policyFile = path.join(packageRoot, "config", "stream-guard.json");
const ruleNames = Object.freeze(["protected-path-intent", "destructive-shell-intent", "safe-exec-bypass-intent"]);
const mutatingPathTools = new Set(["create_file", "write", "edit", "transactional_edit", "transactional_ast_edit", "ast_grep_rewrite"]);
const pathKeys = new Set(["path", "filePath", "file_path", "program", "file", "cwd", "uri"]);
const destructiveShell = /(?:^|[\s;&|])(?:sudo\s+)?(?:rm\s+-[A-Za-z]*r[A-Za-z]*f\b|rm\s+-[A-Za-z]*f[A-Za-z]*r\b|mkfs(?:\.[A-Za-z0-9_-]+)?\b|shutdown\b|reboot\b|poweroff\b|halt\b|dd\s+[^\n;]{0,1024}\bof=\/dev\/|(?:curl|wget)\b[^\n|]{0,2048}\|\s*(?:ba)?sh\b)/iu;
const safeGit = new Set(["status", "diff", "show", "log", "rev-parse", "ls-files", "branch"]);
const sessionBrokers = new Map();

export class StreamGuardError extends Error {
  constructor(code) { super(code); this.name = "StreamGuardError"; this.code = code; }
}

function fail(code) { throw new StreamGuardError(code); }
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function freeze(value) { return Object.freeze(structuredClone(value)); }
function integer(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code);
  return value;
}
function safeString(value, maximum) { return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value); }

export function validateStreamGuardPolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== STREAM_GUARD_VERSION) fail("STREAM_GUARD_POLICY_INVALID");
  const allowed = ["version", "enabled", "maxBufferedArgumentChars", "maxReservationsPerSession", "maxReservationsPerTurn", "cooldownTurns", "rules"];
  if (Object.keys(value).some((key) => !allowed.includes(key)) || typeof value.enabled !== "boolean") fail("STREAM_GUARD_POLICY_UNKNOWN_FIELD");
  if (!value.rules || typeof value.rules !== "object" || Array.isArray(value.rules) || JSON.stringify(Object.keys(value.rules).sort()) !== JSON.stringify([...ruleNames].sort())) fail("STREAM_GUARD_RULES_INVALID");
  const rules = {};
  for (const name of ruleNames) {
    const rule = value.rules[name];
    if (!rule || typeof rule !== "object" || Array.isArray(rule) || JSON.stringify(Object.keys(rule).sort()) !== JSON.stringify(["enabled", "reminder"]) || typeof rule.enabled !== "boolean" || !safeString(rule.reminder, 1024) || !rule.reminder.startsWith("ERROR [STREAMGUARD]")) fail("STREAM_GUARD_RULE_INVALID");
    rules[name] = freeze({ enabled: rule.enabled, reminder: rule.reminder });
  }
  const policy = {
    version: value.version,
    enabled: value.enabled,
    maxBufferedArgumentChars: integer(value.maxBufferedArgumentChars, 1024, 65536, "STREAM_GUARD_BUFFER_LIMIT_INVALID"),
    maxReservationsPerSession: integer(value.maxReservationsPerSession, 1, 64, "STREAM_GUARD_SESSION_LIMIT_INVALID"),
    maxReservationsPerTurn: integer(value.maxReservationsPerTurn, 1, 4, "STREAM_GUARD_TURN_LIMIT_INVALID"),
    cooldownTurns: integer(value.cooldownTurns, 1, 32, "STREAM_GUARD_COOLDOWN_INVALID"),
    rules,
  };
  if (policy.maxReservationsPerTurn > policy.maxReservationsPerSession) fail("STREAM_GUARD_LIMITS_INVALID");
  return freeze(policy);
}

export function readStreamGuardPolicy(file = policyFile) {
  try { return validateStreamGuardPolicy(JSON.parse(fs.readFileSync(file, "utf8"))); }
  catch (error) { if (error instanceof StreamGuardError) throw error; fail("STREAM_GUARD_POLICY_UNREADABLE"); }
}

function pathValues(input) {
  const values = [];
  for (const [key, value] of Object.entries(input)) {
    if (pathKeys.has(key) && typeof value === "string") values.push(value);
    if ((key === "paths" || key === "files") && Array.isArray(value)) for (const item of value) if (typeof item === "string") values.push(item);
  }
  return values;
}

function safeExecBypass(input) {
  const program = typeof input.program === "string" ? input.program : "";
  const args = Array.isArray(input.args) && input.args.every((item) => typeof item === "string") ? input.args : [];
  if (program === "git") {
    const command = args.find((arg) => !arg.startsWith("-"));
    if (!command || !safeGit.has(command)) return true;
    if (args.some((arg) => arg === "--ext-diff" || arg === "--textconv")) return true;
  }
  if (program === "node" && args.some((arg) => ["-e", "--eval", "-p", "--print", "-i", "--interactive"].includes(arg))) return true;
  if ((program === "python" || program === "python3") && args.includes("-c")) return true;
  if ((program === "npm" || program === "pnpm") && args.some((arg) => ["exec", "x", "dlx"].includes(arg))) return true;
  if (program === "fd" && args.some((arg) => ["-x", "-X", "--exec", "--exec-batch"].includes(arg) || arg.startsWith("--exec="))) return true;
  if (program === "rg" && args.some((arg) => arg === "--pre" || arg.startsWith("--pre="))) return true;
  return false;
}

export function classifyStreamGuardIntent(toolName, input, policy = readStreamGuardPolicy()) {
  if (!policy.enabled || !input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const paths = pathValues(input);
  if (policy.rules["protected-path-intent"].enabled && paths.some((candidate) => isSecretPath(candidate) || (mutatingPathTools.has(toolName) && isAlwaysProtectedWritePath(candidate)))) return "protected-path-intent";
  if (policy.rules["destructive-shell-intent"].enabled && toolName === "bash" && typeof input.command === "string" && destructiveShell.test(input.command)) return "destructive-shell-intent";
  if (policy.rules["safe-exec-bypass-intent"].enabled && toolName === "safe_exec" && safeExecBypass(input)) return "safe-exec-bypass-intent";
  return undefined;
}

function validReceipt(value, policy) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== STREAM_GUARD_VERSION || value.kind !== "STREAM_GUARD_RECEIPT" || !["RESERVED", "DELIVERED", "EXPIRED"].includes(value.status) || !ruleNames.includes(value.rule) || !policy.rules[value.rule]?.enabled) return false;
  for (const key of ["reservationId", "reservationDigest", "ruleDigest", "streamKeyDigest"]) if (!safeString(value[key], 64)) return false;
  if (!safeString(value.toolName, 128) || value.source !== "tool" || !Number.isSafeInteger(value.turnSerial) || value.turnSerial < 1 || !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.updatedAt) || !safeString(value.outcome, 64)) return false;
  return true;
}

export class StreamGuardEngine {
  constructor(options = {}) {
    this.policy = validateStreamGuardPolicy(options.policy ?? readStreamGuardPolicy());
    this.now = options.now ?? Date.now;
    this.active = true;
    this.turnSerial = 0;
    this.turnReservations = 0;
    this.buffers = new Map();
    this.pending = new Map();
    this.reservations = new Map();
    this.lastRuleTurn = new Map();
    this.stats = { matches: 0, reservations: 0, delivered: 0, expired: 0, deduplicated: 0, cooldownSuppressed: 0, limitSuppressed: 0, malformedArguments: 0, oversizedArguments: 0 };
    this.restore(options.receipts ?? []);
  }

  restore(receipts) {
    const latest = new Map();
    for (const receipt of receipts) {
      if (!validReceipt(receipt, this.policy)) continue;
      this.turnSerial = Math.max(this.turnSerial, receipt.turnSerial);
      const current = latest.get(receipt.reservationDigest);
      if (!current || receipt.updatedAt >= current.updatedAt) latest.set(receipt.reservationDigest, freeze(receipt));
    }
    for (const receipt of latest.values()) {
      this.reservations.set(receipt.reservationDigest, receipt);
      this.lastRuleTurn.set(receipt.rule, Math.max(this.lastRuleTurn.get(receipt.rule) ?? 0, receipt.turnSerial));
    }
    this.stats.reservations = this.reservations.size;
    this.stats.delivered = [...this.reservations.values()].filter((entry) => entry.status === "DELIVERED").length;
    this.stats.expired = [...this.reservations.values()].filter((entry) => entry.status === "EXPIRED").length;
  }

  beginTurn() {
    if (!this.active) return;
    this.turnSerial += 1;
    this.turnReservations = 0;
    this.buffers.clear();
  }

  startTool(toolCallId, toolName) {
    if (!this.active || !safeString(toolCallId, 256) || !safeString(toolName, 128) || this.buffers.has(toolCallId)) return;
    this.buffers.set(toolCallId, { toolName, text: "", oversized: false });
  }

  observeToolDelta(toolCallId, toolName, delta) {
    if (!this.active || typeof delta !== "string") return undefined;
    this.startTool(toolCallId, toolName);
    const buffer = this.buffers.get(toolCallId);
    if (!buffer || buffer.oversized) return undefined;
    if (buffer.text.length + delta.length > this.policy.maxBufferedArgumentChars) {
      buffer.text = "";
      buffer.oversized = true;
      this.stats.oversizedArguments += 1;
      return undefined;
    }
    buffer.text += delta;
    try {
      const parsed = JSON.parse(buffer.text);
      return this.#match(toolCallId, buffer.toolName, parsed);
    } catch { return undefined; }
  }

  observeToolSnapshot(toolCallId, toolName, input) {
    this.startTool(toolCallId, toolName);
    return this.#match(toolCallId, toolName, input);
  }

  #match(toolCallId, toolName, input) {
    if (!this.active || this.pending.has(toolCallId)) { if (this.pending.has(toolCallId)) this.stats.deduplicated += 1; return undefined; }
    if (!input || typeof input !== "object" || Array.isArray(input)) { this.stats.malformedArguments += 1; return undefined; }
    const rule = classifyStreamGuardIntent(toolName, input, this.policy);
    if (!rule) return undefined;
    this.stats.matches += 1;
    if (this.reservations.size >= this.policy.maxReservationsPerSession || this.turnReservations >= this.policy.maxReservationsPerTurn) { this.stats.limitSuppressed += 1; return undefined; }
    const lastTurn = this.lastRuleTurn.get(rule);
    if (lastTurn !== undefined && this.turnSerial - lastTurn < this.policy.cooldownTurns) { this.stats.cooldownSuppressed += 1; return undefined; }
    const streamKeyDigest = hash(toolCallId);
    const reservationDigest = hash(JSON.stringify({ version: STREAM_GUARD_VERSION, rule, source: "tool", toolName, streamKeyDigest, turnSerial: this.turnSerial }));
    if (this.reservations.has(reservationDigest)) { this.stats.deduplicated += 1; return undefined; }
    const timestamp = this.now();
    const receipt = freeze({
      version: STREAM_GUARD_VERSION,
      kind: "STREAM_GUARD_RECEIPT",
      status: "RESERVED",
      reservationId: reservationDigest.slice(0, 24),
      reservationDigest,
      rule,
      ruleDigest: hash(`${rule}\0${this.policy.rules[rule].reminder}`),
      source: "tool",
      toolName,
      streamKeyDigest,
      turnSerial: this.turnSerial,
      createdAt: timestamp,
      updatedAt: timestamp,
      outcome: "PENDING_TOOL_RESULT",
    });
    this.reservations.set(reservationDigest, receipt);
    this.pending.set(toolCallId, { receipt, reminder: this.policy.rules[rule].reminder });
    this.lastRuleTurn.set(rule, this.turnSerial);
    this.turnReservations += 1;
    this.stats.reservations += 1;
    return receipt;
  }

  deliver(toolCallId, toolName = undefined) {
    if (!this.active) return undefined;
    const pending = this.pending.get(toolCallId);
    if (!pending || (toolName !== undefined && pending.receipt.toolName !== toolName)) return undefined;
    this.pending.delete(toolCallId);
    this.buffers.delete(toolCallId);
    const receipt = freeze({ ...pending.receipt, status: "DELIVERED", updatedAt: this.now(), outcome: "SAME_BLOCKED_TOOL_RESULT" });
    this.reservations.set(receipt.reservationDigest, receipt);
    this.stats.delivered += 1;
    return freeze({ receipt, reminder: pending.reminder });
  }

  expirePending(outcome = "TURN_ENDED") {
    const receipts = [];
    for (const pending of this.pending.values()) {
      const receipt = freeze({ ...pending.receipt, status: "EXPIRED", updatedAt: this.now(), outcome });
      this.reservations.set(receipt.reservationDigest, receipt);
      receipts.push(receipt);
      this.stats.expired += 1;
    }
    this.pending.clear();
    this.buffers.clear();
    return freeze(receipts);
  }

  shutdown() {
    const expired = this.expirePending("SESSION_SHUTDOWN");
    this.active = false;
    return expired;
  }

  status() {
    return freeze({ version: STREAM_GUARD_VERSION, enabled: this.policy.enabled, active: this.active, turnSerial: this.turnSerial, pending: this.pending.size, reservationCount: this.reservations.size, limits: { maxBufferedArgumentChars: this.policy.maxBufferedArgumentChars, maxReservationsPerSession: this.policy.maxReservationsPerSession, maxReservationsPerTurn: this.policy.maxReservationsPerTurn, cooldownTurns: this.policy.cooldownTurns }, stats: { ...this.stats } });
  }
}

export function registerStreamGuardSession(sessionId, engine, onReceipt) {
  if (!safeString(sessionId, 512) || !(engine instanceof StreamGuardEngine) || typeof onReceipt !== "function") fail("STREAM_GUARD_BROKER_INVALID");
  const owner = Symbol("stream-guard-session-owner");
  sessionBrokers.set(sessionId, { owner, engine, onReceipt });
  return owner;
}

export function unregisterStreamGuardSession(sessionId, owner) {
  const broker = sessionBrokers.get(sessionId);
  if (!broker || broker.owner !== owner) return false;
  sessionBrokers.delete(sessionId);
  return true;
}

export function consumeBlockedStreamGuard(sessionId, toolCallId, toolName) {
  try {
    if (!safeString(sessionId, 512) || !safeString(toolCallId, 256) || !safeString(toolName, 128)) return undefined;
    const broker = sessionBrokers.get(sessionId);
    if (!broker) return undefined;
    const delivered = broker.engine.deliver(toolCallId, toolName);
    if (!delivered) return undefined;
    broker.onReceipt(delivered.receipt);
    return delivered;
  } catch {
    return undefined;
  }
}

export function streamGuardMetadata(receipt) {
  return freeze({ kind: "stream_guard", version: receipt.version, status: receipt.status, reservationId: receipt.reservationId, reservationDigest: receipt.reservationDigest, rule: receipt.rule, ruleDigest: receipt.ruleDigest, source: receipt.source, toolName: receipt.toolName, streamKeyDigest: receipt.streamKeyDigest, turnSerial: receipt.turnSerial, outcome: receipt.outcome });
}
