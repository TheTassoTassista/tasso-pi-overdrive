import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MODEL_PRESETS, MODEL_ROLES, assertModelRoute, canonicalExecutedRoute, parseModelSelection, parsePreset,
  policyWithPreset, policyWithRole, publicModelCatalog, readModelPolicy, resolveModelPolicy,
  settingsAgentOverrides, validateResolvedModelPolicy, writeModelPolicy,
} from "../lib/model-policy.mjs";
import { assessModelCapability, validateCallabilityCache } from "../lib/model-callability.mjs";

const directIds = ["gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-luna", "gpt-6-sol", "gpt-6-astra"];
const directCatalog = directIds.map((id) => ({ provider: "openai-codex", id, reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" }, contextWindow: 278528, maxTokens: 131072, input: ["text"], cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } }));
const omniIds = [
  "deepseek/deepseek-v4-pro-high", "deepseek/deepseek-v4-flash", "openrouter/qwen/qwen3.8-27b",
  "openrouter/qwen/qwen3-coder-next", "groq/qwen/qwen3-32b", "auto/best-fast", "auto/best-reasoning", "auto/best-coding",
];
const omniCatalog = omniIds.map((id) => ({ provider: "omniroute", id, reasoning: false, contextWindow: 1_000_000, maxTokens: 32768, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));
const fullCatalog = [...directCatalog, ...omniCatalog];
const policy = (preset = "normal") => ({ version: 2, preset, basePreset: preset, overrides: {} });
const callability = (models, statuses = {}) => ({ version: 1, entries: Object.fromEntries(models.map((model) => {
  const identity = `${model.provider}/${model.id}`;
  const runtimeStatus = statuses[identity] ?? "RUNTIME_CALLABLE";
  return [identity, { runtimeStatus, reasonCode: runtimeStatus === "RUNTIME_CALLABLE" ? "LOCAL_FIXTURE" : "UNSUPPORTED_MODEL" }];
})) });
const options = (models, statuses = {}) => ({ registeredModels: models, callability: callability(models, statuses) });

test("preset parsing exposes only normal/token-saver/custom and aliases efficient safely", () => {
  assert.deepEqual(MODEL_PRESETS, ["normal", "token-saver", "custom"]);
  assert.equal(parsePreset("normal"), "normal");
  assert.equal(parsePreset("token-saver"), "token-saver");
  assert.equal(parsePreset("efficient"), "normal");
  assert.equal(parsePreset("budget"), "token-saver");
  assert.throws(() => parsePreset("imaginary"), /unknown_model_preset/u);
});

test("legacy efficient policy migrates in memory without discarding explicit overrides", () => {
  const legacy = { version: 1, preset: "custom", basePreset: "efficient", overrides: { worker: { model: "openai-codex/gpt-5.5", thinking: "high" } } };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-legacy-"));
  try {
    const file = path.join(root, "legacy.json");
    fs.writeFileSync(file, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
    const migrated = readModelPolicy(file);
    assert.equal(migrated.version, 2);
    assert.equal(migrated.preset, "custom");
    assert.equal(migrated.basePreset, "normal");
    assert.deepEqual(migrated.overrides, legacy.overrides);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), legacy, "read migration must not silently rewrite user configuration");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Normal Work exact direct role targets and efforts are explicit", () => {
  const resolved = resolveModelPolicy(directCatalog, policy(), options(directCatalog));
  const expected = {
    scout: ["openai-codex/gpt-6-luna", "low"], planner: ["openai-codex/gpt-6-sol", "medium"], oracle: ["openai-codex/gpt-6-astra", "high"],
    worker: ["openai-codex/gpt-6-sol", "medium"], tester: ["openai-codex/gpt-6-luna", "medium"], correctness: ["openai-codex/gpt-6-sol", "medium"],
    security: ["openai-codex/gpt-6-sol", "high"], simplicity: ["openai-codex/gpt-6-luna", "medium"], "council-1": ["openai-codex/gpt-6-sol", "high"],
    "council-2": ["openai-codex/gpt-5.5", "high"], "council-3": ["openai-codex/gpt-6-luna", "high"], "council-judge": ["openai-codex/gpt-6-astra", "high"],
  };
  for (const role of MODEL_ROLES) assert.deepEqual([resolved.roles[role].model, resolved.roles[role].thinking], expected[role], role);
  assert.ok(Object.values(resolved.roles).filter((route) => route.provider === "openai-codex").every((route) => ["low", "medium", "high"].includes(route.thinking)));
});

test("fresh-bootstrap subagent overrides match the resolved callable Normal route", () => {
  const patch = JSON.parse(fs.readFileSync(new URL("../config/settings-patch.json", import.meta.url), "utf8"));
  const resolved = resolveModelPolicy(directCatalog, policy(), options(directCatalog));
  assert.deepEqual(patch.subagents.agentOverrides, settingsAgentOverrides(resolved));
});

test("Token Saver is Luna-first and skips unpriced gateway routes even when fixture-callable", () => {
  const resolved = resolveModelPolicy(fullCatalog, policy("token-saver"), options(fullCatalog));
  assert.equal(resolved.roles.scout.model, "openai-codex/gpt-6-luna");
  assert.equal(resolved.roles.worker.model, "openai-codex/gpt-6-luna");
  assert.equal(resolved.roles.planner.model, "openai-codex/gpt-6-luna");
  assert.equal(resolved.roles.correctness.model, "openai-codex/gpt-6-luna");
  assert.equal(resolved.roles.security.model, "openai-codex/gpt-6-sol");
  assert.equal(resolved.roles["council-2"].model, "openai-codex/gpt-5.5");
  assert.equal(resolved.routeChains["council-2"][0].reason, "COST_NOT_ATTESTED");
});

test("Council keeps the diverse candidate dormant without cost proof and Judge stays Astra high", () => {
  const resolved = resolveModelPolicy(fullCatalog, policy(), options(fullCatalog));
  assert.deepEqual(resolved.routeChains["council-2"].map((route) => route.family), ["DeepSeek", "OpenAI", "OpenAI"]);
  assert.deepEqual([resolved.roles["council-1"].model, resolved.roles["council-2"].model, resolved.roles["council-3"].model], ["openai-codex/gpt-6-sol", "openai-codex/gpt-5.5", "openai-codex/gpt-6-luna"]);
  assert.deepEqual([resolved.roles["council-judge"].model, resolved.roles["council-judge"].thinking, resolved.roles["council-judge"].source], ["openai-codex/gpt-6-astra", "high", "direct"]);
  assert.equal(resolved.diversity.heterogeneousProviders, false);
});

test("Council-2 becomes diverse only with verified runtime and zero-extra-cost registry evidence", () => {
  const identity = "omniroute/deepseek/deepseek-v4-pro-high";
  const record = { identity, zeroExtraCost: true, availability: { selectable: true, runtime: { state: "VERIFIED" } }, pricing: { state: "VERIFIED", value: { input: 0, output: 0 } } };
  const eligible = resolveModelPolicy(fullCatalog, policy(), { ...options(fullCatalog), providerRegistry: { kind: "PROVIDER_CAPABILITY_REGISTRY", models: [record] } });
  assert.equal(eligible.roles["council-2"].model, identity);
  assert.equal(eligible.diversity.heterogeneousProviders, true);
  const unverified = resolveModelPolicy(fullCatalog, policy(), { ...options(fullCatalog), providerRegistry: { kind: "PROVIDER_CAPABILITY_REGISTRY", models: [{ ...record, pricing: { ...record.pricing, state: "CACHED" } }] } });
  assert.equal(unverified.roles["council-2"].model, "openai-codex/gpt-5.5");
  assert.throws(() => validateResolvedModelPolicy(fullCatalog, eligible, options(fullCatalog)), /cost_unattested/u);
});

test("fallback order is deterministic and rejects catalog presence without callability evidence", () => {
  const rejectedLuna = { "openai-codex/gpt-6-luna": "RUNTIME_REJECTED" };
  const fallback = resolveModelPolicy(fullCatalog, policy("token-saver"), options(fullCatalog, rejectedLuna));
  assert.equal(fallback.roles.worker.model, "openai-codex/gpt-6-sol");
  assert.equal(fallback.roles.worker.fallbackIndex, 1);
  assert.deepEqual(fallback.routingDecisions.find((entry) => entry.role === "worker").skipped, [{ model: "openai-codex/gpt-6-luna", reason: "RUNTIME_REJECTED:UNSUPPORTED_MODEL" }]);
  const oldOnly = { version: 1, entries: Object.fromEntries(directCatalog.filter((model) => !["gpt-6-luna", "gpt-6-sol"].includes(model.id)).map((model) => [`${model.provider}/${model.id}`, { runtimeStatus: "RUNTIME_CALLABLE", reasonCode: "LOCAL_FIXTURE" }])) };
  const liveSafe = resolveModelPolicy(fullCatalog, policy("token-saver"), { registeredModels: fullCatalog, callability: oldOnly });
  assert.equal(liveSafe.roles.worker.model, "openai-codex/gpt-5.6-terra");
  assert.equal(liveSafe.roles.worker.fallbackIndex, 2);
});

test("complete route unavailability fails closed", () => {
  const rejected = Object.fromEntries(fullCatalog.map((model) => [`${model.provider}/${model.id}`, "RUNTIME_REJECTED"]));
  assert.throws(() => resolveModelPolicy(fullCatalog, policy(), options(fullCatalog, rejected)), /BLOCKED_BY_MODEL/u);
});

test("nested OmniRoute IDs parse and runtime route attestation is exact", () => {
  const model = omniCatalog.find((entry) => entry.id === "openrouter/qwen/qwen3-coder-next");
  const selected = parseModelSelection("omniroute/openrouter/qwen/qwen3-coder-next:off", [model], options([model]));
  assert.deepEqual(selected, { model: "omniroute/openrouter/qwen/qwen3-coder-next", thinking: "off" });
  assert.equal(assertModelRoute(selected, { model: `${selected.model}:off`, thinking: "off" }), true);
  assert.deepEqual(canonicalExecutedRoute(selected, { model: selected.model, thinking: "off", status: "completed" }), { model: selected.model, thinking: "off", status: "completed" });
  assert.throws(() => assertModelRoute(selected, { model: "omniroute/openrouter/qwen/other:off", thinking: "off" }), /route_mismatch/u);
});

test("manual unsupported effort is rejected and quality max uses strongest supported direct effort", () => {
  const nonReasoning = [{ provider: "fixture", id: "plain/model", reasoning: false }];
  assert.throws(() => parseModelSelection("fixture/plain/model:high", nonReasoning, options(nonReasoning)), /thinking_not_supported/u);
  const max = resolveModelPolicy(directCatalog, policy(), { ...options(directCatalog), qualityRequested: "max", effectiveQuality: "max" });
  assert.equal(max.roles.worker.thinking, "xhigh");
  assert.equal(max.roles.scout.thinking, "medium");
});

test("high raises Sol coding effort without raising fan-out or context limits", () => {
  const base = resolveModelPolicy(directCatalog, policy(), options(directCatalog));
  const high = resolveModelPolicy(directCatalog, policy(), { ...options(directCatalog), qualityRequested: "high", effectiveQuality: "high" });
  assert.equal(base.roles.worker.thinking, "medium");
  assert.equal(high.roles.worker.thinking, "high");
  assert.equal(high.roles.planner.thinking, "high");
  assert.equal(high.roles.tester.thinking, "high");
  assert.equal(high.roles.scout.thinking, "low");
  assert.equal(high.roles["council-judge"].thinking, "high");
  assert.deepEqual(Object.keys(high.roles), Object.keys(base.roles));
});

test("low quality cannot weaken mandatory Security, Oracle, Council, or Judge direct reasoning", () => {
  const low = resolveModelPolicy(directCatalog, policy(), { ...options(directCatalog), qualityRequested: "low", effectiveQuality: "low" });
  for (const role of ["security", "oracle", "council-1", "council-2", "council-3", "council-judge"]) assert.equal(low.roles[role].thinking, "high", role);
  assert.equal(low.roles.worker.thinking, "medium");
  assert.equal(low.roles.scout.thinking, "low");
});

test("custom route remains user-owned, persists privately, and symlink writes are rejected", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-policy-"));
  try {
    const file = path.join(root, "config", "model-policy.json");
    const custom = policyWithRole(policy(), "worker", { model: "openai-codex/gpt-5.5", thinking: "high" });
    writeModelPolicy(file, custom);
    assert.equal(fs.statSync(file).mode & 0o077, 0);
    assert.deepEqual(readModelPolicy(file), custom);
    const resolved = resolveModelPolicy(directCatalog, custom, options(directCatalog));
    assert.equal(resolved.roles.worker.override, true);
    const outside = path.join(root, "outside.json");
    fs.writeFileSync(outside, "{}\n");
    const link = path.join(root, "linked.json");
    fs.symlinkSync(outside, link);
    assert.throws(() => writeModelPolicy(link, policy()), /target_unsafe/u);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("resolved policy resumes exactly and rejects route/digest tampering", () => {
  const resolved = resolveModelPolicy(fullCatalog, policy(), options(fullCatalog));
  const resumed = validateResolvedModelPolicy(fullCatalog, structuredClone(resolved), options(fullCatalog));
  assert.deepEqual(resumed.roles, resolved.roles);
  const changed = structuredClone(resolved);
  changed.roles.worker.model = "openai-codex/gpt-5.5";
  assert.throws(() => validateResolvedModelPolicy(fullCatalog, changed, options(fullCatalog)), /digest_mismatch|route_unavailable/u);
});

test("capability states remain distinct, nested cache IDs validate, and unknown pricing is not reported as zero", () => {
  const model = omniCatalog[0];
  const id = `${model.provider}/${model.id}`;
  const callable = callability([model]);
  assert.doesNotThrow(() => validateCallabilityCache(callable));
  assert.equal(assessModelCapability(id, { registeredModels: [model], authenticatedModels: [model], callability: callable }).usable, true);
  assert.equal(assessModelCapability(id, { registeredModels: [model], authenticatedModels: [], callability: callable }).authenticationStatus, "AUTH_MISSING");
  const catalog = publicModelCatalog([model], [model], { callability: callable });
  assert.equal(catalog[0].cost, null);
  assert.equal(catalog[0].costMetadata, "NOT_REPORTED_BY_OMNIROUTE_CATALOG");
});

test("resolved policy projects to every pi-subagents role", () => {
  const overrides = settingsAgentOverrides(resolveModelPolicy(directCatalog, policyWithPreset(policy(), "efficient"), options(directCatalog)));
  assert.deepEqual(Object.keys(overrides).sort(), ["correctness-reviewer", "council-1", "council-2", "council-3", "council-judge", "oracle", "planner", "scout", "security-reviewer", "simplicity-reviewer", "tester", "worker"].sort());
});
