#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-verification-"));
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const provider = path.join(packageRoot, "tests", "fixtures", "deterministic-single-tool-provider.ts");
const pi = process.env.PI_BIN || "pi";
const results = [];
const check = (name, condition, detail) => results.push({ name, status: condition ? "PASS" : "FAIL", detail });

async function invoke(cwd) {
  const child = spawn(pi, ["--offline", "--approve", "--no-session", "--mode", "rpc", "--extension", provider, "--provider", "pi-overdrive-tool-audit", "--model", "single-tool-driver", "--api-key", "audit-only", "--tools", "verification_gate"], {
    cwd,
    env: { ...process.env, PI_OVERDRIVE_TOOL_AUDIT_KEY: "audit-only", PI_OVERDRIVE_AUDIT_TOOL: "verification_gate", PI_OVERDRIVE_AUDIT_TOOL_ARGS: JSON.stringify({ mode: "full" }), XDG_STATE_HOME: path.join(root, "state") },
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
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4000); });
  child.stdin.write(`${JSON.stringify({ id: "verify", type: "prompt", message: "Run the deterministic verification audit." })}\n`);
  const deadline = Date.now() + 5 * 60 * 1000;
  while (!events.some((event) => event.type === "agent_settled") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  child.stdin.end();
  await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGTERM"); resolve(); }, 3000);
    child.once("close", () => { clearTimeout(timer); resolve(); });
  });
  if (!events.some((event) => event.type === "agent_settled")) throw new Error(`Pi verification audit timed out: ${stderr}`);
  return events.find((event) => event.type === "tool_execution_end" && event.toolName === "verification_gate");
}

try {
  const failing = path.join(root, "failing");
  const noChecks = path.join(root, "no-checks");
  fs.mkdirSync(failing);
  fs.mkdirSync(noChecks);
  fs.writeFileSync(path.join(failing, "package.json"), `${JSON.stringify({ private: true, scripts: { test: "node -e \"process.exit(7)\"" } }, null, 2)}\n`);
  execFileSync("git", ["init", "-q"], { cwd: failing });
  const failed = await invoke(failing);
  const failedText = (failed?.result?.content ?? []).map((item) => item.text ?? "").join("\n");
  let failedSummary;
  try { failedSummary = JSON.parse(failedText); } catch {}
  check("failed-command-is-tool-error", failed?.isError === true, { isError: failed?.isError });
  check("failed-command-cannot-report-pass", failedSummary?.status === "FAIL" && failedSummary?.results?.some((entry) => entry.name === "test" && entry.status === "FAIL" && entry.exitCode === 7), failedSummary ?? failedText.slice(-1200));
  const empty = await invoke(noChecks);
  const emptyText = (empty?.result?.content ?? []).map((item) => item.text ?? "").join("\n");
  let emptySummary;
  try { emptySummary = JSON.parse(emptyText); } catch {}
  check("no-checks-is-tool-error", empty?.isError === true, { isError: empty?.isError });
  check("no-checks-fails-closed", emptySummary?.status === "NO_CHECKS" && emptySummary?.results?.length === 0, emptySummary ?? emptyText.slice(-800));
} catch (error) {
  check("verification-runtime-harness", false, error instanceof Error ? error.message : String(error));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

const status = results.length >= 4 && results.every((item) => item.status === "PASS") ? "PASS" : "FAIL";
process.stdout.write(`${JSON.stringify({ status, results }, null, 2)}\n`);
process.exit(status === "PASS" ? 0 : 1);
