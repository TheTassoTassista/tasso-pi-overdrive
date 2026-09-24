#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { resolveTaskPolicy } from "../../lib/task-governor.mjs";
import { resolveToolPolicy } from "../../lib/tool-governor.mjs";
import { buildProviderCapabilityRegistry } from "../../lib/provider-capability-registry.mjs";
import { normalizeOpenRouterCatalog, readLocalOpenRouterCatalog } from "../../lib/provider-catalog-snapshot.mjs";
import { governContext } from "../../lib/context-governor.mjs";
import { sanitizeArtifactText } from "../../lib/artifact-store.mjs";
import { localPrewalkEligibility } from "../../lib/local-prewalk.mjs";

const now = Date.parse("2026-09-24T12:00:00Z");
const task = "Find and fix the intermittent race condition under load in src/queue.ts.";
const taskPolicy = resolveTaskPolicy({ task, preset: "normal", quality: "auto" });
const prewalkTask = "Find parser code and fix broken parse behavior in repository";
const prewalkPolicy = resolveTaskPolicy({ task: prewalkTask, preset: "token-saver", quality: "low" });
const availableTools = ["read", "ffgrep", "fffind", "ast_grep_run", "transactional_edit", "semantic_nav", "task_notebook", "verification_gate", "secure_coding_workflow", "debug_engine", "persistent_python", "persistent_javascript", "safe_exec", "mcp"];
const registeredModels = Array.from({ length: 1200 }, (_, index) => ({ provider: "fixture", id: `model-${String(index).padStart(4, "0")}`, contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0 } }));
const catalogRaw = { fetchedAt: "2026-09-13T00:00:00Z", data: Array.from({ length: 445 }, (_, index) => ({ id: `fixture/model-${String(index).padStart(4, "0")}`, context_length: 64000, top_provider: { max_completion_tokens: 2048 } })) };
const catalogSnapshot = normalizeOpenRouterCatalog(catalogRaw, now);
const callability = { version: 1, provider: "fixture", updatedAt: "2026-09-24T11:00:00Z", source: "test", entries: {} };
const registryInput = { registeredModels, authenticatedModels: [], callability, catalogSnapshot, now, onlyIdentity: "fixture/model-0000" };
const policy = { version: 1, safetyTokens: 1024, toolResultMaxChars: 4000, toolResultMaxLines: 80, smartReadTargetChars: 3000, artifactDuplicateMaxChars: 256 };
const contextInput = { messages: [{ role: "user", content: "Inspect the parser.", timestamp: 1 }, { role: "toolResult", toolCallId: "a", toolName: "read", content: [{ type: "text", text: "fixture line\n".repeat(1000) }], isError: false, timestamp: 2 }], systemPrompt: "system", tools: [{ name: "read", description: "read file", parameters: { type: "object" } }], activeToolNames: ["read"], model: { provider: "fixture", id: "model-0000", contextWindow: 20000, maxTokens: 2048 }, policy };
const artifactText = `${"normal output line\n".repeat(1000)}ERROR canonical fixture\n`;
const hashBytes = Buffer.alloc(1024 * 1024, 0x61);

function measure(name, iterations, operation) {
  for (let index = 0; index < Math.min(iterations, 100); index += 1) operation();
  const cpuStart = process.cpuUsage();
  const started = performance.now();
  let result;
  for (let index = 0; index < iterations; index += 1) result = operation();
  const wallMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuStart);
  return { name, iterations, wallMs: Number(wallMs.toFixed(3)), meanWallMs: Number((wallMs / iterations).toFixed(5)), cpuMs: Number(((cpu.user + cpu.system) / 1000).toFixed(3)), result };
}

const measurements = [
  measure("task-governor", 5000, () => resolveTaskPolicy({ task, preset: "normal", quality: "auto" }).digest),
  measure("tool-governor", 5000, () => resolveToolPolicy({ taskPolicy, availableTools }).digest),
  measure("provider-registry-1645-candidates-single-selected", 100, () => buildProviderCapabilityRegistry(registryInput).models[0].contextWindow.value),
  measure("catalog-normalize-445", 100, () => normalizeOpenRouterCatalog(catalogRaw, now).digest),
  measure("context-fit-1000-lines", 100, () => governContext(contextInput).proof.status),
  measure("artifact-sanitize-19000-chars", 100, () => sanitizeArtifactText(artifactText).storedBytes),
  measure("edit-sha256-1mib-native-node", 100, () => createHash("sha256").update(hashBytes).digest("hex")),
  measure("prewalk-eligible-policy-only", 5000, () => localPrewalkEligibility(prewalkTask, prewalkPolicy)),
];
const cache = readLocalOpenRouterCatalog();
if (cache.status === "AVAILABLE") measurements.push(measure("local-catalog-file-read-and-parse", 30, () => readLocalOpenRouterCatalog().status));
assert.equal(measurements.find((entry) => entry.name.startsWith("provider-registry")).result, 128000);
assert.equal(measurements.find((entry) => entry.name === "context-fit-1000-lines").result, "PASS");
assert.equal(measurements.find((entry) => entry.name === "prewalk-eligible-policy-only").result, "ELIGIBLE");
console.log(JSON.stringify({ status: "PASS", kind: "current-expansion-local-cpu-profile", paidModelCalls: 0, externalProviderCalls: 0, catalogStatus: cache.status, measurements, caveat: "CPU includes Node native runtime work. Pi startup, Git/LSP/ast-grep subprocesses and filesystem effects require separate process benchmarks; these local microbenchmarks do not establish end-to-end speedups." }));
