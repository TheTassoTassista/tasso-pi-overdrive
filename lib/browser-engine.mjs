import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findRuntimeAllocation } from "./runtime-isolation.mjs";
import { captureProcessIdentity, inspectProcessIdentity } from "./process-identity.mjs";
import { validateAllocatedBrowserCall } from "./safety.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browserDir = path.join(os.homedir(), ".local/share/pi-overdrive/agent-browser-0.36.0");
const chromeDir = path.join(os.homedir(), ".agent-browser/browsers/chrome-152.0.7977.82");
const pins = Object.freeze([
  [path.join(browserDir, "agent-browser"), "56d15181e51e00213f907fcf39707cfc76bfa804ff20f5a9373661c73f96de5e"],
  [path.join(chromeDir, "chrome"), "115ee0fc6d26768ec757db2b0c6f54554dece46b59e96c7eca653c944db7f3de"],
]);
const MAX_IMAGE = 4 * 1024 * 1024;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function validateBrowserPng(data) {
  if (!Buffer.isBuffer(data) || data.length < 57 || data.length > MAX_IMAGE || !data.subarray(0, 8).equals(PNG)) return false;
  let offset = 8;
  let first = true;
  let idat = false;
  while (offset + 12 <= data.length) {
    const size = data.readUInt32BE(offset);
    const end = offset + 12 + size;
    if (size > MAX_IMAGE || end > data.length) return false;
    const type = data.toString("ascii", offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/u.test(type)) return false;
    if (first) {
      if (type !== "IHDR" || size !== 13) return false;
      const width = data.readUInt32BE(offset + 8);
      const height = data.readUInt32BE(offset + 12);
      if (width < 1 || height < 1 || width > 16384 || height > 16384) return false;
      first = false;
    }
    let crc = 0xffffffff;
    for (let index = offset + 4; index < end - 4; index += 1) {
      crc ^= data[index];
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    if (((crc ^ 0xffffffff) >>> 0) !== data.readUInt32BE(end - 4)) return false;
    if (type === "IDAT") idat = true;
    if (type === "IEND") return size === 0 && idat && end === data.length;
    offset = end;
  }
  return false;
}

function deny(code) { throw new Error(`BROWSER_ENGINE_${code}`); }

async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file, { flags: "r" })) hash.update(chunk);
  return hash.digest("hex");
}

async function pinnedRuntime() {
  for (const [file, expected] of pins) {
    if (fs.realpathSync(file) !== file || !fs.statSync(file).isFile() || await hashFile(file) !== expected) deny("PIN_MISMATCH");
  }
}

function captureFixture(allocation) {
  const source = path.join(allocation.worktree, "index.html");
  const descriptor = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let data;
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 512 * 1024) deny("FIXTURE_REJECTED");
    data = fs.readFileSync(descriptor);
    if (data.length !== stat.size) deny("FIXTURE_CHANGED");
  } finally { fs.closeSync(descriptor); }
  const target = path.join(allocation.stateDir, "browser-fixture.html");
  const out = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(out, data); fs.fsyncSync(out); } finally { fs.closeSync(out); }
  return target;
}

function translate(input, allocation) {
  const policy = validateAllocatedBrowserCall(input, allocation);
  if (!policy.allowed) deny(`POLICY_${policy.reason}`);
  const args = input.args;
  const action = args[2] === "--profile" ? "open" : args[2];
  const request = { action, timeoutMs: input.timeoutMs ?? 15000 };
  if (action === "snapshot") request.value = args[3];
  if (action === "click") request.selector = args[3];
  if (action === "fill") { request.selector = args[3]; request.value = args[4]; }
  if (action === "wait") { request.action = "wait_text"; request.value = args[4]; }
  if (action === "get") {
    request.action = args[3] === "text" ? "get_text" : args[3] === "title" ? "get_title" : "get_url";
    if (args[3] === "text") request.selector = args[4];
  }
  return request;
}

function storeScreenshot(allocation, answer) {
  if (typeof answer.image !== "string" || answer.image.length > Math.ceil(MAX_IMAGE * 4 / 3) + 8) deny("CAPTURE_REJECTED");
  const data = Buffer.from(answer.image, "base64");
  const digest = createHash("sha256").update(data).digest("hex");
  if (!validateBrowserPng(data) || digest !== answer.sha256 || answer.bytes !== data.length) deny("CAPTURE_REJECTED");
  const file = path.join(allocation.stateDir, `browser-${digest}.png`);
  const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  let complete = false;
  try {
    fs.writeFileSync(descriptor, data);
    fs.fsyncSync(descriptor);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== data.length || (stat.mode & 0o077) !== 0) deny("CAPTURE_REJECTED");
    complete = true;
  } finally {
    fs.closeSync(descriptor);
    if (!complete) { try { fs.unlinkSync(file); } catch {} }
  }
  return { digest, bytes: data.length, mime: "image/png", retention: "allocation" };
}

export class BrowserEngine {
  constructor({ cwd, ownerSession }) {
    this.cwd = fs.realpathSync(cwd);
    this.ownerSession = ownerSession;
    this.state = "ALLOCATED";
    this.child = undefined;
    this.allocationId = undefined;
    this.namespace = undefined;
    this.chromiumIdentity = undefined;
    this.buffer = "";
    this.pending = undefined;
    this.runnerIdentity = undefined;
    this.fixtureFile = undefined;
  }

  status() { return { state: this.state, allocationId: this.allocationId, networkNamespace: this.namespace, sandboxed: this.state === "ACTIVE", network: false }; }

  allocation() {
    const value = findRuntimeAllocation(this.cwd);
    if (!value || (this.allocationId && value.allocationId !== this.allocationId) || fs.realpathSync(value.worktree) !== this.cwd) deny("ALLOCATION_REJECTED");
    return value;
  }

  async start(allocation) {
    if (this.state !== "ALLOCATED") deny("STATE_REJECTED");
    this.state = "STARTING";
    this.allocationId = allocation.allocationId;
    await pinnedRuntime();
    if (this.state !== "STARTING") deny("CANCELLED");
    const fixture = captureFixture(allocation);
    this.fixtureFile = fixture;
    const runner = path.join(root, "runtime/browser/runner.py");
    const args = [
      "--unshare-all", "--clearenv", "--die-with-parent", "--new-session",
      "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib", "/lib64",
      "--tmpfs", "/etc", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/home", "--dir", "/home/sandbox",
      "--dir", "/opt", "--dir", "/fixture", "--ro-bind", browserDir, "/opt/agent-browser", "--ro-bind", chromeDir, "/opt/chrome",
      "--ro-bind", runner, "/opt/browser-runner.py", "--ro-bind", fixture, "/fixture/index.html", "--bind", allocation.browserProfile, "/profile",
      "--setenv", "HOME", "/home/sandbox", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "LANG", "C.UTF-8",
      "--setenv", "AGENT_BROWSER_EXECUTABLE_PATH", "/opt/chrome/chrome", "--setenv", "AGENT_BROWSER_SOCKET_DIR", "/tmp",
      "--setenv", "AGENT_BROWSER_PROFILE", "/profile",
      "--setenv", "OVERDRIVE_BROWSER_SESSION", allocation.browserSession, "--setenv", "OVERDRIVE_BROWSER_PORT", String(allocation.port),
      "--", "/usr/bin/python3", "/opt/browser-runner.py",
    ];
    this.child = spawn("/usr/bin/bwrap", args, { stdio: ["pipe", "pipe", "pipe"], detached: true, env: {}, cwd: "/", windowsHide: true });
    this.child.stderr.on("data", () => {});
    this.child.stdout.on("data", (data) => this.receive(data));
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", () => { if (this.state !== "CLOSED") this.fail(new Error("runner exited")); });
    const ready = await this.response(15000);
    const hostNamespace = fs.readlinkSync("/proc/self/ns/net");
    if (ready.ready !== true || typeof ready.networkNamespace !== "string" || ready.networkNamespace === hostNamespace || ready.fixturePort !== allocation.port || ready.ambientSecrets !== false || ready.hostHomeVisible !== false) deny("NAMESPACE_REJECTED");
    this.namespace = ready.networkNamespace;
    this.runnerIdentity = captureProcessIdentity(this.child.pid);
    this.removeFixture();
    this.state = "READY";
  }

  removeFixture() {
    if (!this.fixtureFile) return;
    try { fs.unlinkSync(this.fixtureFile); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    this.fixtureFile = undefined;
  }

  receive(chunk) {
    this.buffer += chunk.toString("utf8");
    if (this.buffer.length > 8 * 1024 * 1024) { this.fail(new Error("runner output exceeded bound")); return; }
    const newline = this.buffer.indexOf("\n");
    if (newline < 0) return;
    const line = this.buffer.slice(0, newline);
    this.buffer = this.buffer.slice(newline + 1);
    if (!this.pending) { this.fail(new Error("unsolicited runner response")); return; }
    const pending = this.pending;
    this.pending = undefined;
    clearTimeout(pending.timer);
    try { pending.resolve(JSON.parse(line)); } catch (error) { pending.reject(error); }
  }

  response(timeoutMs) {
    if (this.pending) deny("CONCURRENT_REQUEST");
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject, timer: setTimeout(() => this.fail(new Error("runner timeout")), timeoutMs) };
    });
  }

  fail(error) {
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = undefined; }
    try { this.removeFixture(); } catch {}
    if (this.state !== "CLOSED") { this.state = "FAILED"; this.kill(); }
  }

  kill() {
    if (this.runnerIdentity && inspectProcessIdentity(this.runnerIdentity).alive) { try { process.kill(-this.runnerIdentity.pid, "SIGKILL"); } catch {} }
    else if (this.child?.pid && this.child.exitCode === null) { try { this.child.kill("SIGKILL"); } catch {} }
    this.child?.stdin?.destroy();
  }

  async execute(input, ownerSession) {
    if (ownerSession !== this.ownerSession) deny("OWNER_REJECTED");
    const allocation = this.allocation();
    const request = translate(input, allocation);
    if (this.state === "ALLOCATED" && request.action !== "open") deny("OPEN_REQUIRED");
    if (this.state === "ALLOCATED") {
      try { await this.start(allocation); } catch (error) { this.fail(error); throw error; }
    }
    if (this.state !== "READY" && this.state !== "ACTIVE") deny("STATE_REJECTED");
    if (request.action === "open" && this.state !== "READY") deny("ALREADY_OPEN");
    if (request.action !== "open" && this.state !== "ACTIVE") deny("OPEN_REQUIRED");
    if (request.action === "close") this.state = "CLOSING";
    const response = this.response(request.timeoutMs + 2000);
    this.child.stdin.write(`${JSON.stringify(request)}\n`);
    let answer;
    try { answer = await response; } catch (error) { this.fail(error); throw error; }
    if (!answer?.ok || answer.networkNamespace !== this.namespace) { this.fail(new Error(answer?.error ?? "runner namespace changed")); throw new Error(`BROWSER_ENGINE_RUNNER_FAILED: ${String(answer?.error ?? "namespace changed").slice(0, 1000)}`); }
    if (request.action !== "close") {
      if (!Number.isSafeInteger(answer.chromiumIdentity?.pid) || !/^\d+$/u.test(answer.chromiumIdentity?.startTicks ?? "")) { this.fail(new Error("Chromium identity unavailable")); deny("CHROMIUM_IDENTITY_REJECTED"); }
      if (!this.chromiumIdentity) this.chromiumIdentity = answer.chromiumIdentity;
      else if (this.chromiumIdentity.pid !== answer.chromiumIdentity.pid || this.chromiumIdentity.startTicks !== answer.chromiumIdentity.startTicks) { this.fail(new Error("Chromium identity changed")); deny("CHROMIUM_IDENTITY_REJECTED"); }
    }
    if (request.action === "close") { this.state = "CLOSED"; this.kill(); }
    else this.state = "ACTIVE";
    let screenshot;
    try { screenshot = request.action === "screenshot" ? storeScreenshot(allocation, answer) : undefined; }
    catch (error) { this.fail(error); throw error; }
    return { status: "PASS", action: request.action, text: String(answer.text ?? "").slice(0, 32768), screenshot, state: this.state, networkNamespace: this.namespace, runnerIdentity: this.runnerIdentity, chromiumIdentity: this.chromiumIdentity, sandboxed: true, externalNetwork: false, ambientSecrets: false, hostHomeVisible: false };
  }

  async terminate() {
    this.state = "CLOSED";
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new Error("BROWSER_ENGINE_CANCELLED")); this.pending = undefined; }
    this.kill();
    this.removeFixture();
  }
}
