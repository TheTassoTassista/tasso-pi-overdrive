import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectWorkspacePath, isAlwaysProtectedWritePath, isSecretPath } from "./safety.mjs";
import { requireCodingBackend, sandboxInvocation } from "../platform/shared/coding-execution.mjs";

export const DAP_ENGINE_VERSION = 2;
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const policyFile = path.join(packageRoot, "config", "dap-engine.json");
const secureGdbArguments = Object.freeze([
  "-q", "-nx", "-nh", "-iex", "set auto-load off", "-iex", "set debuginfod enabled off", "-i", "dap",
]);
const criticalPattern = /\b(?:ERROR|FATAL|PANIC|ASSERT|EXCEPTION|SEGMENTATION|SIG[A-Z0-9]+)\b/iu;
export const DAP_ADAPTER_CAPABILITIES = Object.freeze({
  gdb: Object.freeze({ launch: true, breakpoints: true, continue: true, stepOver: true, stack: true, scopes: true, variables: true, output: true, attach: false, evaluate: false, customRequest: false, remoteTarget: false }),
  debugpy: Object.freeze({ launch: true, breakpoints: true, continue: true, stepOver: true, stack: true, scopes: true, variables: true, output: true, attach: false, evaluate: false, customRequest: false, remoteTarget: false }),
});
const actionKeys = Object.freeze({
  launch: new Set(["action", "program", "args", "timeoutMs"]),
  set_breakpoint: new Set(["action", "file", "line", "timeoutMs"]),
  continue: new Set(["action", "timeoutMs"]),
  step_over: new Set(["action", "timeoutMs"]),
  stack_trace: new Set(["action", "levels", "timeoutMs"]),
  scopes: new Set(["action", "frameId", "timeoutMs"]),
  variables: new Set(["action", "variablesReference", "start", "count", "timeoutMs"]),
  output: new Set(["action"]),
  status: new Set(["action"]),
  terminate: new Set(["action"]),
});

export class DapEngineError extends Error {
  constructor(code) { super(code); this.name = "DapEngineError"; this.code = code; }
}

function fail(code) { throw new DapEngineError(code); }
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function integer(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code);
  return value;
}
function boundedString(value, maximum, code, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > maximum || value.includes("\0")) fail(code);
  return value;
}
function sameIdentity(left, right) { return left?.dev === right?.dev && left?.ino === right?.ino; }
function freeze(value) { return Object.freeze(structuredClone(value)); }
function safeText(value, maximum) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "�")
    .slice(0, maximum);
}
function errorCode(error, fallback = "DAP_ENGINE_FAILED") {
  const candidate = error instanceof DapEngineError ? error.code : error && typeof error === "object" && "code" in error ? String(error.code) : "";
  return /^[A-Z][A-Z0-9_]{2,63}$/u.test(candidate) ? candidate : fallback;
}
function boundedPromise(promise, timeoutMs, code) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      handler(value);
    };
    const timer = setTimeout(() => finish(reject, new DapEngineError(code)), timeoutMs);
    promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

export function validateDapPolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== DAP_ENGINE_VERSION) fail("DAP_POLICY_INVALID");
  const keys = [
    "version", "enabled", "platform", "adapter", "secondaryAdapters", "startupTimeoutMs", "requestTimeoutMs", "idleTimeoutMs", "shutdownGraceMs",
    "maxMessageBytes", "maxOutputBytes", "maxStderrBytes", "maxArguments", "maxArgumentChars", "maxProgramBytes", "maxSourceBytes",
    "maxBreakpoints", "maxStackFrames", "maxVariables", "maxValueChars",
  ];
  if (Object.keys(value).some((key) => !keys.includes(key))) fail("DAP_POLICY_UNKNOWN_FIELD");
  if (typeof value.enabled !== "boolean" || value.platform !== "linux-x64") fail("DAP_POLICY_PLATFORM_INVALID");
  const adapter = value.adapter;
  if (!adapter || typeof adapter !== "object" || Array.isArray(adapter)) fail("DAP_POLICY_ADAPTER_INVALID");
  if (Object.keys(adapter).some((key) => !["id", "binaryPath", "binaryVersion", "binarySha256", "arguments"].includes(key))) fail("DAP_POLICY_ADAPTER_UNKNOWN_FIELD");
  if (adapter.id !== "gdb" || adapter.binaryPath !== "/usr/bin/gdb" || adapter.binaryVersion !== "GNU gdb (GDB) 17.2") fail("DAP_POLICY_ADAPTER_INVALID");
  if (!/^[0-9a-f]{64}$/u.test(adapter.binarySha256 ?? "")) fail("DAP_POLICY_ADAPTER_DIGEST_INVALID");
  if (!Array.isArray(adapter.arguments) || JSON.stringify(adapter.arguments) !== JSON.stringify(secureGdbArguments)) fail("DAP_POLICY_ADAPTER_ARGUMENTS_INVALID");
  if (!Array.isArray(value.secondaryAdapters) || value.secondaryAdapters.length !== 1) fail("DAP_POLICY_SECONDARY_ADAPTER_INVALID");
  const secondary = value.secondaryAdapters[0];
  if (!secondary || typeof secondary !== "object" || Array.isArray(secondary) ||
      Object.keys(secondary).some((key) => !["id", "binaryPath", "binaryVersion", "binarySha256", "arguments", "moduleVersion", "moduleRelative", "moduleSha256"].includes(key))) fail("DAP_POLICY_SECONDARY_ADAPTER_INVALID");
  if (secondary.id !== "debugpy" || secondary.binaryPath !== "/usr/bin/python3.14" || secondary.binaryVersion !== "Python 3.14.7" ||
      secondary.moduleVersion !== "1.8.22" || secondary.moduleRelative !== "runtime/dap/python/debugpy" ||
      JSON.stringify(secondary.arguments) !== JSON.stringify(["-m", "debugpy.adapter"]) ||
      !/^[0-9a-f]{64}$/u.test(secondary.binarySha256 ?? "") || !/^[0-9a-f]{64}$/u.test(secondary.moduleSha256 ?? "")) fail("DAP_POLICY_SECONDARY_ADAPTER_INVALID");
  return freeze({
    version: value.version,
    enabled: value.enabled,
    platform: value.platform,
    adapter: {
      id: adapter.id,
      binaryPath: adapter.binaryPath,
      binaryVersion: adapter.binaryVersion,
      binarySha256: adapter.binarySha256,
      arguments: [...adapter.arguments],
    },
    secondaryAdapters: [{ ...secondary, arguments: [...secondary.arguments] }],
    startupTimeoutMs: integer(value.startupTimeoutMs, 1000, 60_000, "DAP_POLICY_STARTUP_TIMEOUT_INVALID"),
    requestTimeoutMs: integer(value.requestTimeoutMs, 500, 60_000, "DAP_POLICY_REQUEST_TIMEOUT_INVALID"),
    idleTimeoutMs: integer(value.idleTimeoutMs, 10_000, 3_600_000, "DAP_POLICY_IDLE_TIMEOUT_INVALID"),
    shutdownGraceMs: integer(value.shutdownGraceMs, 100, 10_000, "DAP_POLICY_SHUTDOWN_INVALID"),
    maxMessageBytes: integer(value.maxMessageBytes, 64 * 1024, 8 * 1024 * 1024, "DAP_POLICY_MESSAGE_LIMIT_INVALID"),
    maxOutputBytes: integer(value.maxOutputBytes, 16 * 1024, 1024 * 1024, "DAP_POLICY_OUTPUT_LIMIT_INVALID"),
    maxStderrBytes: integer(value.maxStderrBytes, 4096, 256 * 1024, "DAP_POLICY_STDERR_LIMIT_INVALID"),
    maxArguments: integer(value.maxArguments, 0, 128, "DAP_POLICY_ARGUMENT_LIMIT_INVALID"),
    maxArgumentChars: integer(value.maxArgumentChars, 64, 16_384, "DAP_POLICY_ARGUMENT_CHARS_INVALID"),
    maxProgramBytes: integer(value.maxProgramBytes, 1024, 1024 * 1024 * 1024, "DAP_POLICY_PROGRAM_LIMIT_INVALID"),
    maxSourceBytes: integer(value.maxSourceBytes, 1024, 64 * 1024 * 1024, "DAP_POLICY_SOURCE_LIMIT_INVALID"),
    maxBreakpoints: integer(value.maxBreakpoints, 1, 128, "DAP_POLICY_BREAKPOINT_LIMIT_INVALID"),
    maxStackFrames: integer(value.maxStackFrames, 1, 128, "DAP_POLICY_FRAME_LIMIT_INVALID"),
    maxVariables: integer(value.maxVariables, 1, 500, "DAP_POLICY_VARIABLE_LIMIT_INVALID"),
    maxValueChars: integer(value.maxValueChars, 64, 16_384, "DAP_POLICY_VALUE_LIMIT_INVALID"),
  });
}

export function readDapPolicy(file = policyFile) {
  try { return validateDapPolicy(JSON.parse(fs.readFileSync(file, "utf8"))); }
  catch (error) { if (error instanceof DapEngineError) throw error; fail("DAP_POLICY_UNREADABLE"); }
}

function inspectRegularFile(cwd, candidate, options = {}) {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.includes("\0") || path.isAbsolute(candidate)) fail(options.code ?? "DAP_PATH_INVALID");
  const segments = path.normalize(candidate).split(path.sep);
  if (segments.includes("..") || isSecretPath(candidate) || isAlwaysProtectedWritePath(candidate)) fail(options.code ?? "DAP_PATH_INVALID");
  const inspected = inspectWorkspacePath(cwd, candidate, { mustExist: true });
  if (!inspected.allowed || !inspected.stat?.isFile() || inspected.stat.isSymbolicLink() || inspected.stat.nlink !== 1) fail(options.code ?? "DAP_PATH_INVALID");
  if (isSecretPath(inspected.canonical) || isAlwaysProtectedWritePath(inspected.canonical)) fail(options.code ?? "DAP_PATH_INVALID");
  if (options.executable && (inspected.stat.mode & 0o111) === 0) fail("DAP_PROGRAM_NOT_EXECUTABLE");
  if (inspected.stat.size > options.maxBytes) fail(options.code === "DAP_SOURCE_INVALID" ? "DAP_SOURCE_TOO_LARGE" : "DAP_PROGRAM_TOO_LARGE");
  let descriptor;
  try {
    descriptor = fs.openSync(inspected.lexical, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || !sameIdentity(opened, inspected.stat)) fail(options.code ?? "DAP_PATH_INVALID");
    const bytes = options.digest ? fs.readFileSync(descriptor) : undefined;
    const after = fs.fstatSync(descriptor);
    const pathname = fs.lstatSync(inspected.lexical);
    if (!sameIdentity(opened, after) || !sameIdentity(opened, pathname) || pathname.isSymbolicLink() || pathname.nlink !== 1) fail("DAP_PATH_CHANGED");
    return freeze({
      workspace: inspected.workspace,
      canonical: inspected.canonical,
      relative: path.relative(inspected.workspace, inspected.canonical),
      dev: opened.dev,
      ino: opened.ino,
      size: opened.size,
      mtimeMs: opened.mtimeMs,
      ctimeMs: opened.ctimeMs,
      digest: bytes ? hash(bytes) : undefined,
    });
  } catch (error) {
    if (error instanceof DapEngineError) throw error;
    fail(options.code ?? "DAP_PATH_INVALID");
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function inspectManagedModule(profile) {
  if (!profile.moduleRelative) return undefined;
  const root = path.join(packageRoot, "runtime", "dap", "python");
  const modulePath = path.join(packageRoot, profile.moduleRelative);
  let canonical;
  try { canonical = fs.realpathSync(modulePath); }
  catch { fail("DAP_ADAPTER_UNAVAILABLE"); }
  if (canonical !== modulePath || path.dirname(modulePath) !== root) fail("DAP_ADAPTER_UNSAFE");
  for (const directory of [root, modulePath]) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) fail("DAP_ADAPTER_UNSAFE");
  }
  const entries = [];
  let totalBytes = 0;
  function visit(current) {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) fail("DAP_ADAPTER_UNSAFE");
      if (stat.isDirectory()) { visit(file); continue; }
      if (!stat.isFile() || stat.nlink !== 1) fail("DAP_ADAPTER_UNSAFE");
      totalBytes += stat.size;
      if (totalBytes > 64 * 1024 * 1024 || entries.length >= 2000) fail("DAP_ADAPTER_TOO_LARGE");
      const relative = path.relative(root, file).split(path.sep).join("/");
      const bytes = fs.readFileSync(file);
      const after = fs.lstatSync(file);
      if (!sameIdentity(stat, after) || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) fail("DAP_ADAPTER_CHANGED");
      entries.push({ relative, digest: hash(bytes) });
    }
  }
  try { visit(modulePath); }
  catch (error) { if (error instanceof DapEngineError) throw error; fail("DAP_ADAPTER_UNAVAILABLE"); }
  const inventory = entries.sort((left, right) => Buffer.compare(Buffer.from(left.relative), Buffer.from(right.relative)))
    .map((entry) => `${entry.digest}  ${entry.relative}\n`).join("");
  if (entries.length === 0 || hash(inventory) !== profile.moduleSha256) fail("DAP_ADAPTER_DIGEST_MISMATCH");
  return freeze({ path: canonical, fileCount: entries.length, bytes: totalBytes, digest: profile.moduleSha256 });
}

function inspectAdapter(profile) {
  const configured = profile.binaryPath;
  let canonical;
  let stat;
  try {
    canonical = fs.realpathSync(configured);
    stat = fs.lstatSync(configured);
  } catch { fail("DAP_ADAPTER_UNAVAILABLE"); }
  if (canonical !== configured || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o111) === 0 || (stat.mode & 0o022) !== 0) fail("DAP_ADAPTER_UNSAFE");
  const digest = hash(fs.readFileSync(configured));
  const after = fs.lstatSync(configured);
  if (!sameIdentity(stat, after) || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) fail("DAP_ADAPTER_CHANGED");
  if (digest !== profile.binarySha256) fail("DAP_ADAPTER_DIGEST_MISMATCH");
  const module = inspectManagedModule(profile);
  return freeze({ path: canonical, digest, module, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
}

function defaultSpawnAdapter({ workspace, profile }) {
  const args = ["--workspace-read-only", ...(profile.id === "debugpy" ? ["--minimal-runtime", "--managed-dap"] : []), workspace, "--cwd", ".", "--", profile.binaryPath, ...profile.arguments];
  const invocation = sandboxInvocation("debug", args);
  return spawn(invocation.command, invocation.args, {
    cwd: workspace,
    shell: invocation.shell,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C.UTF-8", NO_COLOR: "1" },
  });
}

class DapConnection extends EventEmitter {
  constructor(child, policy) {
    super();
    if (!child?.stdin || !child?.stdout || !child?.stderr) fail("DAP_ADAPTER_SPAWN_INVALID");
    this.child = child;
    this.policy = policy;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.waiters = new Set();
    this.sequence = 0;
    this.closed = false;
    this.stderr = "";
    child.stdout.on("data", (chunk) => this.#consume(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => {
      this.stderr = safeText(`${this.stderr}${chunk.toString("utf8")}`, policy.maxStderrBytes);
    });
    child.once("error", () => this.#close("DAP_ADAPTER_PROCESS_ERROR"));
    child.once("exit", () => this.#close("DAP_ADAPTER_EXITED"));
    child.stdin.on("error", () => this.#close("DAP_ADAPTER_WRITE_FAILED"));
    child.stdout.on("error", () => this.#close("DAP_ADAPTER_READ_FAILED"));
    child.stderr.on("error", () => this.#close("DAP_ADAPTER_STDERR_FAILED"));
  }

  #close(code) {
    if (this.closed) return;
    this.closed = true;
    const error = new DapEngineError(code);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters.clear();
    this.emit("closed", code);
  }

  #consume(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > this.policy.maxMessageBytes + 8192) return this.#protocolFailure();
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        if (this.buffer.length > 8192) this.#protocolFailure();
        return;
      }
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = header.match(/(?:^|\r\n)Content-Length:\s*(\d+)\s*(?:\r\n|$)/iu);
      if (!match) return this.#protocolFailure();
      const length = Number(match[1]);
      if (!Number.isSafeInteger(length) || length < 2 || length > this.policy.maxMessageBytes) return this.#protocolFailure();
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      let message;
      try { message = JSON.parse(body); } catch { return this.#protocolFailure(); }
      this.#dispatch(message);
      if (this.closed) return;
    }
  }

  #protocolFailure() {
    this.#close("DAP_PROTOCOL_INVALID");
    this.kill();
  }

  #dispatch(message) {
    if (!message || typeof message !== "object" || !Number.isSafeInteger(message.seq) || typeof message.type !== "string") return this.#protocolFailure();
    if (message.type === "response") {
      const pending = this.pending.get(message.request_seq);
      if (!pending) return;
      this.pending.delete(message.request_seq);
      if (message.success === true) pending.resolve(message.body ?? {});
      else pending.reject(new DapEngineError("DAP_REQUEST_REJECTED"));
      return;
    }
    if (message.type === "event" && typeof message.event === "string") {
      this.emit("event", message.event, message.body ?? {});
      for (const waiter of [...this.waiters]) {
        if (!waiter.events.has(message.event)) continue;
        this.waiters.delete(waiter);
        waiter.resolve({ event: message.event, body: message.body ?? {} });
      }
      return;
    }
    if (message.type === "request" && typeof message.command === "string") {
      this.#write({
        seq: ++this.sequence, type: "response", request_seq: message.seq, success: false, command: message.command,
        message: "Reverse requests are disabled by Pi Overdrive.",
      });
      this.emit("reverse_request_denied", message.command);
      return;
    }
    this.#protocolFailure();
  }

  #write(message) {
    if (this.closed) fail("DAP_ADAPTER_NOT_RUNNING");
    const body = JSON.stringify(message);
    if (Buffer.byteLength(body) > this.policy.maxMessageBytes) fail("DAP_MESSAGE_TOO_LARGE");
    try { this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`); }
    catch { this.#close("DAP_ADAPTER_WRITE_FAILED"); fail("DAP_ADAPTER_WRITE_FAILED"); }
  }

  request(command, argumentsValue, options = {}) {
    if (this.closed) return Promise.reject(new DapEngineError("DAP_ADAPTER_NOT_RUNNING"));
    const requestSeq = ++this.sequence;
    const timeoutMs = options.timeoutMs ?? this.policy.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
      };
      const finish = (handler, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        handler(value);
      };
      const abort = () => {
        this.pending.delete(requestSeq);
        finish(reject, new DapEngineError("DAP_ABORTED"));
      };
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(requestSeq);
        finish(reject, new DapEngineError("DAP_REQUEST_TIMEOUT"));
      }, timeoutMs) : undefined;
      if (options.signal?.aborted) return abort();
      options.signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(requestSeq, {
        resolve: (value) => finish(resolve, value),
        reject: (error) => finish(reject, error),
      });
      try { this.#write({ seq: requestSeq, type: "request", command, arguments: argumentsValue ?? {} }); }
      catch (error) { this.pending.delete(requestSeq); finish(reject, error); }
    });
  }

  waitFor(events, options = {}) {
    const names = new Set(Array.isArray(events) ? events : [events]);
    if (this.closed) return Promise.reject(new DapEngineError("DAP_ADAPTER_NOT_RUNNING"));
    return new Promise((resolve, reject) => {
      let settled = false;
      const waiter = {
        events: names,
        resolve: (value) => finish(resolve, value),
        reject: (error) => finish(reject, error),
      };
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        this.waiters.delete(waiter);
      };
      const finish = (handler, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        handler(value);
      };
      const abort = () => finish(reject, new DapEngineError("DAP_ABORTED"));
      const timer = setTimeout(() => finish(reject, new DapEngineError("DAP_EVENT_TIMEOUT")), options.timeoutMs ?? this.policy.requestTimeoutMs);
      if (options.signal?.aborted) return abort();
      options.signal?.addEventListener("abort", abort, { once: true });
      this.waiters.add(waiter);
    });
  }

  kill() {
    if (this.closed && this.child.exitCode !== null) return;
    try {
      if (Number.isSafeInteger(this.child.pid) && this.child.pid > 1) process.kill(-this.child.pid, "SIGTERM");
      else this.child.kill("SIGTERM");
    } catch { try { this.child.kill("SIGTERM"); } catch {} }
  }
}

function sandboxPath(relative) { return `/workspace/${relative.split(path.sep).join("/")}`; }

export class DapEngine {
  constructor(options = {}) {
    requireCodingBackend("debug");
    this.cwd = fs.realpathSync(options.cwd ?? process.cwd());
    this.policy = validateDapPolicy(options.policy ?? readDapPolicy());
    this.spawnAdapter = options.spawnAdapter ?? defaultSpawnAdapter;
    this.attestAdapter = options.attestAdapter ?? inspectAdapter;
    this.session = undefined;
    this.adapterIdentity = undefined;
    this.idleTimer = undefined;
    this.stats = { launches: 0, requests: 0, denied: 0, timeouts: 0, reverseRequestsDenied: 0, cleanups: 0 };
  }

  #timeout(value, startup = false) {
    if (value === undefined) return startup ? this.policy.startupTimeoutMs : this.policy.requestTimeoutMs;
    return integer(value, 100, startup ? this.policy.startupTimeoutMs : this.policy.requestTimeoutMs, "DAP_TIMEOUT_INVALID");
  }

  #validateInput(input) {
    if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.action !== "string" || !actionKeys[input.action]) fail("DAP_INPUT_INVALID");
    if (Object.keys(input).some((key) => !actionKeys[input.action].has(key))) fail("DAP_INPUT_INVALID");
    return input.action;
  }

  #touch() {
    if (!this.session) return;
    this.session.lastActivityAt = Date.now();
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { void this.terminate("IDLE_TIMEOUT"); }, this.policy.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  #appendOutput(value) {
    if (!this.session || typeof value !== "string" || value.length === 0) return;
    const sanitized = safeText(value, this.policy.maxMessageBytes);
    this.session.outputTotalBytes += Buffer.byteLength(sanitized);
    for (const line of sanitized.split(/\r?\n/u)) {
      if (criticalPattern.test(line) && this.session.criticalOutput.length < 32) this.session.criticalOutput.push(line.slice(0, 1024));
    }
    const combined = Buffer.from(`${this.session.outputTail}${sanitized}`, "utf8");
    if (combined.length > this.policy.maxOutputBytes) {
      this.session.outputTail = combined.subarray(combined.length - this.policy.maxOutputBytes).toString("utf8");
      this.session.outputTruncated = true;
    } else this.session.outputTail = combined.toString("utf8");
  }

  #summary() {
    const session = this.session;
    if (!session) return freeze({
      version: DAP_ENGINE_VERSION, enabled: this.policy.enabled, adapter: this.policy.adapter.id, adapterVersion: this.policy.adapter.binaryVersion,
      adapters: [
        { id: this.policy.adapter.id, status: "DECLARED", capabilities: DAP_ADAPTER_CAPABILITIES.gdb },
        { id: "debugpy", status: fs.existsSync(path.join(packageRoot, this.policy.secondaryAdapters[0].moduleRelative)) ? "INSTALLED_UNVERIFIED" : "UNAVAILABLE", capabilities: DAP_ADAPTER_CAPABILITIES.debugpy },
      ],
      state: "IDLE", sandboxed: true, network: false, workspaceReadOnly: true, activeSessions: 0, stats: { ...this.stats },
    });
    const state = session.connection.closed && !["EXITED", "TERMINATED"].includes(session.state) ? "TERMINATED" : session.state;
    return freeze({
      version: DAP_ENGINE_VERSION, enabled: this.policy.enabled, sessionId: session.id, adapter: session.profile.id,
      adapterVersion: session.profile.moduleVersion ?? session.profile.binaryVersion, state, sandboxed: true, network: false, workspaceReadOnly: true, activeSessions: 1,
      program: session.program.relative, programDigest: session.program.digest, breakpointCount: [...session.breakpoints.values()].reduce((sum, lines) => sum + lines.length, 0),
      outputBytes: session.outputTotalBytes, outputTruncated: session.outputTruncated, stopReason: session.stopReason,
      source: session.source, line: session.line, threadId: session.threadId, exitCode: session.exitCode, stats: { ...this.stats },
    });
  }

  status() { return this.#summary(); }

  async execute(input = {}, signal) {
    const action = this.#validateInput(input);
    try {
      let result;
      if (action === "launch") result = await this.launch(input, signal);
      else if (action === "set_breakpoint") result = await this.setBreakpoint(input, signal);
      else if (action === "continue") result = await this.continue(input, signal);
      else if (action === "step_over") result = await this.stepOver(input, signal);
      else if (action === "stack_trace") result = await this.stackTrace(input, signal);
      else if (action === "scopes") result = await this.scopes(input, signal);
      else if (action === "variables") result = await this.variables(input, signal);
      else if (action === "output") result = this.output();
      else if (action === "status") result = this.status();
      else result = await this.terminate("EXPLICIT");
      return result;
    } catch (error) {
      this.stats.denied += 1;
      const code = errorCode(error);
      if (["DAP_REQUEST_TIMEOUT", "DAP_EVENT_TIMEOUT", "DAP_LAUNCH_TIMEOUT"].includes(code)) this.stats.timeouts += 1;
      if (!["status", "output", "terminate"].includes(action) && this.session) await this.terminate(code);
      throw error instanceof DapEngineError ? error : new DapEngineError(code);
    }
  }

  async launch(input, signal) {
    if (!this.policy.enabled) fail("DAP_DISABLED");
    if (this.session) fail("DAP_SESSION_ALREADY_ACTIVE");
    const programName = boundedString(input.program, 2048, "DAP_PROGRAM_INVALID");
    const adapterId = programName.endsWith(".py") ? "debugpy" : "gdb";
    const profile = adapterId === "gdb" ? this.policy.adapter : adapterId === "debugpy" ? this.policy.secondaryAdapters[0] : undefined;
    if (!profile) fail("DAP_ADAPTER_UNSUPPORTED");
    if ((profile.id === "debugpy") !== programName.endsWith(".py")) fail("DAP_ADAPTER_PROGRAM_MISMATCH");
    const program = inspectRegularFile(this.cwd, programName, {
      executable: profile.id === "gdb", digest: true,
      maxBytes: profile.id === "debugpy" ? this.policy.maxSourceBytes : this.policy.maxProgramBytes, code: "DAP_PROGRAM_INVALID",
    });
    const args = input.args ?? [];
    if (!Array.isArray(args) || args.length > this.policy.maxArguments) fail("DAP_ARGUMENTS_INVALID");
    for (const argument of args) boundedString(argument, this.policy.maxArgumentChars, "DAP_ARGUMENTS_INVALID", true);
    const timeoutMs = this.#timeout(input.timeoutMs, true);
    this.adapterIdentity = this.attestAdapter(profile);
    const child = this.spawnAdapter({ workspace: program.workspace, policy: this.policy, profile, adapterIdentity: this.adapterIdentity });
    const connection = new DapConnection(child, this.policy);
    const session = {
      id: randomUUID(), connection, program, profile, child, state: "STARTING", startedAt: Date.now(), lastActivityAt: Date.now(),
      breakpoints: new Map(), outputTail: "", outputTotalBytes: 0, outputTruncated: false, criticalOutput: [],
      configurationDone: false, launchPromise: undefined, stopReason: undefined, source: undefined, line: undefined, threadId: undefined, exitCode: undefined,
    };
    this.session = session;
    connection.on("reverse_request_denied", () => { this.stats.reverseRequestsDenied += 1; });
    connection.on("event", (event, body) => {
      if (event === "output" && typeof body?.output === "string") this.#appendOutput(body.output);
      if (event === "stopped") {
        session.state = "STOPPED";
        session.stopReason = safeText(body?.reason ?? "stopped", 128);
        session.threadId = Number.isSafeInteger(body?.threadId) ? body.threadId : undefined;
      } else if (event === "continued") session.state = "RUNNING";
      else if (event === "exited") { session.state = "EXITED"; session.exitCode = Number.isSafeInteger(body?.exitCode) ? body.exitCode : undefined; }
      else if (event === "terminated") session.state = "TERMINATED";
    });
    try {
      const initialized = connection.waitFor("initialized", { signal, timeoutMs });
      initialized.catch(() => undefined);
      await connection.request("initialize", {
        clientID: "pi-overdrive", clientName: "Pi Overdrive", adapterID: profile.id, pathFormat: "path",
        linesStartAt1: true, columnsStartAt1: true, supportsVariableType: true, supportsVariablePaging: true,
        supportsRunInTerminalRequest: false, locale: "en-US",
      }, { signal, timeoutMs });
      const launchArguments = profile.id === "gdb"
        ? { request: "launch", program: sandboxPath(program.relative), cwd: "/workspace", args: [...args], stopAtBeginningOfMainSubprogram: true }
        : { request: "launch", type: "python", program: sandboxPath(program.relative), python: [profile.binaryPath], cwd: "/workspace", args: [...args], console: "internalConsole", stopOnEntry: true, subProcess: false, redirectOutput: true, justMyCode: true };
      session.launchPromise = connection.request("launch", launchArguments, { timeoutMs: 0 });
      session.launchPromise.catch(() => undefined);
      await Promise.race([
        initialized,
        session.launchPromise.then(() => { throw new DapEngineError("DAP_INITIALIZED_MISSING"); }),
      ]);
      const rechecked = inspectRegularFile(this.cwd, program.relative, { executable: profile.id === "gdb", digest: true, maxBytes: profile.id === "gdb" ? this.policy.maxProgramBytes : this.policy.maxSourceBytes, code: "DAP_PROGRAM_INVALID" });
      if (!sameIdentity(program, rechecked) || program.digest !== rechecked.digest) fail("DAP_PROGRAM_CHANGED");
      session.state = "CONFIGURING";
      this.stats.launches += 1;
      this.stats.requests += 2;
      this.#touch();
      return this.#summary();
    } catch (error) {
      await this.terminate(errorCode(error));
      throw error;
    }
  }

  #active(...states) {
    if (!this.session || this.session.connection.closed) fail("DAP_SESSION_NOT_ACTIVE");
    if (states.length && !states.includes(this.session.state)) fail("DAP_SESSION_STATE_INVALID");
    return this.session;
  }

  async setBreakpoint(input, signal) {
    const session = this.#active("CONFIGURING", "STOPPED");
    const source = inspectRegularFile(this.cwd, boundedString(input.file, 2048, "DAP_SOURCE_INVALID"), { executable: false, digest: false, maxBytes: this.policy.maxSourceBytes, code: "DAP_SOURCE_INVALID" });
    const line = integer(input.line, 1, 10_000_000, "DAP_LINE_INVALID");
    const existing = session.breakpoints.get(source.relative) ?? [];
    const lines = [...new Set([...existing, line])].sort((left, right) => left - right);
    const total = [...session.breakpoints.entries()].reduce((sum, [name, values]) => sum + (name === source.relative ? 0 : values.length), 0) + lines.length;
    if (total > this.policy.maxBreakpoints) fail("DAP_BREAKPOINT_LIMIT_EXCEEDED");
    const body = await session.connection.request("setBreakpoints", {
      source: { name: path.basename(source.relative), path: sandboxPath(source.relative) },
      breakpoints: lines.map((value) => ({ line: value })), sourceModified: false,
    }, { signal, timeoutMs: this.#timeout(input.timeoutMs) });
    session.breakpoints.set(source.relative, lines);
    this.stats.requests += 1;
    this.#touch();
    return freeze({
      kind: "DAP_BREAKPOINTS", source: source.relative,
      breakpoints: lines.map((value, index) => ({ line: value, verified: body?.breakpoints?.[index]?.verified === true, message: safeText(body?.breakpoints?.[index]?.message ?? "", 256) || undefined })),
      session: this.#summary(),
    });
  }

  async #resume(command, input, signal) {
    const session = this.#active("CONFIGURING", "STOPPED");
    const timeoutMs = this.#timeout(input.timeoutMs);
    const outcome = session.connection.waitFor(["stopped", "exited", "terminated"], { signal, timeoutMs });
    outcome.catch(() => undefined);
    if (session.state === "CONFIGURING") {
      const rechecked = inspectRegularFile(this.cwd, session.program.relative, { executable: session.profile.id === "gdb", digest: true, maxBytes: session.profile.id === "gdb" ? this.policy.maxProgramBytes : this.policy.maxSourceBytes, code: "DAP_PROGRAM_INVALID" });
      if (!sameIdentity(session.program, rechecked) || session.program.digest !== rechecked.digest) fail("DAP_PROGRAM_CHANGED");
      await session.connection.request("configurationDone", {}, { signal, timeoutMs });
      session.configurationDone = true;
      await boundedPromise(session.launchPromise, timeoutMs, "DAP_LAUNCH_TIMEOUT");
      this.stats.requests += 1;
    } else {
      const argumentsValue = command === "continue" ? { threadId: session.threadId ?? 1, singleThread: false } : { threadId: session.threadId ?? 1, singleThread: false };
      await session.connection.request(command, argumentsValue, { signal, timeoutMs });
      this.stats.requests += 1;
    }
    const event = await outcome;
    if (event.event === "stopped") {
      session.state = "STOPPED";
      session.stopReason = safeText(event.body?.reason ?? "stopped", 128);
      session.threadId = Number.isSafeInteger(event.body?.threadId) ? event.body.threadId : session.threadId;
    } else if (event.event === "exited") {
      session.state = "EXITED";
      session.exitCode = Number.isSafeInteger(event.body?.exitCode) ? event.body.exitCode : undefined;
    } else session.state = "TERMINATED";
    this.#touch();
    return this.#summary();
  }

  continue(input, signal) { return this.#resume("continue", input, signal); }
  stepOver(input, signal) {
    if (this.session?.state === "CONFIGURING") fail("DAP_SESSION_STATE_INVALID");
    return this.#resume("next", input, signal);
  }

  async stackTrace(input, signal) {
    const session = this.#active("STOPPED");
    const levels = input.levels === undefined ? this.policy.maxStackFrames : integer(input.levels, 1, this.policy.maxStackFrames, "DAP_LEVELS_INVALID");
    const body = await session.connection.request("stackTrace", { threadId: session.threadId ?? 1, startFrame: 0, levels }, { signal, timeoutMs: this.#timeout(input.timeoutMs) });
    const frames = (Array.isArray(body?.stackFrames) ? body.stackFrames : []).slice(0, levels).map((frame) => {
      const sourcePath = typeof frame?.source?.path === "string" && frame.source.path.startsWith("/workspace/") ? frame.source.path.slice("/workspace/".length) : undefined;
      return {
        id: Number.isSafeInteger(frame?.id) ? frame.id : 0,
        name: safeText(frame?.name ?? "<unknown>", 256), source: sourcePath,
        line: Number.isSafeInteger(frame?.line) ? frame.line : 0, column: Number.isSafeInteger(frame?.column) ? frame.column : 0,
      };
    });
    if (frames[0]) { session.source = frames[0].source; session.line = frames[0].line; }
    this.stats.requests += 1;
    this.#touch();
    return freeze({ kind: "DAP_STACK_TRACE", frames, totalFrames: Number.isSafeInteger(body?.totalFrames) ? body.totalFrames : frames.length, session: this.#summary() });
  }

  async scopes(input, signal) {
    const session = this.#active("STOPPED");
    const frameId = integer(input.frameId, 0, Number.MAX_SAFE_INTEGER, "DAP_FRAME_INVALID");
    const body = await session.connection.request("scopes", { frameId }, { signal, timeoutMs: this.#timeout(input.timeoutMs) });
    const scopes = (Array.isArray(body?.scopes) ? body.scopes : []).slice(0, 32).map((scope) => ({
      name: safeText(scope?.name ?? "scope", 128), variablesReference: Number.isSafeInteger(scope?.variablesReference) ? scope.variablesReference : 0,
      expensive: scope?.expensive === true, namedVariables: Number.isSafeInteger(scope?.namedVariables) ? scope.namedVariables : undefined,
      indexedVariables: Number.isSafeInteger(scope?.indexedVariables) ? scope.indexedVariables : undefined,
    }));
    this.stats.requests += 1;
    this.#touch();
    return freeze({ kind: "DAP_SCOPES", frameId, scopes, session: this.#summary() });
  }

  async variables(input, signal) {
    const session = this.#active("STOPPED");
    const variablesReference = integer(input.variablesReference, 1, Number.MAX_SAFE_INTEGER, "DAP_VARIABLE_REFERENCE_INVALID");
    const start = input.start === undefined ? 0 : integer(input.start, 0, Number.MAX_SAFE_INTEGER, "DAP_VARIABLE_START_INVALID");
    const count = input.count === undefined ? this.policy.maxVariables : integer(input.count, 1, this.policy.maxVariables, "DAP_VARIABLE_COUNT_INVALID");
    const body = await session.connection.request("variables", { variablesReference, start, count }, { signal, timeoutMs: this.#timeout(input.timeoutMs) });
    const variables = (Array.isArray(body?.variables) ? body.variables : []).slice(0, count).map((variable) => ({
      name: safeText(variable?.name ?? "", 256), value: safeText(variable?.value ?? "", this.policy.maxValueChars),
      type: safeText(variable?.type ?? "", 256) || undefined,
      variablesReference: Number.isSafeInteger(variable?.variablesReference) ? variable.variablesReference : 0,
      namedVariables: Number.isSafeInteger(variable?.namedVariables) ? variable.namedVariables : undefined,
      indexedVariables: Number.isSafeInteger(variable?.indexedVariables) ? variable.indexedVariables : undefined,
    }));
    this.stats.requests += 1;
    this.#touch();
    return freeze({ kind: "DAP_VARIABLES", variablesReference, start, variables, truncated: Array.isArray(body?.variables) && body.variables.length > count, session: this.#summary() });
  }

  output() {
    const session = this.#active();
    this.#touch();
    const critical = session.criticalOutput.length ? `Critical diagnostics retained:\n${session.criticalOutput.join("\n")}\n` : "";
    const omission = session.outputTruncated ? `[Earlier debug output omitted; retained tail ${this.policy.maxOutputBytes} bytes.]\n` : "";
    return freeze({ kind: "DAP_OUTPUT", output: `${critical}${omission}${session.outputTail}`, totalBytes: session.outputTotalBytes, truncated: session.outputTruncated, criticalLines: session.criticalOutput.length, session: this.#summary() });
  }

  async terminate(reason = "EXPLICIT") {
    const session = this.session;
    if (!session) return this.#summary();
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    try {
      if (!session.connection.closed) await session.connection.request("disconnect", { restart: false, terminateDebuggee: true }, { timeoutMs: Math.min(this.policy.requestTimeoutMs, 2000) });
    } catch {}
    session.connection.kill();
    if (session.child.exitCode === null) {
      await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(); } };
        const timer = setTimeout(finish, this.policy.shutdownGraceMs);
        timer.unref?.();
        session.child.once("exit", finish);
      });
    }
    if (session.child.exitCode === null) {
      try {
        if (Number.isSafeInteger(session.child.pid) && session.child.pid > 1) process.kill(-session.child.pid, "SIGKILL");
        else session.child.kill("SIGKILL");
      } catch { try { session.child.kill("SIGKILL"); } catch {} }
    }
    session.state = "TERMINATED";
    const final = freeze({ ...this.#summary(), cleanupReason: reason, adapterExited: session.child.exitCode !== null || session.connection.closed });
    this.session = undefined;
    this.stats.cleanups += 1;
    return final;
  }
}

export function dapErrorCode(error) { return errorCode(error); }
