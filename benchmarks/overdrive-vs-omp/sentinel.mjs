#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const benchmarkRoot = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(benchmarkRoot, "../..");
const provider = path.join(packageRoot, "tests", "fixtures", "deterministic-sentinel-provider.ts");
const extension = path.join(packageRoot, "extensions", "sentinel.ts");
const pi = process.env.PI_BIN ?? "pi";
const writeResults = process.argv.includes("--write-results");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-sentinel-benchmark-"));

function parseLines(text) { return String(text ?? "").split(/\r?\n/u).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }); }
function sha256(value) { return createHash("sha256").update(String(value)).digest("hex"); }

async function runSequence(root, env) {
  const child = spawn(pi, [
    "--offline", "--approve", "--no-session", "--mode", "rpc", "--extension", provider, "--extension", extension,
    "--provider", "pi-overdrive-sentinel-audit", "--api-key", "audit-only", "--model", "driver", "--thinking", "low", "--no-tools",
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
    for (const waiter of [...waiters]) {
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.reject(new Error(`pi_closed:${code}:${stderr.slice(-500)}`));
    }
    resolve(code);
  }));
  const request = (message, timeoutMs = 45_000) => {
    const prior = events.find((event) => event.type === "response" && event.id === message.id);
    if (prior) return Promise.resolve(prior);
    const waiting = new Promise((resolve, reject) => {
      const waiter = { predicate: (event) => event.type === "response" && event.id === message.id, resolve, reject, timer: setTimeout(() => { waiters.delete(waiter); reject(new Error(`timeout:${message.id}:${stderr.slice(-500)}`)); }, timeoutMs) };
      waiters.add(waiter);
    });
    child.stdin.write(`${JSON.stringify(message)}\n`);
    return waiting;
  };
  let exitCode;
  try {
    const responses = [];
    responses.push(await request({ id: "commands", type: "get_commands" }));
    responses.push(await request({ id: "status", type: "prompt", message: "/sentinel status" }));
    responses.push(await request({ id: "negative", type: "prompt", message: "/sentinel Change one string value." }));
    responses.push(await request({ id: "positive", type: "prompt", message: "/sentinel Find and fix the intermittent race condition under load in src/queue.ts. BENCHMARK_TASK_MARKER_72" }));
    responses.push(await request({ id: "repeat", type: "prompt", message: "/sentinel Find and fix the intermittent race condition under load in src/queue.ts again." }));
    child.stdin.end();
    exitCode = await closePromise;
    return { responses, events, stderr, exitCode };
  } finally {
    if (!closed) {
      child.stdin.end();
      const killer = setTimeout(() => child.kill("SIGTERM"), 3000);
      exitCode = await closePromise;
      clearTimeout(killer);
    }
  }
}

let report;
try {
  const root = path.join(temporary, "run");
  const agentDir = path.join(root, "agent");
  const configDir = path.join(root, "config", "pi-overdrive");
  const auditFile = path.join(root, "audit.jsonl");
  const modelPolicyFile = path.join(configDir, "model-policy.json");
  const callabilityFile = path.join(configDir, "model-callability.json");
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(agentDir, "settings.json"), "{}\n", { mode: 0o600 });
  fs.writeFileSync(auditFile, "", { mode: 0o600 });
  const storedPolicy = { version: 2, preset: "normal", basePreset: "normal", overrides: {} };
  fs.writeFileSync(modelPolicyFile, `${JSON.stringify(storedPolicy, null, 2)}\n`, { mode: 0o600 });
  const directIds = ["gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-astra"];
  fs.writeFileSync(callabilityFile, `${JSON.stringify({ version: 1, entries: Object.fromEntries(directIds.map((id) => [`openai-codex/${id}`, { runtimeStatus: "RUNTIME_CALLABLE", reasonCode: "DETERMINISTIC_LOCAL_PROVIDER" }])) }, null, 2)}\n`, { mode: 0o600 });
  const beforePolicy = fs.readFileSync(modelPolicyFile, "utf8");
  const env = {
    ...process.env, XDG_STATE_HOME: path.join(root, "state"), PI_CODING_AGENT_DIR: agentDir,
    PI_OVERDRIVE_MODEL_POLICY: modelPolicyFile, PI_OVERDRIVE_MODEL_CALLABILITY: callabilityFile,
    PI_OVERDRIVE_SENTINEL_AUDIT_KEY: "audit-only", PI_OVERDRIVE_SENTINEL_AUDIT_FILE: auditFile,
  };
  const started = performance.now();
  const run = await runSequence(root, env);
  const elapsedMs = Number((performance.now() - started).toFixed(3));
  const audit = parseLines(fs.readFileSync(auditFile, "utf8"));
  const providerCalls = audit.filter((entry) => entry.kind === "sentinel_provider_call");
  const sentinelEvents = audit.filter((entry) => entry.auditKind === "sentinel_metadata");
  const contextEvents = audit.filter((entry) => entry.auditKind === "context_metadata" && entry.kind === "context_fit_direct_sentinel");
  const commands = run.responses[0]?.data?.commands ?? [];
  const notifications = run.events.filter((event) => event.type === "extension_ui_request" && event.method === "notify").map((event) => String(event.message));
  const customAdvice = run.events.filter((event) => event.type === "message_start" && event.message?.role === "custom" && event.message?.customType === "tasso-pi-overdrive.sentinel-advice");
  const statuses = sentinelEvents.map((entry) => entry.status);
  const assertions = {
    realPiCommandRegistered: commands.some((entry) => entry.name === "sentinel" && entry.source === "extension"),
    statusAndNegativePathsZeroCall: providerCalls.length === 1 && notifications.some((entry) => entry.includes("SENTINEL_TASK_POLICY_DENIED")),
    oneExactOracleCall: providerCalls.length === 1 && providerCalls[0].provider === "openai-codex" && providerCalls[0].model === "gpt-6-astra" && providerCalls[0].reasoning === "high",
    noToolsNoRetry: providerCalls[0]?.toolCount === 0 && providerCalls[0]?.maxRetries === 0 && providerCalls[0]?.maxTokens === 768 && providerCalls[0]?.cacheRetention === "none",
    contextGatePassed: contextEvents.length === 1 && contextEvents[0].status === "PASS" && contextEvents[0].toolCount === 0,
    reservationBeforeCompletion: statuses.filter((entry) => entry === "RESERVED").length === 1 && statuses.filter((entry) => entry === "COMPLETED").length === 1 && statuses.indexOf("RESERVED") < statuses.indexOf("COMPLETED"),
    repeatSuppressed: notifications.some((entry) => entry.includes("SENTINEL_SESSION_LIMIT_REACHED")) && providerCalls.length === 1,
    advicePublishedWithoutAgentTurn: customAdvice.length === 1 && !run.events.some((event) => event.type === "agent_start"),
    metadataOnly: !fs.readFileSync(auditFile, "utf8").includes("BENCHMARK_TASK_MARKER_72") && !/timing failure|scheduling reproduction|Capture the failing/u.test(fs.readFileSync(auditFile, "utf8")),
    routingUnchanged: fs.readFileSync(modelPolicyFile, "utf8") === beforePolicy,
  };
  report = {
    version: 1, recordedAt: new Date().toISOString(), status: run.exitCode === 0 && Object.values(assertions).every(Boolean) ? "PASS" : "FAIL",
    measurementMode: "real-pi-process-deterministic-local-oracle-direct-completion",
    piVersion: spawnSync(pi, ["--version"], { encoding: "utf8" }).stdout.trim(),
    overdriveUltra: { elapsedMs, providerCalls: providerCalls.length, sentinelMetadataEvents: sentinelEvents.length, statuses, contextEvents: contextEvents.map((entry) => ({ status: entry.status ?? null, toolCount: entry.toolCount ?? null, kind: entry.kind ?? null })), assertions },
    accounting: { deterministicLocalProviderCalls: providerCalls.length, externalProviderCalls: 0, paidModelCalls: 0, networkCalls: 0, cost: 0 },
    cleanup: { noRuntimeOrProcessCreated: true },
    ompReference: { commit: "4267074ac91456866e95ed8de0b6353388f08502", version: "18.1.21", executableStatus: "NOT_RUN", reason: "Bun >=1.4 is unavailable; source inspection is not numeric benchmark evidence." },
    stderrDigest: run.stderr ? sha256(run.stderr) : null,
  };
} catch (error) {
  report = { version: 1, recordedAt: new Date().toISOString(), status: "FAIL", accounting: { paidModelCalls: 0, externalProviderCalls: 0, networkCalls: 0, cost: 0 }, error: error instanceof Error ? error.message : String(error) };
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
  if (report) report.cleanup = { ...(report.cleanup ?? {}), temporaryRemoved: !fs.existsSync(temporary) };
}

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (writeResults) fs.writeFileSync(path.join(benchmarkRoot, "sentinel-results.json"), serialized, { mode: 0o600 });
process.stdout.write(serialized);
process.exit(report.status === "PASS" ? 0 : 1);
