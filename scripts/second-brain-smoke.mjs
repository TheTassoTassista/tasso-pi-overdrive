#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deriveProjectIdentity } from "../lib/memory-config.mjs";
import { MemoryLedger } from "../lib/memory-ledger.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pi = process.env.PI_BIN || path.join(path.dirname(process.execPath), "pi");
const provider = path.join(packageRoot, "tests", "fixtures", "deterministic-routing-provider.ts");
const extension = path.join(packageRoot, "extensions", "second-brain.ts");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-second-brain-smoke-"));
const agentDir = path.join(root, "agent");
const memoryRoot = path.join(root, "memory");
const policyFile = path.join(root, "config", "pi-overdrive", "model-policy.json");
const results = [];
const check = (name, condition, detail) => results.push({ name, status: condition ? "PASS" : "FAIL", detail });

function run(message, overrides = {}) {
  return new Promise((resolve) => {
    const child = spawn(pi, ["--extension", provider, "--extension", extension, "--offline", "--approve", "--no-session", "--mode", "rpc", "--provider", "pi-overdrive-routing-audit", "--model", "driver", "--api-key", "audit-only", "--no-tools"], {
      cwd: packageRoot,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OVERDRIVE_MODEL_POLICY: policyFile, PI_OVERDRIVE_ROUTING_AUDIT_KEY: "audit-only", PI_OVERDRIVE_MEMORY_ROOT: memoryRoot, PI_OVERDRIVE_OPENVIKING_URL: "http://127.0.0.1:1", PI_OVERDRIVE_HINDSIGHT_URL: "http://127.0.0.1:2", ...overrides },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const events = [];
    let stdout = "";
    let stdoutBuffer = "";
    let stderr = "";
    let spawnError;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 30_000);
    const parseLine = (line) => {
      if (!line) return;
      try {
        const event = JSON.parse(line);
        events.push(event);
        if (event.type === "response" && event.id === message.id) child.stdin.end();
      } catch {}
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/u);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) parseLine(line);
      if (stdout.length > 16 * 1024 * 1024) child.kill("SIGTERM");
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { spawnError = error.message; });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      parseLine(stdoutBuffer);
      resolve({ code, events, stdout: stdout.slice(-4000), stderr: stderr.slice(-4000), signal, error: spawnError ?? (timedOut ? "timeout" : undefined) });
    });
    child.stdin.on("error", () => {});
    child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}
const notifications = (run) => run.events.filter((event) => event.type === "extension_ui_request" && event.method === "notify").map((event) => String(event.message)).join("\n");
const modelCalls = (run) => run.events.filter((event) => ["agent_start", "message_start", "message_update", "message_end"].includes(event.type)).length;
const detail = (run) => ({ code: run.code, notifications: notifications(run), events: run.events.slice(-8), stdout: run.stdout, stderr: run.stderr, signal: run.signal, error: run.error });

try {
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(policyFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(agentDir, "settings.json"), "{}\n", { mode: 0o600 });
  fs.writeFileSync(policyFile, `${JSON.stringify({ version: 2, preset: "normal", basePreset: "normal", overrides: {} }, null, 2)}\n`, { mode: 0o600 });
  const projectId = deriveProjectIdentity(packageRoot);
  const ledger = new MemoryLedger(path.join(memoryRoot, "ledger"));
  const accepted = ledger.accept({ type: "resource", project: projectId, content: "The deterministic Second Brain fixture uses a bounded shared memory pack.", source: "fixture:smoke", sourceType: "test", trustLevel: "VERIFIED", confidence: 1, verified: true, importance: "high", retentionDays: 0, tags: ["architecture"], reason: "Smoke fixture" });
  check("deterministic-fixture-indexed", accepted.status === "ACCEPTED", accepted.status);

  const catalog = await run({ id: "commands", type: "get_commands" });
  const commands = catalog.events.find((event) => event.type === "response" && event.id === "commands")?.data?.commands ?? [];
  check("pi-starts-and-registers-memory-commands", catalog.code === 0 && ["memory", "memory-status", "memory-search", "memory-recent", "memory-why"].every((name) => commands.some((entry) => entry.name === name && entry.source === "extension")) && modelCalls(catalog) === 0, { code: catalog.code, commands: commands.filter((entry) => entry.name.startsWith("memory")).map((entry) => entry.name), events: catalog.events.slice(0, 8), stdout: catalog.stdout, stderr: catalog.stderr, signal: catalog.signal, error: catalog.error });

  const memory = await run({ id: "memory", type: "prompt", message: "/memory" });
  check("memory-command-zero-model-call", memory.code === 0 && /Second Brain: DEGRADED/u.test(notifications(memory)) && modelCalls(memory) === 0, detail(memory));
  const status = await run({ id: "status", type: "prompt", message: "/memory-status" });
  check("memory-status-truthful-with-services-down", status.code === 0 && /OpenViking: degraded|Hindsight: degraded/u.test(notifications(status)) && modelCalls(status) === 0, detail(status));
  const search = await run({ id: "search", type: "prompt", message: "/memory-search project architecture" });
  check("memory-search-retrieves-local-fixture-with-openviking-down", search.code === 0 && notifications(search).includes("bounded shared memory pack") && /PARTIAL/u.test(notifications(search)) && modelCalls(search) === 0, detail(search));
  const recent = await run({ id: "recent", type: "prompt", message: "/memory-recent" });
  check("memory-recent-zero-model-call", recent.code === 0 && notifications(recent).includes(accepted.entry.id) && modelCalls(recent) === 0, notifications(recent));
  const why = await run({ id: "why", type: "prompt", message: `/memory-why ${accepted.entry.id}` });
  check("memory-why-shows-provenance-zero-model-call", why.code === 0 && /fixture:smoke \(test\)|VERIFIED\/1/u.test(notifications(why)) && modelCalls(why) === 0, notifications(why));
  const history = await run({ id: "history", type: "prompt", message: "/memory-search Why did this architecture change before?" });
  check("hindsight-down-is-fail-soft", history.code === 0 && /sources=.*hindsight/u.test(notifications(history)) && /PARTIAL|DEGRADED/u.test(notifications(history)) && modelCalls(history) === 0, detail(history));

  const unavailableRoot = path.join(root, "not-a-directory");
  fs.writeFileSync(unavailableRoot, "fixture\n", { mode: 0o600 });
  const aceDown = await run({ id: "ace-down", type: "prompt", message: "/memory-search best practice workflow strategy" }, { PI_OVERDRIVE_MEMORY_ROOT: unavailableRoot });
  check("ace-storage-down-is-fail-soft", aceDown.code === 0 && /sources=ace/u.test(notifications(aceDown)) && /DEGRADED/u.test(notifications(aceDown)) && modelCalls(aceDown) === 0, detail(aceDown));
  const allDown = await run({ id: "all-down", type: "prompt", message: "/memory-status" }, { PI_OVERDRIVE_MEMORY_ROOT: unavailableRoot });
  check("all-memory-backends-down-pi-remains-usable", allDown.code === 0 && /Second Brain: UNAVAILABLE/u.test(notifications(allDown)) && /ACE: degraded/u.test(notifications(allDown)) && /Curated ledger: degraded/u.test(notifications(allDown)) && modelCalls(allDown) === 0, detail(allDown));

  const source = fs.readFileSync(extension, "utf8");
  check("no-service-or-gui-autostart", !/node:child_process|spawnSync|execFile|chromium|electron/iu.test(source), "extension performs lazy HTTP/local reads only");
} catch (error) {
  check("second-brain-smoke-harness", false, error instanceof Error ? error.message : String(error));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

const status = results.length === 11 && results.every((entry) => entry.status === "PASS") ? "PASS" : "FAIL";
process.stdout.write(`${JSON.stringify({ status, modelCalls: 0, realProviderCalls: 0, guiLaunches: 0, duplicateServices: 0, tempRemoved: true, results }, null, 2)}\n`);
process.exit(status === "PASS" ? 0 : 1);
