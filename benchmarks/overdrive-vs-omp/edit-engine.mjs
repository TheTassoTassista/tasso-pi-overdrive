#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const benchmarkRoot = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(benchmarkRoot, "../..");
const provider = path.join(packageRoot, "tests", "fixtures", "deterministic-edit-engine-provider.ts");
const editEngine = path.join(packageRoot, "extensions", "edit-engine.ts");
const pi = process.env.PI_BIN ?? "pi";
const writeResults = process.argv.includes("--write-results");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-edit-engine-"));

function parseJsonLines(text) {
  return String(text ?? "").split(/\r?\n/u).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}

function textOf(message) {
  return (message?.content ?? []).filter((entry) => entry?.type === "text").map((entry) => entry.text ?? "").join("");
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

function filesBelow(root, predicate) {
  if (!fs.existsSync(root)) return [];
  const output = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && predicate(full)) output.push(full);
    }
  };
  walk(root);
  return output;
}

async function runScenario(scenario) {
  const root = path.join(temporary, scenario);
  const stateHome = path.join(root, "state");
  const agentDir = path.join(root, "agent");
  const fixture = path.join(root, "edit-fixture.txt");
  const auditReceipt = path.join(root, "audit.jsonl");
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(agentDir, "settings.json"), "{}\n", { mode: 0o600 });
  fs.writeFileSync(fixture, "header\nanchor old\ntail\n", { mode: 0o600 });
  fs.writeFileSync(auditReceipt, "", { mode: 0o600 });
  const child = spawn(pi, [
    "--offline", "--approve", "--no-session", "--mode", "rpc",
    "--extension", provider, "--extension", editEngine,
    "--provider", "pi-overdrive-edit-audit", "--api-key", "audit-only", "--model", "edit-driver", "--thinking", "low",
    "--tools", "read,transactional_edit",
  ], {
    cwd: root,
    env: {
      ...process.env, XDG_STATE_HOME: stateHome, PI_CODING_AGENT_DIR: agentDir,
      PI_OVERDRIVE_EDIT_AUDIT_KEY: "audit-only", PI_OVERDRIVE_EDIT_AUDIT_FIXTURE: "edit-fixture.txt",
      PI_OVERDRIVE_EDIT_AUDIT_SCENARIO: scenario, PI_OVERDRIVE_EDIT_AUDIT_RECEIPT: auditReceipt,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events = [];
  let buffer = "";
  let stderr = "";
  let timedOut = false;
  let exitCode = null;
  const settled = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { timedOut = true; resolve(); }, 30_000);
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
  const started = performance.now();
  try {
    child.stdin.write(`${JSON.stringify({ id: scenario, type: "prompt", message: `Run the deterministic ${scenario} edit transaction.` })}\n`);
    await settled;
  } finally {
    child.stdin.end();
    const timeout = setTimeout(() => child.kill("SIGTERM"), 5_000);
    await closed;
    clearTimeout(timeout);
  }
  const ended = [...events].reverse().find((event) => event.type === "agent_end");
  const messages = ended?.messages ?? [];
  const finalText = textOf([...messages].reverse().find((message) => message.role === "assistant"));
  let finalPayload;
  try { finalPayload = JSON.parse(finalText); } catch {}
  const audit = parseJsonLines(fs.readFileSync(auditReceipt, "utf8"));
  const receiptFiles = filesBelow(path.join(stateHome, "pi-overdrive", "edit-receipts"), (file) => /^[0-9a-f-]{36}\.json$/iu.test(path.basename(file)));
  const staged = filesBelow(root, (file) => path.basename(file).startsWith(".pi-overdrive-edit-"));
  const receiptRecords = receiptFiles.map((file) => ({ file, text: fs.readFileSync(file, "utf8"), mode: fs.lstatSync(file).mode & 0o777 }));
  return {
    status: !timedOut && exitCode === 0 && finalPayload ? "COMPLETE" : "FAILED",
    elapsedMs: Number((performance.now() - started).toFixed(3)), timedOut, exitCode,
    providerTurns: audit.filter((entry) => entry.kind === "provider_turn").length,
    editMetadata: audit.filter((entry) => entry.auditKind === "edit_metadata").map(({ auditKind: _auditKind, ...entry }) => entry),
    finalPayload: finalPayload ?? null,
    finalContents: fs.readFileSync(fixture, "utf8"),
    finalDigest: sha256(fs.readFileSync(fixture)),
    receipts: receiptRecords.map((entry) => ({ mode: entry.mode, digest: sha256(entry.text), containsRawData: /edit-fixture|anchor old|anchor new|external prefix/iu.test(entry.text) })),
    stagedFiles: staged.length,
    stderrBytes: Buffer.byteLength(stderr), stderrDigest: stderr ? sha256(stderr) : null,
  };
}

function inspectCommand() {
  const root = path.join(temporary, "command");
  const agentDir = path.join(root, "agent");
  const receipt = path.join(root, "audit.jsonl");
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(agentDir, "settings.json"), "{}\n", { mode: 0o600 });
  fs.writeFileSync(path.join(root, "edit-fixture.txt"), "unused\n", { mode: 0o600 });
  fs.writeFileSync(receipt, "", { mode: 0o600 });
  const run = spawnSync(pi, [
    "--offline", "--approve", "--no-session", "--mode", "rpc", "--extension", provider, "--extension", editEngine,
    "--provider", "pi-overdrive-edit-audit", "--api-key", "audit-only", "--model", "edit-driver", "--thinking", "low", "--no-tools",
  ], {
    cwd: root,
    env: { ...process.env, XDG_STATE_HOME: path.join(root, "state"), PI_CODING_AGENT_DIR: agentDir, PI_OVERDRIVE_EDIT_AUDIT_KEY: "audit-only", PI_OVERDRIVE_EDIT_AUDIT_RECEIPT: receipt },
    input: `${JSON.stringify({ id: "commands", type: "get_commands" })}\n`, encoding: "utf8", timeout: 45_000,
  });
  const events = parseJsonLines(run.stdout);
  const commands = events.find((event) => event.type === "response" && event.id === "commands")?.data?.commands ?? [];
  const command = commands.find((entry) => entry.name === "edit-engine");
  return { status: run.status === 0 && command?.source === "extension" ? "PASS" : "FAIL", providerTurns: parseJsonLines(fs.readFileSync(receipt, "utf8")).filter((entry) => entry.kind === "provider_turn").length, exitCode: run.status };
}

let report;
try {
  const recovery = await runScenario("recovery");
  const stale = await runScenario("stale");
  const command = inspectCommand();
  const metadataSafe = [...recovery.editMetadata, ...stale.editMetadata].every((entry) => !JSON.stringify(entry).includes(temporary) && !/anchor old|anchor new|external prefix/iu.test(JSON.stringify(entry)));
  const assertions = {
    realPiRecoveryCompleted: recovery.status === "COMPLETE" && recovery.providerTurns === 4 && recovery.finalPayload?.toolResults === 3,
    snapshotBoundAndPreviewed: recovery.finalPayload?.snapshotBound === true && recovery.finalPayload?.previewNonMutating === true && recovery.finalPayload?.previewStatus === "SAFE_RECOVERY",
    safeRecoveryApplied: recovery.finalPayload?.applyStatus === "APPLIED" && recovery.finalPayload?.applyIsError === false && recovery.finalContents === "external prefix\nheader\nanchor new\ntail\n",
    immutableMetadataReceipt: recovery.receipts.length === 1 && recovery.receipts[0].mode === 0o400 && recovery.receipts[0].containsRawData === false,
    staleRunCompleted: stale.status === "COMPLETE" && stale.providerTurns === 4 && stale.finalPayload?.previewNonMutating === true,
    staleApplyFailedClosed: stale.finalPayload?.applyIsError === true && stale.finalPayload?.applyStatus === "STALE_EDIT" && stale.finalPayload?.applyGuidancePresent === true && stale.finalContents === "external after preview\n" && stale.receipts.length === 0,
    noStagedResidue: recovery.stagedFiles === 0 && stale.stagedFiles === 0,
    metadataOnly: metadataSafe && recovery.editMetadata.length >= 3 && stale.editMetadata.length >= 3,
    commandRegisteredWithoutProviderCall: command.status === "PASS" && command.providerTurns === 0,
  };
  report = {
    version: 1, recordedAt: new Date().toISOString(), status: Object.values(assertions).every(Boolean) ? "PASS" : "FAIL",
    measurementMode: "real-pi-process-deterministic-local-provider", piVersion: spawnSync(pi, ["--version"], { encoding: "utf8" }).stdout.trim(),
    overdriveUltra: { recovery, stale, command, assertions },
    accounting: { deterministicLocalProviderTurns: recovery.providerTurns + stale.providerTurns, paidModelCalls: 0, externalProviderCalls: 0, networkCalls: 0, cost: 0 },
    ompReference: { commit: "4267074ac91456866e95ed8de0b6353388f08502", version: "18.1.21", executableStatus: "NOT_RUN", reason: "Bun >=1.4 is unavailable; source inspection is not numeric benchmark evidence." },
  };
} catch (error) {
  report = { version: 1, recordedAt: new Date().toISOString(), status: "FAIL", accounting: { paidModelCalls: 0, externalProviderCalls: 0, networkCalls: 0, cost: 0 }, error: error instanceof Error ? error.message : String(error) };
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
  if (report) report.cleanup = { temporaryRemoved: !fs.existsSync(temporary) };
}

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (writeResults) fs.writeFileSync(path.join(benchmarkRoot, "edit-engine-results.json"), serialized, { mode: 0o600 });
process.stdout.write(serialized);
process.exit(report.status === "PASS" ? 0 : 1);
