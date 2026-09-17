#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const benchmarkRoot = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(benchmarkRoot, "../..");
const provider = path.join(packageRoot, "tests", "fixtures", "deterministic-single-tool-provider.ts");
const safety = path.join(packageRoot, "extensions", "safety.ts");
const extension = path.join(packageRoot, "extensions", "stream-guard.ts");
const pi = process.env.PI_BIN ?? "pi";
const writeResults = process.argv.includes("--write-results");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-stream-guard-benchmark-"));

function parseLines(text) { return String(text ?? "").split(/\r?\n/u).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }); }
function textOf(message) { return (message?.content ?? []).filter((entry) => entry?.type === "text").map((entry) => entry.text ?? "").join("\n"); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

async function runRpc(root, env, request) {
  const child = spawn(pi, [
    "--offline", "--approve", "--no-session", "--mode", "rpc",
    "--extension", provider, "--extension", safety, "--extension", extension,
    "--provider", "pi-overdrive-tool-audit", "--api-key", "audit-only", "--model", "single-tool-driver", "--thinking", "low", "--tools", "bash",
  ], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  const events = [];
  let stderr = "";
  let buffer = "";
  let exitCode = null;
  let settled = false;
  let settle;
  const settledPromise = new Promise((resolve) => { settle = resolve; });
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
        if (event.type === "agent_settled") { settled = true; settle(); }
      } catch {}
    }
  });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8 * 1024 * 1024); });
  child.once("close", (code) => { exitCode = code; settle(); });
  child.once("error", settle);
  const timer = setTimeout(settle, 45_000);
  child.stdin.write(`${JSON.stringify(request)}\n`);
  await settledPromise;
  clearTimeout(timer);
  child.stdin.end();
  if (exitCode === null) await new Promise((resolve) => { const kill = setTimeout(() => child.kill("SIGTERM"), 5000); child.once("close", () => { clearTimeout(kill); resolve(); }); });
  return { events, stderr, exitCode, settled };
}

function commandInspection(root, env) {
  const result = spawnSync(pi, [
    "--offline", "--approve", "--no-session", "--mode", "rpc", "--extension", provider, "--extension", extension,
    "--provider", "pi-overdrive-tool-audit", "--api-key", "audit-only", "--model", "single-tool-driver", "--thinking", "low", "--no-tools",
  ], { cwd: root, env, input: `${JSON.stringify({ id: "commands", type: "get_commands" })}\n`, encoding: "utf8", timeout: 45_000, maxBuffer: 8 * 1024 * 1024 });
  const commands = parseLines(result.stdout).find((event) => event.type === "response" && event.id === "commands")?.data?.commands ?? [];
  return { status: result.status === 0 && commands.some((entry) => entry.name === "stream-guard" && entry.source === "extension") ? "PASS" : "FAIL", exitCode: result.status };
}

let report;
try {
  const root = path.join(temporary, "run");
  const agentDir = path.join(root, "agent");
  const auditFile = path.join(root, "audit.jsonl");
  const sentinel = path.join(root, "do-not-remove");
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(sentinel, { mode: 0o700 });
  fs.writeFileSync(path.join(sentinel, "sentinel.txt"), "UNCHANGED\n", { mode: 0o600 });
  fs.writeFileSync(path.join(agentDir, "settings.json"), "{}\n", { mode: 0o600 });
  fs.writeFileSync(auditFile, "", { mode: 0o600 });
  const env = { ...process.env, XDG_STATE_HOME: path.join(root, "state"), PI_CODING_AGENT_DIR: agentDir, PI_OVERDRIVE_TOOL_AUDIT_KEY: "audit-only", PI_OVERDRIVE_AUDIT_TOOL: "bash", PI_OVERDRIVE_AUDIT_TOOL_ARGS: JSON.stringify({ command: "rm -rf ./do-not-remove" }), PI_OVERDRIVE_AUDIT_EVENT_FILE: auditFile };
  const started = performance.now();
  const run = await runRpc(root, env, { id: "guard", type: "prompt", message: "Run the deterministic StreamGuard blocked-tool fixture." });
  const elapsedMs = Number((performance.now() - started).toFixed(3));
  const ended = [...run.events].reverse().find((event) => event.type === "agent_end");
  const messages = ended?.messages ?? [];
  const toolResults = messages.filter((message) => message.role === "toolResult");
  const finalText = textOf([...messages].reverse().find((message) => message.role === "assistant"));
  const audit = parseLines(fs.readFileSync(auditFile, "utf8"));
  const providerTurns = audit.filter((entry) => entry.kind === "provider_turn");
  const metadata = audit.filter((entry) => entry.auditKind === "stream_guard_metadata");
  const reserved = metadata.filter((entry) => entry.status === "RESERVED");
  const delivered = metadata.filter((entry) => entry.status === "DELIVERED");
  const command = commandInspection(root, env);
  const reminderText = textOf(toolResults[0]);
  const assertions = {
    realPiWorkflowCompleted: run.exitCode === 0 && run.settled && finalText === "AUDIT_TOOL_FINISHED" && toolResults.length === 1 && providerTurns.length === 2,
    safetyBlockedBeforeExecution: toolResults[0]?.isError === true && fs.readFileSync(path.join(sentinel, "sentinel.txt"), "utf8") === "UNCHANGED\n",
    reservationBeforeDelivery: reserved.length === 1 && delivered.length === 1 && metadata.indexOf(reserved[0]) < metadata.indexOf(delivered[0]) && reserved[0].reservationDigest === delivered[0].reservationDigest,
    correctionReachedNormalNextTurn: reminderText.startsWith("ERROR [STREAMGUARD]") && providerTurns[1]?.modelFacingLastToolStreamGuard === true,
    safetyReasonRetained: reminderText.includes("Blocked by governing safety policy:"),
    sameBlockedToolBound: reserved[0]?.toolName === "bash" && delivered[0]?.toolName === "bash" && delivered[0]?.outcome === "SAME_BLOCKED_TOOL_RESULT",
    deltaAndFinalDeduplicated: metadata.length === 2,
    metadataOnly: metadata.every((entry) => !/rm -rf|do-not-remove|sentinel\.txt|blocked-tool fixture/u.test(JSON.stringify(entry))),
    zeroExtraProviderTurn: providerTurns.length === 2,
    lazyCommandSurface: command.status === "PASS",
  };
  report = {
    version: 1,
    recordedAt: new Date().toISOString(),
    status: Object.values(assertions).every(Boolean) ? "PASS" : "FAIL",
    measurementMode: "real-pi-process-deterministic-local-provider-stream-reservation-safety-block-correction",
    piVersion: spawnSync(pi, ["--version"], { encoding: "utf8" }).stdout.trim(),
    overdriveUltra: { elapsedMs, providerTurns: providerTurns.length, toolResults: toolResults.length, streamGuardMetadataEvents: metadata.length, metadataStatuses: metadata.map((entry) => entry.status), command, assertions },
    accounting: { deterministicLocalProviderTurns: providerTurns.length, guardAddedProviderTurns: 0, paidModelCalls: 0, externalProviderCalls: 0, networkCalls: 0, cost: 0 },
    cleanup: { sentinelUnchanged: fs.readFileSync(path.join(sentinel, "sentinel.txt"), "utf8") === "UNCHANGED\n" },
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
if (writeResults) fs.writeFileSync(path.join(benchmarkRoot, "stream-guard-results.json"), serialized, { mode: 0o600 });
process.stdout.write(serialized);
process.exit(report.status === "PASS" ? 0 : 1);
