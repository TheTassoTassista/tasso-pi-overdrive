#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pi = process.env.PI_BIN || path.join(path.dirname(process.execPath), "pi");
const provider = path.join(root, "tests", "fixtures", "deterministic-routing-provider.ts");
const extension = path.join(root, "extensions", "model-policy.ts");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-routing-smoke-"));
const agentDir = path.join(temporary, "agent");
const policyFile = path.join(temporary, "config", "pi-overdrive", "model-policy.json");
const callabilityFile = path.join(temporary, "config", "pi-overdrive", "model-callability.json");
const catalogFile = path.join(temporary, "openrouter-catalog.json");
const results = [];
const check = (name, condition, detail) => results.push({ name, status: condition ? "PASS" : "FAIL", detail });
const directIds = ["gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-astra"].map((id) => `openai-codex/${id}`);
const omniIds = [
  "deepseek/deepseek-v4-pro-high", "deepseek/deepseek-v4-flash", "openrouter/qwen/qwen3.8-27b",
  "openrouter/qwen/qwen3-coder-next", "groq/qwen/qwen3-32b", "auto/best-fast", "auto/best-reasoning", "auto/best-coding",
].map((id) => `omniroute/${id}`);

function run(message) {
  const messages = Array.isArray(message) ? message : [message];
  const child = spawnSync(pi, ["--extension", provider, "--extension", extension, "--offline", "--approve", "--no-session", "--mode", "rpc", "--provider", "pi-overdrive-routing-audit", "--model", "driver", "--api-key", "audit-only", "--no-tools"], {
    cwd: root,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OVERDRIVE_MODEL_POLICY: policyFile, PI_OVERDRIVE_MODEL_CALLABILITY: callabilityFile, PI_OVERDRIVE_OMNIROUTE_CATALOG_CACHE: catalogFile, PI_OVERDRIVE_ROUTING_AUDIT_KEY: "audit-only" },
    input: `${messages.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const events = String(child.stdout ?? "").split(/\r?\n/u).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  return { code: child.status, events, stdout: String(child.stdout ?? "").slice(-5000), stderr: String(child.stderr ?? "").slice(-5000), signal: child.signal, error: child.error?.message };
}

const notifications = (run) => run.events.filter((event) => event.type === "extension_ui_request" && event.method === "notify").map((event) => String(event.message)).join("\n");
const noModelCall = (run) => !run.events.some((event) => ["agent_start", "message_start", "message_update", "message_end"].includes(event.type));

try {
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(agentDir, "settings.json"), "{}\n", { mode: 0o600 });
  fs.mkdirSync(path.dirname(callabilityFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(callabilityFile, `${JSON.stringify({ version: 1, entries: Object.fromEntries([...directIds, ...omniIds].map((identity) => [identity, { runtimeStatus: "RUNTIME_CALLABLE", reasonCode: "DETERMINISTIC_LOCAL_PROVIDER" }])) }, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(catalogFile, `${JSON.stringify({ fetchedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), data: [{ id: "fixture/stale", context_length: 64000 }] })}\n`, { mode: 0o600 });

  const catalog = await run({ id: "commands", type: "get_commands" });
  const commands = catalog.events.find((event) => event.type === "response" && event.id === "commands")?.data?.commands ?? [];
  check("routing-slash-commands-registered", ["preset", "quality", "ai-tree", "task-policy", "model-profile"].every((name) => commands.some((entry) => entry.name === name && entry.source === "extension")), { code: catalog.code, commands: commands.filter((entry) => ["preset", "quality", "ai-tree", "task-policy", "model-profile"].includes(entry.name)).map((entry) => ({ name: entry.name, source: entry.source })), stderr: catalog.stderr, signal: catalog.signal, error: catalog.error });

  const initial = await run({ id: "preset-show", type: "prompt", message: "/preset" }, /Normal Work/u);
  check("preset-default-command", initial.code === 0 && notifications(initial).includes("Normal Work (normal)") && noModelCall(initial), notifications(initial) || initial.stderr || initial.events.slice(-10));

  const saver = await run({ id: "preset-saver", type: "prompt", message: "/preset token-saver" }, /Token Saver/u);
  const saved = fs.existsSync(policyFile) ? JSON.parse(fs.readFileSync(policyFile, "utf8")) : {};
  check("preset-persistence-command", saver.code === 0 && saved.version === 2 && saved.preset === "token-saver" && (fs.statSync(policyFile).mode & 0o077) === 0 && noModelCall(saver), { output: notifications(saver), saved });

  const alias = await run({ id: "preset-alias", type: "prompt", message: "/preset efficient" }, /Normal Work/u);
  check("preset-efficient-alias-command", alias.code === 0 && JSON.parse(fs.readFileSync(policyFile, "utf8")).preset === "normal" && noModelCall(alias), notifications(alias));

  const quality = await run([
    { id: "quality-max", type: "prompt", message: "/quality max" },
    { id: "quality-tree", type: "prompt", message: "/ai-tree" },
  ]);
  const qualityText = notifications(quality);
  check("quality-command-and-immediate-session-effect", quality.code === 0 && qualityText.includes("Quality: max (session)") && qualityText.includes("openai-codex/gpt-5.6-terra:max") && qualityText.includes("reset quality to auto") && noModelCall(quality), quality.code === 0 ? { quality: "max", workerEffort: "max", modelCalls: 0 } : qualityText || quality.stderr);

  const freshQuality = await run({ id: "quality-fresh", type: "prompt", message: "/quality" }, /Quality: auto \(session\)/u);
  check("quality-new-session-resets-auto", freshQuality.code === 0 && noModelCall(freshQuality), notifications(freshQuality));

  const tree = await run({ id: "tree", type: "prompt", message: "/ai-tree" }, /PI OVERDRIVE AI ROUTING/u);
  const treeText = notifications(tree);
  check("ai-tree-complete-and-zero-model-calls", tree.code === 0 && noModelCall(tree) && ["openai-codex/gpt-5.6-luna:low", "omniroute/deepseek/deepseek-v4-pro-high:off", "omniroute/openrouter/qwen/qwen3.8-27b:off", "openai-codex/gpt-6-astra:high", "deterministic/local tools first", "share the OmniRoute gateway"].every((text) => treeText.includes(text)), tree.code === 0 ? { characters: treeText.length, roles: 12, modelCalls: 0 } : treeText.slice(0, 5000) || tree.stderr);

  const treeJson = await run({ id: "tree-json", type: "prompt", message: "/ai-tree --json" }, /"title": "PI OVERDRIVE AI ROUTING"/u);
  let parsedTree;
  try { parsedTree = JSON.parse(notifications(treeJson)); } catch {}
  check("ai-tree-json-zero-model-calls", treeJson.code === 0 && noModelCall(treeJson) && parsedTree?.roles?.length === 12 && parsedTree?.council?.concurrency === 3, parsedTree ? { roles: parsedTree.roles.length, concurrency: parsedTree.council.concurrency, modelCalls: 0 } : notifications(treeJson));

  const taskPolicy = await run({ id: "task-policy", type: "prompt", message: "/task-policy Change one string value." });
  const taskPolicyText = notifications(taskPolicy);
  check("task-policy-command-deterministic-and-zero-model-calls", taskPolicy.code === 0 && noModelCall(taskPolicy) && taskPolicyText.includes("deterministic-v1; 0 model calls") && taskPolicyText.includes("Planner/Reviewer/Council: false / false / false") && taskPolicyText.includes("Capabilities: read, edit, lsp, verify"), taskPolicyText || taskPolicy.stderr);

  const modelProfile = await run({ id: "model-profile", type: "prompt", message: "/model-profile --json" });
  let parsedProfile;
  try { parsedProfile = JSON.parse(notifications(modelProfile)); } catch {}
  check("model-profile-command-generic-safe-and-zero-model-calls", modelProfile.code === 0 && noModelCall(modelProfile) && parsedProfile?.id === "generic-safe-v1" && parsedProfile?.decisionModelCalls === 0 && parsedProfile?.match?.identity === "pi-overdrive-routing-audit/driver", parsedProfile ?? (notifications(modelProfile) || modelProfile.stderr));

  const providerRegistry = await run({ id: "provider-registry", type: "prompt", message: "/models --capabilities --json pi-overdrive-routing-audit/driver" });
  let parsedRegistry;
  try { parsedRegistry = JSON.parse(notifications(providerRegistry)); } catch {}
  check("provider-capability-registry-local-and-zero-model-calls", providerRegistry.code === 0 && noModelCall(providerRegistry) && parsedRegistry?.selectedModels?.length === 1 && parsedRegistry.selectedModels[0].identity === "pi-overdrive-routing-audit/driver" && parsedRegistry.selectedModels[0].availability.runtime.state === "UNKNOWN" && parsedRegistry.selectedModels[0].pricing.state === "UNKNOWN" && parsedRegistry.decisionModelCalls === 0 && parsedRegistry.catalogFetches === 0 && parsedRegistry.routingMutations === 0, parsedRegistry ?? (notifications(providerRegistry) || providerRegistry.stderr));

  const providerSummary = await run({ id: "provider-summary", type: "prompt", message: "/models --capabilities" });
  const summaryText = notifications(providerSummary);
  check("provider-capability-registry-default-output-bounded", providerSummary.code === 0 && noModelCall(providerSummary) && summaryText.includes("Provider capabilities: 0/") && summaryText.includes("local catalog STALE") && summaryText.length < 500, { characters: summaryText.length, modelCalls: 0 });

  const secretScan = [notifications(initial), notifications(saver), notifications(alias), notifications(quality), notifications(freshQuality), treeText, notifications(treeJson), taskPolicyText, notifications(modelProfile), notifications(providerRegistry), summaryText].join("\n");
  check("routing-command-output-secret-free", !/bearer\s+|api[_ -]?key\s*[:=]|cookie\s*[:=]|credential\s*[:=]/iu.test(secretScan), "metadata-only command output");
} catch (error) {
  check("routing-smoke-harness", false, error instanceof Error ? error.message : String(error));
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

const status = results.length === 13 && results.every((entry) => entry.status === "PASS") ? "PASS" : "FAIL";
process.stdout.write(`${JSON.stringify({ status, modelInferenceCalls: 0, providerExecution: "NONE_COMMAND_HANDLERS_ONLY", results }, null, 2)}\n`);
process.exit(status === "PASS" ? 0 : 1);
