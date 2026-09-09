#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntimeWorktree, releaseRuntimeResources } from "../lib/runtime-isolation.mjs";

const pi = process.env.PI_BIN || "pi";
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const providerExtension = path.join(packageRoot, "tests", "fixtures", "deterministic-browser-provider.ts");
const model = "pi-overdrive-browser-audit/browser-driver";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-browser-"));
const repo = path.join(root, "repo");
const runtimeRoot = path.join(root, "runtime");
const worktreeRoot = path.join(root, "worktrees");
const results = [];
let allocation;

function check(name, condition, detail) {
  results.push({ name, status: condition ? "PASS" : "FAIL", detail });
}

function textOf(event) {
  return (event?.result?.content ?? []).filter((item) => item?.type === "text").map((item) => item.text).join("\n");
}

async function runPiBrowser() {
  const url = new URL(`file://${path.join(allocation.worktree, "index.html")}`).href;
  const child = spawn(pi, ["--offline", "--approve", "--no-session", "--mode", "rpc", "--extension", providerExtension, "--provider", "pi-overdrive-browser-audit", "--model", "browser-driver", "--api-key", "audit-only", "--tools", "agent_browser"], {
    cwd: allocation.worktree,
    env: { ...process.env, PI_OVERDRIVE_BROWSER_AUDIT_KEY: "audit-only", PI_OVERDRIVE_BROWSER_SESSION: allocation.browserSession, PI_OVERDRIVE_BROWSER_PROFILE: allocation.browserProfile, PI_OVERDRIVE_BROWSER_URL: url, PI_OVERDRIVE_RUNTIME_ROOT: runtimeRoot, PI_OVERDRIVE_WORKTREE_ROOT: worktreeRoot, XDG_STATE_HOME: path.join(root, "state") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events = [];
  const waiters = new Set();
  let buffer = "";
  let stderr = "";
  const receive = (event) => {
    events.push(event);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(event)) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.resolve(event);
      }
    }
  };
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/u, "");
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try { receive(JSON.parse(line)); } catch { receive({ type: "invalid_json" }); }
    }
  });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8000); });
  const waitFor = (predicate, label, timeoutMs) => {
    const prior = events.find(predicate);
    if (prior) return Promise.resolve(prior);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: setTimeout(() => { waiters.delete(waiter); reject(new Error(`Timed out waiting for ${label}. ${stderr}`)); }, timeoutMs) };
      waiters.add(waiter);
    });
  };
  const prompt = "Run the deterministic isolated-browser audit supplied by the local audit provider.";
  child.stdin.write(`${JSON.stringify({ id: "browser", type: "prompt", message: prompt })}\n`);
  const accepted = await waitFor((event) => event.type === "response" && event.id === "browser", "prompt acceptance", 30000);
  await waitFor((event) => event.type === "agent_settled", "browser settlement", 8 * 60 * 1000);
  child.stdin.end();
  await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGTERM"); resolve(); }, 5000);
    child.once("close", () => { clearTimeout(timer); resolve(); });
  });
  return { accepted, events, stderr };
}

try {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "index.html"), "<!doctype html><html><head><title>Overdrive isolated browser</title></head><body><main><button id=proof>OVERDRIVE_BROWSER_OK</button></main></body></html>\n");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Pi Browser Audit"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "pi-browser@invalid"], { cwd: repo });
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "browser fixture"], { cwd: repo });
  allocation = await createRuntimeWorktree(repo, { stateRoot: runtimeRoot, shareRoot: worktreeRoot });
  const invocation = await runPiBrowser();
  check("pi-browser-prompt-accepted", invocation.accepted.success === true, invocation.accepted.success);
  const starts = invocation.events.filter((event) => event.type === "tool_execution_start" && event.toolName === "agent_browser");
  const ends = invocation.events.filter((event) => event.type === "tool_execution_end" && event.toolName === "agent_browser");
  check("browser-three-real-calls", starts.length === 3 && ends.length === 3, { starts: starts.length, ends: ends.length });
  check("browser-isolated-profile-input", starts[0]?.args?.sessionMode === "fresh" && starts[0]?.args?.args?.includes(allocation.browserProfile) && starts.every((event) => event.args?.args?.includes(allocation.browserSession)), starts.map((event) => event.args));
  check("browser-calls-succeed", ends.length === 3 && ends.every((event) => event.isError !== true), ends.map((event) => ({ isError: event.isError, text: textOf(event).slice(0, 300) })));
  check("browser-inspects-test-page", /OVERDRIVE_BROWSER_OK/u.test(textOf(ends[1])), textOf(ends[1]).slice(0, 700));
  const profileEntries = fs.existsSync(allocation.browserProfile) ? fs.readdirSync(allocation.browserProfile) : [];
  check("browser-profile-materialized", profileEntries.length > 0, profileEntries.slice(0, 20));
} catch (error) {
  check("browser-runtime-harness", false, error instanceof Error ? error.message : String(error));
} finally {
  if (allocation?.browserSession) spawnSync("agent-browser", ["--session", allocation.browserSession, "close"], { encoding: "utf8" });
  if (allocation?.allocationId) {
    try { releaseRuntimeResources(allocation.allocationId, { stateRoot: runtimeRoot, shareRoot: worktreeRoot }); } catch {}
  }
  if (allocation?.worktree && fs.existsSync(allocation.worktree)) spawnSync("git", ["-C", repo, "worktree", "remove", "--force", allocation.worktree], { encoding: "utf8" });
  fs.rmSync(root, { recursive: true, force: true });
}

const status = results.length >= 5 && results.every((item) => item.status === "PASS") ? "PASS" : "FAIL";
process.stdout.write(`${JSON.stringify({ status, model, results }, null, 2)}\n`);
process.exit(status === "PASS" ? 0 : 1);
