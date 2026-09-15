#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const benchmarkRoot = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(benchmarkRoot, "../..");
const provider = path.join(packageRoot, "tests", "fixtures", "deterministic-context-fit-provider.ts");
const fixtureTools = path.join(packageRoot, "tests", "fixtures", "artifact-tools.ts");
const artifacts = path.join(packageRoot, "extensions", "artifacts.ts");
const governor = path.join(packageRoot, "extensions", "context-governor.ts");
const pi = process.env.PI_BIN ?? "pi";
const writeResults = process.argv.includes("--write-results");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-context-governor-"));

function parseJsonLines(text) {
  return String(text ?? "").split(/\r?\n/u).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}

function assistantText(events) {
  const ended = [...events].reverse().find((event) => event.type === "agent_end");
  const assistant = [...(ended?.messages ?? [])].reverse().find((message) => message.role === "assistant");
  return (assistant?.content ?? []).filter((block) => block?.type === "text").map((block) => block.text ?? "").join("");
}

async function runScenario(name, model, prompt, withArtifacts) {
  const root = path.join(temporary, name);
  const agentDir = path.join(root, "agent");
  const stateHome = path.join(root, "state");
  const receiptFile = path.join(root, "receipt.jsonl");
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(agentDir, "settings.json"), "{}\n", { mode: 0o600 });
  fs.writeFileSync(receiptFile, "", { mode: 0o600 });
  const args = [
    "--offline", "--approve", "--no-session", "--mode", "rpc",
    "--extension", provider,
    ...(withArtifacts ? ["--extension", fixtureTools, "--extension", artifacts] : []),
    "--extension", governor,
    "--provider", "pi-overdrive-context-fit-audit", "--api-key", "audit-only", "--model", model, "--thinking", "low",
    ...(withArtifacts ? ["--tools", "artifact_fixture"] : ["--no-tools"]),
  ];
  const started = performance.now();
  const child = spawn(pi, args, {
    cwd: root,
    env: { ...process.env, XDG_STATE_HOME: stateHome, PI_CODING_AGENT_DIR: agentDir, PI_OVERDRIVE_CONTEXT_FIT_KEY: "audit-only", PI_OVERDRIVE_CONTEXT_FIT_RECEIPT: receiptFile },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events = [];
  let buffer = "";
  let stderr = "";
  let exitCode = null;
  let timedOut = false;
  const settled = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { timedOut = true; resolve(); }, 20_000);
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
          if (event.type === "agent_settled") { clearTimeout(timeout); resolve(); }
        } catch {}
      }
    });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4000); });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
  });
  const closed = new Promise((resolve) => child.once("close", (code) => { exitCode = code; resolve(); }));
  try {
    child.stdin.write(`${JSON.stringify({ id: name, type: "prompt", message: prompt })}\n`);
    await settled;
  } finally {
    child.stdin.end();
    const timeout = setTimeout(() => child.kill("SIGTERM"), 5_000);
    await closed;
    clearTimeout(timeout);
  }
  const receipts = parseJsonLines(fs.readFileSync(receiptFile, "utf8"));
  let finalPayload;
  try { finalPayload = JSON.parse(assistantText(events)); } catch {}
  return {
    status: !timedOut && exitCode === 0 ? "COMPLETE" : "FAILED",
    elapsedMs: Number((performance.now() - started).toFixed(3)),
    timedOut,
    exitCode,
    providerInvocations: receipts.filter((entry) => entry.kind === "provider_stream_entered"),
    fitDecisions: receipts.filter((entry) => entry.kind !== "provider_stream_entered").map((entry) => ({
      kind: entry.kind,
      status: entry.status,
      reason: entry.reason,
      provider: entry.provider,
      model: entry.model,
      initialInputTokens: entry.initialInputTokens,
      finalInputTokens: entry.finalInputTokens,
      usableInputTokens: entry.usableInputTokens,
      reductions: entry.reductions,
      proofDigest: entry.proofDigest,
    })),
    finalPayload: finalPayload ?? null,
    eventTypes: events.slice(-20).map((event) => event.type),
    stderrBytes: Buffer.byteLength(stderr),
    stderrDigest: stderr ? createHash("sha256").update(stderr).digest("hex") : null,
  };
}

function inspectCommand() {
  const root = path.join(temporary, "command");
  const agentDir = path.join(root, "agent");
  const receiptFile = path.join(root, "receipt.jsonl");
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(agentDir, "settings.json"), "{}\n", { mode: 0o600 });
  fs.writeFileSync(receiptFile, "", { mode: 0o600 });
  const run = spawnSync(pi, [
    "--offline", "--approve", "--no-session", "--mode", "rpc", "--extension", provider, "--extension", governor,
    "--provider", "pi-overdrive-context-fit-audit", "--api-key", "audit-only", "--model", "fit-driver", "--thinking", "low", "--no-tools",
  ], {
    cwd: root,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OVERDRIVE_CONTEXT_FIT_KEY: "audit-only", PI_OVERDRIVE_CONTEXT_FIT_RECEIPT: receiptFile },
    input: `${JSON.stringify({ id: "commands", type: "get_commands" })}\n`, encoding: "utf8", timeout: 45_000,
  });
  const events = parseJsonLines(run.stdout);
  const commands = events.find((event) => event.type === "response" && event.id === "commands")?.data?.commands ?? [];
  const command = commands.find((entry) => entry.name === "context-fit");
  return { status: run.status === 0 && command?.source === "extension" ? "PASS" : "FAIL", command: command ? { name: command.name, source: command.source } : null, providerInvocations: parseJsonLines(fs.readFileSync(receiptFile, "utf8")).filter((entry) => entry.kind === "provider_stream_entered").length, exitCode: run.status };
}

let report;
try {
  const fit = await runScenario("fit", "fit-driver", "Exercise the deterministic context fit path.", true);
  const blockedPrompt = `LATEST_USER_CONTEXT_BLOCK_SENTINEL\n${"uncompressible-current-request ".repeat(5000)}`;
  const blocked = await runScenario("blocked", "blocked-driver", blockedPrompt, false);
  const command = inspectCommand();
  const fitProofs = fit.fitDecisions.filter((entry) => entry.kind === "context_fit");
  const blockedProofs = blocked.fitDecisions.filter((entry) => entry.kind === "context_fit");
  const reductions = fitProofs.flatMap((entry) => entry.reductions ?? []);
  const assertions = {
    fitRunComplete: fit.status === "COMPLETE" && fit.providerInvocations.length === 3 && fit.finalPayload?.toolResults === 2,
    fitAuthorizedEveryRequest: fitProofs.length === 3 && fitProofs.every((entry) => entry.status === "PASS"),
    providerAttestedEveryFitRequest: fit.fitDecisions.filter((entry) => entry.kind === "context_fit_provider_attestation" && entry.status === "PASS").length === 3,
    redundantArtifactsReducedBeforeThirdRequest: reductions.some((entry) => entry.name === "redundant-artifacts" && entry.changedMessages === 1 && entry.savedTokens > 0),
    artifactReferencesRemainReopenable: fit.finalPayload?.artifactReferences >= 2 && fit.finalPayload?.redundantMarkers === 1,
    criticalDiagnosticsNeverDropped: fit.finalPayload?.criticalDiagnostics === 2,
    blockedRunComplete: blocked.status === "COMPLETE" && blockedProofs.some((entry) => entry.status === "BLOCKED" && entry.reason === "CONTEXT_CANNOT_FIT_WITH_SAFE_LOCAL_REDUCTIONS"),
    blockedBeforeProviderEntry: blocked.providerInvocations.length === 0,
    commandRegisteredWithoutProviderCall: command.status === "PASS" && command.providerInvocations === 0,
  };
  report = {
    version: 1,
    recordedAt: new Date().toISOString(),
    status: Object.values(assertions).every(Boolean) ? "PASS" : "FAIL",
    measurementMode: "real-pi-process-deterministic-local-provider",
    piVersion: spawnSync(pi, ["--version"], { encoding: "utf8" }).stdout.trim(),
    overdriveUltra: { fit, blocked: { ...blocked, finalPayload: blocked.finalPayload ? { messageCount: blocked.finalPayload.messageCount } : null }, command, assertions },
    accounting: { deterministicLocalProviderTurns: fit.providerInvocations.length + blocked.providerInvocations.length, paidModelCalls: 0, externalProviderCalls: 0, networkCalls: 0, cost: 0 },
    ompReference: { commit: "4267074ac91456866e95ed8de0b6353388f08502", version: "18.1.21", executableStatus: "NOT_RUN", reason: "Bun >=1.4 is unavailable; source inspection is not numeric benchmark evidence." },
  };
} catch (error) {
  report = { version: 1, recordedAt: new Date().toISOString(), status: "FAIL", accounting: { paidModelCalls: 0, externalProviderCalls: 0, networkCalls: 0, cost: 0 }, error: error instanceof Error ? error.message : String(error) };
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
  if (report) report.cleanup = { temporaryRemoved: !fs.existsSync(temporary) };
}

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (writeResults) fs.writeFileSync(path.join(benchmarkRoot, "context-governor-results.json"), serialized, { mode: 0o600 });
process.stdout.write(serialized);
process.exit(report.status === "PASS" ? 0 : 1);
