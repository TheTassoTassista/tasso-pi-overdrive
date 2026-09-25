#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const benchmarkRoot = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(benchmarkRoot, "../..");
const pi = process.env.PI_BIN ?? "pi";
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-watchdog-pi-"));
const parseLines = (value) => String(value).split(/\r?\n/u).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });

async function run(root, environment) {
  const child = spawn(pi, [
    "--offline", "--approve", "--no-session", "--mode", "rpc",
    "--extension", path.join(packageRoot, "tests", "fixtures", "deterministic-sentinel-provider.ts"),
    "--extension", path.join(packageRoot, "extensions", "watchdog.ts"),
    "--extension", path.join(packageRoot, "tests", "fixtures", "deterministic-watchdog-observer.ts"),
    "--extension", path.join(packageRoot, "extensions", "metadata-trace.ts"),
    "--provider", "pi-overdrive-sentinel-audit", "--api-key", "audit-only", "--model", "driver", "--thinking", "low", "--no-tools",
  ], { cwd: root, env: environment, stdio: ["pipe", "pipe", "pipe"] });
  const events = [];
  const waiters = new Set();
  let buffer = "";
  let stderr = "";
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
        for (const waiter of [...waiters]) if (waiter.predicate(event)) { clearTimeout(waiter.timer); waiters.delete(waiter); waiter.resolve(event); }
      } catch {}
    }
  });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4096); });
  const closed = new Promise((resolve) => child.once("close", (code) => {
    for (const waiter of [...waiters]) { clearTimeout(waiter.timer); waiters.delete(waiter); waiter.reject(new Error(`pi_closed:${code}:${stderr.slice(-500)}`)); }
    resolve(code);
  }));
  const request = (message) => new Promise((resolve, reject) => {
    const waiter = { predicate: (event) => event.type === "response" && event.id === message.id, resolve, reject, timer: setTimeout(() => { waiters.delete(waiter); reject(new Error(`timeout:${message.id}:${stderr.slice(-500)}`)); }, 45_000) };
    waiters.add(waiter);
    child.stdin.write(`${JSON.stringify(message)}\n`);
  });
  let exitCode;
  try {
    const responses = [];
    responses.push(await request({ id: "commands", type: "get_commands" }));
    for (const [id, message] of [["status", "/watchdog status"], ["disabled", "/watchdog-fixture repeated"], ["on", "/watchdog on"], ["tiny", "/watchdog-fixture tiny"], ["repeated", "/watchdog-fixture repeated"], ["regression", "/watchdog-fixture regression"], ["malformed", "/watchdog-fixture malformed"], ["off", "/watchdog off"]]) responses.push(await request({ id, type: "prompt", message }));
    child.stdin.end();
    exitCode = await closed;
    return { responses, events, stderr, exitCode };
  } finally {
    if (exitCode === undefined) {
      child.stdin.end();
      const timeout = setTimeout(() => child.kill("SIGTERM"), 3000);
      exitCode = await closed;
      clearTimeout(timeout);
    }
  }
}

let report;
try {
  const root = path.join(temporary, "run");
  const agentDir = path.join(root, "agent");
  const auditFile = path.join(root, "watchdog-audit.jsonl");
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(agentDir, "settings.json"), "{}\n", { mode: 0o600 });
  fs.writeFileSync(auditFile, "", { mode: 0o600 });
  const started = performance.now();
  const execution = await run(root, { ...process.env, XDG_STATE_HOME: path.join(root, "state"), PI_CODING_AGENT_DIR: agentDir, PI_OVERDRIVE_SENTINEL_AUDIT_KEY: "audit-only", PI_OVERDRIVE_WATCHDOG_AUDIT_FILE: auditFile });
  const audit = parseLines(fs.readFileSync(auditFile, "utf8"));
  const statuses = audit.map((entry) => entry.status);
  const commands = execution.responses[0]?.data?.commands ?? [];
  const advice = execution.events.filter((event) => event.type === "message_start" && event.message?.role === "custom" && event.message?.customType === "tasso-pi-overdrive.watchdog-advice");
  const traceRoot = path.join(root, "state", "pi-overdrive", "traces");
  const traces = fs.existsSync(traceRoot) ? fs.readdirSync(traceRoot).map((name) => fs.readFileSync(path.join(traceRoot, name), "utf8")).join("\n") : "";
  const assertions = {
    registered: commands.some((entry) => entry.name === "watchdog" && entry.source === "extension"),
    defaultOff: statuses.includes("SKIPPED_DISABLED"),
    tinyDenied: statuses.includes("SKIPPED_INELIGIBLE"),
    repeatedFailureAdvised: audit.some((entry) => entry.status === "REVIEWED" && entry.reason === "REPEATED_FAILURE"),
    duplicateSuppressed: statuses.includes("SKIPPED_DUPLICATE"),
    regressionAdvised: audit.some((entry) => entry.status === "REVIEWED" && entry.reason === "VERIFICATION_REGRESSION"),
    malformedFailSoft: statuses.includes("FAILED_SOFT"),
    customAdviceNoTurn: advice.length === 2 && !execution.events.some((event) => event.type === "agent_start"),
    noModelOrToolCalls: audit.every((entry) => entry.modelCalls === 0) && !execution.events.some((event) => event.type === "tool_execution_start"),
    boundedMetadataOnly: audit.every((entry) => entry.contextChars <= 768) && !fs.readFileSync(auditFile, "utf8").includes("BENCHMARK_PRIVATE_MARKER") && !traces.includes("BENCHMARK_PRIVATE_MARKER"),
  };
  report = { version: 1, status: execution.exitCode === 0 && Object.values(assertions).every(Boolean) ? "PASS" : "FAIL", measurementMode: "real-pi-process-controller-observation-fixture", piVersion: spawnSync(pi, ["--version"], { encoding: "utf8" }).stdout.trim(), durationMs: Number((performance.now() - started).toFixed(3)), metadataEvents: audit.length, statuses, adviceCount: advice.length, assertions, accounting: { deterministicLocalModelCalls: 0, externalProviderCalls: 0, paidModelCalls: 0, costEur: 0 }, limitations: { fullSecureWorkflowE2E: "NOT_RUN", controllerObservationPath: "fixture-emitted through production event contract" } };
} catch (error) {
  report = { version: 1, status: "FAIL", error: error instanceof Error ? error.message : String(error), accounting: { externalProviderCalls: 0, paidModelCalls: 0, costEur: 0 } };
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
  if (report) report.cleanup = { temporaryRemoved: !fs.existsSync(temporary) };
}
if (process.argv.includes("--write-results")) fs.writeFileSync(path.join(benchmarkRoot, "watchdog-pi-results.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.status === "PASS" ? 0 : 1;
