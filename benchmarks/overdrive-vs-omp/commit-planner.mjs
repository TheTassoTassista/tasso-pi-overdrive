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
const extension = path.join(packageRoot, "extensions", "resources.ts");
const pi = process.env.PI_BIN ?? "pi";
const writeResults = process.argv.includes("--write-results");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-commit-plan-"));
const repository = path.join(temporary, "repo");
const agentDir = path.join(temporary, "agent");
const auditFile = path.join(temporary, "audit.jsonl");

function git(args) {
  const result = spawnSync("/usr/bin/git", ["-C", repository, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`fixture git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function digestFile(file) { return createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }

function repositoryState() {
  const index = path.resolve(repository, git(["rev-parse", "--git-path", "index"]));
  return {
    head: git(["rev-parse", "HEAD"]),
    indexDigest: digestFile(index),
    statusDigest: createHash("sha256").update(git(["status", "--porcelain=v1", "-z"])).digest("hex"),
    selectedDigest: digestFile(path.join(repository, "owned.txt")),
    unrelatedDigest: digestFile(path.join(repository, "unrelated.txt")),
    protectedDigest: digestFile(path.join(repository, ".env")),
  };
}

function parseEvents(text) {
  return String(text ?? "").split(/\r?\n/u).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}

function textOf(message) {
  return (message?.content ?? []).filter((entry) => entry?.type === "text").map((entry) => entry.text ?? "").join("");
}

async function runPlanner() {
  const sequence = [
    { name: "commit_plan", args: { action: "inspect", scope: "worktree", paths: ["owned.txt"] } },
    { name: "commit_plan", args: { action: "propose", scope: "worktree", groups: [
      { id: "first", changes: [{ path: "owned.txt", hunks: [1] }] },
      { id: "second", changes: [{ path: "owned.txt", hunks: [2] }] },
    ] } },
  ];
  const started = performance.now();
  const child = spawn(pi, [
    "--offline", "--approve", "--no-session", "--mode", "rpc",
    "--extension", provider, "--extension", extension,
    "--provider", "pi-overdrive-tool-audit", "--api-key", "audit-only",
    "--model", "pi-overdrive-tool-audit/single-tool-driver", "--thinking", "low",
    "--tools", "commit_plan",
  ], {
    cwd: repository,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OVERDRIVE_TOOL_AUDIT_KEY: "audit-only",
      PI_OVERDRIVE_AUDIT_TOOL_ARGS_SEQUENCE: JSON.stringify(sequence),
      PI_OVERDRIVE_AUDIT_EVENT_FILE: auditFile,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events = [];
  let buffer = "";
  let stderr = "";
  let exitCode = null;
  const settled = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("commit planner rpc timeout")), 45_000);
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
    child.stdin.write(`${JSON.stringify({ id: "commit-plan", type: "prompt", message: "Inspect the explicitly owned file and propose the two deterministic atomic groups." })}\n`);
    await settled;
  } finally {
    child.stdin.end();
    const timeout = setTimeout(() => child.kill("SIGTERM"), 3000);
    await closed;
    clearTimeout(timeout);
  }
  const ended = [...events].reverse().find((event) => event.type === "agent_end");
  const toolResults = (ended?.messages ?? []).filter((message) => message.role === "toolResult");
  return {
    status: exitCode === 0 && toolResults.length === 2 ? "PASS" : "FAIL",
    elapsedMs: Number((performance.now() - started).toFixed(3)),
    providerTurns: (ended?.messages ?? []).filter((message) => message.role === "assistant").length,
    exitCode,
    stderr: exitCode === 0 ? "" : stderr,
    results: toolResults.map((message) => ({ isError: message.isError === true, output: textOf(message), details: message.details ?? null })),
  };
}

function inspectCommand() {
  const run = spawnSync(pi, [
    "--offline", "--approve", "--no-session", "--mode", "rpc",
    "--extension", provider, "--extension", extension,
    "--provider", "pi-overdrive-tool-audit", "--api-key", "audit-only",
    "--model", "pi-overdrive-tool-audit/single-tool-driver", "--thinking", "low",
  ], {
    cwd: repository,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OVERDRIVE_TOOL_AUDIT_KEY: "audit-only" },
    input: `${JSON.stringify({ id: "commands", type: "get_commands" })}\n`,
    encoding: "utf8",
    timeout: 45_000,
  });
  const commands = parseEvents(run.stdout).find((event) => event.type === "response" && event.id === "commands")?.data?.commands ?? [];
  const command = commands.find((entry) => entry.name === "commit-plan");
  return { status: run.status === 0 && command?.source === "extension" ? "PASS" : "FAIL", source: command?.source ?? null, exitCode: run.status };
}

let report;
try {
  fs.mkdirSync(repository, { recursive: true, mode: 0o700 });
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(agentDir, "settings.json"), "{}\n", { mode: 0o600 });
  git(["init", "-q"]);
  git(["config", "user.name", "Fixture"]);
  git(["config", "user.email", "fixture@invalid"]);
  fs.writeFileSync(path.join(repository, "owned.txt"), `${Array.from({ length: 40 }, (_, index) => `line-${index}`).join("\n")}\n`);
  fs.writeFileSync(path.join(repository, "unrelated.txt"), "base\n");
  git(["add", "owned.txt", "unrelated.txt"]);
  git(["commit", "-qm", "base"]);

  const lines = fs.readFileSync(path.join(repository, "owned.txt"), "utf8").split("\n");
  lines[1] = "first-owned-change";
  lines[35] = "second-owned-change";
  fs.writeFileSync(path.join(repository, "owned.txt"), lines.join("\n"));
  fs.appendFileSync(path.join(repository, "unrelated.txt"), "unrelated-user-change\n");
  fs.writeFileSync(path.join(repository, ".env"), "BENCHMARK_SECRET_DO_NOT_RECORD=value\n", { mode: 0o600 });

  const before = repositoryState();
  const run = await runPlanner();
  const after = repositoryState();
  const command = inspectCommand();
  const audit = fs.existsSync(auditFile) ? parseEvents(fs.readFileSync(auditFile, "utf8")) : [];
  const metadata = audit.filter((entry) => entry.auditKind === "commit_plan_metadata");
  const inspect = run.results[0];
  const proposal = run.results[1];
  const serializedMetadata = JSON.stringify(metadata);
  const assertions = {
    piRunComplete: run.status === "PASS" && run.results.every((entry) => entry.isError === false),
    explicitOwnershipOnly: inspect?.details?.selectedFileCount === 1 && inspect?.details?.changedFileCount === 3 && inspect?.details?.excludedChangedFileCount === 2 && inspect?.details?.protectedChangedFileCount === 1,
    realTwoHunkSnapshot: /"hunks": \[/u.test(inspect?.output ?? "") && /"index": 1/u.test(inspect?.output ?? "") && /"index": 2/u.test(inspect?.output ?? ""),
    atomicGroupsProposed: proposal?.details?.groupCount === 2 && /"id": "first"/u.test(proposal?.output ?? "") && /"id": "second"/u.test(proposal?.output ?? ""),
    proposalHasNoAuthority: /"status": "PROPOSAL_ONLY"/u.test(proposal?.output ?? "") && /"canStage": false/u.test(proposal?.output ?? "") && /"canCommit": false/u.test(proposal?.output ?? "") && /"canPublish": false/u.test(proposal?.output ?? ""),
    digestBound: /^[0-9a-f]{64}$/u.test(inspect?.details?.snapshotDigest ?? "") && /^[0-9a-f]{64}$/u.test(proposal?.details?.snapshotDigest ?? "") && /^[0-9a-f]{64}$/u.test(proposal?.details?.planDigest ?? ""),
    metadataOnly: metadata.length === 2 && !serializedMetadata.includes("owned.txt") && !serializedMetadata.includes("unrelated.txt") && !serializedMetadata.includes("BENCHMARK_SECRET_DO_NOT_RECORD") && !serializedMetadata.includes("first-owned-change"),
    zeroDecisionModelCalls: metadata.every((entry) => entry.decisionModelCalls === 0),
    repositoryByteInvariant: JSON.stringify(before) === JSON.stringify(after),
    commandRegistered: command.status === "PASS",
    deterministicTurnCount: run.providerTurns === 3,
  };
  for (const result of run.results) delete result.output;
  report = {
    version: 1,
    recordedAt: new Date().toISOString(),
    status: Object.values(assertions).every(Boolean) ? "PASS" : "FAIL",
    measurementMode: "real-pi-process-deterministic-local-provider-pinned-git-proposal-only",
    piVersion: spawnSync(pi, ["--version"], { encoding: "utf8" }).stdout.trim(),
    overdriveUltra: { run, command, assertions },
    accounting: { deterministicLocalProviderTurns: run.providerTurns, decisionModelCalls: 0, paidModelCalls: 0, externalProviderCalls: 0, networkCalls: 0, cost: 0 },
    ompReference: { commit: "4267074ac91456866e95ed8de0b6353388f08502", version: "18.1.21", executableStatus: "NOT_RUN", reason: "Bun >=1.4 is unavailable; source inspection is not numeric benchmark evidence." },
  };
} catch (error) {
  report = { version: 1, recordedAt: new Date().toISOString(), status: "FAIL", accounting: { paidModelCalls: 0, externalProviderCalls: 0, networkCalls: 0, cost: 0 }, error: error instanceof Error ? error.message : String(error) };
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

report.cleanup = { temporaryFixtureRemoved: !fs.existsSync(temporary) };
if (!report.cleanup.temporaryFixtureRemoved) report.status = "FAIL";
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (writeResults) fs.writeFileSync(path.join(benchmarkRoot, "commit-planner-results.json"), serialized, { mode: 0o600 });
process.stdout.write(serialized);
process.exit(report.status === "PASS" ? 0 : 1);
