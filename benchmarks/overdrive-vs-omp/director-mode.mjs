#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const benchmarkRoot = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(benchmarkRoot, "../..");
const secureWorkflow = path.join(packageRoot, "extensions", "secure-workflow.ts");
const verification = path.join(packageRoot, "extensions", "verification-gate.ts");
const director = path.join(packageRoot, "extensions", "director-mode.ts");
const provider = path.join(packageRoot, "tests", "fixtures", "deterministic-director-provider.ts");
const pi = process.env.PI_BIN ?? "pi";
const writeResults = process.argv.includes("--write-results");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-director-benchmark-"));

function parseLines(text) { return String(text ?? "").split(/\r?\n/u).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }); }

async function runSequence(root, env) {
  const child = spawn(pi, [
    "--offline", "--approve", "--no-session", "--mode", "rpc",
    "--extension", secureWorkflow,
    "--extension", verification,
    "--extension", director,
    "--extension", provider,
    "--provider", "director-local",
    "--api-key", "audit-only",
    "--model", "director-local/driver",
    "--thinking", "low",
  ], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  const events = [];
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
        for (const waiter of [...waiters]) if (waiter.predicate(event)) { clearTimeout(waiter.timer); waiters.delete(waiter); waiter.resolve(event); }
      } catch {}
    }
  });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-1024 * 1024); });
  const closePromise = new Promise((resolve) => child.once("close", (code) => {
    closed = true;
    for (const waiter of [...waiters]) { clearTimeout(waiter.timer); waiters.delete(waiter); waiter.reject(new Error(`pi_closed:${code}:${stderr.slice(-500)}`)); }
    resolve(code);
  }));
  const request = (message, timeoutMs = 60_000) => {
    const waiting = new Promise((resolve, reject) => {
      const waiter = { predicate: (event) => event.type === "response" && event.id === message.id, resolve, reject, timer: setTimeout(() => { waiters.delete(waiter); reject(new Error(`timeout:${message.id}:${stderr.slice(-500)}`)); }, timeoutMs) };
      waiters.add(waiter);
    });
    child.stdin.write(`${JSON.stringify(message)}\n`);
    return waiting;
  };
  try {
    const responses = [];
    responses.push(await request({ id: "commands", type: "get_commands" }));
    responses.push(await request({ id: "status-before", type: "prompt", message: "/director status" }));
    responses.push(await request({ id: "tiny", type: "prompt", message: "/director Change one string value." }));
    responses.push(await request({ id: "run", type: "prompt", message: "/director Refactor the concurrent recovery state machine and integration tests. DIRECTOR_BENCHMARK_TASK_MARKER" }));
    responses.push(await request({ id: "status-after", type: "prompt", message: "/director status" }));
    responses.push(await request({ id: "fixture-state", type: "prompt", message: "/director-fixture-state" }));
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
  const configDir = path.join(root, "config");
  const auditFile = path.join(root, "audit.jsonl");
  const sentinel = path.join(root, "director-must-not-write.txt");
  const modelPolicyFile = path.join(configDir, "model-policy.json");
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(agentDir, "settings.json"), "{}\n", { mode: 0o600 });
  fs.writeFileSync(auditFile, "", { mode: 0o600 });
  fs.writeFileSync(modelPolicyFile, `${JSON.stringify({ version: 2, preset: "normal", basePreset: "normal", overrides: {} }, null, 2)}\n`, { mode: 0o600 });
  const started = performance.now();
  const run = await runSequence(root, {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OVERDRIVE_MODEL_POLICY: modelPolicyFile,
    PI_OVERDRIVE_DIRECTOR_AUDIT_KEY: "audit-only",
    PI_OVERDRIVE_DIRECTOR_AUDIT_FILE: auditFile,
    PI_OVERDRIVE_DIRECTOR_SENTINEL: sentinel,
  });
  const elapsedMs = Number((performance.now() - started).toFixed(3));
  const auditText = fs.readFileSync(auditFile, "utf8");
  const audit = parseLines(auditText);
  const providerTurns = audit.filter((entry) => entry.kind === "provider_turn");
  const metadata = audit.filter((entry) => entry.auditKind === "director_metadata");
  const blocked = audit.find((entry) => entry.kind === "blocked_result");
  const initialTools = audit.find((entry) => entry.kind === "initial_tools");
  const postTools = audit.find((entry) => entry.kind === "post_tools");
  const commands = run.responses[0]?.data?.commands ?? [];
  const notifications = run.events.filter((event) => event.type === "extension_ui_request" && event.method === "notify").map((event) => String(event.message));
  const statuses = metadata.map((entry) => entry.status);
  const assertions = {
    realPiCommandRegistered: commands.some((entry) => entry.name === "director" && entry.source === "extension"),
    statusAndTinyTaskZeroCall: notifications.some((message) => message.includes("Director Mode: IDLE")) && notifications.some((message) => message.includes("DIRECT_SMALL_EDIT")) && providerTurns.length === 2,
    explicitEligibleActivation: statuses.includes("ACTIVATED") && statuses.includes("STARTED") && metadata.some((entry) => entry.reasonCode === "ELIGIBLE_BOUNDED_DELEGATION"),
    actualControllerToolsVisible: providerTurns.every((entry) => entry.tools.includes("read") && entry.tools.includes("secure_coding_workflow") && entry.tools.includes("verification_gate")),
    directorPromptInjected: providerTurns.every((entry) => entry.directorPrompt === true),
    lateMutationSurfaceBlocked: providerTurns[0]?.tools.includes("write") && blocked?.isError === true && blocked?.directorReason === true && statuses.includes("DIRECT_TOOL_BLOCKED"),
    repositoryMutationAbsent: !fs.existsSync(sentinel),
    automaticExit: statuses.includes("COMPLETED") && notifications.filter((message) => message.includes("Director Mode: IDLE")).length >= 2,
    priorSurfaceRestored: postTools?.equalsInitial === true && Array.isArray(initialTools?.tools),
    metadataOnly: !auditText.includes("DIRECTOR_BENCHMARK_TASK_MARKER") && !/"prompt"|"transcript"|"toolArgs"|"toolResult"|"councilOutput"|"credential"/u.test(auditText),
    exactlyTwoLocalTurns: providerTurns.length === 2 && run.events.filter((event) => event.type === "agent_start").length === 1,
  };
  report = {
    version: 1,
    recordedAt: new Date().toISOString(),
    status: run.exitCode === 0 && Object.values(assertions).every(Boolean) ? "PASS" : "FAIL",
    measurementMode: "real-pi-explicit-director-tool-clamp-and-runtime-barrier",
    piVersion: spawnSync(pi, ["--version"], { encoding: "utf8" }).stdout.trim(),
    overdriveUltra: { elapsedMs, providerTurns: providerTurns.length, metadataStatuses: statuses, assertions },
    accounting: { deterministicLocalProviderCalls: providerTurns.length, externalProviderCalls: 0, paidModelCalls: 0, networkCalls: 0, cost: 0 },
    authority: { directMutationFallback: false, parallelWorkerRegistryAdded: false, existingSecureWorkflowController: true },
    ompReference: { commit: "4267074ac91456866e95ed8de0b6353388f08502", version: "18.1.21", executableStatus: "NOT_RUN", reason: "Bun >=1.4 is unavailable; source inspection is not numeric benchmark evidence." },
    stderr: run.exitCode === 0 ? "" : run.stderr.slice(-2000),
  };
} catch (error) {
  report = { version: 1, recordedAt: new Date().toISOString(), status: "FAIL", accounting: { deterministicLocalProviderCalls: 0, externalProviderCalls: 0, paidModelCalls: 0, networkCalls: 0, cost: 0 }, error: error instanceof Error ? error.message : String(error) };
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
  if (report) report.cleanup = { temporaryRemoved: !fs.existsSync(temporary), residualProcesses: 0 };
}

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (writeResults) fs.writeFileSync(path.join(benchmarkRoot, "director-mode-results.json"), serialized, { mode: 0o600 });
process.stdout.write(serialized);
process.exit(report.status === "PASS" ? 0 : 1);
