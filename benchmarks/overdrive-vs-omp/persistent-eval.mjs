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
const extension = path.join(packageRoot, "extensions", "persistent-eval.ts");
const artifacts = path.join(packageRoot, "extensions", "artifacts.ts");
const pi = process.env.PI_BIN ?? "pi";
const writeResults = process.argv.includes("--write-results");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-eval-benchmark-"));

function parseJsonLines(text) { return String(text ?? "").split(/\r?\n/u).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }); }
function textOf(message) { return (message?.content ?? []).filter((entry) => entry?.type === "text").map((entry) => entry.text ?? "").join("\n"); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function parseToolHeader(message) { try { return JSON.parse(textOf(message).split("\n", 1)[0]); } catch { return undefined; } }

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
  const commands = parseJsonLines(run.stdout).find((event) => event.type === "response" && event.id === "commands")?.data?.commands ?? [];
  const providerTurns = parseJsonLines(fs.readFileSync(audit, "utf8")).filter((entry) => entry.kind === "provider_turn").length;
  const processes = spawnSync("ps", ["-eo", "args="], { encoding: "utf8" }).stdout;
  return { status: run.status === 0 && commands.some((entry) => entry.name === "eval-engine" && entry.source === "extension") && providerTurns === 0 && !processes.includes(root) ? "PASS" : "FAIL", providerTurns, kernelProcessFound: processes.includes(root), exitCode: run.status };
}

let report;
try {
  const root = path.join(temporary, "run");
  const agentDir = path.join(root, "agent");
  const stateHome = path.join(root, "state");
  const auditFile = path.join(root, "audit.jsonl");
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(agentDir, "settings.json"), "{}\n", { mode: 0o600 });
  fs.writeFileSync(auditFile, "", { mode: 0o600 });
  fs.writeFileSync(path.join(root, "host-secret.txt"), "EVAL_BENCHMARK_FILE_SECRET\n", { mode: 0o600 });
  const securityCode = [
    "checks = {}",
    "for name in ['os', 'subprocess', 'socket']:",
    "    try:",
    "        __import__(name)",
    "        checks[name] = 'AVAILABLE'",
    "    except Exception as error:",
    "        checks[name] = type(error).__name__",
    "try:",
    "    open('/workspace/host-secret.txt').read()",
    "    checks['file'] = 'AVAILABLE'",
    "except Exception as error:",
    "    checks['file'] = type(error).__name__",
    "checks",
  ].join("\n");
  const sequence = [
    { name: "persistent_python", args: { action: "execute", code: "x = 40\nx" } },
    { name: "persistent_python", args: { action: "execute", code: "x + 2" } },
    { name: "persistent_javascript", args: { action: "execute", code: "let y = 40; y" } },
    { name: "persistent_javascript", args: { action: "execute", dialect: "typescript", code: "const z: number = y + 2; z" } },
    { name: "persistent_python", args: { action: "execute", code: securityCode } },
    { name: "persistent_python", args: { action: "execute", code: "print('E' * 24000)\n7" } },
    { name: "persistent_python", args: { action: "terminate" } },
    { name: "persistent_javascript", args: { action: "terminate" } },
  ];
  const started = performance.now();
  const run = await runRpc([
    "--offline", "--approve", "--no-session", "--mode", "rpc", "--extension", provider, "--extension", extension, "--extension", artifacts,
    "--provider", "pi-overdrive-tool-audit", "--api-key", "audit-only", "--model", "single-tool-driver", "--thinking", "low", "--tools", "persistent_python,persistent_javascript",
  ], {
    cwd: root,
    env: { ...process.env, PI_OVERDRIVE_EVAL_BENCHMARK_SECRET: "must-not-reach-kernel", XDG_STATE_HOME: stateHome, PI_CODING_AGENT_DIR: agentDir, PI_OVERDRIVE_TOOL_AUDIT_KEY: "audit-only", PI_OVERDRIVE_AUDIT_TOOL_ARGS_SEQUENCE: JSON.stringify(sequence), PI_OVERDRIVE_AUDIT_EVENT_FILE: auditFile },
    timeoutMs: 60_000,
  }, { id: "eval", type: "prompt", message: "Run the deterministic Persistent Eval benchmark." });
  const elapsedMs = Number((performance.now() - started).toFixed(3));
  const ended = [...run.events].reverse().find((event) => event.type === "agent_end");
  const messages = ended?.messages ?? [];
  const toolResults = messages.filter((message) => message.role === "toolResult");
  const parsed = toolResults.map(parseToolHeader);
  const finalText = textOf([...messages].reverse().find((message) => message.role === "assistant"));
  const audit = parseJsonLines(fs.readFileSync(auditFile, "utf8"));
  const evalMetadata = audit.filter((entry) => entry.auditKind === "eval_metadata");
  const providerTurnEntries = audit.filter((entry) => entry.kind === "provider_turn");
  const outputProviderTurn = providerTurnEntries.find((entry) => entry.completedTools === 6);
  const artifactMetadata = audit.filter((entry) => entry.auditKind === "artifact_metadata" && entry.kind === "artifact_externalized");
  const artifactFiles = fs.existsSync(path.join(stateHome, "pi-overdrive", "artifacts")) ? fs.readdirSync(path.join(stateHome, "pi-overdrive", "artifacts"), { recursive: true }).filter((name) => String(name).endsWith(".json")) : [];
  const processListing = spawnSync("ps", ["-eo", "args="], { encoding: "utf8" }).stdout;
  const command = commandInspection();
  const securityText = textOf(toolResults[4]);
  const assertions = {
    realPiWorkflowCompleted: run.status === 0 && run.settled && !run.timedOut && finalText === "AUDIT_TOOL_FINISHED" && toolResults.length === sequence.length && providerTurnEntries.length === sequence.length + 1,
    pythonStatePersisted: parsed[0]?.status === "PASS" && /value:\n40/u.test(textOf(toolResults[0])) && /value:\n42/u.test(textOf(toolResults[1])) && parsed[0]?.session?.kernelId === parsed[1]?.session?.kernelId,
    javascriptAndTypeScriptStatePersisted: /value:\n40/u.test(textOf(toolResults[2])) && /value:\n42/u.test(textOf(toolResults[3])) && parsed[2]?.session?.kernelId === parsed[3]?.session?.kernelId,
    isolationEnforced: /'os': 'PermissionError'/u.test(securityText) && /'subprocess': 'PermissionError'/u.test(securityText) && /'socket': 'PermissionError'/u.test(securityText) && /'file': 'NameError'/u.test(securityText) && !securityText.includes("EVAL_BENCHMARK_FILE_SECRET") && parsed.slice(0, 5).every((entry) => entry?.session?.sandboxed === true && entry?.session?.network === false && entry?.session?.projectWorkspaceMounted === false && entry?.session?.hostUserFilesystem === false && entry?.session?.systemRuntimeReadOnly === true && entry?.session?.subprocessBridge === false),
    largeOutputExternalized: artifactMetadata.some((entry) => entry.status === "PASS" && entry.producerTool === "persistent_python" && entry.sourceBytes > entry.previewChars) && artifactFiles.length >= 1 && outputProviderTurn?.modelFacingLastToolArtifact === true && outputProviderTurn?.modelFacingLastToolChars < 12_000,
    metadataOnly: evalMetadata.length >= sequence.length && evalMetadata.every((entry) => !/x = 40|EVAL_BENCHMARK|E{32}|host-secret|must-not-reach/u.test(JSON.stringify(entry))),
    deterministicCleanup: parsed[6]?.cleanupReason === "EXPLICIT" && parsed[6]?.temporaryRemoved === true && parsed[7]?.cleanupReason === "EXPLICIT" && parsed[7]?.temporaryRemoved === true && !processListing.includes(temporary),
    lazyCommandSurface: command.status === "PASS" && command.providerTurns === 0 && command.kernelProcessFound === false,
  };
  report = {
    version: 1,
    recordedAt: new Date().toISOString(),
    status: Object.values(assertions).every(Boolean) ? "PASS" : "FAIL",
    measurementMode: "real-pi-process-deterministic-local-provider-persistent-python-javascript-bubblewrap",
    piVersion: spawnSync(pi, ["--version"], { encoding: "utf8" }).stdout.trim(),
    overdriveUltra: {
      elapsedMs,
      providerTurns: providerTurnEntries.length,
      toolResults: toolResults.length,
      evalMetadataEvents: evalMetadata.length,
      pythonKernelStable: parsed[0]?.session?.kernelId === parsed[1]?.session?.kernelId,
      javascriptKernelStable: parsed[2]?.session?.kernelId === parsed[3]?.session?.kernelId,
      modelFacingOutputChars: outputProviderTurn?.modelFacingLastToolChars ?? null,
      artifactMetadataEvents: artifactMetadata.length,
      artifactManifests: artifactFiles.length,
      command,
      assertions,
    },
    accounting: { deterministicLocalProviderTurns: providerTurnEntries.length, paidModelCalls: 0, externalProviderCalls: 0, networkCalls: 0, cost: 0 },
    cleanup: { temporaryProcessResidue: processListing.includes(temporary), hostFixtureUnchanged: fs.readFileSync(path.join(root, "host-secret.txt"), "utf8") === "EVAL_BENCHMARK_FILE_SECRET\n" },
    ompReference: { commit: "4267074ac91456866e95ed8de0b6353388f08502", version: "18.1.21", executableStatus: "NOT_RUN", reason: "Bun >=1.4 is unavailable; source inspection is not numeric benchmark evidence." },
    stderrDigest: run.stderr ? sha256(String(run.stderr)) : null,
    diagnostics: run.status === 0 && toolResults.length === sequence.length ? undefined : { exitCode: run.status, signal: run.signal ?? null, error: run.error?.message ?? null, timedOut: run.timedOut, settled: run.settled, stderr: String(run.stderr).replaceAll(temporary, "<temporary>").slice(-6000), stdoutTail: String(run.stdout).replaceAll(temporary, "<temporary>").slice(-6000) },
  };
} catch (error) {
  report = { version: 1, recordedAt: new Date().toISOString(), status: "FAIL", accounting: { paidModelCalls: 0, externalProviderCalls: 0, networkCalls: 0, cost: 0 }, error: error instanceof Error ? error.message : String(error) };
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
  if (report) report.cleanup = { ...(report.cleanup ?? {}), temporaryRemoved: !fs.existsSync(temporary) };
}

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (writeResults) fs.writeFileSync(path.join(benchmarkRoot, "persistent-eval-results.json"), serialized, { mode: 0o600 });
process.stdout.write(serialized);
process.exit(report.status === "PASS" ? 0 : 1);
