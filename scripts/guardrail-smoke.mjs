#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pi = process.env.PI_BIN || "pi";
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const providerExtension = path.join(packageRoot, "tests", "fixtures", "deterministic-guardrail-provider.ts");
const model = "pi-overdrive-audit/guardrail-driver";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-guardrail-"));
const repo = path.join(root, "repo");
const outside = path.join(root, "outside");
const results = [];

function check(name, condition, detail) {
  results.push({ name, status: condition ? "PASS" : "FAIL", detail });
}

function resultText(event) {
  return (event?.result?.content ?? []).filter((item) => item?.type === "text").map((item) => item.text).join("\n");
}

async function runPi() {
  const tools = "read,write,fffind,ast_grep_run,bash,safe_exec";
  const child = spawn(pi, ["--offline", "--approve", "--no-session", "--mode", "rpc", "--extension", providerExtension, "--provider", "pi-overdrive-audit", "--model", "guardrail-driver", "--api-key", "audit-only", "--tools", tools], {
    cwd: repo,
    env: {
      ...process.env,
      PI_OVERDRIVE_AUDIT_KEY: "audit-only",
      PI_OVERDRIVE_AUDIT_OUTSIDE: path.join(outside, "outside.js"),
      XDG_STATE_HOME: path.join(root, "state"),
    },
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
  const prompt = "Run the deterministic guardrail audit supplied by the local audit provider.";
  child.stdin.write(`${JSON.stringify({ id: "guard", type: "prompt", message: prompt })}\n`);
  const accepted = await waitFor((event) => event.type === "response" && event.id === "guard", "prompt acceptance", 30000);
  await waitFor((event) => event.type === "agent_settled", "guardrail settlement", 8 * 60 * 1000);
  child.stdin.end();
  await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGTERM"); resolve(); }, 5000);
    child.once("close", () => { clearTimeout(timer); resolve(); });
  });
  return { accepted, events, stderr };
}

try {
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(repo, ".env"), "PRIVATE_ENV_MARKER_DO_NOT_DISCLOSE\n", { mode: 0o600 });
  fs.writeFileSync(path.join(outside, "outside.js"), "const OUTSIDE_PROTECTED_MARKER = eval('1');\n", { mode: 0o600 });
  fs.symlinkSync(path.join(outside, "outside.js"), path.join(repo, "secret-link"));
  fs.writeFileSync(path.join(repo, "safe.txt"), "tracked\n");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Pi Guardrail Audit"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "pi-guardrail@invalid"], { cwd: repo });
  execFileSync("git", ["add", "safe.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "guardrail fixture"], { cwd: repo });
  const headBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  const outsideBefore = fs.readFileSync(path.join(outside, "outside.js"), "utf8");
  const invocation = await runPi();
  check("pi-guardrail-prompt-accepted", invocation.accepted.success === true, invocation.accepted.success);
  const ends = invocation.events.filter((event) => event.type === "tool_execution_end");
  check("all-adversarial-calls-attempted", ends.length === 13, ends.map((event) => event.toolName));
  check("all-adversarial-calls-denied", ends.length === 13 && ends.every((event) => event.isError === true), ends.map((event) => ({ tool: event.toolName, isError: event.isError, reason: resultText(event).slice(0, 180) })));
  const output = ends.map(resultText).join("\n");
  check("no-protected-content-leaked", !output.includes("PRIVATE_ENV_MARKER_DO_NOT_DISCLOSE") && !output.includes("OUTSIDE_PROTECTED_MARKER"), "protected marker absent from tool results");
  check("symlink-target-unchanged", fs.readFileSync(path.join(outside, "outside.js"), "utf8") === outsideBefore, "outside inode unchanged");
  check("shell-escape-file-not-created", !fs.existsSync(path.join(outside, "escape.txt")), "no escape file");
  check("git-head-unchanged", execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim() === headBefore, headBefore);
} catch (error) {
  check("guardrail-runtime-harness", false, error instanceof Error ? error.message : String(error));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

const status = results.length >= 7 && results.every((item) => item.status === "PASS") ? "PASS" : "FAIL";
process.stdout.write(`${JSON.stringify({ status, model, results }, null, 2)}\n`);
process.exit(status === "PASS" ? 0 : 1);
