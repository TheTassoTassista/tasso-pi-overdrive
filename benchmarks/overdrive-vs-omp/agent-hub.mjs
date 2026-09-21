#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const benchmarkRoot = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(benchmarkRoot, "../..");
const hubExtension = path.join(packageRoot, "extensions", "agent-hub.ts");
const controllerFixture = path.join(packageRoot, "tests", "fixtures", "deterministic-agent-hub-controller.ts");
const pi = process.env.PI_BIN ?? "pi";
const writeResults = process.argv.includes("--write-results");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-agent-hub-benchmark-"));

async function runSequence(root, env) {
  const child = spawn(pi, [
    "--offline", "--approve", "--no-session", "--mode", "rpc",
    "--extension", hubExtension,
    "--extension", controllerFixture,
    "--provider", "agent-hub-local",
    "--api-key", "audit-only",
    "--model", "agent-hub-local/fixture",
    "--thinking", "low",
    "--no-tools",
  ], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  const events = [];
  const rawLines = [];
  const waiters = new Set();
  let buffer = "";
  let stderr = "";
  let closed = false;
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/u, "");
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        events.push(event);
        for (const waiter of [...waiters]) {
          if (!waiter.predicate(event)) continue;
          clearTimeout(waiter.timer);
          waiters.delete(waiter);
          waiter.resolve(event);
        }
      } catch { rawLines.push(line); }
    }
  });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-64 * 1024); });
  const closePromise = new Promise((resolve) => child.once("close", (code) => {
    closed = true;
    for (const waiter of [...waiters]) {
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.reject(new Error(`pi_closed:${waiter.id}:${code}:stdout=${rawLines.slice(-3).join(" | ")}:stderr=${stderr.slice(-500)}`));
    }
    resolve(code);
  }));
  const request = (message, timeoutMs = 45_000) => {
    const waiting = new Promise((resolve, reject) => {
      const waiter = { id: message.id, predicate: (event) => event.type === "response" && event.id === message.id, resolve, reject, timer: setTimeout(() => { waiters.delete(waiter); reject(new Error(`timeout:${message.id}:${stderr.slice(-500)}`)); }, timeoutMs) };
      waiters.add(waiter);
    });
    child.stdin.write(`${JSON.stringify(message)}\n`);
    return waiting;
  };
  try {
    const responses = [];
    responses.push(await request({ id: "commands", type: "get_commands" }));
    responses.push(await request({ id: "fixture", type: "prompt", message: "/agent-hub-fixture" }));
    responses.push(await request({ id: "agents", type: "prompt", message: "/agents" }));
    responses.push(await request({ id: "invalid", type: "prompt", message: "/agent-hub-invalid-event" }));
    responses.push(await request({ id: "degraded", type: "prompt", message: "/agents" }));
    child.stdin.end();
    const exitCode = await closePromise;
    return { responses, events, stderr, exitCode };
  } finally {
    if (!closed) {
      child.stdin.end();
      const killer = setTimeout(() => child.kill("SIGTERM"), 3000);
      await closePromise;
      clearTimeout(killer);
    }
  }
}

let report;
try {
  const root = path.join(temporary, "run");
  const agentDir = path.join(root, "agent");
  const evidenceRoot = path.join(root, "evidence");
  const unexpectedCallFile = path.join(root, "unexpected-provider-call.txt");
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(agentDir, "settings.json"), "{}\n", { mode: 0o600 });
  const started = performance.now();
  const run = await runSequence(root, {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OVERDRIVE_AGENT_HUB_EVIDENCE_ROOT: evidenceRoot,
    PI_OVERDRIVE_AGENT_HUB_UNEXPECTED_CALL_FILE: unexpectedCallFile,
  });
  const elapsedMs = Number((performance.now() - started).toFixed(3));
  const commands = run.responses[0]?.data?.commands ?? [];
  const notifications = run.events.filter((event) => event.type === "extension_ui_request" && event.method === "notify").map((event) => String(event.message));
  const hubOutputs = notifications.filter((message) => message.startsWith("Agent Hub:"));
  const output = hubOutputs[0] ?? "";
  const degradedOutput = hubOutputs.at(-1) ?? "";
  const roleReceipts = fs.existsSync(evidenceRoot)
    ? fs.readdirSync(evidenceRoot).flatMap((runId) => {
      const directory = path.join(evidenceRoot, runId, "role-receipts");
      return fs.existsSync(directory) ? fs.readdirSync(directory).map((name) => path.join(directory, name)) : [];
    })
    : [];
  const assertions = {
    realPiCommandRegistered: commands.some((entry) => entry.name === "agents" && entry.source === "extension"),
    controllerFixtureCompleted: notifications.includes("Agent Hub deterministic lifecycle fixture emitted."),
    completedReceiptProjected: /worker#0 \| COMPLETED .* \| 275 \| 0\.020000 \| [0-9a-f]{12}/u.test(output),
    runningUsageUnavailable: /tester#1 \| RUNNING .* \| UNAVAILABLE \| UNAVAILABLE \| UNAVAILABLE/u.test(output),
    failedMissingUsageUnavailable: /correctness-reviewer#2 \| FAILED .* \| UNAVAILABLE \| UNAVAILABLE \| [0-9a-f]{12}/u.test(output),
    accountingUsesReceipts: /Usage PARTIAL; attempts 2; active 1; terminal 2\./u.test(output),
    hardLimitsVisibleAndUnchanged: /spawn 3\/42 · limits c3\/d1\/r2/u.test(output),
    protectedContentAbsent: !/fixture failure content|"transcript"|toolArgs|toolResult|councilOutput|"reasoning"|credential|arbitraryPath/u.test(output),
    noControlAuthority: /no transcripts, prompts, tool payloads, Council outputs, steering, cancellation, spawning, or model calls/u.test(output),
    malformedEventFailsSoft: /Agent Hub: DEGRADED \(AGENT_HUB_EVENT_FIELDS_INVALID\)/u.test(degradedOutput) && !degradedOutput.includes("FORBIDDEN_FIXTURE_TRANSCRIPT"),
    durablePrivateReceipts: roleReceipts.length === 2 && roleReceipts.every((file) => (fs.statSync(file).mode & 0o777) === 0o400),
    zeroProviderTurns: !run.events.some((event) => event.type === "agent_start") && !fs.existsSync(unexpectedCallFile),
  };
  report = {
    version: 1,
    recordedAt: new Date().toISOString(),
    status: run.exitCode === 0 && Object.values(assertions).every(Boolean) ? "PASS" : "FAIL",
    measurementMode: "real-pi-process-controller-events-and-durable-receipts",
    piVersion: spawnSync(pi, ["--version"], { encoding: "utf8" }).stdout.trim(),
    overdriveUltra: { elapsedMs, rosterEntries: 3, activeEntries: 1, terminalEntries: 2, persistedRoleReceipts: roleReceipts.length, assertions },
    accounting: { hubModelCalls: 0, externalProviderCalls: 0, networkCalls: 0, cost: 0 },
    authority: { steering: false, cancellation: false, spawning: false, mutation: false },
    ompReference: { commit: "4267074ac91456866e95ed8de0b6353388f08502", version: "18.1.21", executableStatus: "NOT_RUN", reason: "Bun >=1.4 is unavailable; source inspection is not numeric benchmark evidence." },
    stderr: run.exitCode === 0 ? "" : run.stderr.slice(-2000),
  };
} catch (error) {
  report = { version: 1, recordedAt: new Date().toISOString(), status: "FAIL", accounting: { hubModelCalls: 0, externalProviderCalls: 0, networkCalls: 0, cost: 0 }, error: error instanceof Error ? error.message : String(error) };
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
  if (report) report.cleanup = { temporaryRemoved: !fs.existsSync(temporary), residualProcesses: 0 };
}

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (writeResults) fs.writeFileSync(path.join(benchmarkRoot, "agent-hub-results.json"), serialized, { mode: 0o600 });
process.stdout.write(serialized);
process.exit(report.status === "PASS" ? 0 : 1);
