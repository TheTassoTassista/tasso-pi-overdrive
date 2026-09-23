import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePrivateDirectory } from "./memory-security.mjs";

export const EDITOR_BRIDGE_VERSION = 1;
export const ACP_PROTOCOL_VERSION = 1;
export const EDITOR_APPROVAL_TITLE = "Pi Overdrive editor approval";
export const EDITOR_APPROVAL_PREFIX = "OVERDRIVE_EDITOR_APPROVAL_V1 ";
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultPolicyFile = path.join(packageRoot, "config", "editor-bridge.json");
const approvalExtension = path.join(packageRoot, "extensions", "editor-approval.ts");
const HEX_64 = /^[0-9a-f]{64}$/u;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const APPROVAL_KINDS = new Set(["edit", "execute", "fetch", "other"]);
const STOP_REASONS = new Set(["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"]);
const POLICY_KEYS = [
  "version", "enabled", "protocolVersion", "expectedPiVersion", "maxSessions", "maxConcurrentPrompts",
  "maxFrameBytes", "maxPiFrameBytes", "maxPromptChars", "maxUpdateChars", "commandTimeoutMs",
  "promptTimeoutMs", "permissionTimeoutMs", "shutdownTimeoutMs", "maxReceiptEvents", "maxReceiptBytes",
  "allowSessionPersistence", "allowClientMcp", "allowAdditionalDirectories", "allowClientFilesystem",
  "allowClientTerminal", "allowClientRouteChanges", "allowSlashCommands", "approvalTools", "digest",
];
const REQUIRED_APPROVAL_TOOLS = Object.freeze([
  "agent_browser", "ast_grep_rewrite", "bash", "debug_engine", "edit", "mcp", "persistent_javascript",
  "persistent_python", "powershell", "safe_exec", "safe_remove_file", "safe_web_fetch",
  "secure_coding_workflow", "subagent", "transactional_ast_edit", "transactional_edit", "verification_gate",
  "web_research", "write",
]);
const RECEIPT_FIELDS = Object.freeze({
  bridge_started: ["policyDigest", "rootDigest", "piVersion", "piBinaryDigest"],
  initialized: ["clientDigest", "protocolVersion"],
  session_started: ["sessionDigest", "provider", "model", "thinking"],
  prompt_started: ["requestDigest", "promptDigest", "promptChars", "sequence"],
  tool_started: ["toolCallDigest", "toolName", "toolKind"],
  tool_finished: ["toolCallDigest", "toolName", "status"],
  assistant_error: ["errorDigest", "errorBytes", "errorClass"],
  permission_requested: ["permissionDigest", "toolCallDigest", "inputDigest", "toolName", "toolKind"],
  permission_decided: ["permissionDigest", "toolCallDigest", "inputDigest", "toolName", "decision"],
  prompt_finished: ["requestDigest", "stopReason", "provider", "model", "thinking", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens", "cost"],
  cancel_requested: ["requestDigest"],
  session_closed: ["sessionDigest", "status"],
  child_exit: ["exitCode", "signal", "stderrBytes", "stderrDigest", "stderrClass", "stderrSubject"],
  bridge_stopped: ["status"],
});

export class EditorBridgeError extends Error {
  constructor(code, rpcCode = -32602) { super(code); this.name = "EditorBridgeError"; this.code = code; this.rpcCode = rpcCode; }
}

function fail(code, rpcCode) { throw new EditorBridgeError(code, rpcCode); }
function hash(value) { return createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex"); }
function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}
function integer(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code);
  return value;
}
function exactKeys(value, allowed, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) fail(code);
  return value;
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}
function withTimeout(promise, milliseconds, code) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new EditorBridgeError(code, -32603)), milliseconds); timer.unref?.(); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
function sameIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs; }
function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
  return value;
}

export function validateEditorBridgePolicy(value) {
  exactKeys(value, POLICY_KEYS, "editor_policy_invalid");
  if (value.version !== EDITOR_BRIDGE_VERSION || value.enabled !== true || value.protocolVersion !== ACP_PROTOCOL_VERSION || value.expectedPiVersion !== "0.85.1") fail("editor_policy_identity_invalid");
  for (const key of ["allowSessionPersistence", "allowClientMcp", "allowAdditionalDirectories", "allowClientFilesystem", "allowClientTerminal", "allowClientRouteChanges", "allowSlashCommands"]) if (value[key] !== false) fail("editor_policy_authority_invalid");
  const approvalTools = [...new Set(Array.isArray(value.approvalTools) ? value.approvalTools : [])].sort();
  if (approvalTools.some((name) => typeof name !== "string" || !SAFE_NAME.test(name)) || JSON.stringify(approvalTools) !== JSON.stringify([...REQUIRED_APPROVAL_TOOLS].sort())) fail("editor_policy_approval_tools_invalid");
  const policy = {
    version: value.version,
    enabled: true,
    protocolVersion: value.protocolVersion,
    expectedPiVersion: value.expectedPiVersion,
    maxSessions: integer(value.maxSessions, 1, 1, "editor_policy_sessions_invalid"),
    maxConcurrentPrompts: integer(value.maxConcurrentPrompts, 1, 1, "editor_policy_prompts_invalid"),
    maxFrameBytes: integer(value.maxFrameBytes, 1024, 256 * 1024, "editor_policy_frame_invalid"),
    maxPiFrameBytes: integer(value.maxPiFrameBytes, 64 * 1024, 8 * 1024 * 1024, "editor_policy_pi_frame_invalid"),
    maxPromptChars: integer(value.maxPromptChars, 1024, 16_000, "editor_policy_prompt_invalid"),
    maxUpdateChars: integer(value.maxUpdateChars, 1024, 64 * 1024, "editor_policy_update_invalid"),
    commandTimeoutMs: integer(value.commandTimeoutMs, 1_000, 60_000, "editor_policy_command_timeout_invalid"),
    promptTimeoutMs: integer(value.promptTimeoutMs, 60_000, 3_600_000, "editor_policy_prompt_timeout_invalid"),
    permissionTimeoutMs: integer(value.permissionTimeoutMs, 5_000, 120_000, "editor_policy_permission_timeout_invalid"),
    shutdownTimeoutMs: integer(value.shutdownTimeoutMs, 500, 10_000, "editor_policy_shutdown_timeout_invalid"),
    maxReceiptEvents: integer(value.maxReceiptEvents, 64, 4096, "editor_policy_receipt_events_invalid"),
    maxReceiptBytes: integer(value.maxReceiptBytes, 64 * 1024, 1024 * 1024, "editor_policy_receipt_bytes_invalid"),
    allowSessionPersistence: false,
    allowClientMcp: false,
    allowAdditionalDirectories: false,
    allowClientFilesystem: false,
    allowClientTerminal: false,
    allowClientRouteChanges: false,
    allowSlashCommands: false,
    approvalTools,
  };
  const digest = hash(stableJson(policy));
  if (value.digest !== undefined && value.digest !== digest) fail("editor_policy_digest_invalid");
  return freeze({ ...policy, digest });
}

export function readEditorBridgePolicy(file = defaultPolicyFile) {
  try { return validateEditorBridgePolicy(JSON.parse(fs.readFileSync(file, "utf8"))); }
  catch (error) { if (error instanceof EditorBridgeError) throw error; fail("editor_policy_unreadable", -32603); }
}

export function resolveEditorRoot(candidate) {
  if (typeof candidate !== "string" || !path.isAbsolute(candidate) || candidate.includes("\0")) fail("editor_root_invalid");
  const lexical = path.resolve(candidate);
  if (candidate !== lexical) fail("editor_root_ambiguous");
  let stat;
  let canonical;
  try { stat = fs.lstatSync(lexical); canonical = fs.realpathSync(lexical); } catch { fail("editor_root_unavailable"); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonical !== lexical) fail("editor_root_unsafe");
  return canonical;
}

export function findExecutable(name, environment = process.env) {
  if (typeof name !== "string" || !/^[A-Za-z0-9._+-]+$/u.test(name)) fail("editor_binary_name_invalid");
  for (const directory of String(environment.PATH ?? "").split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, name);
    try { fs.accessSync(candidate, fs.constants.X_OK); return fs.realpathSync(candidate); } catch {}
  }
  fail("editor_pi_binary_missing", -32603);
}

export function attestPiBinary(candidate, policy = readEditorBridgePolicy(), environment = process.env) {
  if (typeof candidate !== "string" || !path.isAbsolute(candidate)) fail("editor_pi_binary_invalid", -32603);
  let canonical;
  let stat;
  try { canonical = fs.realpathSync(candidate); stat = fs.statSync(canonical); } catch { fail("editor_pi_binary_missing", -32603); }
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o111) === 0 || (stat.mode & 0o022) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) fail("editor_pi_binary_unsafe", -32603);
  const digest = hash(fs.readFileSync(canonical));
  const probe = spawnSync(canonical, ["--version"], { encoding: "utf8", timeout: 10_000, maxBuffer: 4096, env: environment });
  const version = String(probe.stdout ?? "").trim();
  if (probe.status !== 0 || version !== policy.expectedPiVersion) fail("editor_pi_version_mismatch", -32603);
  const after = fs.statSync(canonical);
  if (!sameIdentity(stat, after) || hash(fs.readFileSync(canonical)) !== digest) fail("editor_pi_binary_changed", -32603);
  return freeze({ path: canonical, pathDigest: hash(canonical), digest, version, stat: { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs } });
}

export function editorBridgeChildArgs(extension = approvalExtension) {
  if (typeof extension !== "string" || !path.isAbsolute(extension)) fail("editor_approval_extension_invalid", -32603);
  return freeze(["--offline", "--approve", "--no-session", "--mode", "rpc", "--extension", extension]);
}

export function editorApprovalIntent(toolName, input, policy = readEditorBridgePolicy()) {
  const name = String(toolName ?? "");
  if (!policy.approvalTools.includes(name)) return undefined;
  const action = input && typeof input === "object" && !Array.isArray(input) ? String(input.action ?? "") : "";
  if (["transactional_edit", "transactional_ast_edit"].includes(name) && action !== "apply") return undefined;
  const toolKind = ["write", "edit", "transactional_edit", "transactional_ast_edit", "ast_grep_rewrite", "safe_remove_file", "secure_coding_workflow"].includes(name)
    ? "edit"
    : ["agent_browser", "web_research", "safe_web_fetch", "mcp"].includes(name)
      ? "fetch"
      : ["bash", "powershell", "safe_exec", "verification_gate", "debug_engine", "persistent_python", "persistent_javascript", "subagent"].includes(name)
        ? "execute"
        : "other";
  return freeze({ toolName: name, toolKind, inputDigest: hash(stableJson(input ?? {})) });
}

export function encodeEditorApproval(toolCallId, toolName, toolKind, inputDigest) {
  if (typeof toolCallId !== "string" || !SAFE_NAME.test(toolCallId) || typeof toolName !== "string" || !SAFE_NAME.test(toolName) || !APPROVAL_KINDS.has(toolKind) || typeof inputDigest !== "string" || !HEX_64.test(inputDigest)) fail("editor_approval_identity_invalid");
  return `${EDITOR_APPROVAL_PREFIX}${JSON.stringify({ toolCallId, toolName, toolKind, inputDigest })}`;
}

export function decodeEditorApproval(title, message) {
  if (title !== EDITOR_APPROVAL_TITLE || typeof message !== "string" || !message.startsWith(EDITOR_APPROVAL_PREFIX) || message.length > 1024) fail("editor_approval_request_invalid");
  let value;
  try { value = JSON.parse(message.slice(EDITOR_APPROVAL_PREFIX.length)); } catch { fail("editor_approval_request_invalid"); }
  exactKeys(value, ["toolCallId", "toolName", "toolKind", "inputDigest"], "editor_approval_request_invalid");
  if (typeof value.toolCallId !== "string" || !SAFE_NAME.test(value.toolCallId) || typeof value.toolName !== "string" || !SAFE_NAME.test(value.toolName) || !APPROVAL_KINDS.has(value.toolKind) || typeof value.inputDigest !== "string" || !HEX_64.test(value.inputDigest)) fail("editor_approval_request_invalid");
  return freeze({ ...value });
}

function receiptValue(field, value) {
  if (value === null) return null;
  if (["protocolVersion", "promptChars", "sequence", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens", "stderrBytes", "errorBytes", "exitCode"].includes(field)) {
    if (!Number.isSafeInteger(value) || value < 0) fail("editor_receipt_value_invalid", -32603);
    return value;
  }
  if (field === "cost") {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail("editor_receipt_value_invalid", -32603);
    return value;
  }
  if (field.endsWith("Digest")) {
    if (typeof value !== "string" || !HEX_64.test(value)) fail("editor_receipt_digest_invalid", -32603);
    return value;
  }
  if (typeof value !== "string" || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) fail("editor_receipt_value_invalid", -32603);
  return value;
}

export function sanitizeEditorReceipt(kind, data, sequence, at = new Date().toISOString()) {
  const fields = RECEIPT_FIELDS[kind];
  if (!fields || !data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).some((key) => !fields.includes(key)) || fields.some((key) => !Object.hasOwn(data, key))) fail("editor_receipt_shape_invalid", -32603);
  if (!Number.isSafeInteger(sequence) || sequence < 1 || typeof at !== "string" || !/^\d{4}-\d{2}-\d{2}T/u.test(at)) fail("editor_receipt_identity_invalid", -32603);
  const receipt = { version: EDITOR_BRIDGE_VERSION, sequence, at, kind };
  for (const field of fields) receipt[field] = receiptValue(field, data[field]);
  return freeze(receipt);
}

export class EditorReceiptJournal {
  constructor(options = {}) {
    this.policy = validateEditorBridgePolicy(options.policy ?? readEditorBridgePolicy());
    const environment = options.environment ?? process.env;
    const base = options.stateDir ?? (environment.XDG_STATE_HOME
      ? environment.XDG_STATE_HOME
      : environment.HOME
        ? path.join(environment.HOME, ".local", "state")
        : fail("editor_state_home_missing", -32603));
    this.directory = ensurePrivateDirectory(path.join(path.resolve(base), "pi-overdrive", "editor-bridge"));
    this.file = path.join(this.directory, `${Date.now()}-${randomUUID()}.jsonl`);
    this.fd = fs.openSync(this.file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    const stat = fs.fstatSync(this.fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) { fs.closeSync(this.fd); fail("editor_receipt_file_unsafe", -32603); }
    this.sequence = 0;
    this.bytes = 0;
    this.closed = false;
  }

  record(kind, data) {
    if (this.closed || this.sequence >= this.policy.maxReceiptEvents) fail("editor_receipt_limit_exceeded", -32603);
    const receipt = sanitizeEditorReceipt(kind, data, this.sequence + 1);
    const line = `${JSON.stringify(receipt)}\n`;
    const bytes = Buffer.byteLength(line);
    if (this.bytes + bytes > this.policy.maxReceiptBytes) fail("editor_receipt_bytes_exceeded", -32603);
    fs.writeSync(this.fd, line, null, "utf8");
    fs.fsyncSync(this.fd);
    this.sequence += 1;
    this.bytes += bytes;
    return receipt;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    fs.closeSync(this.fd);
  }
}

export class PiRpcProcess {
  constructor(options) {
    this.policy = validateEditorBridgePolicy(options.policy ?? readEditorBridgePolicy());
    this.identity = options.identity;
    this.cwd = resolveEditorRoot(options.cwd);
    this.environment = { ...options.environment, PI_OVERDRIVE_EDITOR_BRIDGE: "1" };
    this.onEvent = options.onEvent ?? (() => {});
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = "";
    this.stderrBytes = 0;
    this.stderrHash = createHash("sha256");
    this.stderrPreview = "";
    this.closed = deferred();
    this.started = false;
  }

  start() {
    if (this.started) fail("editor_pi_already_started", -32603);
    const current = fs.statSync(this.identity.path);
    if (!sameIdentity(current, this.identity.stat) || hash(fs.readFileSync(this.identity.path)) !== this.identity.digest) fail("editor_pi_binary_changed", -32603);
    this.started = true;
    this.child = spawn(this.identity.path, editorBridgeChildArgs(), { cwd: this.cwd, env: this.environment, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", (chunk) => this.#consume(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderrBytes = Math.min(Number.MAX_SAFE_INTEGER, this.stderrBytes + chunk.length);
      this.stderrHash.update(chunk);
      this.stderrPreview = `${this.stderrPreview}${chunk.toString("utf8")}`.slice(0, 4096);
    });
    this.child.on("error", (error) => this.#finish(error));
    this.child.on("close", (code, signal) => this.#finish(undefined, code, signal));
  }

  stderrDiagnostics() {
    const source = this.stderrPreview;
    const missing = /Cannot find (?:module|package)\s+['"]?([^'"\s]+)['"]?/iu.exec(source)?.[1] ?? "";
    const stderrSubject = ["typebox", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-agent-core", "@earendil-works/pi-tui", "typescript", "tsx"].includes(missing)
      ? missing : missing ? "OTHER_MODULE" : "NONE";
    const stderrClass = /No models available|No API key found|Model .* not found/iu.test(source) ? "MODEL_SETUP"
      : /Cannot find module|Cannot find package|ERR_MODULE_NOT_FOUND/iu.test(source) ? "PACKAGE_LOAD"
      : /extension|Extension/iu.test(source) ? "EXTENSION_INIT"
      : /unknown option|invalid option|Unknown argument/iu.test(source) ? "CLI"
      : /EACCES|EPERM|permission denied/iu.test(source) ? "PERMISSION"
      : /SyntaxError|TypeError|ReferenceError/iu.test(source) ? "RUNTIME"
      : this.stderrBytes ? "OTHER" : "NONE";
    return { stderrBytes: this.stderrBytes, stderrDigest: this.stderrHash.copy().digest("hex"), stderrClass, stderrSubject };
  }

  #consume(chunk) {
    this.buffer += chunk.toString("utf8");
    if (Buffer.byteLength(this.buffer) > this.policy.maxPiFrameBytes && !this.buffer.includes("\n")) { void this.close("pi_frame_limit"); return; }
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).replace(/\r$/u, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line) > this.policy.maxPiFrameBytes) { void this.close("pi_frame_limit"); return; }
      let event;
      try { event = JSON.parse(line); } catch { void this.close("pi_frame_invalid"); return; }
      if (event?.type === "response" && typeof event.id === "string" && this.pending.has(event.id)) {
        const pending = this.pending.get(event.id);
        this.pending.delete(event.id);
        if (event.success === true) pending.resolve(event);
        else pending.reject(new EditorBridgeError("editor_pi_command_failed", -32603));
      } else Promise.resolve(this.onEvent(event)).catch(() => this.close("pi_event_handler_failed"));
    }
  }

  #finish(error, code = null, signal = null) {
    if (this.exited) return;
    this.exited = { code, signal, error };
    const reason = new EditorBridgeError("editor_pi_exited", -32603);
    for (const pending of this.pending.values()) pending.reject(reason);
    this.pending.clear();
    this.closed.resolve(this.exited);
  }

  async command(type, payload = {}) {
    if (!this.started || this.exited) fail("editor_pi_unavailable", -32603);
    const id = `overdrive-${this.nextId++}`;
    const waiting = deferred();
    this.pending.set(id, waiting);
    const frame = { id, type, ...payload };
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
    try { return await withTimeout(waiting.promise, this.policy.commandTimeoutMs, "editor_pi_command_timeout"); }
    finally { this.pending.delete(id); }
  }

  send(frame) {
    if (!this.started || this.exited) fail("editor_pi_unavailable", -32603);
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  async close(reason = "normal") {
    if (!this.started) return { code: null, signal: null, reason };
    if (this.exited) return { ...this.exited, reason };
    this.child.stdin.end();
    try { return { ...(await withTimeout(this.closed.promise, this.policy.shutdownTimeoutMs, "editor_pi_shutdown_timeout")), reason }; }
    catch {
      this.child.kill("SIGTERM");
      try { return { ...(await withTimeout(this.closed.promise, this.policy.shutdownTimeoutMs, "editor_pi_terminate_timeout")), reason }; }
      catch { this.child.kill("SIGKILL"); return { ...(await this.closed.promise), reason }; }
    }
  }
}

function normalizeRoute(state) {
  const model = state?.data?.model;
  const provider = typeof model?.provider === "string" && SAFE_NAME.test(model.provider) ? model.provider : null;
  const modelId = typeof model?.id === "string" && SAFE_NAME.test(model.id) ? model.id : null;
  const thinking = typeof state?.data?.thinkingLevel === "string" && SAFE_NAME.test(state.data.thinkingLevel) ? state.data.thinkingLevel : null;
  if (!provider || !modelId || !thinking) fail("editor_route_unavailable", -32603);
  return freeze({ provider, model: modelId, thinking, digest: hash(`${provider}\0${modelId}\0${thinking}`) });
}

function promptText(params, policy) {
  exactKeys(params, ["sessionId", "prompt", "_meta"], "editor_prompt_params_invalid");
  if (!Array.isArray(params.prompt) || params.prompt.length < 1 || params.prompt.length > 64) fail("editor_prompt_blocks_invalid");
  const blocks = [];
  for (const block of params.prompt) {
    exactKeys(block, ["type", "text", "_meta"], "editor_prompt_block_invalid");
    if (block.type !== "text" || typeof block.text !== "string" || /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(block.text)) fail("editor_prompt_block_invalid");
    blocks.push(block.text);
  }
  const text = blocks.join("\n").trim();
  if (!text || text.length > policy.maxPromptChars) fail("editor_prompt_size_invalid");
  if (!policy.allowSlashCommands && /^\s*\//u.test(text)) fail("editor_slash_command_denied", -32000);
  return text;
}

function toolKind(name) {
  if (["read", "resource_fs", "smart_read", "semantic_nav", "ts_definition", "ts_references", "ts_diagnostics"].includes(name)) return "read";
  if (["write", "edit", "transactional_edit", "transactional_ast_edit", "ast_grep_rewrite", "secure_coding_workflow"].includes(name)) return "edit";
  if (["grep", "find", "ffgrep", "fffind", "ast_grep_run", "ast_grep_scan", "ast_grep_outline"].includes(name)) return "search";
  if (["web_research", "safe_web_fetch", "agent_browser"].includes(name)) return "fetch";
  if (["bash", "powershell", "safe_exec", "verification_gate", "debug_engine", "persistent_python", "persistent_javascript"].includes(name)) return "execute";
  return "other";
}

export function classifyEditorAssistantError(message) {
  const source = typeof message === "string" ? message : "";
  const errorClass = /context.{0,32}(?:window|budget|limit|fit)|prompt.{0,32}(?:large|long|exceed)/iu.test(source) ? "CONTEXT"
    : /api key|auth|credential/iu.test(source) ? "AUTH"
    : /provider|model|route/iu.test(source) ? "ROUTE"
    : /task governor|tool governor|policy|denied|blocked/iu.test(source) ? "POLICY"
    : /network|fetch|http/iu.test(source) ? "NETWORK"
    : source ? "OTHER" : "EMPTY";
  return { errorDigest: hash(source), errorBytes: Buffer.byteLength(source), errorClass };
}

function stopReason(value, cancelled) {
  if (cancelled || value === "aborted") return "cancelled";
  if (value === "length") return "max_tokens";
  if (["error", "refusal"].includes(value)) return "refusal";
  return "end_turn";
}

function usageFromStats(response) {
  const tokens = response?.data?.tokens ?? {};
  const safe = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  return freeze({
    inputTokens: safe(tokens.input),
    outputTokens: safe(tokens.output),
    cachedReadTokens: safe(tokens.cacheRead),
    cachedWriteTokens: safe(tokens.cacheWrite),
    totalTokens: safe(tokens.total),
    cost: typeof response?.data?.cost === "number" && Number.isFinite(response.data.cost) && response.data.cost >= 0 ? response.data.cost : 0,
    contextSize: safe(response?.data?.contextUsage?.contextWindow),
    contextUsed: safe(response?.data?.contextUsage?.tokens),
  });
}

export class EditorAcpBridge {
  constructor(options) {
    this.policy = validateEditorBridgePolicy(options.policy ?? readEditorBridgePolicy());
    this.root = resolveEditorRoot(options.root);
    const rootStat = fs.statSync(this.root);
    this.rootIdentity = { dev: rootStat.dev, ino: rootStat.ino };
    this.identity = options.identity;
    this.journal = options.journal;
    this.send = options.send;
    this.environment = options.environment ?? process.env;
    this.piFactory = options.piFactory ?? ((piOptions) => new PiRpcProcess(piOptions));
    this.initialized = false;
    this.authenticated = false;
    this.session = null;
    this.pendingClientRequests = new Map();
    this.nextPermission = 1;
    this.promptSequence = 0;
    this.disposed = false;
    this.journal.record("bridge_started", { policyDigest: this.policy.digest, rootDigest: hash(this.root), piVersion: this.identity.version, piBinaryDigest: this.identity.digest });
  }

  async receive(message) {
    if (this.disposed) return;
    if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") return this.#sendError(message?.id ?? null, -32600, "Invalid request");
    if (Object.keys(message).some((key) => !["jsonrpc", "id", "method", "params", "result", "error"].includes(key)) || (Object.hasOwn(message, "method") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) || (Object.hasOwn(message, "id") && !(typeof message.id === "string" && message.id.length > 0 && message.id.length <= 128) && !(Number.isSafeInteger(message.id) && message.id >= 0))) return this.#sendError(message?.id ?? null, -32600, "Invalid request");
    if (!Object.hasOwn(message, "method")) { this.#receiveClientResponse(message); return; }
    const notification = !Object.hasOwn(message, "id");
    if (typeof message.method !== "string") return notification ? undefined : this.#sendError(message.id, -32600, "Invalid request");
    try {
      const result = await this.#dispatch(message.method, message.params ?? {}, notification, message.id);
      if (!notification) await this.send({ jsonrpc: "2.0", id: message.id, result: result ?? {} });
    } catch (error) {
      if (!notification) await this.#sendError(message.id, error instanceof EditorBridgeError ? error.rpcCode : -32603, error instanceof EditorBridgeError ? error.code : "Internal error");
    }
  }

  async #sendError(id, code, message) { await this.send({ jsonrpc: "2.0", id, error: { code, message } }); }

  async #dispatch(method, params, notification, requestId) {
    if (method === "initialize") return this.#initialize(params);
    if (!this.initialized) fail("editor_not_initialized", -32000);
    if (method === "authenticate") return this.#authenticate(params);
    if (method === "session/new") return this.#newSession(params);
    if (method === "session/prompt") {
      if (notification) fail("editor_prompt_requires_id");
      return this.#prompt(params, requestId);
    }
    if (method === "session/cancel") return this.#cancel(params);
    if (method === "session/close") return this.#closeSession(params);
    if (method === "session/set_mode") return this.#setMode(params);
    fail("editor_method_not_found", -32601);
  }

  #initialize(params) {
    exactKeys(params, ["protocolVersion", "clientCapabilities", "clientInfo", "_meta"], "editor_initialize_invalid");
    if (params.protocolVersion !== this.policy.protocolVersion || this.initialized) fail("editor_protocol_mismatch", -32602);
    this.initialized = true;
    const client = params.clientInfo && typeof params.clientInfo === "object" ? `${String(params.clientInfo.name ?? "unknown")}\0${String(params.clientInfo.version ?? "unknown")}` : "unknown";
    this.journal.record("initialized", { clientDigest: hash(client), protocolVersion: this.policy.protocolVersion });
    return {
      protocolVersion: this.policy.protocolVersion,
      agentInfo: { name: "tasso-pi-overdrive", title: "Pi Overdrive", version: "1.0.0" },
      authMethods: [{ id: "agent", name: "Use existing local Pi credentials", description: "Uses the existing Pi provider configuration without modifying it." }],
      agentCapabilities: { loadSession: false, mcpCapabilities: { http: false, sse: false }, promptCapabilities: { embeddedContext: false, image: false, audio: false }, sessionCapabilities: { close: {} } },
    };
  }

  #authenticate(params) {
    exactKeys(params, ["methodId", "_meta"], "editor_auth_invalid");
    if (params.methodId !== "agent") fail("editor_auth_method_denied", -32000);
    this.authenticated = true;
    return {};
  }

  async #newSession(params) {
    exactKeys(params, ["cwd", "mcpServers", "additionalDirectories", "_meta"], "editor_session_params_invalid");
    if (!this.authenticated) fail("editor_not_authenticated", -32000);
    if (this.session) fail("editor_session_limit", -32003);
    if (resolveEditorRoot(params.cwd) !== this.root) fail("editor_session_root_mismatch", -32000);
    this.#assertRootIdentity();
    if (!Array.isArray(params.mcpServers) || params.mcpServers.length !== 0) fail("editor_client_mcp_denied", -32000);
    if (params.additionalDirectories !== undefined && (!Array.isArray(params.additionalDirectories) || params.additionalDirectories.length !== 0)) fail("editor_additional_directories_denied", -32000);
    const sessionId = randomUUID();
    const pi = this.piFactory({ policy: this.policy, identity: this.identity, cwd: this.root, environment: this.environment, onEvent: (event) => this.#onPiEvent(event) });
    pi.start();
    this.session = { id: sessionId, digest: hash(sessionId), pi, route: null, activePrompt: null, lastStopReason: "stop", closed: false };
    try {
      const state = await pi.command("get_state");
      this.session.route = normalizeRoute(state);
      this.journal.record("session_started", { sessionDigest: this.session.digest, provider: this.session.route.provider, model: this.session.route.model, thinking: this.session.route.thinking });
    } catch (error) {
      await this.#terminateSession("startup_failed");
      throw error;
    }
    return { sessionId, modes: { currentModeId: "overdrive", availableModes: [{ id: "overdrive", name: "Overdrive", description: "Governed Pi Overdrive policy; client route and authority changes are disabled." }] } };
  }

  #assertSession(sessionId) {
    if (!this.session || this.session.closed || sessionId !== this.session.id) fail("editor_session_unknown", -32002);
    return this.session;
  }

  #assertRootIdentity() {
    try {
      if (resolveEditorRoot(this.root) !== this.root) fail("editor_root_changed", -32000);
      const current = fs.statSync(this.root);
      if (current.dev !== this.rootIdentity.dev || current.ino !== this.rootIdentity.ino) fail("editor_root_changed", -32000);
    } catch { fail("editor_root_changed", -32000); }
  }

  async #setMode(params) {
    exactKeys(params, ["sessionId", "modeId", "_meta"], "editor_mode_invalid");
    this.#assertSession(params.sessionId);
    if (params.modeId !== "overdrive") fail("editor_mode_change_denied", -32000);
    return {};
  }

  async #prompt(params, requestId) {
    const session = this.#assertSession(params?.sessionId);
    this.#assertRootIdentity();
    if (session.activePrompt) fail("editor_session_busy", -32003);
    const text = promptText(params, this.policy);
    const settled = deferred();
    const requestDigest = hash(String(requestId));
    const active = { requestDigest, settled, cancelled: false, toolCalls: new Map(), approvedToolCalls: new Set() };
    session.activePrompt = active;
    try {
      const before = normalizeRoute(await session.pi.command("get_state"));
      if (before.digest !== session.route.digest) fail("editor_route_drift", -32000);
      this.promptSequence += 1;
      this.journal.record("prompt_started", { requestDigest, promptDigest: hash(text), promptChars: text.length, sequence: this.promptSequence });
      await session.pi.command("prompt", { message: text });
      await withTimeout(settled.promise, this.policy.promptTimeoutMs, "editor_prompt_timeout");
      if (session.closed) fail("editor_session_closed", -32000);
      const [stats, finalState] = await Promise.all([session.pi.command("get_session_stats"), session.pi.command("get_state")]);
      const route = normalizeRoute(finalState);
      if (route.digest !== session.route.digest) fail("editor_route_drift", -32000);
      const usage = usageFromStats(stats);
      const reason = stopReason(session.lastStopReason, active.cancelled);
      this.journal.record("prompt_finished", {
        requestDigest, stopReason: reason, provider: route.provider, model: route.model, thinking: route.thinking,
        inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cachedReadTokens,
        cacheWriteTokens: usage.cachedWriteTokens, totalTokens: usage.totalTokens, cost: usage.cost,
      });
      if (usage.contextSize > 0) await this.#notify({ sessionUpdate: "usage_update", size: usage.contextSize, used: Math.min(usage.contextUsed, usage.contextSize), cost: { amount: usage.cost, currency: "USD" } });
      return { stopReason: reason, usage: { totalTokens: usage.totalTokens, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedReadTokens: usage.cachedReadTokens, cachedWriteTokens: usage.cachedWriteTokens } };
    } catch (error) {
      if (error?.code === "editor_prompt_timeout") await this.#cancel({ sessionId: session.id });
      throw error;
    } finally {
      if (session.activePrompt === active) session.activePrompt = null;
    }
  }

  async #cancel(params) {
    exactKeys(params, ["sessionId", "_meta"], "editor_cancel_invalid");
    const session = this.#assertSession(params.sessionId);
    const active = session.activePrompt;
    if (!active) return {};
    active.cancelled = true;
    for (const waiting of this.pendingClientRequests.values()) waiting.reject(new EditorBridgeError("editor_prompt_cancelled", -32000));
    this.pendingClientRequests.clear();
    this.journal.record("cancel_requested", { requestDigest: active.requestDigest });
    try { await session.pi.command("abort"); } finally { active.settled.resolve(); }
    return {};
  }

  async #closeSession(params) {
    exactKeys(params, ["sessionId", "_meta"], "editor_close_invalid");
    this.#assertSession(params.sessionId);
    await this.#terminateSession("client_closed");
    return {};
  }

  async #terminateSession(status) {
    const session = this.session;
    if (!session || session.closed) return;
    session.closed = true;
    for (const waiting of this.pendingClientRequests.values()) waiting.reject(new EditorBridgeError("editor_session_closed", -32000));
    this.pendingClientRequests.clear();
    if (session.activePrompt) {
      session.activePrompt.cancelled = true;
      try { await session.pi.command("abort"); } catch {}
      session.activePrompt.settled.resolve();
    }
    const exit = await session.pi.close(status);
    this.journal.record("child_exit", { exitCode: Number.isSafeInteger(exit.code) && exit.code >= 0 ? exit.code : null, signal: typeof exit.signal === "string" ? exit.signal : "none", ...(session.pi.stderrDiagnostics?.() ?? { stderrBytes: session.pi.stderrBytes ?? 0, stderrDigest: hash(""), stderrClass: "NONE", stderrSubject: "NONE" }) });
    this.journal.record("session_closed", { sessionDigest: session.digest, status });
  }

  async #notify(update) {
    if (!this.session || this.session.closed) return;
    await this.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: this.session.id, update } });
  }

  async #onPiEvent(event) {
    const session = this.session;
    if (!session || session.closed || !event || typeof event !== "object") return;
    if (event.type === "message_update") {
      const stream = event.assistantMessageEvent;
      if (stream?.type === "text_delta" && typeof stream.delta === "string") await this.#notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: stream.delta.slice(0, this.policy.maxUpdateChars) } });
      else if (stream?.type === "thinking_delta" && typeof stream.delta === "string") await this.#notify({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: stream.delta.slice(0, this.policy.maxUpdateChars) } });
      return;
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      session.lastStopReason = String(event.message.stopReason ?? "stop");
      if (session.lastStopReason === "error") this.journal.record("assistant_error", classifyEditorAssistantError(event.message.errorMessage));
      return;
    }
    if (event.type === "tool_execution_start" && typeof event.toolCallId === "string" && typeof event.toolName === "string") {
      const digest = hash(event.toolCallId);
      const kind = toolKind(event.toolName);
      session.activePrompt?.toolCalls.set(event.toolCallId, { name: event.toolName, intent: editorApprovalIntent(event.toolName, event.args ?? {}) });
      this.journal.record("tool_started", { toolCallDigest: digest, toolName: event.toolName.slice(0, 256), toolKind: kind });
      await this.#notify({ sessionUpdate: "tool_call", toolCallId: event.toolCallId, title: event.toolName, kind, status: "in_progress" });
      return;
    }
    if (event.type === "tool_execution_end" && typeof event.toolCallId === "string" && typeof event.toolName === "string") {
      const status = event.isError === true ? "failed" : "completed";
      this.journal.record("tool_finished", { toolCallDigest: hash(event.toolCallId), toolName: event.toolName.slice(0, 256), status });
      await this.#notify({ sessionUpdate: "tool_call_update", toolCallId: event.toolCallId, title: event.toolName, kind: toolKind(event.toolName), status });
      return;
    }
    if (event.type === "extension_ui_request") { await this.#handleUiRequest(event); return; }
    if (event.type === "agent_settled") session.activePrompt?.settled.resolve();
  }

  async #handleUiRequest(event) {
    const session = this.session;
    if (!session || typeof event.id !== "string") return;
    try { this.#assertRootIdentity(); } catch { session.pi.send({ type: "extension_ui_response", id: event.id, confirmed: false }); return; }
    if (event.method !== "confirm") {
      if (["select", "input", "editor"].includes(event.method)) session.pi.send({ type: "extension_ui_response", id: event.id, cancelled: true });
      return;
    }
    let approval;
    try { approval = decodeEditorApproval(event.title, event.message); }
    catch { session.pi.send({ type: "extension_ui_response", id: event.id, confirmed: false }); return; }
    const active = session.activePrompt;
    const started = active?.toolCalls.get(approval.toolCallId);
    if (!active || active.cancelled || active.approvedToolCalls.has(approval.toolCallId) || !started || started.name !== approval.toolName || started.intent?.inputDigest !== approval.inputDigest || started.intent?.toolKind !== approval.toolKind) {
      session.pi.send({ type: "extension_ui_response", id: event.id, confirmed: false });
      return;
    }
    active.approvedToolCalls.add(approval.toolCallId);
    const permissionId = `overdrive-permission-${this.nextPermission++}`;
    const waiting = deferred();
    this.pendingClientRequests.set(permissionId, waiting);
    const permissionDigest = hash(`${session.id}\0${event.id}\0${approval.toolCallId}\0${approval.inputDigest}\0${permissionId}`);
    this.journal.record("permission_requested", { permissionDigest, toolCallDigest: hash(approval.toolCallId), inputDigest: approval.inputDigest, toolName: approval.toolName, toolKind: approval.toolKind });
    await this.send({
      jsonrpc: "2.0", id: permissionId, method: "session/request_permission",
      params: {
        sessionId: session.id,
        toolCall: { toolCallId: approval.toolCallId, title: approval.toolName, kind: approval.toolKind, status: "pending", _meta: { inputDigest: approval.inputDigest } },
        options: [
          { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject_once", name: "Reject", kind: "reject_once" },
        ],
      },
    });
    let decision = "reject_once";
    try {
      const response = await withTimeout(waiting.promise, this.policy.permissionTimeoutMs, "editor_permission_timeout");
      if (response && typeof response === "object" && !Array.isArray(response) && Object.keys(response).length === 1 && Object.hasOwn(response, "outcome") && response.outcome && typeof response.outcome === "object" && !Array.isArray(response.outcome) && Object.keys(response.outcome).length === 2 && response.outcome.outcome === "selected" && response.outcome.optionId === "allow_once") decision = "allow_once";
    } catch {}
    this.pendingClientRequests.delete(permissionId);
    if (session.closed || session.activePrompt !== active || active.cancelled) decision = "reject_once";
    this.journal.record("permission_decided", { permissionDigest, toolCallDigest: hash(approval.toolCallId), inputDigest: approval.inputDigest, toolName: approval.toolName, decision });
    if (!session.closed) session.pi.send({ type: "extension_ui_response", id: event.id, confirmed: decision === "allow_once" });
  }

  #receiveClientResponse(message) {
    if (Object.keys(message).some((key) => !["jsonrpc", "id", "result", "error"].includes(key)) || !Object.hasOwn(message, "id") || Object.hasOwn(message, "result") === Object.hasOwn(message, "error")) return;
    const pending = this.pendingClientRequests.get(String(message.id));
    if (!pending) return;
    if (message.error) pending.reject(new EditorBridgeError("editor_permission_rejected", -32000));
    else pending.resolve(message.result);
  }

  async dispose(status = "transport_closed") {
    if (this.disposed) return;
    this.disposed = true;
    for (const waiting of this.pendingClientRequests.values()) waiting.reject(new EditorBridgeError("editor_transport_closed", -32603));
    this.pendingClientRequests.clear();
    await this.#terminateSession(status);
    this.journal.record("bridge_stopped", { status });
    this.journal.close();
  }
}

export function parseEditorFrame(line, policy = readEditorBridgePolicy()) {
  if (typeof line !== "string" || !line || Buffer.byteLength(line) > policy.maxFrameBytes) fail("editor_frame_size_invalid", -32700);
  let value;
  try { value = JSON.parse(line); } catch { fail("editor_frame_parse_error", -32700); }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("editor_frame_invalid", -32600);
  return value;
}
