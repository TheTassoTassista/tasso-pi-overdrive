#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pi = process.env.PI_BIN || "pi";
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const provider = path.join(packageRoot, "tests", "fixtures", "deterministic-single-tool-provider.ts");
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-agent-policy-"));
const results = [];
const check = (name, condition, detail) => results.push({ name, status: condition ? "PASS" : "FAIL", detail });

try {
  const child = spawn(pi, ["--offline", "--approve", "--no-session", "--mode", "rpc", "--extension", provider, "--provider", "pi-overdrive-tool-audit", "--model", "single-tool-driver", "--api-key", "audit-only", "--tools", "subagent"], {
    cwd: packageRoot,
    env: {
      ...process.env,
      PI_OVERDRIVE_TOOL_AUDIT_KEY: "audit-only",
      PI_OVERDRIVE_AUDIT_TOOL: "subagent",
      PI_OVERDRIVE_AUDIT_TOOL_ARGS: JSON.stringify({ action: "list", capabilities: true }),
      XDG_STATE_HOME: stateRoot,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
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
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-6000); });
  child.stdin.write(`${JSON.stringify({ id: "agent-policy", type: "prompt", message: "Run the deterministic agent policy audit." })}\n`);
  const deadline = Date.now() + 120000;
  while (!events.some((event) => event.type === "agent_settled") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  child.stdin.end();
  await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGTERM"); resolve(); }, 3000);
    child.once("close", () => { clearTimeout(timer); resolve(); });
  });
  const event = events.find((item) => item.type === "tool_execution_end" && item.toolName === "subagent");
  const text = (event?.result?.content ?? []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
  const details = event?.result?.details;
  const serialized = JSON.stringify(details ?? text);
  const expected = ["scout", "planner", "oracle", "worker", "tester", "correctness-reviewer", "security-reviewer", "simplicity-reviewer"];
  check("subagent-capability-call-succeeded", event?.isError === false, event ? { isError: event.isError } : stderr || "missing tool result");
  check("all-eight-agents-discovered", expected.every((agent) => serialized.includes(`\"${agent}\"`) || serialized.includes(agent)), expected);
  check("tester-runtime-surface-is-read-only", serialized.includes("tester") && !/^tools:.*\b(?:bash|safe_exec|safe_remove_file|edit|write)\b/mu.test(fs.readFileSync(path.join(packageRoot, "agents", "tester.md"), "utf8")), "Tester definition excludes mutation and general command tools; runtime capability listing loaded it");
  check("worker-runtime-surface-has-no-shell", serialized.includes("worker") && !/^tools:.*\bbash\b/mu.test(fs.readFileSync(path.join(packageRoot, "agents", "worker.md"), "utf8")), "Worker definition excludes bash; runtime capability listing loaded it");
  const autonomousDefinitions = ["worker", "tester"].map((name) => fs.readFileSync(path.join(packageRoot, "agents", `${name}.md`), "utf8"));
  check("autonomous-roles-have-no-web-network-tools", autonomousDefinitions.every((definition) => !/^tools:.*\b(?:web_search|web_fetch|web_research|safe_web_fetch)\b/mu.test(definition)), "Worker and Tester cannot turn the controlled web runner into general shell network access");
} catch (error) {
  check("agent-policy-runtime-harness", false, error instanceof Error ? error.message : String(error));
} finally {
  fs.rmSync(stateRoot, { recursive: true, force: true });
}

const status = results.length >= 5 && results.every((entry) => entry.status === "PASS") ? "PASS" : "FAIL";
process.stdout.write(`${JSON.stringify({ status, results }, null, 2)}\n`);
process.exit(status === "PASS" ? 0 : 1);
