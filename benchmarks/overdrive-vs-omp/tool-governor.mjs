#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_TOOLS } from "../../extensions/tool-surface.ts";

const benchmarkRoot = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(benchmarkRoot, "../..");
const provider = path.join(packageRoot, "tests", "fixtures", "deterministic-context-provider.ts");
const fixtureTools = path.join(packageRoot, "tests", "fixtures", "tool-governor-tools.ts");
const governor = path.join(packageRoot, "extensions", "tool-surface.ts");
const pi = process.env.PI_BIN ?? "pi";
const writeResults = process.argv.includes("--write-results");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-tool-governor-"));
const agentDir = path.join(temporary, "agent");
const modelPolicy = path.join(temporary, "model-policy.json");
const harnessProfiles = path.join(temporary, "model-harness-profiles.json");

function assistantText(events) {
  const ended = [...events].reverse().find((event) => event.type === "agent_end");
  const assistant = [...(ended?.messages ?? [])].reverse().find((message) => message.role === "assistant");
  return (assistant?.content ?? []).filter((item) => item.type === "text").map((item) => item.text ?? "").join("");
}

function measure(id, prompt, extraArgs = []) {
  const started = performance.now();
  const run = spawnSync(pi, [
    "--offline", "--approve", "--no-session", "--mode", "rpc",
    "--extension", provider,
    "--extension", fixtureTools,
    "--extension", governor,
    "--provider", "pi-overdrive-context-audit",
    "--api-key", "audit-only",
    "--model", "context-driver",
    "--thinking", "low",
    ...extraArgs,
  ], {
    cwd: temporary,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OVERDRIVE_MODEL_POLICY: modelPolicy, PI_OVERDRIVE_MODEL_HARNESS_PROFILES: harnessProfiles, PI_OVERDRIVE_CONTEXT_AUDIT_KEY: "audit-only" },
    input: `${JSON.stringify({ id, type: "prompt", message: prompt })}\n`,
    encoding: "utf8",
    timeout: 45_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const events = String(run.stdout ?? "").split(/\r?\n/u).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  let context;
  try { context = JSON.parse(assistantText(events)); } catch {}
  return {
    id,
    status: run.status === 0 && context && Array.isArray(context.toolNames) ? "PASS" : "FAIL",
    elapsedMs: Number((performance.now() - started).toFixed(3)),
    toolCount: context?.toolCount ?? null,
    toolNames: context?.toolNames ?? [],
    toolSchemaCharacters: context?.toolSchemaCharacters ?? null,
    estimatedToolSchemaTokens: context?.estimatedToolSchemaTokens ?? null,
    exitCode: run.status,
    error: run.error?.message ?? null,
    stderr: run.status === 0 ? "" : String(run.stderr ?? "").slice(-2000),
  };
}

function inspectCommands() {
  const run = spawnSync(pi, [
    "--offline", "--approve", "--no-session", "--mode", "rpc",
    "--extension", provider, "--extension", fixtureTools, "--extension", governor,
    "--provider", "pi-overdrive-context-audit", "--api-key", "audit-only", "--model", "context-driver", "--thinking", "low",
  ], {
    cwd: temporary,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OVERDRIVE_MODEL_POLICY: modelPolicy, PI_OVERDRIVE_MODEL_HARNESS_PROFILES: harnessProfiles, PI_OVERDRIVE_CONTEXT_AUDIT_KEY: "audit-only" },
    input: `${JSON.stringify({ id: "commands", type: "get_commands" })}\n`,
    encoding: "utf8",
    timeout: 45_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const events = String(run.stdout ?? "").split(/\r?\n/u).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const commands = events.find((event) => event.type === "response" && event.id === "commands")?.data?.commands ?? [];
  const command = commands.find((entry) => entry.name === "tools");
  return { status: run.status === 0 && command?.source === "extension" ? "PASS" : "FAIL", command: command ? { name: command.name, source: command.source } : null, providerTurns: 0, exitCode: run.status };
}

let report;
try {
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(agentDir, "settings.json"), "{}\n", { mode: 0o600 });
  const trackedHarness = JSON.parse(fs.readFileSync(path.join(packageRoot, "config", "model-harness-profiles.json"), "utf8"));
  trackedHarness.providers["pi-overdrive-context-audit"] = {
    id: "deterministic-tool-governor-fixture-v1",
    toolConstraints: { deniedTools: [] },
    editContracts: { ordinary: ["HASH_ANCHORED", "REPLACE"], structural: ["AST_STRUCTURAL", "HASH_ANCHORED"], maxFallbacks: 1 },
  };
  fs.writeFileSync(harnessProfiles, `${JSON.stringify(trackedHarness, null, 2)}\n`, { mode: 0o600 });
  const starting = measure("starting-overdrive-core", "Change one string value.", ["--tools", CORE_TOOLS.join(",")]);
  const simple = measure("ultra-simple-edit", "Change one string value.");
  const search = measure("ultra-search-only", "Find every function call matching deprecatedApi without changing files.");
  const structural = measure("ultra-structural-edit", "Replace every call expression to legacyApi with modernApi across TypeScript source files.");
  const resource = measure("ultra-resource-uri", "Inspect repo://root/fixture.txt without changing it.");
  const debugging = measure("ultra-debugging", "Find and fix the intermittent race condition under load in src/queue.ts.");
  const research = measure("ultra-research", "Research the latest online documentation and prior project decisions.");
  const browser = measure("ultra-browser", "Inspect the browser DOM for the frontend page.");
  const explicit = measure("explicit-cli-preserved", "Research the latest online documentation.", ["--tools", "read,safe_exec"]);
  const controlPlane = inspectCommands();
  const measurements = [starting, simple, search, structural, resource, debugging, research, browser, explicit];
  const required = {
    allPiRunsComplete: measurements.every((entry) => entry.status === "PASS"),
    simpleRequiredAccessible: ["read", "transactional_edit", "semantic_nav", "verification_gate"].every((name) => simple.toolNames.includes(name)) && !simple.toolNames.includes("edit"),
    simpleSchemaReduced: simple.toolCount < starting.toolCount && simple.toolSchemaCharacters < starting.toolSchemaCharacters,
    simpleHighRiskHidden: ["write", "transactional_ast_edit", "ast_grep_rewrite", "web_research", "safe_web_fetch", "agent_browser", "safe_exec", "mcp", "subagent", "safe_remove_file"].every((name) => !simple.toolNames.includes(name)),
    searchOnlyNonMutating: ["ffgrep", "fffind", "ast_grep_run"].every((name) => search.toolNames.includes(name)) && ["grep", "find", "ls", "ast_grep_scan", "edit", "write", "transactional_ast_edit", "ast_grep_rewrite", "secure_coding_workflow"].every((name) => !search.toolNames.includes(name)),
    structuralRewriteSemantic: structural.toolNames.includes("transactional_ast_edit") && !structural.toolNames.includes("ast_grep_rewrite") && !simple.toolNames.includes("transactional_ast_edit"),
    resourceUriConditional: resource.toolNames.includes("resource_fs") && !simple.toolNames.includes("resource_fs") && !search.toolNames.includes("resource_fs"),
    debuggingFocused: ["fffind", "ast_grep_run", "task_notebook", "secure_coding_workflow", "debug_engine", "persistent_python", "persistent_javascript"].every((name) => debugging.toolNames.includes(name)) && !debugging.toolNames.includes("agent_browser"),
    researchFocused: ["task_notebook", "web_research", "safe_web_fetch"].every((name) => research.toolNames.includes(name)) && !research.toolNames.includes("agent_browser"),
    browserExplicitOnly: browser.toolNames.includes("agent_browser") && !simple.toolNames.includes("agent_browser") && !research.toolNames.includes("agent_browser"),
    explicitCliPreserved: JSON.stringify(explicit.toolNames) === JSON.stringify(["read", "safe_exec"]),
    controllerOnlyNeverVisible: [simple, debugging, research, browser].every((entry) => ["bash", "subagent", "safe_remove_file"].every((name) => !entry.toolNames.includes(name))),
    toolsCommandRegistered: controlPlane.status === "PASS",
  };
  report = {
    version: 1,
    recordedAt: new Date().toISOString(),
    status: Object.values(required).every(Boolean) ? "PASS" : "FAIL",
    measurementMode: "real-pi-process-deterministic-local-provider",
    piVersion: spawnSync(pi, ["--version"], { encoding: "utf8" }).stdout.trim(),
    startingOverdrive: starting,
    overdriveUltra: { measurements: measurements.slice(1), controlPlane, assertions: required },
    accounting: { deterministicLocalProviderTurns: measurements.length, paidModelCalls: 0, externalProviderCalls: 0, networkCalls: 0, cost: 0 },
    ompReference: { commit: "4267074ac91456866e95ed8de0b6353388f08502", version: "18.1.21", executableStatus: "NOT_RUN", reason: "Bun >=1.4 is unavailable; source inspection is not numeric benchmark evidence." },
  };
} catch (error) {
  report = { version: 1, recordedAt: new Date().toISOString(), status: "FAIL", accounting: { paidModelCalls: 0, externalProviderCalls: 0, networkCalls: 0, cost: 0 }, error: error instanceof Error ? error.message : String(error) };
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (writeResults) fs.writeFileSync(path.join(benchmarkRoot, "tool-governor-results.json"), serialized, { mode: 0o600 });
process.stdout.write(serialized);
process.exit(report.status === "PASS" ? 0 : 1);
