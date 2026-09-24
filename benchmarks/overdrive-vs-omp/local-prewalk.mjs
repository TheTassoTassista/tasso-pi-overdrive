#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildLocalPrewalk } from "../../lib/local-prewalk.mjs";
import { resolveTaskPolicy } from "../../lib/task-governor.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pi = process.env.PI_BIN ?? "pi";
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-prewalk-benchmark-"));
const repo = path.join(temporary, "repo");
const agentDir = path.join(temporary, "agent");
const task = "Find parser code and identify parseInput in repository";
const writeResults = process.argv.includes("--write-results");

function git(args) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`fixture git ${args[0]} failed`);
}

function parseLines(text) {
  return String(text).split(/\r?\n/u).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}

async function run(name, hint) {
  const receiptFile = path.join(temporary, `${name}.jsonl`);
  fs.writeFileSync(receiptFile, "", { mode: 0o600 });
  const prompt = hint ? `${task}\n\n${hint}` : task;
  const started = performance.now();
  const piRun = spawnSync(pi, [
    "--offline", "--approve", "--no-session", "--mode", "rpc", "--no-extensions",
    "--extension", path.join(packageRoot, "tests/fixtures/deterministic-prewalk-worker.ts"),
    "--provider", "pi-overdrive-prewalk-local", "--api-key", "audit-only", "--model", "pi-overdrive-prewalk-local/worker", "--thinking", "off",
    "--tools", "prewalk_search,prewalk_read",
  ], {
    cwd: repo, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OVERDRIVE_PREWALK_KEY: "audit-only", PI_OVERDRIVE_PREWALK_RECEIPT: receiptFile },
    input: `${JSON.stringify({ id: name, type: "prompt", message: prompt })}\n`, encoding: "utf8", timeout: 45000, maxBuffer: 2_000_000,
  });
  const stdout = piRun.stdout ?? "";
  const stderr = piRun.stderr ?? "";
  if (piRun.status !== 0 || !parseLines(stdout).some((event) => event.type === "agent_settled")) throw new Error(`${name}:Pi exited ${piRun.status}: ${String(stderr).slice(-1000)} stdout=${String(stdout).slice(-1000)}`);
  const receipts = parseLines(fs.readFileSync(receiptFile, "utf8"));
  const events = parseLines(stdout);
  const end = [...events].reverse().find((event) => event.type === "agent_end");
  const assistant = [...(end?.messages ?? [])].reverse().find((message) => message.role === "assistant");
  const answer = assistant?.content?.filter((block) => block.type === "text").map((block) => block.text).join("") ?? "";
  let result;
  try { result = JSON.parse(answer); } catch { result = null; }
  return {
    elapsedMs: Number((performance.now() - started).toFixed(3)), promptChars: prompt.length,
    approximatePromptTokens: Math.ceil(prompt.length / 4), providerTurns: receipts.filter((entry) => entry.kind === "provider_turn").length,
    searchCalls: receipts.filter((entry) => entry.kind === "search_call").length,
    readCalls: receipts.filter((entry) => entry.kind === "read_call").length,
    toolCalls: receipts.filter((entry) => ["search_call", "read_call"].includes(entry.kind)).length,
    result, stderrBytes: Buffer.byteLength(stderr),
  };
}

let report;
try {
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(agentDir, "settings.json"), "{}\n", { mode: 0o600 });
  fs.writeFileSync(path.join(repo, "src/parser.ts"), "export function parseInput(value: string) { return value.trim(); }\n");
  fs.writeFileSync(path.join(repo, "src/other.ts"), "export const unrelated = true;\n");
  git(["init", "-q"]);
  git(["add", "-A"]);
  const policy = resolveTaskPolicy({ task, preset: "token-saver", quality: "low" });
  const prewalkStarted = performance.now();
  const prewalk = await buildLocalPrewalk(repo, task, policy);
  const prewalkMs = Number((performance.now() - prewalkStarted).toFixed(3));
  const control = await run("control", "");
  const enriched = await run("prewalk", prewalk.text);
  const assertions = {
    eligibleWithoutScout: policy.routingStrategy.roles.scout === false && prewalk.status === "HINTS",
    relevantPathSelected: prewalk.text.includes("- src/parser.ts"),
    sameCorrectResult: control.result?.found === true && enriched.result?.found === true && control.result?.path === enriched.result?.path,
    searchReduced: control.searchCalls === 1 && enriched.searchCalls === 0,
    noExtraRead: control.readCalls === 1 && enriched.readCalls === 1,
    oneFewerProviderTurn: control.providerTurns === 3 && enriched.providerTurns === 2,
    noExtraAuthority: control.toolCalls === 2 && enriched.toolCalls === 1,
  };
  report = {
    version: 1, recordedAt: new Date().toISOString(), status: Object.values(assertions).every(Boolean) ? "PASS" : "FAIL",
    measurementMode: "real-Pi-offline-deterministic-local-Worker-provider", piVersion: spawnSync(pi, ["--version"], { encoding: "utf8" }).stdout.trim(),
    prewalk: { status: prewalk.status, chars: prewalk.text.length, selectedCount: prewalk.candidateCount, scannedCount: prewalk.scannedCount, elapsedMs: prewalkMs },
    control, enriched, assertions,
    deltas: { providerTurns: enriched.providerTurns - control.providerTurns, searchCalls: enriched.searchCalls - control.searchCalls, reads: enriched.readCalls - control.readCalls, promptChars: enriched.promptChars - control.promptChars, elapsedMsIncludingPrewalk: Number((enriched.elapsedMs + prewalkMs - control.elapsedMs).toFixed(3)) },
    accounting: { localDeterministicProviderTurns: control.providerTurns + enriched.providerTurns, prewalkModelCalls: 0, externalProviderCalls: 0, paidModelCalls: 0, monetaryCost: 0 },
  };
} catch (error) {
  report = { version: 1, recordedAt: new Date().toISOString(), status: "FAIL", error: error instanceof Error ? error.message : String(error), accounting: { prewalkModelCalls: 0, externalProviderCalls: 0, paidModelCalls: 0, monetaryCost: 0 } };
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
  report.cleanup = { temporaryRemoved: !fs.existsSync(temporary) };
  if (!report.cleanup.temporaryRemoved) report.status = "FAIL";
}
const output = `${JSON.stringify(report, null, 2)}\n`;
if (writeResults) fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "local-prewalk-results.json"), output, { mode: 0o600 });
process.stdout.write(output);
process.exit(report.status === "PASS" ? 0 : 1);
