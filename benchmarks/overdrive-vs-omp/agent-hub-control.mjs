#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectProcessIdentity } from "../../lib/process-identity.mjs";
import { cleanupRuntimeResources, listRuntimeAllocations } from "../../lib/runtime-isolation.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const piBinary = process.env.PI_BIN ?? "pi";
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-agent-control-"));
const repository = path.join(temporary, "repository");
const agentDir = path.join(temporary, "agent");
const evidenceRoot = path.join(temporary, "evidence");
const shareRoot = path.join(temporary, "worktrees");
const stateRoot = path.join(temporary, "runtime");
const unexpectedCallFile = path.join(temporary, "unexpected-provider-call.txt");
const workerIdentityFile = path.join(temporary, "worker-identity.json");
const writeResults = process.argv.includes("--write-results");

function shellWord(value) {
  if (!/^[A-Za-z0-9_./:@=-]+$/u.test(value)) throw new Error("benchmark command path contains unsupported shell characters");
  return value;
}

function git(args) {
  const result = spawnSync("git", args, { cwd: repository, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function productionCommandRegistered() {
  const result = spawnSync(piBinary, [
    "--offline", "--approve", "--no-session", "--mode", "rpc", "--no-extensions",
    "--extension", path.join(root, "extensions", "secure-workflow.ts"),
    "--provider", "openai-codex", "--model", "gpt-5.6-terra", "--no-tools",
  ], { cwd: repository, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, input: `${JSON.stringify({ id: "commands", type: "get_commands" })}\n`, encoding: "utf8" });
  if (result.status !== 0) return false;
  const response = result.stdout.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).find((entry) => entry?.type === "response" && entry.id === "commands");
  return response?.data?.commands?.some((entry) => entry.name === "agent-cancel" && entry.sourceInfo?.path === path.join(root, "extensions", "secure-workflow.ts")) === true;
}

function waitForEvent(events, waiters, predicate, timeoutMs, label) {
  const existing = events.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const waiter = { predicate, resolve, reject, timer: setTimeout(() => { waiters.delete(waiter); reject(new Error(`timeout:${label}`)); }, timeoutMs) };
    waiters.add(waiter);
  });
}

async function runPi() {
  const piExecutable = fs.realpathSync(path.isAbsolute(piBinary) ? piBinary : spawnSync("which", [piBinary], { encoding: "utf8" }).stdout.trim());
  const piArgs = [
    "--offline", "--approve", "--no-session", "--mode", "rpc",
    "--extension", path.join(root, "extensions", "agent-hub.ts"),
    "--extension", path.join(root, "tests", "fixtures", "deterministic-agent-hub-control.ts"),
    "--provider", "agent-hub-control-local", "--api-key", "audit-only",
    "--model", "agent-hub-control-local/fixture", "--thinking", "off", "--no-tools",
  ];
  const command = [piExecutable, ...piArgs].map(shellWord).join(" ");
  const child = spawn("script", ["-q", "-e", "-c", command, "/dev/null"], { cwd: repository, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OVERDRIVE_AGENT_HUB_EVIDENCE_ROOT: evidenceRoot, PI_OVERDRIVE_WORKTREE_ROOT: shareRoot, PI_OVERDRIVE_RUNTIME_ROOT: stateRoot, PI_OVERDRIVE_AGENT_HUB_UNEXPECTED_CALL_FILE: unexpectedCallFile, PI_OVERDRIVE_AGENT_HUB_WORKER_IDENTITY_FILE: workerIdentityFile }, stdio: ["pipe", "pipe", "pipe"] });
  const events = [];
  const waiters = new Set();
  let buffer = "";
  let stderr = "";
  let closed = false;
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      const line = buffer.slice(0, index).replace(/\r$/u, "");
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        events.push(event);
        for (const waiter of [...waiters]) if (waiter.predicate(event)) { clearTimeout(waiter.timer); waiters.delete(waiter); waiter.resolve(event); }
      } catch { stderr = `${stderr}\nNON_JSON_STDOUT:${line}`.slice(-8192); }
    }
  });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8192); });
  const closePromise = new Promise((resolve) => child.once("close", (code) => {
    closed = true;
    for (const waiter of [...waiters]) { clearTimeout(waiter.timer); waiters.delete(waiter); waiter.reject(new Error(`pi_closed:${code}:${JSON.stringify(events.slice(-3)).slice(-1200)}:${stderr.slice(-1000)}`)); }
    resolve(code);
  }));
  const request = (id, message, timeoutMs = 30_000) => {
    const response = waitForEvent(events, waiters, (event) => event.type === "response" && event.id === id, timeoutMs, id);
    child.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
    return response;
  };
  try {
    const commandsWait = waitForEvent(events, waiters, (event) => event.type === "response" && event.id === "commands", 30_000, "commands");
    child.stdin.write(`${JSON.stringify({ id: "commands", type: "get_commands" })}\n`);
    const commands = (await commandsWait).data?.commands ?? [];
    if (!commands.some((entry) => entry.name === "agent-hub-control-start")) throw new Error(`Agent Hub control fixture command missing: ${JSON.stringify(commands.map((entry) => entry.name))} stderr=${stderr.slice(-1000)}`);
    const startResponse = await request("start", "/agent-hub-control-start");
    await request("running", "/agents");
    const notifications = () => events.filter((event) => event.type === "extension_ui_request" && event.method === "notify").map((event) => String(event.message));
    const runningOutput = notifications().filter((message) => message.startsWith("Agent Hub:")).at(-1) ?? "";
    const attemptId = runningOutput.match(/worker#0 \| RUNNING [^\n]* \| ([0-9a-f]{8}-[0-9a-f-]{27})/u)?.[1];
    if (!attemptId) throw new Error(`running Worker attempt missing from /agents: start=${JSON.stringify(startResponse).slice(-800)} notifications=${JSON.stringify(notifications()).slice(-1600)} events=${JSON.stringify(events.slice(-8)).slice(-3000)} output=${runningOutput.slice(-1000)}`);
    await request("cancel", `/agent-cancel ${attemptId}`);
    await waitForEvent(events, waiters, (event) => event.type === "extension_ui_request" && event.method === "notify" && String(event.message).includes("Agent Hub controller terminal: CANCELLED; cleanup PASS."), 15_000, "terminal-cleanup");
    await request("terminal", "/agents");
    const terminalOutput = notifications().filter((message) => message.startsWith("Agent Hub:")).at(-1) ?? "";
    const receiptFiles = fs.existsSync(evidenceRoot) ? fs.readdirSync(evidenceRoot).flatMap((runId) => {
      const directory = path.join(evidenceRoot, runId, "role-receipts");
      return fs.existsSync(directory) ? fs.readdirSync(directory).map((name) => path.join(directory, name)) : [];
    }) : [];
    const receipts = receiptFiles.map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
    const cancellationNotice = notifications().find((message) => message.includes("Agent control CANCEL_REQUESTED."));
    const assertions = {
      piCommandsRegistered: ["agents", "agent-cancel", "agent-hub-control-start"].every((name) => commands.some((entry) => entry.name === name && entry.source === "extension")),
      activeWorkerProjected: runningOutput.includes(`worker#0 | RUNNING`) && runningOutput.includes(attemptId),
      exactCancelAccepted: Boolean(cancellationNotice),
      durableCancelledReceipt: receipts.length === 1 && receipts[0]?.execution_id === attemptId && receipts[0]?.status === "cancelled",
      terminalProjected: terminalOutput.includes("worker#0 | CANCELLED"),
      usageNotInvented: terminalOutput.includes("UNAVAILABLE | UNAVAILABLE"),
      worktreeDestroyed: git(["worktree", "list", "--porcelain"]).split("\n").filter((line) => line.startsWith("worktree ")).length === 1,
      runtimeReleased: !fs.existsSync(path.join(stateRoot, "allocations")) || fs.readdirSync(path.join(stateRoot, "allocations")).length === 0,
      portReleased: !fs.existsSync(path.join(stateRoot, "ports")) || fs.readdirSync(path.join(stateRoot, "ports")).length === 0,
      zeroProviderCalls: !events.some((event) => event.type === "agent_start") && !fs.existsSync(unexpectedCallFile),
    };
    child.stdin.end();
    const exitCode = await closePromise;
    return { assertions, exitCode, stderr, attemptId, receiptCount: receipts.length };
  } finally {
    if (!closed) {
      child.stdin.end();
      const killer = setTimeout(() => child.kill("SIGTERM"), 3000);
      await closePromise;
      clearTimeout(killer);
    }
  }
}

let unrelated;
let report;
try {
  fs.mkdirSync(repository, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(agentDir, "settings.json"), "{}\n", { mode: 0o600 });
  git(["init", "-q"]);
  git(["config", "user.email", "local-benchmark@example.invalid"]);
  git(["config", "user.name", "Local Benchmark"]);
  fs.writeFileSync(path.join(repository, "README.md"), "# Local isolated Worker fixture\n", { mode: 0o600 });
  git(["add", "README.md"]);
  git(["commit", "-qm", "Local fixture"]);
  unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: temporary, stdio: "ignore" });
  if (!unrelated.pid) throw new Error("unrelated process failed to start");
  const started = performance.now();
  const run = await runPi();
  let unrelatedSurvived = false;
  try { process.kill(unrelated.pid, 0); unrelatedSurvived = true; } catch {}
  const assertions = { ...run.assertions, productionCommandRegistered: productionCommandRegistered(), unrelatedProcessSurvived: unrelatedSurvived, piExitZero: run.exitCode === 0 };
  report = {
    version: 1, recordedAt: new Date().toISOString(),
    status: Object.values(assertions).every(Boolean) ? "PASS" : "FAIL",
    measurementMode: "real-pi-offline-controller-owned-process-worktree-durable-receipt",
    elapsedMs: Number((performance.now() - started).toFixed(3)),
    piVersion: spawnSync(piBinary, ["--version"], { encoding: "utf8" }).stdout.trim(),
    attemptId: run.attemptId, receiptCount: run.receiptCount, assertions,
    accounting: { providerCalls: 0, externalNetworkCalls: 0, monetaryCost: 0 },
    stderr: run.exitCode === 0 ? "" : run.stderr.slice(-1500),
  };
} catch (error) {
  report = { version: 1, recordedAt: new Date().toISOString(), status: "FAIL", error: error instanceof Error ? error.message : String(error), accounting: { providerCalls: 0, externalNetworkCalls: 0, monetaryCost: 0 } };
} finally {
  if (unrelated?.pid) { unrelated.kill("SIGTERM"); await new Promise((resolve) => unrelated.once("exit", resolve)); }
  let workerAbsent = true;
  if (fs.existsSync(workerIdentityFile)) {
    try {
      const identity = JSON.parse(fs.readFileSync(workerIdentityFile, "utf8"));
      if (inspectProcessIdentity(identity).alive) {
        process.kill(identity.pid, "SIGTERM");
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (inspectProcessIdentity(identity).alive) process.kill(identity.pid, "SIGKILL");
      }
      workerAbsent = !inspectProcessIdentity(identity).alive;
    } catch { workerAbsent = false; }
  }
  let residualAllocations = null;
  try {
    for (const allocation of listRuntimeAllocations({ shareRoot, stateRoot })) cleanupRuntimeResources(allocation.allocationId, { shareRoot, stateRoot });
    residualAllocations = listRuntimeAllocations({ shareRoot, stateRoot }).length;
  } catch {}
  fs.rmSync(temporary, { recursive: true, force: true });
  report.cleanup = { temporaryRemoved: !fs.existsSync(temporary), unrelatedProcessStopped: unrelated ? unrelated.exitCode !== null || unrelated.signalCode !== null : true, workerAbsent, residualAllocations };
  if (!report.cleanup.temporaryRemoved || !report.cleanup.unrelatedProcessStopped || !workerAbsent || residualAllocations !== 0) report.status = "FAIL";
}

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (writeResults) fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "agent-hub-control-results.json"), serialized, { mode: 0o600 });
process.stdout.write(serialized);
process.exit(report.status === "PASS" ? 0 : 1);
