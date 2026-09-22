#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { constrainToolsForModelProfile, resolveModelHarnessProfile } from "../../lib/model-harness-profile.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const writeResults = process.argv.includes("--write-results");
const knownModel = { provider: "openai-codex", id: "gpt-5.6-terra", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" }, contextWindow: 278528, maxTokens: 131072 };
const unknownModel = { provider: "fixture-unknown", id: "model", reasoning: false, contextWindow: 8192, maxTokens: 1024 };
const callability = { version: 1, entries: { "openai-codex/gpt-5.6-terra": { runtimeStatus: "RUNTIME_CALLABLE", reasonCode: "WORKFLOW_RECEIPT", evidenceRunId: "0789657a-a21f-4614-8919-ad88089050b8" } } };
const tools = ["read", "ffgrep", "transactional_edit", "edit", "write", "transactional_ast_edit", "agent_browser", "safe_exec"];

function resolve(model, structural = false) {
  const profile = resolveModelHarnessProfile({ model, registeredModels: [model], authenticatedModels: [model], callability });
  return { profile, selection: constrainToolsForModelProfile(tools, profile, { structural }) };
}

for (let index = 0; index < 1000; index += 1) resolve(index % 3 === 0 ? unknownModel : knownModel, index % 2 === 0);
const iterations = 10_000;
const started = performance.now();
let last;
for (let index = 0; index < iterations; index += 1) last = resolve(index % 4 === 0 ? unknownModel : knownModel, index % 2 === 0);
const totalMs = performance.now() - started;
const ordinary = resolve(knownModel, false);
const structural = resolve(knownModel, true);
const unknown = resolve(unknownModel, false);
const assertions = {
  postSelectionIdentityPreserved: ordinary.profile.match.identity === "openai-codex/gpt-5.6-terra",
  receiptBackedEvidence: ordinary.profile.capabilities.runtimeCallability.level === "VERIFIED",
  ordinaryHashAnchored: ordinary.selection.editContract.selected === "HASH_ANCHORED" && ordinary.selection.editContract.fallback === "REPLACE",
  structuralAstThenHash: structural.selection.editContract.selected === "AST_STRUCTURAL" && structural.selection.editContract.fallback === "HASH_ANCHORED",
  boundedFallback: ordinary.selection.editContract.maxFallbacks === 1 && structural.selection.editContract.maxFallbacks === 1,
  noToolEscalation: [...ordinary.selection.activeTools, ...structural.selection.activeTools, ...unknown.selection.activeTools].every((tool) => tools.includes(tool)),
  unknownGenericSafe: unknown.profile.id === "generic-safe-v1" && unknown.selection.activeTools.every((tool) => ["read", "ffgrep"].includes(tool)),
  deterministicReceipt: ordinary.profile.digest === resolve(knownModel, false).profile.digest,
  zeroDecisionCalls: ordinary.profile.decisionModelCalls === 0 && last.profile.decisionModelCalls === 0,
};
const report = {
  version: 1,
  recordedAt: new Date().toISOString(),
  status: Object.values(assertions).every(Boolean) ? "PASS" : "FAIL",
  measurementMode: "deterministic-post-route-profile-resolution-and-governor-composition",
  overdriveUltra: { iterations, totalMs: Number(totalMs.toFixed(3)), meanDecisionMs: Number((totalMs / iterations).toFixed(6)), assertions },
  accounting: { decisionModelCalls: 0, externalProviderCalls: 0, paidModelCalls: 0, networkCalls: 0, cost: 0 },
  authority: { changesRouting: false, canAddTools: false, maxEditFallbacks: 1, unknownProfile: "generic-safe-v1" },
  ompReference: { commit: "4267074ac91456866e95ed8de0b6353388f08502", version: "18.1.21", executableStatus: "NOT_RUN", reason: "Bun >=1.4 is unavailable; source inspection is not numeric benchmark evidence." },
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (writeResults) fs.writeFileSync(path.join(root, "model-harness-profile-results.json"), serialized, { mode: 0o600 });
process.stdout.write(serialized);
process.exit(report.status === "PASS" ? 0 : 1);
