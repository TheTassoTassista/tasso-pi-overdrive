#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const benchmarkRoot = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(benchmarkRoot, "../..");
const provider = path.join(packageRoot, "tests", "fixtures", "deterministic-single-tool-provider.ts");
const extension = path.join(packageRoot, "extensions", "resources.ts");
const pi = process.env.PI_BIN ?? "pi";
const writeResults = process.argv.includes("--write-results");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-resource-fs-"));
const agentDir = path.join(temporary, "agent");

function eventsFrom(run) {
  return String(run.stdout ?? "").split(/\r?\n/u).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}

function textOf(message) {
  return (message?.content ?? []).filter((entry) => entry?.type === "text").map((entry) => entry.text ?? "").join("");
}

async function runTool(id, tool, args) {
  const started = performance.now();
  const child = spawn(pi, [
    "--offline", "--approve", "--no-session", "--mode", "rpc",
    "--extension", provider,
    "--extension", extension,
    "--provider", "pi-overdrive-tool-audit",
    "--api-key", "audit-only",
    "--model", "pi-overdrive-tool-audit/single-tool-driver",
    "--thinking", "low",
    "--tools", tool,
  ], {
    cwd: temporary,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OVERDRIVE_TOOL_AUDIT_KEY: "audit-only",
      PI_OVERDRIVE_AUDIT_TOOL: tool,
      PI_OVERDRIVE_AUDIT_TOOL_ARGS: JSON.stringify(args),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events = [];
  let buffer = "";
  let stderr = "";
  let exitCode = null;
  const settled = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${id}: rpc timeout`)), 45_000);
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
          if (event.type === "agent_settled") {
            clearTimeout(timeout);
            resolve();
          }
        } catch {}
      }
    });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4000); });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
  });
  const closed = new Promise((resolve) => child.once("close", (code) => { exitCode = code; resolve(); }));
  try {
    child.stdin.write(`${JSON.stringify({ id, type: "prompt", message: "Run the deterministic ResourceFS benchmark call." })}\n`);
    await settled;
  } finally {
    child.stdin.end();
    const timeout = setTimeout(() => child.kill("SIGTERM"), 3000);
    await closed;
    clearTimeout(timeout);
  }
  const ended = [...events].reverse().find((event) => event.type === "agent_end");
  const toolResult = [...(ended?.messages ?? [])].reverse().find((message) => message.role === "toolResult");
  const output = textOf(toolResult);
  return {
    id,
    status: exitCode === 0 && toolResult ? "PASS" : "FAIL",
    elapsedMs: Number((performance.now() - started).toFixed(3)),
    tool,
    requestChars: JSON.stringify(args).length,
    outputChars: output.length,
    output,
    details: toolResult?.details ?? null,
    isError: toolResult?.isError === true,
    providerTurns: (ended?.messages ?? []).filter((message) => message.role === "assistant").length,
    exitCode,
    stderr: exitCode === 0 ? "" : stderr,
  };
}

function inspectCommand() {
  const run = spawnSync(pi, [
    "--offline", "--approve", "--no-session", "--mode", "rpc",
    "--extension", provider, "--extension", extension,
    "--provider", "pi-overdrive-tool-audit", "--api-key", "audit-only",
    "--model", "pi-overdrive-tool-audit/single-tool-driver", "--thinking", "low",
  ], {
    cwd: temporary,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OVERDRIVE_TOOL_AUDIT_KEY: "audit-only" },
    input: `${JSON.stringify({ id: "commands", type: "get_commands" })}\n`,
    encoding: "utf8",
    timeout: 45_000,
  });
  const commands = eventsFrom(run).find((event) => event.type === "response" && event.id === "commands")?.data?.commands ?? [];
  const command = commands.find((entry) => entry.name === "resources");
  return { status: run.status === 0 && command?.source === "extension" ? "PASS" : "FAIL", source: command?.source ?? null, exitCode: run.status };
}

let report;
try {
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(agentDir, "settings.json"), "{}\n", { mode: 0o600 });
  const fixture = Array.from({ length: 300 }, (_, index) => `${index + 1}: deterministic fixture`).join("\n");
  fs.writeFileSync(path.join(temporary, "fixture.txt"), `${fixture}\n`, "utf8");
  fs.writeFileSync(path.join(temporary, ".env"), "RESOURCE_BENCHMARK_SECRET\n", { mode: 0o600 });
  const rawRead = await runTool("builtin-read", "read", { path: "fixture.txt", offset: 1, limit: 200 });
  const resourceRead = await runTool("resource-read", "resource_fs", { operation: "read", uri: "repo://root/fixture.txt", offsetLine: 1, limitLines: 200 });
  const deniedSecret = await runTool("resource-secret-denied", "resource_fs", { operation: "read", uri: "repo://root/.env" });
  const command = inspectCommand();
  const assertions = {
    allPiRunsComplete: [rawRead, resourceRead, deniedSecret].every((entry) => entry.status === "PASS"),
    builtinReadWorks: rawRead.isError === false && rawRead.outputChars > 0,
    resourceReadWorks: resourceRead.isError === false && resourceRead.outputChars > 0,
    explicitTrustMetadata: resourceRead.details?.trust === "WORKSPACE_UNTRUSTED" && resourceRead.details?.immutable === true && /^[0-9a-f]{64}$/u.test(resourceRead.details?.uriDigest ?? ""),
    secretDenied: deniedSecret.isError === true && deniedSecret.output.includes("resource_repo_path_protected"),
    publicSurfaceReadOnly: JSON.stringify(resourceRead.details).includes("WRITE") === false && JSON.stringify(resourceRead.details).includes("MUTATE") === false && JSON.stringify(resourceRead.details).includes("EXECUTE") === false,
    commandRegistered: command.status === "PASS",
  };
  for (const entry of [rawRead, resourceRead, deniedSecret]) delete entry.output;
  report = {
    version: 1,
    recordedAt: new Date().toISOString(),
    status: Object.values(assertions).every(Boolean) ? "PASS" : "FAIL",
    measurementMode: "real-pi-process-deterministic-local-provider",
    piVersion: spawnSync(pi, ["--version"], { encoding: "utf8" }).stdout.trim(),
    overdriveUltra: { rawRead, resourceRead, deniedSecret, command, assertions },
    accounting: { deterministicLocalProviderTurns: rawRead.providerTurns + resourceRead.providerTurns + deniedSecret.providerTurns, paidModelCalls: 0, externalProviderCalls: 0, networkCalls: 0, cost: 0 },
    interpretation: "ResourceFS intentionally adds trust/digest metadata and strict policy checks; it is not expected to beat Pi's raw read tool on output size or latency.",
    ompReference: { commit: "4267074ac91456866e95ed8de0b6353388f08502", version: "18.1.21", executableStatus: "NOT_RUN", reason: "Bun >=1.4 is unavailable; source inspection is not numeric benchmark evidence." },
  };
} catch (error) {
  report = { version: 1, recordedAt: new Date().toISOString(), status: "FAIL", accounting: { paidModelCalls: 0, externalProviderCalls: 0, networkCalls: 0, cost: 0 }, error: error instanceof Error ? error.message : String(error) };
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (writeResults) fs.writeFileSync(path.join(benchmarkRoot, "resource-fs-results.json"), serialized, { mode: 0o600 });
process.stdout.write(serialized);
process.exit(report.status === "PASS" ? 0 : 1);
