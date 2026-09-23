#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupRuntimeResources, createRuntimeWorktree } from "../lib/runtime-isolation.mjs";

const pi = process.env.PI_BIN || "pi";
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const providerExtension = path.join(packageRoot, "tests", "fixtures", "deterministic-browser-provider.ts");
const model = "pi-overdrive-browser-audit/browser-driver";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-browser-"));
const repo = path.join(root, "repo");
const runtimeRoot = path.join(root, "runtime");
const worktreeRoot = path.join(root, "worktrees");
const agentDir = path.join(root, "agent");
const modelPolicy = path.join(root, "model-policy.json");
const harnessProfiles = path.join(root, "model-harness-profiles.json");
const results = [];
let allocation;
let server;

function check(name, condition, detail) {
  results.push({ name, status: condition ? "PASS" : "FAIL", detail });
}

function textOf(event) {
  return (event?.result?.content ?? []).filter((item) => item?.type === "text").map((item) => item.text).join("\n");
}

async function runPiBrowser(negative = false) {
  const url = `http://127.0.0.1:${allocation.port}/`;
  const child = spawn(pi, ["--offline", "--approve", "--no-session", "--mode", "rpc", "--extension", providerExtension, "--provider", "pi-overdrive-browser-audit", "--model", "browser-driver", "--api-key", "audit-only", "--tools", "agent_browser"], {
    cwd: allocation.worktree,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OVERDRIVE_MODEL_POLICY: modelPolicy, PI_OVERDRIVE_MODEL_HARNESS_PROFILES: harnessProfiles, PI_OVERDRIVE_BROWSER_AUDIT_KEY: "audit-only", PI_OVERDRIVE_BROWSER_NEGATIVE: negative ? "1" : "0", PI_OVERDRIVE_BROWSER_SESSION: allocation.browserSession, PI_OVERDRIVE_BROWSER_PROFILE: allocation.browserProfile, PI_OVERDRIVE_BROWSER_CAPTURE: path.join(allocation.stateDir, "browser-capture.png"), PI_OVERDRIVE_BROWSER_URL: url, PI_OVERDRIVE_RUNTIME_ROOT: runtimeRoot, PI_OVERDRIVE_WORKTREE_ROOT: worktreeRoot, XDG_STATE_HOME: path.join(root, "state") },
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
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const browserPackage = path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "pi-agent-browser-native");
  if (!fs.existsSync(path.join(browserPackage, "package.json"))) throw new Error("pinned browser plugin is not installed");
  fs.writeFileSync(path.join(agentDir, "settings.json"), `${JSON.stringify({ packages: [{ source: packageRoot, extensions: ["-extensions/mcp.ts"] }, { source: browserPackage }] }, null, 2)}\n`, { mode: 0o600 });
  fs.copyFileSync(path.join(packageRoot, "config", "model-policy.json"), modelPolicy);
  const profiles = JSON.parse(fs.readFileSync(path.join(packageRoot, "config", "model-harness-profiles.json"), "utf8"));
  profiles.providers["pi-overdrive-browser-audit"] = { id: "deterministic-browser-fixture-v1", toolConstraints: { deniedTools: [] }, editContracts: { ordinary: ["HASH_ANCHORED", "REPLACE"], structural: ["AST_STRUCTURAL", "HASH_ANCHORED"], maxFallbacks: 1 } };
  fs.writeFileSync(harnessProfiles, `${JSON.stringify(profiles, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(repo, "index.html"), '<!doctype html><html><head><title>Overdrive isolated browser</title></head><body><main><label>Name <input id="name"></label><button id="submit" onclick="document.querySelector(\'#result\').textContent=\'OVERDRIVE_BROWSER_SUBMITTED:\'+document.querySelector(\'#name\').value">Submit</button><p id="result">OVERDRIVE_BROWSER_READY</p></main></body></html>\n');
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Pi Browser Audit"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "pi-browser@invalid"], { cwd: repo });
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "browser fixture"], { cwd: repo });
  allocation = await createRuntimeWorktree(repo, { stateRoot: runtimeRoot, shareRoot: worktreeRoot });
  server = createServer((request, response) => {
    if (request.url !== "/") { response.writeHead(404).end(); return; }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(fs.readFileSync(path.join(allocation.worktree, "index.html")));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(allocation.port, "127.0.0.1", resolve); });
  const negative = await runPiBrowser(true);
  const denied = negative.events.filter((event) => event.type === "tool_execution_end" && event.toolName === "agent_browser");
  const negativeEnd = [...negative.events].reverse().find((event) => event.type === "agent_end");
  const negativeResult = negativeEnd?.messages?.find((message) => message.role === "toolResult");
  check("browser-real-pi-eval-denied", negative.accepted.success === true && denied.length === 1 && negativeResult?.isError === true && /Browser runtime isolation denied/u.test(textOf({ result: negativeResult })) && fs.readdirSync(allocation.browserProfile).length === 0, { denied: denied.length, isError: negativeResult?.isError, profileEntries: fs.readdirSync(allocation.browserProfile).length });
  const invocation = await runPiBrowser();
  check("pi-browser-prompt-accepted", invocation.accepted.success === true, invocation.accepted.success);
  const starts = invocation.events.filter((event) => event.type === "tool_execution_start" && event.toolName === "agent_browser");
  const ends = invocation.events.filter((event) => event.type === "tool_execution_end" && event.toolName === "agent_browser");
  check("browser-eight-real-calls", starts.length === 8 && ends.length === 8, { starts: starts.length, ends: ends.length, events: invocation.events.map((event) => ({ type: event.type, toolName: event.toolName, reason: event.reason, role: event.message?.role, stopReason: event.message?.stopReason, errorMessage: typeof event.message?.errorMessage === "string" ? event.message.errorMessage.slice(0, 180) : undefined })).slice(0, 30), stderrClass: /error|failed|denied/iu.test(invocation.stderr) ? "error_present" : "none" });
  check("browser-isolated-profile-input", starts[0]?.args?.sessionMode === "fresh" && starts[0]?.args?.args?.includes(allocation.browserProfile) && starts.every((event) => event.args?.args?.includes(allocation.browserSession)), starts.map((event) => event.args));
  check("browser-calls-succeed", ends.length === 8 && ends.every((event) => event.isError !== true), ends.map((event) => ({ isError: event.isError, text: textOf(event).slice(0, 300) })));
  check("browser-inspects-test-page", /textbox "Name/u.test(textOf(ends[1])) && /button "Submit"/u.test(textOf(ends[1])) && /^OVERDRIVE_BROWSER_SUBMITTED:Tasso\n/u.test(textOf(ends[5])), { before: textOf(ends[1]).slice(0, 700), after: textOf(ends[5]).slice(0, 700) });
  const capture = path.join(allocation.stateDir, "browser-capture.png");
  check("browser-private-screenshot", fs.existsSync(capture) && fs.readFileSync(capture).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), fs.existsSync(capture) ? fs.statSync(capture).size : 0);
  const profileEntries = fs.existsSync(allocation.browserProfile) ? fs.readdirSync(allocation.browserProfile) : [];
  check("browser-profile-materialized", profileEntries.length > 0, profileEntries.slice(0, 20));
} catch (error) {
  check("browser-runtime-harness", false, error instanceof Error ? error.message : String(error));
} finally {
  if (allocation?.browserSession) spawnSync("agent-browser", ["--session", allocation.browserSession, "close"], { encoding: "utf8" });
  if (server) await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  if (allocation?.allocationId) {
    try {
      cleanupRuntimeResources(allocation.allocationId, { stateRoot: runtimeRoot, shareRoot: worktreeRoot });
      check("browser-worktree-runtime-cleanup", !fs.existsSync(allocation.worktree) && !fs.existsSync(path.dirname(allocation.stateDir)) && !fs.existsSync(allocation.portReservation), { worktree: fs.existsSync(allocation.worktree), allocation: fs.existsSync(path.dirname(allocation.stateDir)), port: fs.existsSync(allocation.portReservation) });
    } catch (error) { check("browser-worktree-runtime-cleanup", false, error instanceof Error ? error.message : String(error)); }
    const residual = spawnSync("pgrep", ["-af", allocation.browserProfile], { encoding: "utf8" });
    check("browser-process-cleanup", residual.status === 1, { status: residual.status, count: residual.stdout?.trim() ? residual.stdout.trim().split("\n").length : 0 });
  }
  fs.rmSync(root, { recursive: true, force: true });
  check("browser-temporary-cleanup", !fs.existsSync(root), fs.existsSync(root));
}

const status = results.length >= 5 && results.every((item) => item.status === "PASS") ? "PASS" : "FAIL";
process.stdout.write(`${JSON.stringify({ status, model, results }, null, 2)}\n`);
process.exit(status === "PASS" ? 0 : 1);
