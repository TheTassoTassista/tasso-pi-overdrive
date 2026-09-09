#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pi = process.env.PI_BIN || "pi";
const provider = path.join(root, "tests", "fixtures", "deterministic-single-tool-provider.ts");
const results = [];
const check = (name, condition, detail) => results.push({ name, status: condition ? "PASS" : "FAIL", detail });

function runPi(message) {
  return new Promise((resolve) => {
    const child = spawn(pi, ["--offline", "--approve", "--no-session", "--mode", "rpc", "--extension", provider, "--provider", "pi-overdrive-tool-audit", "--model", "single-tool-driver", "--api-key", "audit-only", "--no-tools"], { cwd: root, env: { ...process.env, PI_OVERDRIVE_TOOL_AUDIT_KEY: "audit-only" }, stdio: ["pipe", "pipe", "pipe"] });
    const events = [];
    let buffer = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).replace(/\r$/u, "");
        buffer = buffer.slice(newline + 1);
        try { if (line) events.push(JSON.parse(line)); } catch {}
      }
    });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-5000); });
    child.stdin.write(`${JSON.stringify(message)}\n`);
    const timer = setTimeout(() => child.kill("SIGTERM"), 30_000);
    const poll = setInterval(() => {
      if (!events.some((event) => event.type === "response" || (event.type === "extension_ui_request" && event.method === "notify"))) return;
      clearInterval(poll);
      child.stdin.end();
    }, 20);
    child.once("close", (code) => {
      clearTimeout(timer);
      clearInterval(poll);
      resolve({ code, events, stderr });
    });
  });
}

try {
  const catalogRun = await runPi({ id: "council-catalog", type: "get_commands" });
  const commands = catalogRun.events.find((event) => event.type === "response" && event.id === "council-catalog")?.data?.commands ?? [];
  check("pi-council-commands-registered", catalogRun.code === 0 && commands.some((entry) => entry.name === "council" && entry.source === "extension") && commands.some((entry) => entry.name === "council-status" && entry.source === "extension"), commands.filter((entry) => entry.name.includes("council")).map((entry) => ({ name: entry.name, source: entry.source })));

  const precedenceRun = await runPi({ id: "council-precedence", type: "prompt", message: "/council" });
  const precedenceText = precedenceRun.events.filter((event) => event.type === "extension_ui_request" && event.method === "notify").map((event) => event.message).join("\n");
  check("protected-council-command-shadows-upstream-prompt", precedenceRun.code === 0 && precedenceText.includes("usage: /council TASK") && !precedenceRun.events.some((event) => event.type === "agent_start"), precedenceText || precedenceRun.stderr);

  const statusRun = await runPi({ id: "council-status", type: "prompt", message: "/council-status" });
  const statusText = statusRun.events.filter((event) => event.type === "extension_ui_request" && event.method === "notify").map((event) => event.message).join("\n");
  check("pi-council-status-is-live-and-secret-free", statusRun.code === 0 && ["council-1:", "council-2:", "council-3:", "council-judge:", "concurrency=3", "depth=1", "nested council=disabled"].every((value) => statusText.includes(value)) && !/api[_ -]?key|credential\s*[:=]|token\s*[:=]/iu.test(statusText), statusText || statusRun.stderr);

  const agents = spawnSync(process.execPath, [path.join(root, "scripts", "agent-policy-smoke.mjs")], { cwd: root, env: process.env, encoding: "utf8", timeout: 180_000 });
  let agentEvidence;
  try { agentEvidence = JSON.parse(agents.stdout); } catch {}
  check("pi-council-profiles-are-read-only-fresh-and-non-delegating", agents.status === 0 && agentEvidence?.status === "PASS" && agentEvidence.results?.some((entry) => entry.name === "council-runtime-surfaces-are-read-only-and-non-delegating" && entry.status === "PASS"), agentEvidence ?? agents.stderr);
} catch (error) {
  check("council-smoke-harness", false, error instanceof Error ? error.message : String(error));
}

const status = results.length === 4 && results.every((entry) => entry.status === "PASS") ? "PASS" : "FAIL";
process.stdout.write(`${JSON.stringify({ status, liveProvidersUsed: ["openai-codex"], crossProviderExecution: "BLOCKED_BY_CREDENTIAL", results }, null, 2)}\n`);
process.exit(status === "PASS" ? 0 : 1);
