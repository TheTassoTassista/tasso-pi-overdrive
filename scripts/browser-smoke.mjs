#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupRuntimeResources, createRuntimeWorktree } from "../lib/runtime-isolation.mjs";
import { inspectProcessIdentity } from "../lib/process-identity.mjs";

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
let sentinel;
let sentinelRequests = 0;
let runnerIdentity;

function check(name, condition, detail) {
  results.push({ name, status: condition ? "PASS" : "FAIL", detail });
}

function textOf(event) {
  return (event?.result?.content ?? []).filter((item) => item?.type === "text").map((item) => item.text).join("\n");
}

async function runPiBrowser(negative = false, native = false) {
  const url = `http://127.0.0.1:${allocation.port}/`;
  const child = spawn(pi, ["--offline", "--approve", "--no-session", "--mode", "rpc", "--extension", providerExtension, "--provider", "pi-overdrive-browser-audit", "--model", "browser-driver", "--api-key", "audit-only", "--tools", native ? "agent_browser" : "browser_engine"], {
    cwd: allocation.worktree,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OVERDRIVE_MODEL_POLICY: modelPolicy, PI_OVERDRIVE_MODEL_HARNESS_PROFILES: harnessProfiles, PI_OVERDRIVE_BROWSER_AUDIT_KEY: "audit-only", PI_OVERDRIVE_BROWSER_SENTINEL_TOKEN: "must-not-reach-runner", PI_OVERDRIVE_BROWSER_TOOL: native ? "agent_browser" : "browser_engine", PI_OVERDRIVE_BROWSER_NEGATIVE: negative ? "1" : "0", PI_OVERDRIVE_BROWSER_SESSION: allocation.browserSession, PI_OVERDRIVE_BROWSER_PROFILE: allocation.browserProfile, PI_OVERDRIVE_BROWSER_CAPTURE: path.join(allocation.stateDir, "browser-capture.png"), PI_OVERDRIVE_BROWSER_URL: url, PI_OVERDRIVE_RUNTIME_ROOT: runtimeRoot, PI_OVERDRIVE_WORKTREE_ROOT: worktreeRoot, XDG_STATE_HOME: path.join(root, "state") },
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
  if (JSON.parse(fs.readFileSync(path.join(browserPackage, "package.json"), "utf8")).version !== "0.6.6") throw new Error("browser plugin version pin mismatch");
  fs.writeFileSync(path.join(agentDir, "settings.json"), `${JSON.stringify({ packages: [{ source: packageRoot, extensions: ["-extensions/mcp.ts"] }, { source: browserPackage }] }, null, 2)}\n`, { mode: 0o600 });
  fs.copyFileSync(path.join(packageRoot, "config", "model-policy.json"), modelPolicy);
  const profiles = JSON.parse(fs.readFileSync(path.join(packageRoot, "config", "model-harness-profiles.json"), "utf8"));
  profiles.providers["pi-overdrive-browser-audit"] = { id: "deterministic-browser-fixture-v1", toolConstraints: { deniedTools: [] }, editContracts: { ordinary: ["HASH_ANCHORED", "REPLACE"], structural: ["AST_STRUCTURAL", "HASH_ANCHORED"], maxFallbacks: 1 } };
  fs.writeFileSync(harnessProfiles, `${JSON.stringify(profiles, null, 2)}\n`, { mode: 0o600 });
  sentinel = createServer((_request, response) => { sentinelRequests += 1; response.writeHead(200).end("SENTINEL_REACHED"); });
  await new Promise((resolve, reject) => { sentinel.once("error", reject); sentinel.listen(0, "127.0.0.1", resolve); });
  const sentinelPort = sentinel.address().port;
  const control = await fetch(`http://127.0.0.1:${sentinelPort}/host-control`);
  check("browser-host-sentinel-control", control.status === 200 && sentinelRequests === 1, { status: control.status, requests: sentinelRequests });
  sentinelRequests = 0;
  fs.writeFileSync(path.join(repo, "index.html"), `<!doctype html><html><head><title>Overdrive isolated browser</title></head><body><main><label>Name <input id="name"></label><button id="submit" onclick="document.querySelector('#result').textContent='OVERDRIVE_BROWSER_SUBMITTED:'+document.querySelector('#name').value">Submit</button><p id="result">OVERDRIVE_BROWSER_READY</p><p id="network-result">PENDING</p><img src="http://127.0.0.1:${sentinelPort}/forbidden-image"><script>fetch('http://127.0.0.1:${sentinelPort}/forbidden-fetch').then(()=>document.querySelector('#network-result').textContent='SENTINEL_REACHED').catch(()=>document.querySelector('#network-result').textContent='OVERDRIVE_NETWORK_BLOCKED')</script></main></body></html>\n`);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Pi Browser Audit"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "pi-browser@invalid"], { cwd: repo });
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "browser fixture"], { cwd: repo });
  allocation = await createRuntimeWorktree(repo, { stateRoot: runtimeRoot, shareRoot: worktreeRoot });
  const negative = await runPiBrowser(true);
  const denied = negative.events.filter((event) => event.type === "tool_execution_end" && event.toolName === "browser_engine");
  const negativeEnd = [...negative.events].reverse().find((event) => event.type === "agent_end");
  const negativeResult = negativeEnd?.messages?.find((message) => message.role === "toolResult");
  check("browser-real-pi-eval-denied", negative.accepted.success === true && denied.length === 1 && negativeResult?.isError === true && fs.readdirSync(allocation.browserProfile).length === 0, { denied: denied.length, isError: negativeResult?.isError, profileEntries: fs.readdirSync(allocation.browserProfile).length });
  const nativeNegative = await runPiBrowser(true, true);
  const nativeDenied = nativeNegative.events.filter((event) => event.type === "tool_execution_end" && event.toolName === "agent_browser");
  check("browser-native-allocation-path-blocked", nativeNegative.accepted.success === true && nativeDenied.length === 1 && nativeDenied[0].isError === true && fs.readdirSync(allocation.browserProfile).length === 0, { denied: nativeDenied.length, isError: nativeDenied[0]?.isError, profileEntries: fs.readdirSync(allocation.browserProfile).length });
  const invocation = await runPiBrowser();
  check("pi-browser-prompt-accepted", invocation.accepted.success === true, invocation.accepted.success);
  const starts = invocation.events.filter((event) => event.type === "tool_execution_start" && event.toolName === "browser_engine");
  const ends = invocation.events.filter((event) => event.type === "tool_execution_end" && event.toolName === "browser_engine");
  const metadata = ends.map((event) => { try { return JSON.parse(textOf(event).split("\n", 1)[0]); } catch { return {}; } });
  runnerIdentity = metadata[0]?.runnerIdentity;
  check("browser-single-network-namespace", metadata.length === 10 && metadata.every((item) => item.networkNamespace === metadata[0]?.networkNamespace && item.sandboxed === true && item.externalNetwork === false) && metadata[0]?.networkNamespace !== fs.readlinkSync("/proc/self/ns/net"), { namespaces: [...new Set(metadata.map((item) => item.networkNamespace))], hostNamespace: fs.readlinkSync("/proc/self/ns/net") });
  check("browser-single-chromium-process", metadata.length === 10 && Number.isSafeInteger(metadata[0]?.chromiumIdentity?.pid) && metadata.every((item) => item.chromiumIdentity?.pid === metadata[0]?.chromiumIdentity?.pid && item.chromiumIdentity?.startTicks === metadata[0]?.chromiumIdentity?.startTicks), { chromiumIdentities: [...new Set(metadata.map((item) => JSON.stringify(item.chromiumIdentity)))] });
  check("browser-scrubbed-environment", metadata.length === 10 && metadata.every((item) => item.ambientSecrets === false && item.hostHomeVisible === false), metadata.map((item) => ({ ambientSecrets: item.ambientSecrets, hostHomeVisible: item.hostHomeVisible })));
  check("browser-ten-real-calls", starts.length === 10 && ends.length === 10, { starts: starts.length, ends: ends.length, events: invocation.events.map((event) => ({ type: event.type, toolName: event.toolName, reason: event.reason, role: event.message?.role, stopReason: event.message?.stopReason, errorMessage: typeof event.message?.errorMessage === "string" ? event.message.errorMessage.slice(0, 180) : undefined })).slice(0, 30), stderrClass: /error|failed|denied/iu.test(invocation.stderr) ? "error_present" : "none" });
  check("browser-isolated-profile-input", starts[0]?.args?.sessionMode === "fresh" && starts[0]?.args?.args?.includes(allocation.browserProfile) && starts.every((event) => event.args?.args?.includes(allocation.browserSession)), starts.map((event) => event.args));
  check("browser-calls-succeed", ends.length === 10 && ends.every((event) => event.isError !== true), ends.map((event) => ({ isError: event.isError, text: textOf(event).slice(0, 300) })));
  check("browser-inspects-test-page", /textbox "Name/u.test(textOf(ends[1])) && /button "Submit"/u.test(textOf(ends[1])) && /\nOVERDRIVE_BROWSER_SUBMITTED:Tasso\n/u.test(textOf(ends[5])), { before: textOf(ends[1]).slice(0, 700), after: textOf(ends[5]).slice(0, 700) });
  check("browser-networkless-subresource", /OVERDRIVE_NETWORK_BLOCKED/u.test(textOf(ends[7])) && sentinelRequests === 0, { result: textOf(ends[7]).slice(0, 300), sentinelRequests });
  const capture = fs.readdirSync(allocation.stateDir).filter((name) => /^browser-[0-9a-f]{64}\.png$/u.test(name));
  const captureStat = capture.length === 1 ? fs.lstatSync(path.join(allocation.stateDir, capture[0])) : undefined;
  check("browser-private-screenshot", capture.length === 1 && fs.readFileSync(path.join(allocation.stateDir, capture[0])).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && captureStat.isFile() && captureStat.nlink === 1 && (captureStat.mode & 0o077) === 0 && metadata[8]?.screenshot?.digest === capture[0].slice(8, -4) && !JSON.stringify(metadata[8]).includes(allocation.stateDir), { capture, bytes: captureStat?.size, mode: captureStat?.mode & 0o777 });
  const profileEntries = fs.existsSync(allocation.browserProfile) ? fs.readdirSync(allocation.browserProfile) : [];
  check("browser-profile-materialized", profileEntries.length > 0, profileEntries.slice(0, 20));
} catch (error) {
  check("browser-runtime-harness", false, error instanceof Error ? error.message : String(error));
} finally {
  if (sentinel) await new Promise((resolve) => { sentinel.closeAllConnections(); sentinel.close(resolve); });
  if (allocation?.allocationId) {
    try {
      cleanupRuntimeResources(allocation.allocationId, { stateRoot: runtimeRoot, shareRoot: worktreeRoot });
      check("browser-worktree-runtime-cleanup", !fs.existsSync(allocation.worktree) && !fs.existsSync(path.dirname(allocation.stateDir)) && !fs.existsSync(allocation.portReservation), { worktree: fs.existsSync(allocation.worktree), allocation: fs.existsSync(path.dirname(allocation.stateDir)), port: fs.existsSync(allocation.portReservation) });
    } catch (error) { check("browser-worktree-runtime-cleanup", false, error instanceof Error ? error.message : String(error)); }
    const residual = spawnSync("pgrep", ["-af", allocation.browserProfile], { encoding: "utf8" });
    check("browser-process-cleanup", !!runnerIdentity && inspectProcessIdentity(runnerIdentity).alive === false && residual.status === 1, { runnerAlive: runnerIdentity ? inspectProcessIdentity(runnerIdentity).alive : null, profileProcessStatus: residual.status });
  }
  fs.rmSync(root, { recursive: true, force: true });
  check("browser-temporary-cleanup", !fs.existsSync(root), fs.existsSync(root));
}

const status = results.length >= 5 && results.every((item) => item.status === "PASS") ? "PASS" : "FAIL";
process.stdout.write(`${JSON.stringify({ status, model, results }, null, 2)}\n`);
process.exit(status === "PASS" ? 0 : 1);
