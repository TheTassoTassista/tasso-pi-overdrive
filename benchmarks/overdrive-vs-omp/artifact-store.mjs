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
const fixtureTools = path.join(packageRoot, "tests", "fixtures", "artifact-tools.ts");
const resources = path.join(packageRoot, "extensions", "resources.ts");
const artifacts = path.join(packageRoot, "extensions", "artifacts.ts");
const pi = process.env.PI_BIN ?? "pi";
const writeResults = process.argv.includes("--write-results");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-artifact-store-"));
const stateHome = path.join(temporary, "state");
const agentDir = path.join(temporary, "agent");
const modelPolicy = path.join(temporary, "model-policy.json");
function artifactFixtureText(lines = 700) {
  return Array.from({ length: lines }, (_, index) => index === 419 ? "ERROR artifact benchmark critical diagnostic" : `fixture-line-${index + 1} ${"x".repeat(48)}`).join("\n");
}
const original = artifactFixtureText(700);
const artifactId = createHash("sha256").update(original).digest("hex");

function textOf(message) {
  return (message?.content ?? []).filter((entry) => entry?.type === "text").map((entry) => entry.text ?? "").join("");
}

async function runRoundTrip() {
  const sequence = [
    { name: "artifact_fixture", args: { lines: 700 } },
    { name: "resource_fs", args: { operation: "read", uri: `artifact://${artifactId}`, offsetLine: 419, limitLines: 3 } },
    { name: "artifact_fixture", args: { lines: 700, fail: true } },
  ];
  const started = performance.now();
  const child = spawn(pi, [
    "--offline", "--approve", "--no-session", "--mode", "rpc",
    "--extension", provider, "--extension", fixtureTools, "--extension", resources, "--extension", artifacts,
    "--provider", "pi-overdrive-tool-audit", "--api-key", "audit-only",
    "--model", "pi-overdrive-tool-audit/single-tool-driver", "--thinking", "low",
    "--tools", "artifact_fixture,resource_fs",
  ], {
    cwd: temporary,
    env: {
      ...process.env, XDG_STATE_HOME: stateHome, PI_CODING_AGENT_DIR: agentDir, PI_OVERDRIVE_MODEL_POLICY: modelPolicy,
      PI_OVERDRIVE_TOOL_AUDIT_KEY: "audit-only", PI_OVERDRIVE_AUDIT_TOOL: "artifact_fixture",
      PI_OVERDRIVE_AUDIT_TOOL_ARGS_SEQUENCE: JSON.stringify(sequence),
    },
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
    child.stdin.write(`${JSON.stringify({ id: "artifact-round-trip", type: "prompt", message: "Run the deterministic Artifact Store round trip." })}\n`);
    await settled;
  } finally {
    child.stdin.end();
    const timeout = setTimeout(() => child.kill("SIGTERM"), 5_000);
    await closed;
    clearTimeout(timeout);
  }
  const ended = [...events].reverse().find((event) => event.type === "agent_end");
  const messages = ended?.messages ?? [];
  const toolResults = messages.filter((message) => message.role === "toolResult");
  const externalized = toolResults[0];
  const reopened = toolResults[1];
  const failed = toolResults[2];
  return {
    status: !timedOut && exitCode === 0 && toolResults.length === 3 ? "PASS" : "FAIL",
    timedOut,
    elapsedMs: Number((performance.now() - started).toFixed(3)),
    exitCode,
    stderrBytes: Buffer.byteLength(stderr),
    stderrDigest: stderr ? createHash("sha256").update(stderr).digest("hex") : null,
    eventTypes: events.slice(-20).map((event) => event.type),
    providerTurns: messages.filter((message) => message.role === "assistant").length,
    externalized: { output: textOf(externalized), outputChars: textOf(externalized).length, isError: externalized?.isError === true, details: externalized?.details ?? null },
    reopened: { output: textOf(reopened), outputChars: textOf(reopened).length, isError: reopened?.isError === true, details: reopened?.details ?? null },
    failed: { output: textOf(failed), outputChars: textOf(failed).length, isError: failed?.isError === true, details: failed?.details ?? null },
  };
}

function inspectCommands() {
  const run = spawnSync(pi, [
    "--offline", "--approve", "--no-session", "--mode", "rpc",
    "--extension", provider, "--extension", resources, "--extension", artifacts,
    "--provider", "pi-overdrive-tool-audit", "--api-key", "audit-only", "--model", "pi-overdrive-tool-audit/single-tool-driver", "--thinking", "low",
  ], {
    cwd: temporary,
    env: { ...process.env, XDG_STATE_HOME: stateHome, PI_CODING_AGENT_DIR: agentDir, PI_OVERDRIVE_MODEL_POLICY: modelPolicy, PI_OVERDRIVE_TOOL_AUDIT_KEY: "audit-only" },
    input: `${JSON.stringify({ id: "commands", type: "get_commands" })}\n`, encoding: "utf8", timeout: 45_000,
  });
  const events = String(run.stdout ?? "").split(/\r?\n/u).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const commands = events.find((event) => event.type === "response" && event.id === "commands")?.data?.commands ?? [];
  return { status: run.status === 0 && ["artifacts", "resources"].every((name) => commands.some((entry) => entry.name === name && entry.source === "extension")) ? "PASS" : "FAIL", commands: commands.filter((entry) => ["artifacts", "resources"].includes(entry.name)).map((entry) => ({ name: entry.name, source: entry.source })), exitCode: run.status };
}

let report;
try {
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(agentDir, "settings.json"), "{}\n", { mode: 0o600 });
  fs.writeFileSync(modelPolicy, `${JSON.stringify({ version: 2, preset: "normal", basePreset: "normal", overrides: {} })}\n`, { mode: 0o600 });
  const run = await runRoundTrip();
  const command = inspectCommands();
  const artifactRoot = path.join(stateHome, "pi-overdrive", "artifacts");
  const scopeNames = fs.existsSync(artifactRoot) ? fs.readdirSync(artifactRoot).filter((name) => /^[0-9a-f]{64}$/u.test(name)) : [];
  const scope = scopeNames.length === 1 ? path.join(artifactRoot, scopeNames[0]) : "";
  const dataPath = scope ? path.join(scope, `${artifactId}.data`) : "";
  const manifestPath = scope ? path.join(scope, `${artifactId}.json`) : "";
  const stored = dataPath && fs.existsSync(dataPath) ? fs.readFileSync(dataPath, "utf8") : "";
  const manifest = manifestPath && fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : null;
  const storedArtifactCount = scope ? fs.readdirSync(scope).filter((name) => /^[0-9a-f]{64}\.data$/u.test(name)).length : 0;
  const assertions = {
    piRunComplete: run.status === "PASS" && !run.externalized.isError && !run.reopened.isError,
    largeOutputExternalized: run.externalized.details?.artifact?.sha256 === artifactId && run.externalized.output.includes(`artifact://${artifactId}`),
    deterministicPreviewReduced: run.externalized.outputChars > 0 && run.externalized.outputChars < original.length / 2 && !run.externalized.output.includes("fixture-line-300"),
    criticalDiagnosticPreserved: run.externalized.output.includes("ERROR artifact benchmark critical diagnostic"),
    boundedArtifactRangeReopened: run.reopened.output.includes("419|fixture-line-419") && run.reopened.output.includes("420|ERROR artifact benchmark critical diagnostic") && run.reopened.output.includes("421|fixture-line-421"),
    errorSemanticsPreserved: run.failed.isError && run.failed.output.includes("ERROR artifact benchmark critical diagnostic") && /^artifact:\/\/[0-9a-f]{64}$/u.test(run.failed.details?.artifact?.uri ?? "") && run.failed.details?.artifact?.deduplicated === true,
    storedContentCompleteAndAddressed: stored === original && createHash("sha256").update(stored).digest("hex") === artifactId,
    privateFiles: Boolean(scope) && (fs.lstatSync(scope).mode & 0o077) === 0 && [dataPath, manifestPath].every((file) => (fs.lstatSync(file).mode & 0o077) === 0 && fs.lstatSync(file).nlink === 1),
    scopedManifest: manifest?.scopeDigest === scopeNames[0] && /^[0-9a-f]{64}$/u.test(manifest?.sessionDigest ?? "") && manifest?.trust === "TOOL_OUTPUT_UNTRUSTED" && !JSON.stringify(manifest).includes(temporary),
    commandsRegistered: command.status === "PASS",
  };
  delete run.externalized.output;
  delete run.reopened.output;
  delete run.failed.output;
  report = {
    version: 1, recordedAt: new Date().toISOString(), status: Object.values(assertions).every(Boolean) ? "PASS" : "FAIL",
    measurementMode: "real-pi-process-deterministic-local-provider", piVersion: spawnSync(pi, ["--version"], { encoding: "utf8" }).stdout.trim(),
    fixture: { sourceChars: original.length, sourceBytes: Buffer.byteLength(original), lines: 700, sha256: artifactId },
    overdriveUltra: { ...run, command, storedArtifacts: storedArtifactCount, comparison: { originalChars: original.length, previewChars: run.externalized.outputChars, savedChars: original.length - run.externalized.outputChars, savedPercent: Number(((1 - run.externalized.outputChars / original.length) * 100).toFixed(2)), estimatedOriginalTokens: Math.ceil(original.length / 4), estimatedPreviewTokens: Math.ceil(run.externalized.outputChars / 4) }, assertions },
    accounting: { deterministicLocalProviderTurns: run.providerTurns, paidModelCalls: 0, externalProviderCalls: 0, networkCalls: 0, cost: 0 },
    ompReference: { commit: "4267074ac91456866e95ed8de0b6353388f08502", version: "18.1.21", executableStatus: "NOT_RUN", reason: "Bun >=1.4 is unavailable; source inspection is not numeric benchmark evidence." },
  };
} catch (error) {
  report = { version: 1, recordedAt: new Date().toISOString(), status: "FAIL", accounting: { paidModelCalls: 0, externalProviderCalls: 0, networkCalls: 0, cost: 0 }, error: error instanceof Error ? error.message : String(error) };
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
  if (report) report.cleanup = { temporaryRemoved: !fs.existsSync(temporary) };
}

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (writeResults) fs.writeFileSync(path.join(benchmarkRoot, "artifact-store-results.json"), serialized, { mode: 0o600 });
process.stdout.write(serialized);
process.exit(report.status === "PASS" ? 0 : 1);
