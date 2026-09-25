#!/usr/bin/env node
// Policy-only migration corpus. It never launches Pi or an inference request.
import { performance } from "node:perf_hooks";
import { resolveModelPolicy } from "../lib/model-policy.mjs";
import { resolveTokenGovernor } from "../lib/token-governor.mjs";

const oldPrimary = Object.freeze({
  normal: { scout: "gpt-5.6-luna", planner: "gpt-5.6-sol", worker: "gpt-5.6-terra", tester: "gpt-5.6-luna", correctness: "gpt-5.6-sol", security: "gpt-5.6-sol", simplicity: "gpt-5.6-luna", oracle: "gpt-6-astra" },
  "token-saver": { scout: "omniroute/groq/qwen/qwen3-32b", planner: "omniroute/deepseek/deepseek-v4-pro-high", worker: "omniroute/openrouter/qwen/qwen3-coder-next", tester: "omniroute/groq/qwen/qwen3-32b", correctness: "omniroute/deepseek/deepseek-v4-pro-high", security: "gpt-5.6-sol", simplicity: "omniroute/groq/qwen/qwen3-32b", oracle: "omniroute/deepseek/deepseek-v4-pro-high" },
});
const tasks = [
  { id: "tiny-known-file", preset: "token-saver", task: "Rename the label in src/label.ts." },
  { id: "moderate-repository", preset: "normal", task: "Implement and test the parser change in src/parser.ts and tests/parser.test.ts." },
  { id: "reasoning-heavy", preset: "normal", task: "Refactor the concurrent recovery state machine and its integration tests." },
  { id: "test-review", preset: "normal", task: "Review and test the concurrent recovery regression in src/review.ts and tests/review.test.ts." },
  { id: "security-risk", preset: "normal", task: "Fix credential permission validation and test sandbox symlink traversal." },
];
const ids = ["gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-luna", "gpt-6-sol", "gpt-6-astra"];
const models = ids.map((id) => ({ provider: "openai-codex", id, reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } }));
const callability = { version: 1, entries: Object.fromEntries(models.map((model) => [`${model.provider}/${model.id}`, { runtimeStatus: "RUNTIME_CALLABLE", reasonCode: "POLICY_FIXTURE_ONLY" }])) };

const results = tasks.map(({ id, preset, task }) => {
  const started = performance.now();
  const governor = resolveTokenGovernor({ task, preset, quality: "auto" });
  const routing = resolveModelPolicy(models, { version: 2, preset, basePreset: preset, overrides: {} }, { registeredModels: models, callability, qualityRequested: governor.qualityRequested, effectiveQuality: governor.effectiveQuality });
  const activeRoles = Object.entries(governor.roles).filter(([, enabled]) => enabled).map(([role]) => role);
  const oldRoutes = Object.fromEntries(activeRoles.map((role) => [role, oldPrimary[preset][role]]));
  const newRoutes = Object.fromEntries(activeRoles.map((role) => [role, `${routing.roles[role].model}:${routing.roles[role].thinking}`]));
  return { id, preset, difficulty: governor.difficulty, activeRoles, historicalOldPrimary: oldRoutes, intendedNewPrimary: newRoutes, policyResolutionMs: Number((performance.now() - started).toFixed(3)), taskCorrectness: "NOT_RUN", actualModelCalls: "NOT_RUN", retries: "NOT_RUN", toolCalls: "NOT_RUN", inputTokens: "NOT_AVAILABLE", outputTokens: "NOT_AVAILABLE", providerLatency: "NOT_RUN", failures: "NOT_RUN" };
});
const tokenSaver = results.find((item) => item.id === "tiny-known-file");
const review = results.find((item) => item.id === "test-review");
const status = results.length === 5 && tokenSaver.activeRoles.length === 1 && tokenSaver.intendedNewPrimary.worker === "openai-codex/gpt-6-luna:medium" && review.activeRoles.includes("tester") && review.activeRoles.includes("correctness") && results.every((item) => item.activeRoles.every((role) => item.intendedNewPrimary[role])) ? "PASS" : "FAIL";
process.stdout.write(`${JSON.stringify({ status, kind: "DETERMINISTIC_POLICY_BENCHMARK", baseline: "5b1e924:config/routing-policy.json", modelInferenceCalls: 0, additionalMonetaryCostEur: 0, limitation: "No task-quality, provider-latency, token, retry, or live-cost comparison is claimed without authorized callable-model evidence.", results }, null, 2)}\n`);
process.exit(status === "PASS" ? 0 : 1);
