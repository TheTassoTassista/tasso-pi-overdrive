#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pi = process.env.PI_BIN || path.join(path.dirname(process.execPath), "pi");
const routingProvider = path.join(root, "tests", "fixtures", "deterministic-routing-provider.ts");
const modelPolicyExtension = path.join(root, "extensions", "model-policy.ts");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-council-policy-"));
const agentDir = path.join(temporary, "agent");
const policyFile = path.join(temporary, "config", "pi-overdrive", "model-policy.json");
const callabilityFile = path.join(temporary, "config", "pi-overdrive", "model-callability.json");
const results = [];
const check = (name, condition, detail) => results.push({ name, status: condition ? "PASS" : "FAIL", detail });
const identities = [
  "openai-codex/gpt-5.5", "openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-sol",
  "openai-codex/gpt-5.6-terra", "openai-codex/gpt-6-luna", "openai-codex/gpt-6-sol", "openai-codex/gpt-6-astra",
  "omniroute/deepseek/deepseek-v4-pro-high", "omniroute/deepseek/deepseek-v4-flash",
  "omniroute/openrouter/qwen/qwen3.8-27b", "omniroute/openrouter/qwen/qwen3-coder-next",
  "omniroute/groq/qwen/qwen3-32b", "omniroute/auto/best-fast",
  "omniroute/auto/best-reasoning", "omniroute/auto/best-coding",
];

function runPi(message) {
  const child = spawnSync(pi, [
    "--offline", "--approve", "--no-session", "--mode", "rpc",
    "--extension", routingProvider, "--extension", modelPolicyExtension,
    "--provider", "pi-overdrive-routing-audit", "--model", "driver",
    "--api-key", "audit-only", "--no-tools",
  ], {
    cwd: root,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OVERDRIVE_MODEL_POLICY: policyFile,
      PI_OVERDRIVE_MODEL_CALLABILITY: callabilityFile,
      PI_OVERDRIVE_ROUTING_AUDIT_KEY: "audit-only",
    },
    input: `${JSON.stringify(message)}\n`,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const events = String(child.stdout ?? "").split(/\r?\n/u).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  return { code: child.status, events, stderr: String(child.stderr ?? "").slice(-5000), signal: child.signal, error: child.error?.message };
}

const notifications = (run) => run.events.filter((event) => event.type === "extension_ui_request" && event.method === "notify").map((event) => String(event.message)).join("\n");
const noModelCall = (run) => !run.events.some((event) => ["agent_start", "message_start", "message_update", "message_end"].includes(event.type));

try {
  fs.mkdirSync(path.join(agentDir, "extensions", "subagent"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(callabilityFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(agentDir, "settings.json"), "{}\n", { mode: 0o600 });
  fs.copyFileSync(path.join(root, "config", "subagents.json"), path.join(agentDir, "extensions", "subagent", "config.json"));
  fs.chmodSync(path.join(agentDir, "extensions", "subagent", "config.json"), 0o600);
  fs.writeFileSync(policyFile, `${JSON.stringify({ version: 2, preset: "normal", basePreset: "normal", overrides: {} }, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(callabilityFile, `${JSON.stringify({ version: 1, entries: Object.fromEntries(identities.map((identity) => [identity, { runtimeStatus: "RUNTIME_CALLABLE", reasonCode: "DETERMINISTIC_LOCAL_PROVIDER" }])) }, null, 2)}\n`, { mode: 0o600 });

  const catalogRun = runPi({ id: "council-catalog", type: "get_commands" });
  const commands = catalogRun.events.find((event) => event.type === "response" && event.id === "council-catalog")?.data?.commands ?? [];
  check("pi-council-commands-registered", catalogRun.code === 0 && ["council", "council-status"].every((name) => commands.some((entry) => entry.name === name && entry.source === "extension")) && noModelCall(catalogRun), commands.filter((entry) => entry.name.includes("council")).map((entry) => ({ name: entry.name, source: entry.source })));

  const precedenceRun = runPi({ id: "council-precedence", type: "prompt", message: "/council" });
  const precedenceText = notifications(precedenceRun);
  check("protected-council-command-shadows-upstream-prompt", precedenceRun.code === 0 && precedenceText.includes("usage: /council TASK") && noModelCall(precedenceRun), precedenceText || precedenceRun.stderr);

  const statusRun = runPi({ id: "council-status", type: "prompt", message: "/council-status" });
  const statusText = notifications(statusRun);
  check("pi-council-status-reports-cost-gated-diversity-and-is-secret-free", statusRun.code === 0 && [
    "council-1: openai-codex/gpt-6-sol:high", "council-2: openai-codex/gpt-5.5:high",
    "council-3: openai-codex/gpt-6-luna:high", "council-judge: openai-codex/gpt-6-astra:high",
    "concurrency=3", "depth=1", "nested council=disabled", "attested", "cost/callability",
  ].every((value) => statusText.includes(value)) && !/api[_ -]?key|credential\s*[:=]|token\s*[:=]/iu.test(statusText) && noModelCall(statusRun), statusRun.code === 0 ? { diverseCandidateCostGated: true, modelCalls: 0, characters: statusText.length } : statusText || statusRun.stderr || statusRun.error);

  const agents = spawnSync(process.execPath, [path.join(root, "scripts", "agent-policy-smoke.mjs")], { cwd: root, env: process.env, encoding: "utf8", timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
  let agentEvidence;
  try { agentEvidence = JSON.parse(agents.stdout); } catch {}
  check("pi-council-profiles-are-read-only-fresh-and-non-delegating", agents.status === 0 && agentEvidence?.status === "PASS" && agentEvidence.results?.some((entry) => entry.name === "council-runtime-surfaces-are-read-only-and-non-delegating" && entry.status === "PASS"), agentEvidence ?? agents.stderr);
} catch (error) {
  check("council-smoke-harness", false, error instanceof Error ? error.message : String(error));
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

const status = results.length === 4 && results.every((entry) => entry.status === "PASS") ? "PASS" : "FAIL";
process.stdout.write(`${JSON.stringify({ status, modelInferenceCalls: 0, providerExecution: "DETERMINISTIC_LOCAL_ONLY", results }, null, 2)}\n`);
process.exit(status === "PASS" ? 0 : 1);
