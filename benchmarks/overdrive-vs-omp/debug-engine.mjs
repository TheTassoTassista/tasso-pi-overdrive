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
const extension = path.join(packageRoot, "extensions", "debug-engine.ts");
const artifacts = path.join(packageRoot, "extensions", "artifacts.ts");
const pi = process.env.PI_BIN ?? "pi";
const writeResults = process.argv.includes("--write-results");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-dap-benchmark-"));

function parseJsonLines(text) { return String(text ?? "").split(/\r?\n/u).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }); }
function textOf(message) { return (message?.content ?? []).filter((entry) => entry?.type === "text").map((entry) => entry.text ?? "").join("\n"); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function parseToolJson(message) { try { return JSON.parse(textOf(message)); } catch { return undefined; } }

async function runRpc(args, options, request) {
  const child = spawn(pi, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
  const events = [];
  let stdout = "";
  let stderr = "";
  let buffer = "";
  let status = null;
  let signal = null;
  let error;
  let timedOut = false;
  let settled = false;
  let settleResolve;
  const settledPromise = new Promise((resolve) => { settleResolve = resolve; });
  const closedPromise = new Promise((resolve) => {
    child.once("close", (code, childSignal) => { status = code; signal = childSignal; resolve(); settleResolve(); });
    child.once("error", (value) => { error = value; resolve(); settleResolve(); });
  });
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stdout = `${stdout}${text}`.slice(-32 * 1024 * 1024);
    buffer += text;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/u, "");
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        events.push(event);
        if (event.type === "agent_settled") { settled = true; settleResolve(); }
      } catch {}
    }
  });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-32 * 1024 * 1024); });
  const timer = setTimeout(() => { timedOut = true; settleResolve(); }, options.timeoutMs);
  child.stdin.write(`${JSON.stringify(request)}\n`);
  await settledPromise;
  clearTimeout(timer);
  child.stdin.end();
  if (status === null && !error) {
    const killTimer = setTimeout(() => child.kill("SIGTERM"), 5000);
    await closedPromise;
    clearTimeout(killTimer);
  }
  if (timedOut && status === null) child.kill("SIGTERM");
  return { status, signal, error, stdout, stderr, events, timedOut, settled };
}

function commandInspection() {
  const root = path.join(temporary, "command");
  const agentDir = path.join(root, "agent");
  const audit = path.join(root, "audit.jsonl");
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(agentDir, "settings.json"), "{}\n", { mode: 0o600 });
  fs.writeFileSync(audit, "", { mode: 0o600 });
  const run = spawnSync(pi, [
    "--offline", "--approve", "--no-session", "--mode", "rpc", "--extension", provider, "--extension", extension,
    "--provider", "pi-overdrive-tool-audit", "--api-key", "audit-only", "--model", "single-tool-driver", "--thinking", "low", "--no-tools",
  ], {
    cwd: root,
    env: { ...process.env, XDG_STATE_HOME: path.join(root, "state"), PI_CODING_AGENT_DIR: agentDir, PI_OVERDRIVE_TOOL_AUDIT_KEY: "audit-only", PI_OVERDRIVE_AUDIT_EVENT_FILE: audit },
    input: `${JSON.stringify({ id: "commands", type: "get_commands" })}\n`, encoding: "utf8", timeout: 45_000, maxBuffer: 8 * 1024 * 1024,
  });
  const events = parseJsonLines(run.stdout);
  const commands = events.find((event) => event.type === "response" && event.id === "commands")?.data?.commands ?? [];
  const providerTurns = parseJsonLines(fs.readFileSync(audit, "utf8")).filter((entry) => entry.kind === "provider_turn").length;
  const processes = spawnSync("ps", ["-eo", "args="], { encoding: "utf8" }).stdout;
  return {
    status: run.status === 0 && commands.some((entry) => entry.name === "debug-engine" && entry.source === "extension") && providerTurns === 0 && !processes.includes(root) ? "PASS" : "FAIL",
    providerTurns, adapterProcessFound: processes.includes(root), exitCode: run.status,
  };
}

let report;
try {
  const root = path.join(temporary, "run");
  const agentDir = path.join(root, "agent");
  const stateHome = path.join(root, "state");
  const auditFile = path.join(root, "audit.jsonl");
  const source = path.join(root, "fixture.c");
  const program = path.join(root, "fixture");
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(agentDir, "settings.json"), "{}\n", { mode: 0o600 });
  fs.writeFileSync(auditFile, "", { mode: 0o600 });
  fs.writeFileSync(source, [
    "#include <stdio.h>",
    "#include <stdlib.h>",
    "int helper(int value) {",
    "  int next = value + 1;",
    "  return next;",
    "}",
    "int main(void) {",
    "  int result = helper(41);",
    "  if (getenv(\"PI_OVERDRIVE_DAP_BENCHMARK_SECRET\") != NULL) return 91;",
    "  FILE *forbidden = fopen(\"/workspace/forbidden-write\", \"w\");",
    "  if (forbidden != NULL) { fclose(forbidden); return 90; }",
    "  for (int index = 0; index < 24000; index++) putchar('A');",
    "  puts(\"\\nDAP_BENCHMARK_COMPLETE\");",
    "  return result == 42 ? 0 : 1;",
    "}",
    "",
  ].join("\n"), { mode: 0o600 });
  const compiled = spawnSync("cc", ["-g", "-O0", "-fno-omit-frame-pointer", `-fdebug-prefix-map=${root}=/workspace`, "-o", program, source], { encoding: "utf8" });
  if (compiled.status !== 0) throw new Error(`fixture_compile_failed:${compiled.stderr}`);
  const sequence = [
    { name: "debug_engine", args: { action: "launch", program: "fixture" } },
    { name: "debug_engine", args: { action: "set_breakpoint", file: "fixture.c", line: 4 } },
    { name: "debug_engine", args: { action: "continue" } },
    { name: "debug_engine", args: { action: "continue" } },
    { name: "debug_engine", args: { action: "stack_trace", levels: 8 } },
    { name: "debug_engine", args: { action: "continue" } },
    { name: "debug_engine", args: { action: "output" } },
    { name: "debug_engine", args: { action: "terminate" } },
  ];
  const started = performance.now();
  const run = await runRpc([
    "--offline", "--approve", "--no-session", "--mode", "rpc", "--extension", provider, "--extension", extension, "--extension", artifacts,
    "--provider", "pi-overdrive-tool-audit", "--api-key", "audit-only", "--model", "single-tool-driver", "--thinking", "low", "--tools", "debug_engine",
  ], {
    cwd: root,
    env: {
      ...process.env, PI_OVERDRIVE_DAP_BENCHMARK_SECRET: "must-not-reach-debuggee", XDG_STATE_HOME: stateHome, PI_CODING_AGENT_DIR: agentDir,
      PI_OVERDRIVE_TOOL_AUDIT_KEY: "audit-only", PI_OVERDRIVE_AUDIT_TOOL_ARGS_SEQUENCE: JSON.stringify(sequence), PI_OVERDRIVE_AUDIT_EVENT_FILE: auditFile,
    },
    timeoutMs: 60_000,
  }, { id: "dap", type: "prompt", message: "Run the deterministic DAP benchmark." });
  const elapsedMs = Number((performance.now() - started).toFixed(3));
  const events = run.events;
  const ended = [...events].reverse().find((event) => event.type === "agent_end");
  const messages = ended?.messages ?? [];
  const toolResults = messages.filter((message) => message.role === "toolResult");
  const parsed = toolResults.map(parseToolJson);
  const finalText = textOf([...messages].reverse().find((message) => message.role === "assistant"));
  const audit = parseJsonLines(fs.readFileSync(auditFile, "utf8"));
  const dapMetadata = audit.filter((entry) => entry.auditKind === "dap_metadata");
  const providerTurnEntries = audit.filter((entry) => entry.kind === "provider_turn");
  const providerTurns = providerTurnEntries.length;
  const outputProviderTurn = providerTurnEntries.find((entry) => entry.completedTools === 7);
  const artifactMetadata = audit.filter((entry) => entry.auditKind === "artifact_metadata" && entry.kind === "artifact_externalized");
  const artifactResult = toolResults[6] ? textOf(toolResults[6]) : "";
  const artifactFiles = fs.existsSync(path.join(stateHome, "pi-overdrive", "artifacts")) ? fs.readdirSync(path.join(stateHome, "pi-overdrive", "artifacts"), { recursive: true }).filter((name) => String(name).endsWith(".json")) : [];
  const processListing = spawnSync("ps", ["-eo", "args="], { encoding: "utf8" }).stdout;
  const command = commandInspection();
  const sanitizeDiagnostic = (value) => String(value ?? "").replaceAll(temporary, "<temporary>").replaceAll("must-not-reach-debuggee", "<redacted>").slice(-6000);
  const assertions = {
    realPiWorkflowCompleted: run.status === 0 && run.settled && !run.timedOut && finalText === "AUDIT_TOOL_FINISHED" && toolResults.length === sequence.length && providerTurns === sequence.length + 1,
    launchWasIsolated: parsed[0]?.state === "CONFIGURING" && parsed[0]?.sandboxed === true && parsed[0]?.network === false && parsed[0]?.workspaceReadOnly === true,
    breakpointAndStopsWorked: parsed[1]?.kind === "DAP_BREAKPOINTS" && parsed[2]?.state === "STOPPED" && parsed[3]?.state === "STOPPED",
    realStackReachedHelper: parsed[4]?.kind === "DAP_STACK_TRACE" && parsed[4]?.frames?.some((frame) => frame.name.includes("helper") && frame.source === "fixture.c" && frame.line === 4),
    debuggeeIsolationEnforced: parsed[5]?.state === "EXITED" && parsed[5]?.exitCode === 0 && !fs.existsSync(path.join(root, "forbidden-write")),
    largeOutputExternalized: artifactMetadata.some((entry) => entry.status === "PASS" && entry.producerTool === "debug_engine" && entry.sourceBytes > entry.previewChars) && artifactFiles.length >= 1 && outputProviderTurn?.modelFacingLastToolArtifact === true && outputProviderTurn?.modelFacingLastToolChars < 12_000,
    metadataOnly: dapMetadata.length >= sequence.length && dapMetadata.every((entry) => !JSON.stringify(entry).includes(temporary) && !/fixture\.c|DAP_BENCHMARK_COMPLETE|must-not-reach|A{32}/u.test(JSON.stringify(entry))),
    deterministicCleanup: parsed[7]?.cleanupReason === "EXPLICIT" && !processListing.includes(temporary),
    lazyCommandSurface: command.status === "PASS" && command.providerTurns === 0 && command.adapterProcessFound === false,
  };
  report = {
    version: 1, recordedAt: new Date().toISOString(), status: Object.values(assertions).every(Boolean) ? "PASS" : "FAIL",
    measurementMode: "real-pi-process-deterministic-local-provider-real-gdb-bubblewrap", piVersion: spawnSync(pi, ["--version"], { encoding: "utf8" }).stdout.trim(),
    overdriveUltra: {
      elapsedMs, providerTurns, toolResults: toolResults.length, dapMetadataEvents: dapMetadata.length,
      adapter: parsed[0]?.adapter ?? null, adapterVersion: parsed[0]?.adapterVersion ?? null,
      finalState: parsed[5]?.state ?? null, exitCode: parsed[5]?.exitCode ?? null,
      sessionOutputDigest: artifactResult ? sha256(artifactResult) : null, sessionOutputChars: artifactResult.length,
      modelFacingOutputChars: outputProviderTurn?.modelFacingLastToolChars ?? null, artifactMetadataEvents: artifactMetadata.length, artifactManifests: artifactFiles.length,
      command, assertions,
    },
    accounting: { deterministicLocalProviderTurns: providerTurns, paidModelCalls: 0, externalProviderCalls: 0, networkCalls: 0, cost: 0 },
    cleanup: { temporaryProcessResidue: processListing.includes(temporary), workspaceWriteResidue: fs.existsSync(path.join(root, "forbidden-write")) },
    ompReference: { commit: "4267074ac91456866e95ed8de0b6353388f08502", version: "18.1.21", executableStatus: "NOT_RUN", reason: "Bun >=1.4 is unavailable; source inspection is not numeric benchmark evidence." },
    stderrDigest: run.stderr ? sha256(String(run.stderr)) : null,
    diagnostics: run.status === 0 && toolResults.length === sequence.length ? undefined : {
      exitCode: run.status, signal: run.signal ?? null, error: run.error?.message ?? null, timedOut: run.timedOut, settled: run.settled,
      stderr: sanitizeDiagnostic(run.stderr), stdoutTail: sanitizeDiagnostic(run.stdout), eventTypes: events.map((event) => event.type).slice(-40),
      audit: audit.slice(-20),
    },
  };
} catch (error) {
  report = { version: 1, recordedAt: new Date().toISOString(), status: "FAIL", accounting: { paidModelCalls: 0, externalProviderCalls: 0, networkCalls: 0, cost: 0 }, error: error instanceof Error ? error.message : String(error) };
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
  if (report) report.cleanup = { ...(report.cleanup ?? {}), temporaryRemoved: !fs.existsSync(temporary) };
}

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (writeResults) fs.writeFileSync(path.join(benchmarkRoot, "debug-engine-results.json"), serialized, { mode: 0o600 });
process.stdout.write(serialized);
process.exit(report.status === "PASS" ? 0 : 1);
