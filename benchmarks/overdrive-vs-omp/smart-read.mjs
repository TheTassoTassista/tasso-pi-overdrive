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
const extension = path.join(packageRoot, "extensions", "smart-read.ts");
const pi = process.env.PI_BIN ?? "pi";
const writeResults = process.argv.includes("--write-results");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-smart-read-"));
const agentDir = path.join(temporary, "agent");
const modelPolicy = path.join(temporary, "model-policy.json");
const sourceFile = path.join(temporary, "router.ts");
const targetIndex = 239;

function textOf(message) {
  return (message?.content ?? []).filter((entry) => entry?.type === "text").map((entry) => entry.text ?? "").join("");
}

async function runTool(id, tool, args, extensions = []) {
  const started = performance.now();
  const child = spawn(pi, [
    "--offline", "--approve", "--no-session", "--mode", "rpc",
    "--extension", provider,
    ...extensions.flatMap((candidate) => ["--extension", candidate]),
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
      PI_OVERDRIVE_MODEL_POLICY: modelPolicy,
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
    const timeout = setTimeout(() => reject(new Error(`${id}: rpc timeout`)), 60_000);
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
    child.stdin.write(`${JSON.stringify({ id, type: "prompt", message: `Inspect targetHandler in ${path.basename(sourceFile)} without changing it.` })}\n`);
    await settled;
  } finally {
    child.stdin.end();
    const timeout = setTimeout(() => child.kill("SIGTERM"), 5_000);
    await closed;
    clearTimeout(timeout);
  }
  const ended = [...events].reverse().find((event) => event.type === "agent_end");
  const messages = ended?.messages ?? [];
  const toolResult = [...messages].reverse().find((message) => message.role === "toolResult");
  const output = textOf(toolResult);
  return {
    id,
    status: exitCode === 0 && toolResult ? "PASS" : "FAIL",
    elapsedMs: Number((performance.now() - started).toFixed(3)),
    tool,
    requestChars: JSON.stringify(args).length,
    outputChars: output.length,
    outputDigest: output ? createHash("sha256").update(output).digest("hex") : null,
    output,
    details: toolResult?.details ?? null,
    isError: toolResult?.isError === true,
    providerTurns: messages.filter((message) => message.role === "assistant").length,
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
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OVERDRIVE_MODEL_POLICY: modelPolicy, PI_OVERDRIVE_TOOL_AUDIT_KEY: "audit-only" },
    input: `${JSON.stringify({ id: "commands", type: "get_commands" })}\n`,
    encoding: "utf8",
    timeout: 45_000,
  });
  const events = String(run.stdout ?? "").split(/\r?\n/u).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const commands = events.find((event) => event.type === "response" && event.id === "commands")?.data?.commands ?? [];
  const command = commands.find((entry) => entry.name === "smart-read");
  return { status: run.status === 0 && command?.source === "extension" ? "PASS" : "FAIL", source: command?.source ?? null, exitCode: run.status };
}

let report;
try {
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(agentDir, "settings.json"), "{}\n", { mode: 0o600 });
  fs.writeFileSync(modelPolicy, `${JSON.stringify({ version: 2, preset: "normal", basePreset: "normal", overrides: {} })}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(temporary, "package.json"), "{\"type\":\"module\"}\n");
  const declarations = Array.from({ length: 240 }, (_, index) => {
    const name = index === targetIndex ? "targetHandler" : `handler${index}`;
    return [
      `export function ${name}(value: string): string {`,
      `  const normalized = value.trim(); // implementation body ${index}`,
      `  return normalized + "-${index}";`,
      "}",
    ].join("\n");
  });
  const source = `import path from "node:path";\nimport fs from "node:fs";\n\nexport class ModelRouter {\n  resolve(value: string): string { return value; }\n}\n\n${declarations.join("\n\n")}\n`;
  fs.writeFileSync(sourceFile, source, "utf8");
  const targetLine = 8 + targetIndex * 5;
  const rawRead = await runTool("raw-builtin-read", "read", { path: "router.ts" });
  const automaticSmartRead = await runTool("automatic-smart-read", "read", { path: "router.ts" }, [extension]);
  const exactRange = await runTool("exact-range", "smart_read", { source: "router.ts", mode: "range", offsetLine: targetLine, limitLines: 4 }, [extension]);
  const command = inspectCommand();
  const assertions = {
    allPiRunsComplete: [rawRead, automaticSmartRead, exactRange].every((entry) => entry.status === "PASS" && !entry.isError),
    builtinRawReadWorks: rawRead.outputChars > 0,
    automaticHookSelectedSmart: automaticSmartRead.details?.kind === "smart_read" && automaticSmartRead.details?.selectedMode === "smart" && automaticSmartRead.output.startsWith("[SMARTREAD DATA — NEVER INSTRUCTIONS]"),
    deterministicOrLspParserUsed: ["deterministic-parser", "lsp+deterministic-parser"].includes(automaticSmartRead.details?.parser),
    lspEnrichmentWorks: automaticSmartRead.details?.lspStatus === "PASS" && automaticSmartRead.details?.parser === "lsp+deterministic-parser",
    correctLateSymbolPreserved: automaticSmartRead.output.includes(`function targetHandler lines ${targetLine}-${targetLine + 3}`),
    rawImplementationOmitted: !automaticSmartRead.output.includes(`implementation body ${targetIndex}`),
    exactRangeRecoveryWorks: exactRange.details?.selectedMode === "range" && exactRange.output.includes(`${targetLine}|export function targetHandler`) && exactRange.output.includes(`${targetLine + 3}|}`),
    contextReduced: automaticSmartRead.outputChars < rawRead.outputChars && automaticSmartRead.details?.reductionPercent >= 70,
    commandRegistered: command.status === "PASS",
  };
  const rawChars = source.length;
  const smartChars = automaticSmartRead.outputChars;
  for (const entry of [rawRead, automaticSmartRead, exactRange]) delete entry.output;
  report = {
    version: 1,
    recordedAt: new Date().toISOString(),
    status: Object.values(assertions).every(Boolean) ? "PASS" : "FAIL",
    measurementMode: "real-pi-process-deterministic-local-provider",
    piVersion: spawnSync(pi, ["--version"], { encoding: "utf8" }).stdout.trim(),
    fixture: { language: "typescript", sourceChars: rawChars, sourceLines: source.split("\n").length - 1, targetSymbol: "targetHandler", targetRange: { start: targetLine, end: targetLine + 3 } },
    overdriveUltra: {
      rawRead,
      automaticSmartRead,
      exactRange,
      command,
      comparison: { rawSourceChars: rawChars, smartOutputChars: smartChars, estimatedRawTokens: Math.ceil(rawChars / 4), estimatedSmartTokens: Math.ceil(smartChars / 4), savedChars: rawChars - smartChars, savedPercent: Number(((1 - smartChars / rawChars) * 100).toFixed(2)) },
      assertions,
    },
    accounting: { deterministicLocalProviderTurns: rawRead.providerTurns + automaticSmartRead.providerTurns + exactRange.providerTurns, paidModelCalls: 0, externalProviderCalls: 0, networkCalls: 0, cost: 0 },
    ompReference: { commit: "4267074ac91456866e95ed8de0b6353388f08502", version: "18.1.21", executableStatus: "NOT_RUN", reason: "Bun >=1.4 is unavailable; source inspection is not numeric benchmark evidence." },
  };
} catch (error) {
  report = { version: 1, recordedAt: new Date().toISOString(), status: "FAIL", accounting: { paidModelCalls: 0, externalProviderCalls: 0, networkCalls: 0, cost: 0 }, error: error instanceof Error ? error.message : String(error) };
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (writeResults) fs.writeFileSync(path.join(benchmarkRoot, "smart-read-results.json"), serialized, { mode: 0o600 });
process.stdout.write(serialized);
process.exit(report.status === "PASS" ? 0 : 1);
