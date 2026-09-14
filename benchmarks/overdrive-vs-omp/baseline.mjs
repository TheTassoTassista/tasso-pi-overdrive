#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const benchmarkRoot = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(benchmarkRoot, "../..");
const provider = path.join(packageRoot, "tests", "fixtures", "deterministic-single-tool-provider.ts");
const pi = process.env.PI_BIN ?? "pi";
const writeResults = process.argv.includes("--write-results");
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-ultra-baseline-"));

function trackedPackageSize() {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: packageRoot })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  return {
    trackedFiles: files.length,
    trackedBytes: files.reduce((total, relative) => total + fs.statSync(path.join(packageRoot, relative)).size, 0),
  };
}

function processTreeSnapshot(rootPid) {
  const processes = new Map();
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      const pid = Number(entry);
      const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const status = fs.readFileSync(`/proc/${entry}/status`, "utf8");
      const rss = Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/mu)?.[1] ?? 0);
      processes.set(pid, { ppid: Number(fields[1]), rssKiB: rss });
    } catch {}
  }
  const selected = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, process] of processes) {
      if (!selected.has(pid) && selected.has(process.ppid)) {
        selected.add(pid);
        changed = true;
      }
    }
  }
  return {
    processCount: [...selected].filter((pid) => processes.has(pid)).length,
    rssKiB: [...selected].reduce((total, pid) => total + (processes.get(pid)?.rssKiB ?? 0), 0),
  };
}

function contentText(message) {
  return (message?.content ?? [])
    .filter((entry) => entry?.type === "text")
    .map((entry) => entry.text ?? "")
    .join("");
}

async function runPiTool(label, tool, args) {
  const started = performance.now();
  const child = spawn(pi, [
    "--offline", "--approve", "--no-session", "--mode", "rpc",
    "--extension", provider,
    "--provider", "pi-overdrive-tool-audit",
    "--api-key", "audit-only",
    "--model", "pi-overdrive-tool-audit/single-tool-driver",
    "--thinking", "low",
    "--tools", tool,
  ], {
    cwd: fixtureRoot,
    env: {
      ...process.env,
      PI_OVERDRIVE_TOOL_AUDIT_KEY: "audit-only",
      PI_OVERDRIVE_AUDIT_TOOL: tool,
      PI_OVERDRIVE_AUDIT_TOOL_ARGS: JSON.stringify(args),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events = [];
  let buffer = "";
  let stderr = "";
  let peakProcessCount = 0;
  let peakRssKiB = 0;
  const sample = () => {
    const snapshot = processTreeSnapshot(child.pid);
    peakProcessCount = Math.max(peakProcessCount, snapshot.processCount);
    peakRssKiB = Math.max(peakRssKiB, snapshot.rssKiB);
  };
  const sampler = setInterval(sample, 10);
  const settled = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${label}: rpc timeout: ${stderr}`)), 45_000);
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
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  try {
    child.stdin.write(`${JSON.stringify({ id: label, type: "prompt", message: "Run the deterministic benchmark tool call." })}\n`);
    await settled;
  } finally {
    clearInterval(sampler);
    sample();
    child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGTERM"); resolve(); }, 3000);
      child.once("close", () => { clearTimeout(timer); resolve(); });
    });
  }
  const ended = [...events].reverse().find((event) => event.type === "agent_end");
  const messages = ended?.messages ?? [];
  const toolResult = [...messages].reverse().find((message) => message.role === "toolResult");
  const output = contentText(toolResult);
  return {
    label,
    tool,
    elapsedMs: Number((performance.now() - started).toFixed(3)),
    requestChars: JSON.stringify(args).length,
    outputChars: output.length,
    isError: toolResult?.isError === true,
    assistantTurns: messages.filter((message) => message.role === "assistant").length,
    peakProcessCount,
    peakRssKiB,
    outputDigest: output ? await crypto.subtle.digest("SHA-256", new TextEncoder().encode(output)).then((value) => Buffer.from(value).toString("hex")) : null,
  };
}

let report;
try {
  const large = Array.from({ length: 5000 }, (_, index) => `${String(index + 1).padStart(4, "0")} fixture line with SEARCH_MARKER_${index % 5}`).join("\n");
  fs.writeFileSync(path.join(fixtureRoot, "large.txt"), `${large}\n`);
  fs.writeFileSync(path.join(fixtureRoot, "edit.txt"), "before\nstable\n");
  const read = await runPiTool("read-200-lines", "read", { path: "large.txt", offset: 1, limit: 200 });
  const search = await runPiTool("grep-50-results", "grep", { pattern: "SEARCH_MARKER_1", path: ".", limit: 50 });
  const edit = await runPiTool("exact-edit", "edit", { path: "edit.txt", edits: [{ oldText: "before", newText: "after" }] });
  const stale = await runPiTool("stale-edit", "edit", { path: "edit.txt", edits: [{ oldText: "before", newText: "corrupt" }] });
  const finalEditContents = fs.readFileSync(path.join(fixtureRoot, "edit.txt"), "utf8");
  const measurements = [read, search, edit, stale];
  report = {
    version: 1,
    recordedAt: new Date().toISOString(),
    overdrive: {
      baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: packageRoot, encoding: "utf8" }).trim(),
      piVersion: execFileSync(pi, ["--version"], { encoding: "utf8" }).trim(),
      package: trackedPackageSize(),
      paidModelCalls: 0,
      deterministicProviderTurns: measurements.reduce((total, entry) => total + entry.assistantTurns, 0),
      toolCalls: measurements.length,
      measurements,
      assertions: {
        readBounded: !read.isError && read.outputChars > 0,
        searchBounded: !search.isError && search.outputChars > 0,
        exactEditCorrect: !edit.isError && finalEditContents === "after\nstable\n",
        staleEditRejected: stale.isError && finalEditContents === "after\nstable\n",
      },
    },
    ompReference: {
      commit: "4267074ac91456866e95ed8de0b6353388f08502",
      version: "18.1.21",
      license: "MIT",
      executableStatus: "NOT_RUN",
      reason: "Bun >=1.4 is not installed; no numeric OMP result is inferred from source inspection.",
    },
  };
  report.status = Object.values(report.overdrive.assertions).every(Boolean) ? "PASS" : "FAIL";
} catch (error) {
  report = { version: 1, recordedAt: new Date().toISOString(), status: "FAIL", paidModelCalls: 0, error: error instanceof Error ? error.message : String(error) };
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (writeResults) fs.writeFileSync(path.join(benchmarkRoot, "baseline-results.json"), serialized, { mode: 0o600 });
process.stdout.write(serialized);
process.exit(report.status === "PASS" ? 0 : 1);
