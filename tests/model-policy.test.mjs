import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MODEL_PRESETS, MODEL_ROLES, assertModelRoute, canonicalExecutedRoute, parseModelSelection, policyWithPreset, policyWithRole, publicModelCatalog, readModelPolicy, resolveModelPolicy, settingsAgentOverrides, validateResolvedModelPolicy, writeModelPolicy } from "../lib/model-policy.mjs";
import { assessModelCapability } from "../lib/model-callability.mjs";

const catalog = ["gpt-5.3-codex-spark", "gpt-5.4", "gpt-5.4-mini", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-astra"].map((id) => ({ provider: "openai-codex", id, reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" }, contextWindow: id === "gpt-5.3-codex-spark" ? 131072 : 278528, maxTokens: 131072, input: ["text"] }));

test("every preset resolves only against the live authenticated catalog", () => {
  for (const preset of MODEL_PRESETS.filter((name) => name !== "custom")) {
    const stored = policyWithPreset({ version: 1, preset: "efficient", basePreset: "efficient", overrides: {} }, preset);
    const resolved = resolveModelPolicy(catalog, stored);
    assert.deepEqual(Object.keys(resolved.roles), [...MODEL_ROLES]);
    assert.ok(Object.values(resolved.roles).every((route) => catalog.some((model) => `${model.provider}/${model.id}` === route.model)));
    assert.ok(Object.values(resolved.roles).every((route) => route.model !== "openai-codex/gpt-5.4"));
    assert.match(resolved.digest, /^[0-9a-f]{64}$/u);
  }
});

test("efficient and balanced routing separate Worker from independent critics and bound council diversity to available models", () => {
  const efficient = resolveModelPolicy(catalog, policyWithPreset({ version: 1, preset: "budget", basePreset: "budget", overrides: {} }, "efficient"));
  assert.notEqual(efficient.roles.worker.model, efficient.roles.correctness.model);
  assert.equal(new Set([efficient.roles["council-1"].model, efficient.roles["council-2"].model, efficient.roles["council-3"].model]).size, 3);
  assert.equal(efficient.diversity.providers, 1, "the actual authenticated catalog has only one provider");
  const single = resolveModelPolicy([catalog[4]], { version: 1, preset: "balanced", basePreset: "balanced", overrides: {} });
  assert.ok(Object.values(single.roles).every((route) => route.model === "openai-codex/gpt-5.6-luna"));
});

test("manual per-role selection is exact and unavailable models fail closed", () => {
  const selected = parseModelSelection("openai-codex/gpt-5.5:xhigh", catalog);
  const stored = policyWithRole({ version: 1, preset: "efficient", basePreset: "efficient", overrides: {} }, "security", selected);
  const resolved = resolveModelPolicy(catalog, stored);
  assert.equal(resolved.preset, "custom");
  assert.deepEqual(resolved.roles.security, { model: "openai-codex/gpt-5.5", thinking: "xhigh" });
  assert.throws(() => parseModelSelection("other/missing:high", catalog), /not_available/u);
  assert.throws(() => resolveModelPolicy(catalog, { ...stored, overrides: { security: { model: "other/missing", thinking: "high" } } }), /BLOCKED_BY_MODEL/u);
});

test("budget uses real catalog cost metadata and unsupported thinking fails closed", () => {
  const costed = catalog.map((model) => ({ ...model, cost: { input: 5, output: 10 } }));
  costed[6].cost = { input: 0.1, output: 0.5 };
  const budget = resolveModelPolicy(costed, { version: 1, preset: "budget", basePreset: "budget", overrides: {} });
  assert.ok(Object.values(budget.roles).every((route) => route.model === "openai-codex/gpt-5.6-terra"));
  const plain = [{ provider: "fixture", id: "non-reasoning", reasoning: false, cost: { input: 0, output: 0 } }];
  const options = { callability: { version: 1, entries: { "fixture/non-reasoning": { runtimeStatus: "RUNTIME_CALLABLE", reasonCode: "LOCAL_FIXTURE" } } } };
  assert.throws(() => parseModelSelection("fixture/non-reasoning:high", plain, options), /thinking_not_supported/u);
  assert.ok(Object.values(resolveModelPolicy(plain, { version: 1, preset: "budget", basePreset: "budget", overrides: {} }, options).roles).every((route) => route.thinking === "off"));
});

test("actual response model and thinking are bound to the configured route", () => {
  const route = { model: "openai-codex/gpt-5.6-terra", thinking: "high" };
  assert.equal(assertModelRoute(route, { model: route.model, thinking: route.thinking }), true);
  assert.equal(assertModelRoute(route, { model: `${route.model}:high`, thinking: route.thinking }), true, "pi-subagents appends the separately reported thinking level to its model reference");
  assert.deepEqual(canonicalExecutedRoute(route, { model: `${route.model}:high`, thinking: "high", launchContractDigest: "a".repeat(64) }), { model: route.model, thinking: "high", launchContractDigest: "a".repeat(64) });
  assert.throws(() => assertModelRoute(route, { model: "openai-codex/gpt-5.5", thinking: "high" }), /route_mismatch/u);
  assert.throws(() => assertModelRoute(route, { model: route.model, thinking: "low" }), /route_mismatch/u);
  assert.throws(() => assertModelRoute(route, { model: `${route.model}:low`, thinking: "high" }), /route_mismatch/u);
});

test("persisted resolved policy resumes exactly and rejects route or digest tampering", () => {
  const resolved = resolveModelPolicy(catalog, { version: 1, preset: "balanced", basePreset: "balanced", overrides: {} });
  const resumed = validateResolvedModelPolicy(catalog, structuredClone(resolved));
  assert.deepEqual(resumed.roles, resolved.roles);
  assert.equal(resumed.digest, resolved.digest);
  const changedRoute = structuredClone(resolved);
  changedRoute.roles.worker = { model: "openai-codex/gpt-5.6-luna", thinking: "medium" };
  assert.throws(() => validateResolvedModelPolicy(catalog, changedRoute), /digest_mismatch/u);
  assert.throws(() => validateResolvedModelPolicy(catalog, { ...structuredClone(resolved), digest: "0".repeat(64) }), /digest_mismatch/u);
  assert.throws(() => validateResolvedModelPolicy(catalog, { ...structuredClone(resolved), preset: "corrupt" }), /preset_invalid/u);
  assert.throws(() => validateResolvedModelPolicy(catalog, { ...structuredClone(resolved), basePreset: "custom" }), /preset_invalid/u);
});

test("private policy persistence is atomic, owner-only, and rejects symlink targets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-policy-"));
  try {
    const file = path.join(root, "config", "model-policy.json");
    const policy = { version: 1, preset: "efficient", basePreset: "efficient", overrides: {} };
    writeModelPolicy(file, policy);
    assert.equal(fs.statSync(file).mode & 0o077, 0);
    assert.deepEqual(readModelPolicy(file), policy);
    const outside = path.join(root, "outside.json");
    fs.writeFileSync(outside, "{}\n");
    const link = path.join(root, "linked.json");
    fs.symlinkSync(outside, link);
    assert.throws(() => writeModelPolicy(link, policy), /target_unsafe/u);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("resolved policy projects to all direct pi-subagent agent names", () => {
  const resolved = resolveModelPolicy(catalog, { version: 1, preset: "balanced", basePreset: "balanced", overrides: {} });
  const overrides = settingsAgentOverrides(resolved);
  assert.deepEqual(Object.keys(overrides).sort(), ["correctness-reviewer", "council-1", "council-2", "council-3", "council-judge", "oracle", "planner", "scout", "security-reviewer", "simplicity-reviewer", "tester", "worker"].sort());
});

test("registry, authentication, and runtime callability are distinct and fail closed", () => {
  const id = "fixture/model";
  const model = { provider: "fixture", id: "model" };
  const callable = { version: 1, entries: { [id]: { runtimeStatus: "RUNTIME_CALLABLE", reasonCode: "LOCAL_FIXTURE" } } };
  const rejected = { version: 1, entries: { [id]: { runtimeStatus: "RUNTIME_REJECTED", reasonCode: "UNSUPPORTED_MODEL" } } };
  assert.equal(assessModelCapability(id, { registeredModels: [model], authenticatedModels: [model], callability: callable }).usable, true);
  assert.equal(assessModelCapability(id, { registeredModels: [model], authenticatedModels: [model], callability: rejected }).runtimeStatus, "RUNTIME_REJECTED");
  assert.equal(assessModelCapability(id, { registeredModels: [{ ...model, runtimeCallable: true }], authenticatedModels: [{ ...model, runtimeCallable: true }], callability: rejected }).usable, false, "registry metadata cannot override cached runtime rejection");
  assert.equal(assessModelCapability(id, { registeredModels: [model], authenticatedModels: [], callability: callable }).authenticationStatus, "AUTH_MISSING");
  assert.equal(publicModelCatalog([model], [], { callability: callable })[0].usable, false);
});

test("unavailable preset choices fall back deterministically and no callable route is explicit", () => {
  const models = [
    { provider: "fixture", id: "preferred", reasoning: true },
    { provider: "fixture", id: "fallback", reasoning: true },
  ];
  const options = { callability: { version: 1, entries: {
    "fixture/preferred": { runtimeStatus: "RUNTIME_REJECTED", reasonCode: "UNSUPPORTED_MODEL" },
    "fixture/fallback": { runtimeStatus: "RUNTIME_CALLABLE", reasonCode: "LOCAL_FIXTURE" },
  } } };
  const policy = resolveModelPolicy(models, { version: 1, preset: "efficient", basePreset: "efficient", overrides: {} }, options);
  assert.ok(Object.values(policy.roles).every((route) => route.model === "fixture/fallback"));
  assert.ok(policy.routingDecisions.some((decision) => decision.skipped.length > 0));
  assert.throws(() => resolveModelPolicy([{ ...models[0] }], { version: 1, preset: "efficient", basePreset: "efficient", overrides: {} }, options), /BLOCKED_BY_MODEL/u);
});

test("custom policy remains user-owned and an uncallable override is not rewritten", () => {
  const stored = { version: 1, preset: "custom", basePreset: "efficient", overrides: { worker: { model: "openai-codex/gpt-5.4", thinking: "high" } } };
  const before = structuredClone(stored);
  assert.throws(() => resolveModelPolicy(catalog, stored), /BLOCKED_BY_MODEL:worker/u);
  assert.deepEqual(stored, before);
});
