import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireCodingBackend, sandboxInvocation } from "../platform/shared/coding-execution.mjs";

export const EVAL_ENGINE_VERSION = 1;
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const policyFile = path.join(packageRoot, "config", "eval-engine.json");
const rootPrefix = "pi-overdrive-eval-";
const runtimeContract = Object.freeze({
  python: Object.freeze({ path: "/usr/bin/python3.14", version: "Python 3.14.7", runner: "runtime/eval/python-runner.py", arguments: Object.freeze(["-I", "-B", "-u"]) }),
  javascript: Object.freeze({
    path: "/usr/bin/node",
    version: "v26.8.2",
    runner: "runtime/eval/javascript-runner.mjs",
    arguments: Object.freeze(["--no-addons", "--disable-proto=throw", "--max-old-space-size=192"]),
    typescriptCompiler: Object.freeze({ relativePath: "runtime/lsp/node_modules/typescript/lib/typescript.js", version: "6.0.3", sha256: "569177652966bd528c319171c7dd22860dbf72bde116cbc4f644f1d02bb12e39" }),
  }),
});
const processLimiterContract = Object.freeze({ path: "/usr/bin/prlimit", version: "prlimit from util-linux 2.42.4", sha256: "84643075132b361f03d41228856d26e354e700eda4afe411428d366e256fa8a6", arguments: Object.freeze(["--nproc=8", "--"]) });
const actionKeys = Object.freeze({
  execute: new Set(["action", "code", "timeoutMs", "dialect"]),
  reset: new Set(["action"]),
  status: new Set(["action"]),
  terminate: new Set(["action"]),
});

export class PersistentEvalError extends Error {
  constructor(code) { super(code); this.name = "PersistentEvalError"; this.code = code; }
}

function fail(code) { throw new PersistentEvalError(code); }
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function sameIdentity(left, right) { return left?.dev === right?.dev && left?.ino === right?.ino; }
function freeze(value) { return Object.freeze(structuredClone(value)); }
function integer(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code);
  return value;
}
function safeText(value, maximum) {
  const text = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  return text.replace(/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "").slice(0, maximum);
}
function errorCode(error, fallback = "EVAL_ENGINE_FAILED") {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : error instanceof PersistentEvalError ? error.message : fallback;
  return /^EVAL_[A-Z0-9_]+$/u.test(code) ? code : fallback;
}

export function validateEvalPolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== EVAL_ENGINE_VERSION) fail("EVAL_POLICY_INVALID");
  const keys = [
    "version", "enabled", "platform", "runtimes", "processLimiter", "startupTimeoutMs", "executionTimeoutMs", "maxExecutionTimeoutMs",
    "idleTimeoutMs", "shutdownGraceMs", "maxCodeChars", "maxFrameBytes", "maxOutputBytes", "maxStderrBytes", "maxValueChars",
  ];
  if (Object.keys(value).some((key) => !keys.includes(key))) fail("EVAL_POLICY_UNKNOWN_FIELD");
  if (typeof value.enabled !== "boolean" || value.platform !== "linux-x64") fail("EVAL_POLICY_PLATFORM_INVALID");
  if (!value.runtimes || typeof value.runtimes !== "object" || Array.isArray(value.runtimes) || JSON.stringify(Object.keys(value.runtimes).sort()) !== JSON.stringify(["javascript", "python"])) fail("EVAL_POLICY_RUNTIMES_INVALID");
  const runtimes = {};
  for (const language of ["python", "javascript"]) {
    const item = value.runtimes[language];
    const contract = runtimeContract[language];
    const allowedKeys = language === "javascript" ? ["binaryPath", "binaryVersion", "binarySha256", "runner", "arguments", "typescriptCompiler"] : ["binaryPath", "binaryVersion", "binarySha256", "runner", "arguments"];
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some((key) => !allowedKeys.includes(key))) fail("EVAL_POLICY_RUNTIME_INVALID");
    if (item.binaryPath !== contract.path || item.binaryVersion !== contract.version || item.runner !== contract.runner || JSON.stringify(item.arguments) !== JSON.stringify(contract.arguments)) fail("EVAL_POLICY_RUNTIME_INVALID");
    if (!/^[0-9a-f]{64}$/u.test(item.binarySha256 ?? "")) fail("EVAL_POLICY_RUNTIME_DIGEST_INVALID");
    if (language === "javascript") {
      const compiler = item.typescriptCompiler;
      if (!compiler || typeof compiler !== "object" || Array.isArray(compiler) || JSON.stringify(Object.keys(compiler).sort()) !== JSON.stringify(["relativePath", "sha256", "version"]) || compiler.relativePath !== contract.typescriptCompiler.relativePath || compiler.version !== contract.typescriptCompiler.version || compiler.sha256 !== contract.typescriptCompiler.sha256) fail("EVAL_POLICY_TYPESCRIPT_INVALID");
    }
    runtimes[language] = freeze({ ...item, arguments: [...item.arguments], ...(item.typescriptCompiler ? { typescriptCompiler: { ...item.typescriptCompiler } } : {}) });
  }
  const limiter = value.processLimiter;
  if (!limiter || typeof limiter !== "object" || Array.isArray(limiter) || JSON.stringify(Object.keys(limiter).sort()) !== JSON.stringify(["arguments", "binaryPath", "binarySha256", "binaryVersion"]) || limiter.binaryPath !== processLimiterContract.path || limiter.binaryVersion !== processLimiterContract.version || limiter.binarySha256 !== processLimiterContract.sha256 || JSON.stringify(limiter.arguments) !== JSON.stringify(processLimiterContract.arguments)) fail("EVAL_POLICY_PROCESS_LIMITER_INVALID");
  const policy = {
    version: value.version,
    enabled: value.enabled,
    platform: value.platform,
    runtimes,
    processLimiter: freeze({ ...limiter, arguments: [...limiter.arguments] }),
    startupTimeoutMs: integer(value.startupTimeoutMs, 500, 30_000, "EVAL_POLICY_STARTUP_TIMEOUT_INVALID"),
    executionTimeoutMs: integer(value.executionTimeoutMs, 100, 30_000, "EVAL_POLICY_EXECUTION_TIMEOUT_INVALID"),
    maxExecutionTimeoutMs: integer(value.maxExecutionTimeoutMs, value.executionTimeoutMs, 60_000, "EVAL_POLICY_MAX_TIMEOUT_INVALID"),
    idleTimeoutMs: integer(value.idleTimeoutMs, 10_000, 3_600_000, "EVAL_POLICY_IDLE_TIMEOUT_INVALID"),
    shutdownGraceMs: integer(value.shutdownGraceMs, 100, 10_000, "EVAL_POLICY_SHUTDOWN_INVALID"),
    maxCodeChars: integer(value.maxCodeChars, 1024, 1024 * 1024, "EVAL_POLICY_CODE_LIMIT_INVALID"),
    maxFrameBytes: integer(value.maxFrameBytes, 64 * 1024, 8 * 1024 * 1024, "EVAL_POLICY_FRAME_LIMIT_INVALID"),
    maxOutputBytes: integer(value.maxOutputBytes, 16 * 1024, 1024 * 1024, "EVAL_POLICY_OUTPUT_LIMIT_INVALID"),
    maxStderrBytes: integer(value.maxStderrBytes, 1024, 256 * 1024, "EVAL_POLICY_STDERR_LIMIT_INVALID"),
    maxValueChars: integer(value.maxValueChars, 256, 64 * 1024, "EVAL_POLICY_VALUE_LIMIT_INVALID"),
  };
  if (policy.executionTimeoutMs > policy.maxExecutionTimeoutMs || policy.maxOutputBytes + policy.maxStderrBytes + policy.maxValueChars > policy.maxFrameBytes) fail("EVAL_POLICY_LIMITS_INVALID");
  return freeze(policy);
}

export function readEvalPolicy(file = policyFile) {
  try { return validateEvalPolicy(JSON.parse(fs.readFileSync(file, "utf8"))); }
  catch (error) { if (error instanceof PersistentEvalError) throw error; fail("EVAL_POLICY_UNREADABLE"); }
}

function inspectRuntime(language, policy) {
  const runtime = policy.runtimes[language];
  let canonical;
  let stat;
  try {
    canonical = fs.realpathSync(runtime.binaryPath);
    stat = fs.lstatSync(runtime.binaryPath);
  } catch { fail("EVAL_RUNTIME_UNAVAILABLE"); }
  if (canonical !== runtime.binaryPath || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o111) === 0 || (stat.mode & 0o022) !== 0) fail("EVAL_RUNTIME_UNSAFE");
  const digest = hash(fs.readFileSync(runtime.binaryPath));
  const after = fs.lstatSync(runtime.binaryPath);
  if (!sameIdentity(stat, after) || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) fail("EVAL_RUNTIME_CHANGED");
  if (digest !== runtime.binarySha256) fail("EVAL_RUNTIME_DIGEST_MISMATCH");
  const runnerPath = path.join(packageRoot, runtime.runner);
  let runner;
  try { runner = fs.lstatSync(runnerPath); } catch { fail("EVAL_RUNNER_UNAVAILABLE"); }
  if (!runner.isFile() || runner.isSymbolicLink() || runner.nlink !== 1 || fs.realpathSync(runnerPath) !== runnerPath || (runner.mode & 0o022) !== 0) fail("EVAL_RUNNER_UNSAFE");
  const limiter = policy.processLimiter;
  let limiterStat;
  try { limiterStat = fs.lstatSync(limiter.binaryPath); } catch { fail("EVAL_PROCESS_LIMITER_UNAVAILABLE"); }
  if (fs.realpathSync(limiter.binaryPath) !== limiter.binaryPath || !limiterStat.isFile() || limiterStat.isSymbolicLink() || limiterStat.nlink !== 1 || (limiterStat.mode & 0o111) === 0 || (limiterStat.mode & 0o022) !== 0 || hash(fs.readFileSync(limiter.binaryPath)) !== limiter.binarySha256) fail("EVAL_PROCESS_LIMITER_UNSAFE");
  let typescriptPath;
  let typescriptDigest;
  if (language === "javascript") {
    typescriptPath = path.join(packageRoot, runtime.typescriptCompiler.relativePath);
    let compiler;
    try { compiler = fs.lstatSync(typescriptPath); } catch { fail("EVAL_TYPESCRIPT_UNAVAILABLE"); }
    if (!compiler.isFile() || compiler.isSymbolicLink() || compiler.nlink !== 1 || fs.realpathSync(typescriptPath) !== typescriptPath || (compiler.mode & 0o022) !== 0) fail("EVAL_TYPESCRIPT_UNSAFE");
    typescriptDigest = hash(fs.readFileSync(typescriptPath));
    if (typescriptDigest !== runtime.typescriptCompiler.sha256) fail("EVAL_TYPESCRIPT_DIGEST_MISMATCH");
  }
  return freeze({ path: canonical, digest, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, runnerPath, runnerDigest: hash(fs.readFileSync(runnerPath)), typescriptPath, typescriptDigest });
}

function revalidateRuntime(identity, runtime) {
  try {
    const stat = fs.lstatSync(runtime.binaryPath);
    return sameIdentity(identity, stat) && identity.size === stat.size && identity.mtimeMs === stat.mtimeMs && identity.ctimeMs === stat.ctimeMs && !stat.isSymbolicLink();
  } catch { return false; }
}

function createPrivateRoot(identity) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), rootPrefix));
  try {
    fs.chmodSync(root, 0o700);
    const runnerName = path.basename(identity.runnerPath);
    const target = path.join(root, runnerName);
    fs.copyFileSync(identity.runnerPath, target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, 0o400);
    const copied = fs.lstatSync(target);
    if (!copied.isFile() || copied.isSymbolicLink() || copied.nlink !== 1 || hash(fs.readFileSync(target)) !== identity.runnerDigest) fail("EVAL_RUNNER_COPY_INVALID");
    if (identity.typescriptPath) {
      const compilerTarget = path.join(root, "typescript.js");
      fs.copyFileSync(identity.typescriptPath, compilerTarget, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(compilerTarget, 0o400);
      const compiler = fs.lstatSync(compilerTarget);
      if (!compiler.isFile() || compiler.isSymbolicLink() || compiler.nlink !== 1 || hash(fs.readFileSync(compilerTarget)) !== identity.typescriptDigest) fail("EVAL_TYPESCRIPT_COPY_INVALID");
    }
    return { root, runnerName };
  } catch (error) {
    cleanupPrivateRoot(root);
    throw error;
  }
}

function cleanupPrivateRoot(root) {
  try {
    const parent = fs.realpathSync(path.dirname(root));
    const expectedParent = fs.realpathSync(os.tmpdir());
    const stat = fs.lstatSync(root);
    if (parent !== expectedParent || path.basename(root).startsWith(rootPrefix) !== true || !stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(root) !== root) return false;
    fs.rmSync(root, { recursive: true, force: false });
    return true;
  } catch (error) { return error?.code === "ENOENT"; }
}

export function spawnPersistentEvalKernel({ language, policy, identity, root, runnerName }) {
  requireCodingBackend("eval");
  const runtime = policy.runtimes[language];
  const args = ["--minimal-runtime", "--workspace-read-only", root, "--cwd", ".", "--", policy.processLimiter.binaryPath, ...policy.processLimiter.arguments, runtime.binaryPath, ...runtime.arguments, `/workspace/${runnerName}`];
  const invocation = sandboxInvocation("eval", args);
  return spawn(invocation.command, invocation.args, {
    cwd: root,
    shell: invocation.shell,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/nonexistent", LANG: "C.UTF-8", NO_COLOR: "1" },
  });
}

class KernelConnection {
  constructor(child, policy) {
    if (!child?.stdin || !child?.stdout || !child?.stderr) fail("EVAL_KERNEL_SPAWN_INVALID");
    this.child = child;
    this.policy = policy;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.closed = false;
    this.ready = false;
    this.stderr = "";
    this.readyPromise = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    child.stdout.on("data", (chunk) => this.#consume(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => { this.stderr = safeText(`${this.stderr}${chunk.toString("utf8")}`, policy.maxStderrBytes); });
    child.once("error", () => this.#close("EVAL_KERNEL_PROCESS_ERROR"));
    child.once("exit", () => this.#close("EVAL_KERNEL_EXITED"));
    child.stdin.on("error", () => this.#close("EVAL_KERNEL_WRITE_FAILED"));
    child.stdout.on("error", () => this.#close("EVAL_KERNEL_READ_FAILED"));
    child.stderr.on("error", () => this.#close("EVAL_KERNEL_STDERR_FAILED"));
  }

  #close(code) {
    if (this.closed) return;
    this.closed = true;
    const error = new PersistentEvalError(code);
    if (!this.ready) this.rejectReady(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  #protocolFailure() {
    this.#close("EVAL_PROTOCOL_INVALID");
    this.kill("SIGKILL");
  }

  #consume(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > this.policy.maxFrameBytes) return this.#protocolFailure();
    for (;;) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) return;
      const line = this.buffer.subarray(0, newline).toString("utf8");
      this.buffer = this.buffer.subarray(newline + 1);
      if (!line.trim()) continue;
      let frame;
      try { frame = JSON.parse(line); } catch { return this.#protocolFailure(); }
      if (!frame || typeof frame !== "object" || Array.isArray(frame) || typeof frame.type !== "string") return this.#protocolFailure();
      if (frame.type === "ready" && frame.protocol === 1 && typeof frame.language === "string" && !this.ready) {
        this.ready = true;
        this.resolveReady(frame);
        continue;
      }
      if (frame.type === "result" && typeof frame.id === "string") {
        const pending = this.pending.get(frame.id);
        if (!pending) continue;
        this.pending.delete(frame.id);
        pending.resolve(frame);
        continue;
      }
      return this.#protocolFailure();
    }
  }

  waitReady(timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (handler, value) => { if (settled) return; settled = true; clearTimeout(timer); handler(value); };
      const timer = setTimeout(() => finish(reject, new PersistentEvalError("EVAL_STARTUP_TIMEOUT")), timeoutMs);
      this.readyPromise.then((value) => finish(resolve, value), (error) => finish(reject, error));
    });
  }

  request(message, options = {}) {
    if (this.closed || !this.ready) return Promise.reject(new PersistentEvalError("EVAL_KERNEL_NOT_READY"));
    const id = message.id;
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); };
      const finish = (handler, value) => { if (settled) return; settled = true; cleanup(); handler(value); };
      const abort = () => { this.pending.delete(id); finish(reject, new PersistentEvalError("EVAL_ABORTED")); };
      const timer = setTimeout(() => { this.pending.delete(id); finish(reject, new PersistentEvalError("EVAL_TIMEOUT")); }, options.timeoutMs);
      if (options.signal?.aborted) return abort();
      options.signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, { resolve: (value) => finish(resolve, value), reject: (error) => finish(reject, error) });
      try {
        const line = `${JSON.stringify(message)}\n`;
        if (Buffer.byteLength(line) > this.policy.maxFrameBytes) fail("EVAL_REQUEST_TOO_LARGE");
        this.child.stdin.write(line);
      } catch (error) {
        this.pending.delete(id);
        finish(reject, error instanceof PersistentEvalError ? error : new PersistentEvalError("EVAL_KERNEL_WRITE_FAILED"));
      }
    });
  }

  kill(signal = "SIGTERM") {
    try {
      if (Number.isSafeInteger(this.child.pid) && this.child.pid > 1) process.kill(-this.child.pid, signal);
      else this.child.kill(signal);
    } catch { try { this.child.kill(signal); } catch {} }
  }
}

export class PersistentEvalEngine {
  constructor(options = {}) {
    requireCodingBackend("eval");
    this.cwd = fs.realpathSync(options.cwd ?? process.cwd());
    this.policy = validateEvalPolicy(options.policy ?? readEvalPolicy());
    this.spawnKernel = options.spawnKernel ?? spawnPersistentEvalKernel;
    this.attestRuntime = options.attestRuntime ?? inspectRuntime;
    this.kernels = new Map();
    this.identities = new Map();
    this.stats = {
      python: { starts: 0, executions: 0, resets: 0, timeouts: 0, crashes: 0, cleanups: 0 },
      javascript: { starts: 0, executions: 0, resets: 0, timeouts: 0, crashes: 0, cleanups: 0 },
    };
  }

  #language(value) {
    if (value !== "python" && value !== "javascript") fail("EVAL_LANGUAGE_INVALID");
    return value;
  }

  #timeout(value) {
    if (value === undefined) return this.policy.executionTimeoutMs;
    return integer(value, 100, this.policy.maxExecutionTimeoutMs, "EVAL_TIMEOUT_INVALID");
  }

  #validateInput(language, input) {
    if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.action !== "string" || !actionKeys[input.action]) fail("EVAL_INPUT_INVALID");
    if (Object.keys(input).some((key) => !actionKeys[input.action].has(key))) fail("EVAL_INPUT_INVALID");
    if (input.action === "execute") {
      if (typeof input.code !== "string" || input.code.length === 0 || input.code.length > this.policy.maxCodeChars || input.code.includes("\0")) fail("EVAL_CODE_INVALID");
      if (language === "python" && input.dialect !== undefined) fail("EVAL_DIALECT_INVALID");
      if (language === "javascript" && input.dialect !== undefined && !["javascript", "typescript"].includes(input.dialect)) fail("EVAL_DIALECT_INVALID");
      this.#timeout(input.timeoutMs);
    }
    return input.action;
  }

  #identity(language) {
    const runtime = this.policy.runtimes[language];
    const existing = this.identities.get(language);
    if (existing && revalidateRuntime(existing, runtime)) return existing;
    const identity = this.attestRuntime(language, this.policy);
    this.identities.set(language, identity);
    return identity;
  }

  #summary(language) {
    const kernel = this.kernels.get(language);
    const state = !kernel ? "STOPPED" : kernel.connection.closed ? "FAILED" : kernel.state;
    return freeze({
      version: EVAL_ENGINE_VERSION,
      enabled: this.policy.enabled,
      language,
      dialects: language === "javascript" ? ["javascript", "typescript"] : ["python"],
      state,
      kernelId: kernel?.id,
      sandboxed: true,
      network: false,
      projectWorkspaceMounted: false,
      hostUserFilesystem: false,
      systemRuntimeReadOnly: true,
      subprocessBridge: false,
      persistent: Boolean(kernel && !kernel.connection.closed),
      activeKernels: kernel && !kernel.connection.closed ? 1 : 0,
      stats: { ...this.stats[language] },
    });
  }

  status(language) { return this.#summary(this.#language(language)); }

  #touch(language, kernel) {
    clearTimeout(kernel.idleTimer);
    kernel.idleTimer = setTimeout(() => { void this.terminate(language, "IDLE_TIMEOUT"); }, this.policy.idleTimeoutMs);
    kernel.idleTimer.unref?.();
  }

  async #start(language) {
    if (!this.policy.enabled) fail("EVAL_DISABLED");
    const current = this.kernels.get(language);
    if (current && !current.connection.closed) return current;
    if (current) await this.terminate(language, "FAILED_RESTART");
    const identity = this.#identity(language);
    const privateRoot = createPrivateRoot(identity);
    let child;
    try {
      child = this.spawnKernel({ language, policy: this.policy, identity, root: privateRoot.root, runnerName: privateRoot.runnerName });
      const connection = new KernelConnection(child, this.policy);
      const kernel = { id: randomUUID(), language, child, connection, root: privateRoot.root, state: "STARTING", idleTimer: undefined, busy: false };
      this.kernels.set(language, kernel);
      await connection.waitReady(this.policy.startupTimeoutMs);
      kernel.state = "READY";
      this.stats[language].starts += 1;
      this.#touch(language, kernel);
      return kernel;
    } catch (error) {
      if (child) {
        try { if (Number.isSafeInteger(child.pid) && child.pid > 1) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch {}
      }
      cleanupPrivateRoot(privateRoot.root);
      this.kernels.delete(language);
      throw error instanceof PersistentEvalError ? error : new PersistentEvalError("EVAL_KERNEL_START_FAILED");
    }
  }

  async execute(languageValue, input = {}, signal) {
    const language = this.#language(languageValue);
    const action = this.#validateInput(language, input);
    if (action === "status") return this.status(language);
    if (action === "terminate") return this.terminate(language, "EXPLICIT");
    if (action === "reset") {
      await this.terminate(language, "RESET");
      this.stats[language].resets += 1;
      return this.status(language);
    }
    const timeoutMs = this.#timeout(input.timeoutMs);
    const kernel = await this.#start(language);
    if (kernel.busy) fail("EVAL_KERNEL_BUSY");
    kernel.busy = true;
    kernel.state = "BUSY";
    clearTimeout(kernel.idleTimer);
    const id = randomUUID();
    try {
      const frame = await kernel.connection.request({
        id,
        op: "execute",
        code: input.code,
        dialect: language === "javascript" ? input.dialect ?? "javascript" : "python",
        maxOutputBytes: Math.max(1024, Math.floor(this.policy.maxOutputBytes / 2)),
        maxValueChars: this.policy.maxValueChars,
      }, { signal, timeoutMs });
      if (!["PASS", "ERROR"].includes(frame.status) || typeof frame.stdout !== "string" || typeof frame.stderr !== "string" || typeof frame.value !== "string") fail("EVAL_RESULT_INVALID");
      kernel.state = "READY";
      kernel.busy = false;
      this.stats[language].executions += 1;
      this.#touch(language, kernel);
      const stdout = safeText(frame.stdout, this.policy.maxOutputBytes);
      const stderr = safeText(frame.stderr, this.policy.maxOutputBytes);
      const totalOutputBytes = Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + Buffer.byteLength(frame.value);
      return freeze({
        kind: "PERSISTENT_EVAL_RESULT",
        status: frame.status,
        language,
        dialect: language === "javascript" ? input.dialect ?? "javascript" : "python",
        stdout,
        stderr,
        value: safeText(frame.value, this.policy.maxValueChars),
        errorType: safeText(frame.errorType, 128) || undefined,
        error: safeText(frame.error, this.policy.maxValueChars) || undefined,
        durationMs: Number.isFinite(frame.durationMs) && frame.durationMs >= 0 ? Math.round(frame.durationMs * 1000) / 1000 : undefined,
        outputBytes: totalOutputBytes,
        outputTruncated: frame.outputTruncated === true,
        valueTruncated: frame.valueTruncated === true,
        session: this.#summary(language),
      });
    } catch (error) {
      kernel.busy = false;
      const code = errorCode(error);
      if (code === "EVAL_TIMEOUT") this.stats[language].timeouts += 1;
      else if (!["EVAL_ABORTED", "EVAL_CODE_INVALID", "EVAL_DIALECT_INVALID"].includes(code)) this.stats[language].crashes += 1;
      await this.terminate(language, code);
      throw error instanceof PersistentEvalError ? error : new PersistentEvalError(code);
    }
  }

  async terminate(languageValue, reason = "EXPLICIT") {
    const language = this.#language(languageValue);
    const kernel = this.kernels.get(language);
    if (!kernel) return this.#summary(language);
    clearTimeout(kernel.idleTimer);
    kernel.state = "STOPPING";
    kernel.connection.kill("SIGTERM");
    if (kernel.child.exitCode === null) {
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(); };
        const timer = setTimeout(finish, this.policy.shutdownGraceMs);
        kernel.child.once("exit", finish);
      });
    }
    if (kernel.child.exitCode === null) {
      kernel.connection.kill("SIGKILL");
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(); };
        const timer = setTimeout(finish, this.policy.shutdownGraceMs);
        kernel.child.once("exit", finish);
      });
    }
    const cleaned = cleanupPrivateRoot(kernel.root);
    this.kernels.delete(language);
    this.stats[language].cleanups += 1;
    return freeze({ ...this.#summary(language), cleanupReason: reason, processExited: kernel.child.exitCode !== null || kernel.connection.closed, temporaryRemoved: cleaned });
  }

  async terminateAll(reason = "SESSION_SHUTDOWN") {
    const results = [];
    for (const language of ["python", "javascript"]) results.push(await this.terminate(language, reason));
    return freeze(results);
  }
}

export function persistentEvalErrorCode(error) { return errorCode(error); }
