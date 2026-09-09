#!/usr/bin/env node
import { spawn } from "node:child_process";

const pi = process.env.PI_BIN || "pi";
const model = process.env.PI_SMOKE_MODEL || "openai-codex/gpt-5.6-luna";

async function measure(label, extraArgs = []) {
  const started = Date.now();
  const child = spawn(pi, ["--offline", "--approve", "--no-session", "--mode", "rpc", "--model", model, "--thinking", "low", ...extraArgs], { cwd: process.cwd(), env: process.env, stdio: ["pipe", "pipe", "pipe"] });
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
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-5000); });
  const waitFor = (predicate, target, timeoutMs) => {
    const prior = events.find(predicate);
    if (prior) return Promise.resolve(prior);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: setTimeout(() => { waiters.delete(waiter); reject(new Error(`Timed out waiting for ${target}. ${stderr}`)); }, timeoutMs) };
      waiters.add(waiter);
    });
  };
  try {
    child.stdin.write(`${JSON.stringify({ id: label, type: "prompt", message: "Reply with exactly OK. Do not call tools." })}\n`);
    const accepted = await waitFor((event) => event.type === "response" && event.id === label, "prompt acceptance", 30000);
    const ended = await waitFor((event) => event.type === "agent_end", "agent end", 180000);
    await waitFor((event) => event.type === "agent_settled", "agent settlement", 180000);
    const assistant = [...(ended.messages ?? [])].reverse().find((message) => message.role === "assistant");
    return {
      label,
      status: accepted.success === true && assistant?.stopReason === "stop" ? "PASS" : "FAIL",
      runtimeMs: Date.now() - started,
      inputTokens: assistant?.usage?.input ?? null,
      outputTokens: assistant?.usage?.output ?? null,
      cacheReadTokens: assistant?.usage?.cacheRead ?? null,
      cacheWriteTokens: assistant?.usage?.cacheWrite ?? null,
      cost: assistant?.usage?.cost?.total ?? assistant?.usage?.cost ?? null,
      stopReason: assistant?.stopReason ?? null,
    };
  } finally {
    child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGTERM"); resolve(); }, 3000);
      child.once("close", () => { clearTimeout(timer); resolve(); });
    });
  }
}

let report;
try {
  const noTools = await measure("no-tools-control", ["--no-tools"]);
  const readOnly = await measure("read-only", ["--tools", "read"]);
  const editorCore = await measure("editor-core", ["--tools", "read,edit,write"]);
  const workflow = await measure("workflow-only", ["--tools", "secure_coding_workflow"]);
  const notebook = await measure("notebook-only", ["--tools", "task_notebook"]);
  const verification = await measure("verification-only", ["--tools", "verification_gate"]);
  const defaultSurface = await measure("default-core-tools");
  const measurements = [noTools, readOnly, editorCore, workflow, notebook, verification, defaultSurface];
  report = {
    status: measurements.every((entry) => entry.status === "PASS") ? "PASS" : "FAIL",
    model,
    configuredDefaultToolCount: 6,
    measurements,
    measuredToolSchemaDeltaTokens: Number.isFinite(defaultSurface.inputTokens) && Number.isFinite(noTools.inputTokens) ? defaultSurface.inputTokens - noTools.inputTokens : null,
  };
} catch (error) {
  report = { status: "FAIL", model, error: error instanceof Error ? error.message : String(error) };
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(report.status === "PASS" ? 0 : 1);
