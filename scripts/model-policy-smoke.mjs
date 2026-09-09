#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_ROLES, readModelPolicy, resolveModelPolicy } from "../lib/model-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pi = process.env.PI_BIN || "pi";
const provider = path.join(root, "tests", "fixtures", "deterministic-single-tool-provider.ts");
const extension = path.join(root, "extensions", "model-policy.ts");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-model-policy-"));
const isolatedAgentDir = path.join(temporary, "agent");
const isolatedPolicy = path.join(temporary, "config", "pi-overdrive", "model-policy.json");
const results = [];
const check = (name, condition, detail) => results.push({ name, status: condition ? "PASS" : "FAIL", detail });

function runCommand(message, { isolated = false, expected } = {}) {
  return new Promise((resolve) => {
    const args = isolated
      ? ["--extension", provider, "--extension", extension, "--offline", "--approve", "--no-session", "--mode", "rpc", "--provider", "pi-overdrive-tool-audit", "--model", "single-tool-driver", "--api-key", "audit-only", "--no-tools"]
      : ["--offline", "--approve", "--no-session", "--mode", "rpc", "--provider", "openai-codex", "--model", "gpt-5.6-luna", "--no-tools"];
    const environment = { ...process.env };
    if (isolated) {
      environment.PI_CODING_AGENT_DIR = isolatedAgentDir;
      environment.PI_OVERDRIVE_MODEL_POLICY = isolatedPolicy;
      environment.PI_OVERDRIVE_TOOL_AUDIT_KEY = "audit-only";
    }
    const child = spawn(pi, args, { cwd: root, env: environment, stdio: ["pipe", "pipe", "pipe"] });
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
    child.stdin.write(`${JSON.stringify({ id: "model-policy", type: "prompt", message })}\n`);
    const timer = setTimeout(() => child.kill("SIGTERM"), 30_000);
    const poll = setInterval(() => {
      const notification = events.find((event) => event.type === "extension_ui_request" && event.method === "notify" && typeof event.message === "string" && (!expected || expected.test(event.message)));
      if (!notification) return;
      clearInterval(poll);
      child.stdin.end();
    }, 20);
    child.once("close", (code) => {
      clearTimeout(timer);
      clearInterval(poll);
      const notifications = events.filter((event) => event.type === "extension_ui_request" && event.method === "notify");
      resolve({ code, notifications, stderr, events });
    });
  });
}

function messages(run) {
  return run.notifications.map((event) => event.message).filter((value) => typeof value === "string").join("\n");
}

function fileMetadata(file) {
  try {
    const stat = fs.statSync(file);
    return { exists: true, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false };
    throw error;
  }
}

function authMetadata() {
  return fileMetadata(path.join(os.homedir(), ".pi", "agent", "auth.json"));
}

try {
  fs.mkdirSync(isolatedAgentDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(isolatedAgentDir, "settings.json"), "{}\n", { mode: 0o600 });

  const authBefore = authMetadata();
  const catalog = await runCommand("/models", { expected: /openai-codex\//u });
  const authAfter = authMetadata();
  const catalogText = messages(catalog);
  check("pi-model-catalog-command", catalog.code === 0 && catalogText.includes("openai-codex/gpt-5.6-terra") && catalogText.includes("contextWindow") && catalogText.includes('"configured": false') && !/api[_ -]?key|token\s*[:=]/iu.test(catalogText), catalogText.slice(0, 3000) || catalog.stderr || catalog.events.slice(-10));
  check("real-authentication-metadata-unchanged", JSON.stringify(authBefore) === JSON.stringify(authAfter), { before: authBefore, after: authAfter, valuesRead: false });

  const routing = await runCommand("/model-routing", { expected: /Policy receipt:/u });
  const routingText = messages(routing);
  check("pi-effective-routing-command", routing.code === 0 && routingText.includes("Preset: efficient") && MODEL_ROLES.every((role) => routingText.includes(`${role}:`)), routingText.slice(0, 3000) || routing.stderr || routing.events.slice(-10));

  const presetList = await runCommand("/model-preset list", { isolated: true, expected: /max-quality/u });
  const presetListText = messages(presetList);
  check("pi-preset-list-command", presetList.code === 0 && ["budget", "efficient", "balanced", "max-quality", "custom"].every((name) => presetListText.split("\n").includes(name)), presetListText || presetList.stderr);

  const roleList = await runCommand("/model-role list", { isolated: true, expected: /council-judge/u });
  const roleText = messages(roleList);
  check("pi-role-list-command", roleList.code === 0 && MODEL_ROLES.every((role) => roleText.split("\n").includes(role)), roleText || roleList.stderr || roleList.events.slice(-10));
  const isolatedAuthFile = path.join(isolatedAgentDir, "auth.json");
  const isolatedAuthBeforeChanges = fileMetadata(isolatedAuthFile);

  const override = await runCommand("/model-role worker pi-overdrive-tool-audit/single-tool-driver-alt:high", { isolated: true, expected: /Persistent policy updated/u });
  const overrideText = messages(override);
  const storedOverride = JSON.parse(fs.readFileSync(isolatedPolicy, "utf8"));
  const overrideSettings = JSON.parse(fs.readFileSync(path.join(isolatedAgentDir, "settings.json"), "utf8"));
  check("pi-role-override-persists-privately", override.code === 0 && storedOverride.preset === "custom" && storedOverride.overrides?.worker?.model === "pi-overdrive-tool-audit/single-tool-driver-alt" && (fs.statSync(isolatedPolicy).mode & 0o077) === 0 && overrideSettings.subagents?.agentOverrides?.worker?.thinking === "high", overrideText || storedOverride);

  const reloaded = await runCommand("/model-routing", { isolated: true, expected: /single-tool-driver-alt/u });
  check("pi-role-override-survives-reload", reloaded.code === 0 && messages(reloaded).includes("worker: pi-overdrive-tool-audit/single-tool-driver-alt:high") && readModelPolicy(isolatedPolicy).overrides.worker.model.endsWith("single-tool-driver-alt"), messages(reloaded) || reloaded.stderr);

  const beforeInvalid = fs.readFileSync(isolatedPolicy, "utf8");
  const invalid = await runCommand("/model-role worker unavailable-provider/not-real:high", { isolated: true, expected: /selected_model_not_available/u });
  check("invalid-model-id-fails-without-mutation", invalid.code === 0 && messages(invalid).includes("selected_model_not_available") && fs.readFileSync(isolatedPolicy, "utf8") === beforeInvalid, messages(invalid) || invalid.stderr);

  const presetEvidence = {};
  let allPresetsValid = true;
  for (const name of ["budget", "efficient", "balanced", "max-quality"]) {
    const selected = await runCommand(`/model-preset ${name}`, { isolated: true, expected: new RegExp(`Preset: ${name.replace("-", "-")}`, "u") });
    const stored = readModelPolicy(isolatedPolicy);
    const models = [
      { provider: "pi-overdrive-tool-audit", id: "single-tool-driver" },
      { provider: "pi-overdrive-tool-audit", id: "single-tool-driver-alt" },
    ];
    const resolved = resolveModelPolicy(models, stored);
    const valid = selected.code === 0 && stored.preset === name && MODEL_ROLES.every((role) => resolved.roles[role]?.model?.startsWith("pi-overdrive-tool-audit/"));
    allPresetsValid &&= valid;
    presetEvidence[name] = { valid, digest: resolved.digest.slice(0, 16), models: resolved.diversity.models };
  }
  check("all-concrete-presets-runtime-validated", allPresetsValid, presetEvidence);

  await runCommand("/model-role worker pi-overdrive-tool-audit/single-tool-driver-alt:high", { isolated: true, expected: /Persistent policy updated/u });
  const custom = await runCommand("/model-preset custom", { isolated: true, expected: /Preset: custom/u });
  const customStored = readModelPolicy(isolatedPolicy);
  check("custom-preset-preserves-explicit-overrides", custom.code === 0 && customStored.preset === "custom" && customStored.overrides.worker.model.endsWith("single-tool-driver-alt") && messages(custom).includes("worker: pi-overdrive-tool-audit/single-tool-driver-alt:high"), messages(custom) || customStored);

  const preset = await runCommand("/model-preset efficient", { isolated: true, expected: /Preset: efficient/u });
  const presetText = messages(preset);
  const storedPreset = JSON.parse(fs.readFileSync(isolatedPolicy, "utf8"));
  const presetSettings = JSON.parse(fs.readFileSync(path.join(isolatedAgentDir, "settings.json"), "utf8"));
  const resetChecks = {
    process: preset.code === 0,
    preset: storedPreset.preset === "efficient",
    overridesCleared: Object.keys(storedPreset.overrides).length === 0,
    workerRestored: presetText.includes("worker: pi-overdrive-tool-audit/single-tool-driver:high"),
    allRoles: MODEL_ROLES.every((role) => presetText.includes(`${role}:`)),
    settingsRoles: Object.keys(presetSettings.subagents?.agentOverrides ?? {}).length === MODEL_ROLES.length,
    authenticationMetadataUnchanged: JSON.stringify(fileMetadata(isolatedAuthFile)) === JSON.stringify(isolatedAuthBeforeChanges),
  };
  check("pi-reset-to-efficient-is-deterministic", Object.values(resetChecks).every(Boolean), { checks: resetChecks, output: presetText.slice(0, 3000) });
} catch (error) {
  check("model-policy-smoke-harness", false, error instanceof Error ? error.message : String(error));
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

const status = results.length === 11 && results.every((entry) => entry.status === "PASS") ? "PASS" : "FAIL";
process.stdout.write(`${JSON.stringify({ status, persistentWritesTestedOnlyInIsolatedHome: true, results }, null, 2)}\n`);
process.exit(status === "PASS" ? 0 : 1);
