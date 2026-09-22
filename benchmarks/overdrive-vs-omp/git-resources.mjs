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
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-git-resources-"));
const agentDir = path.join(temporary, ".agent");

function git(args) {
  const result = spawnSync("/usr/bin/git", ["-C", temporary, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`fixture git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function eventsFrom(run) {
  return String(run.stdout ?? "").split(/\r?\n/u).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}

function textOf(message) {
  return (message?.content ?? []).filter((entry) => entry?.type === "text").map((entry) => entry.text ?? "").join("");
}

async function runResource(id, args) {
  const started = performance.now();
  const child = spawn(pi, [
    "--offline", "--approve", "--no-session", "--mode", "rpc",
    "--extension", provider, "--extension", extension,
    "--provider", "pi-overdrive-tool-audit", "--api-key", "audit-only",
    "--model", "pi-overdrive-tool-audit/single-tool-driver", "--thinking", "low",
    "--tools", "resource_fs",
  ], {
    cwd: temporary,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OVERDRIVE_TOOL_AUDIT_KEY: "audit-only",
      PI_OVERDRIVE_AUDIT_TOOL: "resource_fs",
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
          if (event.type === "agent_settled") { clearTimeout(timeout); resolve(); }
        } catch {}
      }
    });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4000); });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
  });
  const closed = new Promise((resolve) => child.once("close", (code) => { exitCode = code; resolve(); }));
  try {
    child.stdin.write(`${JSON.stringify({ id, type: "prompt", message: "Run the deterministic local Git ResourceFS benchmark call." })}\n`);
    await settled;
  } finally {
    child.stdin.end();
    const timeout = setTimeout(() => child.kill("SIGTERM"), 3000);
    await closed;
    clearTimeout(timeout);
  }
  const ended = [...events].reverse().find((event) => event.type === "agent_end");
  const toolResult = [...(ended?.messages ?? [])].reverse().find((message) => message.role === "toolResult");
  return {
    id,
    status: exitCode === 0 && toolResult ? "PASS" : "FAIL",
    elapsedMs: Number((performance.now() - started).toFixed(3)),
    output: textOf(toolResult),
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
  git(["init", "-q"]);
  git(["config", "user.name", "Fixture"]);
  git(["config", "user.email", "fixture@invalid"]);
  fs.writeFileSync(path.join(temporary, "file.txt"), "base\n", "utf8");
  fs.writeFileSync(path.join(temporary, "conflict.txt"), "base\n", "utf8");
  git(["add", "file.txt", "conflict.txt"]);
  git(["commit", "-qm", "base"]);
  const initialBranch = git(["branch", "--show-current"]);

  fs.writeFileSync(path.join(temporary, "file.txt"), "base\nworktree\n", "utf8");
  const status = await runResource("git-status", { operation: "read", uri: "git://repo/status" });
  const worktreeDiff = await runResource("git-worktree-diff", { operation: "read", uri: "git://repo/diff/worktree/file.txt" });
  git(["add", "file.txt"]);
  const stagedDiff = await runResource("git-staged-diff", { operation: "read", uri: "git://repo/diff/staged/file.txt" });
  git(["commit", "-qm", "fixture change"]);

  git(["checkout", "-qb", "conflict-side"]);
  fs.writeFileSync(path.join(temporary, "conflict.txt"), "theirs\n", "utf8");
  git(["commit", "-qam", "theirs"]);
  git(["checkout", "-q", initialBranch]);
  fs.writeFileSync(path.join(temporary, "conflict.txt"), "ours\n", "utf8");
  git(["commit", "-qam", "ours"]);
  const merge = spawnSync("/usr/bin/git", ["-C", temporary, "merge", "conflict-side"], { encoding: "utf8" });
  if (merge.status === 0) throw new Error("fixture merge unexpectedly succeeded");
  const conflictList = await runResource("conflict-list", { operation: "read", uri: "conflict://repo/list" });
  const conflictOurs = await runResource("conflict-ours", { operation: "read", uri: "conflict://repo/ours/conflict.txt" });
  const deniedMutation = await runResource("git-reset-denied", { operation: "read", uri: "git://repo/reset" });
  const command = inspectCommand();
  const runs = [status, worktreeDiff, stagedDiff, conflictList, conflictOurs, deniedMutation];
  const assertions = {
    allPiRunsComplete: runs.every((entry) => entry.status === "PASS"),
    statusObserved: status.isError === false && /M file\.txt/u.test(status.output),
    worktreeDiffObserved: worktreeDiff.isError === false && /\+worktree/u.test(worktreeDiff.output),
    stagedDiffObserved: stagedDiff.isError === false && /\+worktree/u.test(stagedDiff.output),
    conflictCatalogObserved: conflictList.isError === false && /conflict\.txt/u.test(conflictList.output) && /\[1,2,3\]/u.test(conflictList.output),
    conflictSideObserved: conflictOurs.isError === false && /ours/u.test(conflictOurs.output),
    mutationSurfaceDenied: deniedMutation.isError === true && /resource_git_uri_invalid/u.test(deniedMutation.output),
    immutableWorkspaceTrust: [status, worktreeDiff, stagedDiff, conflictList, conflictOurs].every((entry) => entry.details?.immutable === true && entry.details?.trust === "WORKSPACE_UNTRUSTED"),
    commandRegistered: command.status === "PASS",
  };
  for (const entry of runs) delete entry.output;
  report = {
    version: 1,
    recordedAt: new Date().toISOString(),
    status: Object.values(assertions).every(Boolean) ? "PASS" : "FAIL",
    measurementMode: "real-pi-process-deterministic-local-provider-pinned-git",
    piVersion: spawnSync(pi, ["--version"], { encoding: "utf8" }).stdout.trim(),
    overdriveUltra: { runs, command, assertions },
    accounting: { deterministicLocalProviderTurns: runs.reduce((sum, entry) => sum + entry.providerTurns, 0), paidModelCalls: 0, externalProviderCalls: 0, networkCalls: 0, cost: 0 },
    scope: { localGit: "RUN", github: "NOT_RUN", githubReason: "No authenticated read-only GitHub client is available; no network or credential probe was attempted." },
    ompReference: { commit: "4267074ac91456866e95ed8de0b6353388f08502", version: "18.1.21", executableStatus: "NOT_RUN", reason: "Bun >=1.4 is unavailable; source inspection is not numeric benchmark evidence." },
  };
} catch (error) {
  report = { version: 1, recordedAt: new Date().toISOString(), status: "FAIL", accounting: { paidModelCalls: 0, externalProviderCalls: 0, networkCalls: 0, cost: 0 }, error: error instanceof Error ? error.message : String(error) };
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (writeResults) fs.writeFileSync(path.join(benchmarkRoot, "git-resources-results.json"), serialized, { mode: 0o600 });
process.stdout.write(serialized);
process.exit(report.status === "PASS" ? 0 : 1);
