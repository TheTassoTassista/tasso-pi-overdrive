#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findExecutable } from "../../lib/editor-bridge.mjs";

const benchmarkRoot = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(benchmarkRoot, "../..");
const bridgeScript = path.join(packageRoot, "scripts", "editor-bridge.mjs");
const provider = path.join(packageRoot, "tests", "fixtures", "deterministic-single-tool-provider.ts");
const pi = fs.realpathSync(process.env.PI_BIN ?? findExecutable("pi"));
const writeResults = process.argv.includes("--write-results");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-editor-bridge-"));
const repository = path.join(temporary, "repo");
const agentDir = path.join(temporary, "agent");
const stateDir = path.join(temporary, "state");
const providerReceipt = path.join(temporary, "provider-receipts.jsonl");
const modelPolicy = path.join(temporary, "model-policy.json");
const shim = path.join(temporary, "pi-editor-fixture");
const promptMarker = "EDITOR_BRIDGE_PRIVATE_PROMPT_MARKER";
const mutationMarker = "EDITOR_BRIDGE_MUTATION_MARKER";

function hashFile(file) {
  try { return createHash("sha256").update(fs.readFileSync(file)).digest("hex"); } catch { return null; }
}
function parseJsonl(text) {
  return String(text ?? "").split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line.replace(/\r$/u, ""))]; } catch { return []; } });
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}
function waitWithTimeout(promise, milliseconds, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const authFile = path.join(process.env.HOME ?? "", ".pi", "agent", "auth.json");
const authBefore = hashFile(authFile);
let report;
let bridge;
let diagnosticStderr = "";
let diagnosticFrames = [];
let diagnosticExit = null;
try {
  fs.mkdirSync(repository, { recursive: true, mode: 0o700 });
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(repository, "note.txt"), "before\n", { mode: 0o600 });
  // The worktree intentionally lacks the ignored MCP runtime; Pi's supported
  // package filter omits only that unrelated proxy for this offline write path.
  fs.writeFileSync(path.join(agentDir, "settings.json"), `${JSON.stringify({ packages: [{ source: packageRoot, extensions: ["-extensions/mcp.ts"] }] }, null, 2)}\n`, { mode: 0o600 });
  fs.copyFileSync(path.join(packageRoot, "config", "model-policy.json"), modelPolicy);
  const shimSource = `#!/usr/bin/env node
const { spawn, spawnSync } = require("node:child_process");
const real = ${JSON.stringify(pi)};
const incoming = process.argv.slice(2);
if (incoming.length === 1 && incoming[0] === "--version") {
  const result = spawnSync(real, incoming, { stdio: "inherit", env: process.env });
  process.exit(result.status ?? 1);
}
const extra = ["--extension", ${JSON.stringify(provider)}, "--provider", "pi-overdrive-tool-audit", "--api-key", "audit-only", "--model", "single-tool-driver", "--thinking", "low", "--tools", "write"];
const child = spawn(real, [...incoming, ...extra], { stdio: "inherit", env: process.env });
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
child.once("exit", (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code ?? 1); });
`;
  fs.writeFileSync(shim, shimSource, { mode: 0o700 });

  const environment = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    XDG_STATE_HOME: stateDir,
    PI_OVERDRIVE_MODEL_POLICY: modelPolicy,
    PI_OVERDRIVE_TOOL_AUDIT_KEY: "audit-only",
    PI_OVERDRIVE_AUDIT_EVENT_FILE: providerReceipt,
    PI_OVERDRIVE_AUDIT_TOOL: "write",
    PI_OVERDRIVE_AUDIT_TOOL_ARGS: JSON.stringify({ path: "note.txt", content: `${mutationMarker}\n` }),
  };
  const started = performance.now();
  bridge = spawn(process.execPath, [bridgeScript, "--cwd", repository, "--pi-bin", shim, "--state-dir", stateDir], { cwd: repository, env: environment, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  const frames = [];
  const permissions = [];
  let preApprovalUnchanged = true;
  let stdoutBuffer = "";
  let stderr = "";
  let nextId = 1;
  const closed = deferred();
  bridge.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    for (;;) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = stdoutBuffer.slice(0, newline).replace(/\r$/u, "");
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let frame;
      try { frame = JSON.parse(line); } catch { frames.push({ invalid: true }); continue; }
      frames.push(frame);
      diagnosticFrames = frames.slice(-30);
      if (frame.method === "session/request_permission" && Object.hasOwn(frame, "id")) {
        permissions.push(frame);
        preApprovalUnchanged &&= fs.readFileSync(path.join(repository, "note.txt"), "utf8") === "before\n";
        bridge.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { outcome: { outcome: "selected", optionId: "allow_once" } } })}\n`);
      } else if (Object.hasOwn(frame, "id") && !frame.method && pending.has(String(frame.id))) {
        const waiting = pending.get(String(frame.id));
        pending.delete(String(frame.id));
        if (frame.error) waiting.reject(Object.assign(new Error(frame.error.message), { response: frame }));
        else waiting.resolve(frame.result);
      }
    }
  });
  bridge.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8192); diagnosticStderr = stderr; });
  bridge.once("error", closed.reject);
  bridge.once("close", (code, signal) => { diagnosticExit = { code, signal }; closed.resolve({ code, signal }); });
  const call = (method, params) => {
    const id = `client-${nextId++}`;
    const waiting = deferred();
    pending.set(id, waiting);
    bridge.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return waitWithTimeout(waiting.promise, 60_000, `client_timeout:${method}`);
  };

  const initialized = await call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true }, clientInfo: { name: "pi-overdrive-benchmark", version: "1" } });
  const authenticated = await call("authenticate", { methodId: "agent" });
  let mcpDenied = false;
  try { await call("session/new", { cwd: repository, mcpServers: [{ type: "stdio", name: "hostile", command: "sh", env: [] }] }); } catch (error) { mcpDenied = error?.response?.error?.message === "editor_client_mcp_denied"; }
  const session = await call("session/new", { cwd: repository, mcpServers: [] });
  let routeDenied = false;
  try { await call("session/set_config_option", { sessionId: session.sessionId, configId: "model", value: "hostile/model" }); } catch (error) { routeDenied = error?.response?.error?.code === -32601; }
  const prompt = await call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: `Update note.txt with the deterministic marker. ${promptMarker}` }] });
  await call("session/close", { sessionId: session.sessionId });
  bridge.stdin.end();
  const exit = await waitWithTimeout(closed.promise, 15_000, "bridge_close_timeout");
  const elapsedMs = Number((performance.now() - started).toFixed(3));
  const receiptFiles = fs.readdirSync(path.join(stateDir, "pi-overdrive", "editor-bridge")).filter((name) => name.endsWith(".jsonl"));
  const bridgeReceipts = receiptFiles.flatMap((name) => parseJsonl(fs.readFileSync(path.join(stateDir, "pi-overdrive", "editor-bridge", name), "utf8")));
  const traceDir = path.join(stateDir, "pi-overdrive", "traces");
  const contextTrace = fs.existsSync(traceDir)
    ? fs.readdirSync(traceDir).filter((name) => name.endsWith(".jsonl")).flatMap((name) => parseJsonl(fs.readFileSync(path.join(traceDir, name), "utf8")))
      .filter((entry) => entry.event === "context_metadata")
      .map((entry) => ({ kind: entry.kind, status: entry.status, reason: entry.reason, errorCode: entry.errorCode, contextWindow: entry.contextWindow, usableInputTokens: entry.usableInputTokens, finalInputTokens: entry.finalInputTokens, toolCount: entry.toolCount }))
    : [];
  const providerReceipts = fs.existsSync(providerReceipt) ? parseJsonl(fs.readFileSync(providerReceipt, "utf8")) : [];
  const serializedReceipts = JSON.stringify(bridgeReceipts);
  const updateKinds = frames.filter((frame) => frame.method === "session/update").map((frame) => frame.params?.update?.sessionUpdate);
  const routeReceipts = bridgeReceipts.filter((entry) => ["session_started", "prompt_finished"].includes(entry.kind));
  const residue = spawnSync("ps", ["-eo", "args="], { encoding: "utf8" }).stdout.split("\n").filter((line) => line.includes(temporary) && !line.includes("ps -eo"));
  const assertions = {
    realPiTransportComplete: exit.code === 0 && !exit.signal && frames.length > 0 && !frames.some((frame) => frame.invalid),
    protocolConformant: initialized?.protocolVersion === 1 && initialized?.agentCapabilities?.loadSession === false && authenticated && typeof session?.sessionId === "string",
    clientAuthorityDenied: mcpDenied && routeDenied && initialized?.agentCapabilities?.mcpCapabilities?.http === false && initialized?.agentCapabilities?.promptCapabilities?.embeddedContext === false,
    promptCompleted: prompt?.stopReason === "end_turn" && prompt?.usage?.totalTokens === 0,
    actualMutationApproved: preApprovalUnchanged && fs.readFileSync(path.join(repository, "note.txt"), "utf8") === `${mutationMarker}\n` && permissions.length === 1 && permissions[0].params?.toolCall?.title === "write" && bridgeReceipts.filter((entry) => entry.kind === "tool_started" && entry.toolName === "write").length === 1 && bridgeReceipts.filter((entry) => entry.kind === "tool_finished" && entry.toolName === "write" && entry.status === "completed").length === 1,
    oneShotPermissionOnly: permissions.length === 1 && JSON.stringify(permissions[0].params?.options?.map((entry) => entry.optionId)) === JSON.stringify(["allow_once", "reject_once"]),
    eventCorrelation: updateKinds.includes("tool_call") && updateKinds.includes("tool_call_update") && updateKinds.includes("agent_message_chunk"),
    routeAttested: routeReceipts.length === 2 && routeReceipts.every((entry) => entry.provider === "pi-overdrive-tool-audit" && entry.model === "single-tool-driver" && entry.thinking === "low"),
    receiptsMetadataOnly: !serializedReceipts.includes(promptMarker) && !serializedReceipts.includes(mutationMarker) && !serializedReceipts.includes("note.txt") && !serializedReceipts.includes("audit-only") && !serializedReceipts.includes("content"),
    exactProviderTurns: providerReceipts.filter((entry) => entry.kind === "provider_turn").length === 2,
    authUnchanged: hashFile(authFile) === authBefore,
    noResidualProcess: residue.length === 0,
  };
  report = {
    version: 1,
    recordedAt: new Date().toISOString(),
    status: Object.values(assertions).every(Boolean) ? "PASS" : "FAIL",
    measurementMode: "real-pi-rpc-through-minimal-acp-editor-bridge-deterministic-local-provider",
    piVersion: spawnSync(pi, ["--version"], { encoding: "utf8" }).stdout.trim(),
    overdriveUltra: {
      elapsedMs, exitCode: exit.code, signal: exit.signal, sessionCount: 1, promptCount: 1,
      permissionCount: permissions.length, permissionOptions: permissions[0]?.params?.options?.map((entry) => entry.optionId) ?? [],
      providerTurns: providerReceipts.filter((entry) => entry.kind === "provider_turn").length,
      updateKinds, receiptKinds: bridgeReceipts.map((entry) => entry.kind), routeReceipts,
      errorReceipts: bridgeReceipts.filter((entry) => entry.kind === "assistant_error"),
      contextTrace,
      stderrBytes: Buffer.byteLength(stderr), stderrDigest: stderr ? createHash("sha256").update(stderr).digest("hex") : null,
      assertions,
    },
    accounting: { deterministicLocalProviderTurns: providerReceipts.filter((entry) => entry.kind === "provider_turn").length, decisionModelCalls: 0, paidModelCalls: 0, externalProviderCalls: 0, networkCalls: 0, cost: 0 },
    ompReference: { commit: "4267074ac91456866e95ed8de0b6353388f08502", version: "18.1.21", executableStatus: "NOT_RUN", reason: "Bun >=1.4 is unavailable; source inspection is architecture evidence only." },
    cleanup: { bridgeExited: exit.code === 0, residualProcesses: residue.length },
  };
} catch (error) {
  if (bridge && bridge.exitCode === null) bridge.kill("SIGTERM");
  const failedReceiptDirectory = path.join(stateDir, "pi-overdrive", "editor-bridge");
  const failedBridgeReceipts = fs.existsSync(failedReceiptDirectory)
    ? fs.readdirSync(failedReceiptDirectory).filter((name) => name.endsWith(".jsonl")).flatMap((name) => parseJsonl(fs.readFileSync(path.join(failedReceiptDirectory, name), "utf8")))
    : [];
  report = {
    version: 1,
    recordedAt: new Date().toISOString(),
    status: "FAIL",
    accounting: { paidModelCalls: 0, externalProviderCalls: 0, networkCalls: 0, cost: 0 },
    error: error instanceof Error ? error.message : String(error),
    diagnostics: {
      exit: diagnosticExit,
      frameTypes: diagnosticFrames.map((frame) => frame.method ?? frame.result?.protocolVersion ?? frame.error?.message ?? "response"),
      stderrBytes: Buffer.byteLength(diagnosticStderr),
      stderrTail: diagnosticStderr.slice(-4000),
      bridgeReceipts: failedBridgeReceipts,
      providerReceipts: fs.existsSync(providerReceipt) ? parseJsonl(fs.readFileSync(providerReceipt, "utf8")) : [],
    },
  };
} finally {
  if (bridge && bridge.exitCode === null) bridge.kill("SIGKILL");
  fs.rmSync(temporary, { recursive: true, force: true });
}

report.cleanup = { ...(report.cleanup ?? {}), temporaryFixtureRemoved: !fs.existsSync(temporary) };
if (!report.cleanup.temporaryFixtureRemoved) report.status = "FAIL";
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (writeResults) fs.writeFileSync(path.join(benchmarkRoot, "editor-bridge-results.json"), serialized, { mode: 0o600 });
process.stdout.write(serialized);
process.exit(report.status === "PASS" ? 0 : 1);
