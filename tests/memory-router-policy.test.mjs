import test from "node:test";
import assert from "node:assert/strict";
import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deriveProjectIdentity, readSecondBrainConfig } from "../lib/memory-config.mjs";
import { inferCurrentContextSufficient, routeMemoryQuery } from "../lib/memory-router.mjs";
import { memoryPolicyTopology, resolveMemoryPolicy } from "../lib/memory-policy.mjs";
import { defaultMemoryRoot } from "../lib/memory-security.mjs";

test("current project questions route only to OpenViking", () => {
  assert.deepEqual(routeMemoryQuery("Which module implements the project architecture?").sources, ["openviking"]);
});

test("historical questions route only to Hindsight Recall", () => {
  const route = routeMemoryQuery("Why did we make this decision before?");
  assert.deepEqual(route.sources, ["hindsight"]);
  assert.equal(route.reflect, false);
});

test("strategy questions route only to the ACE playbook", () => {
  assert.deepEqual(routeMemoryQuery("What debugging strategy should we reuse?").sources, ["ace"]);
});

test("current context sufficiency suppresses all memory", () => {
  assert.equal(inferCurrentContextSufficient("Change src/a.ts line 4"), true);
  assert.deepEqual(routeMemoryQuery("Change src/a.ts line 4").sources, []);
  assert.deepEqual(routeMemoryQuery("project architecture", { currentContextSufficient: true }).sources, []);
});

test("non-memory conversation does not ritualistically query a backend", () => {
  assert.equal(routeMemoryQuery("Thanks, that is all.").decision, "NONE");
});

test("mixed historical architecture strategy selects only necessary sources", () => {
  const route = routeMemoryQuery("Why did our project architecture and debugging strategy change before?");
  assert.deepEqual(route.sources, ["openviking", "hindsight", "ace"]);
});

test("complex historical synthesis marks Reflect as requested but does not execute it", () => {
  const route = routeMemoryQuery("Synthesize the recurring pattern across multiple historical failures");
  assert.equal(route.reflect, true);
  assert.equal(route.deterministic, true);
});

test("Memory Router is deterministic and has no model-routing dependency", () => {
  const first = routeMemoryQuery("Have we seen this bug before?");
  const second = routeMemoryQuery("Have we seen this bug before?");
  assert.deepEqual(first, second);
  const source = readFileSync(fileURLToPath(new URL("../lib/memory-router.mjs", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /modelRegistry|sendUserMessage|provider|inference/iu);
});

test("Token Saver low searches aggressively but emits the smallest pack", () => {
  const saver = resolveMemoryPolicy({ preset: "token-saver", qualityRequested: "low" });
  const normal = resolveMemoryPolicy({ preset: "normal", qualityRequested: "low" });
  assert.equal(saver.localSearch, "aggressive");
  assert.ok(saver.candidateLimit > normal.candidateLimit);
  assert.ok(saver.packCharLimit < normal.packCharLimit);
  assert.equal(saver.hindsight.recall, true);
  assert.equal(saver.hindsight.reflect, false);
});

test("Token Saver permits L0, L1, and one selected L2 but never broad L2", () => {
  const policy = resolveMemoryPolicy({ preset: "token-saver", qualityRequested: "medium" });
  assert.deepEqual(policy.openViking, { l0: true, l1: true, selectedL2: true, broadL2: false });
});

test("normal quality levels compose into bounded increasing evidence budgets", () => {
  const limits = ["low", "medium", "high", "max"].map((quality) => resolveMemoryPolicy({ preset: "normal", qualityRequested: quality }).packCharLimit);
  assert.deepEqual([...limits].sort((a, b) => a - b), limits);
  assert.ok(limits.every((limit) => limit <= 5600));
});

test("Reflect is conditional in high Normal and exceptional-only in high Token Saver", () => {
  const normal = resolveMemoryPolicy({ preset: "normal", qualityRequested: "high" });
  const saver = resolveMemoryPolicy({ preset: "token-saver", qualityRequested: "high" });
  assert.equal(normal.hindsight.reflect, true);
  assert.equal(saver.hindsight.reflect, false);
  assert.equal(saver.hindsight.reflectExceptional, true);
});

test("memory topology exposes every required layer without changing routing config", () => {
  const topology = memoryPolicyTopology(resolveMemoryPolicy());
  assert.match(JSON.stringify(topology), /OpenViking|Hindsight|playbook|Curator|Token Governor/iu);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const routing = JSON.parse(readFileSync(path.join(root, "config", "routing-policy.json"), "utf8"));
  assert.equal(routing.governor.absoluteModelCallCeiling, 42);
  assert.deepEqual(routing.council.members, ["council-1", "council-2", "council-3"]);
});

test("project identity is stable across linked Git worktrees", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-project-id-"));
  try {
    const main = path.join(root, "project");
    const linked = path.join(root, "project-feature");
    const gitDirectory = path.join(main, ".git");
    const linkedGitDirectory = path.join(gitDirectory, "worktrees", "feature");
    fs.mkdirSync(path.join(main, "nested"), { recursive: true });
    fs.mkdirSync(linkedGitDirectory, { recursive: true });
    fs.mkdirSync(linked, { recursive: true });
    fs.writeFileSync(path.join(linked, ".git"), `gitdir: ${linkedGitDirectory}\n`);
    fs.writeFileSync(path.join(linkedGitDirectory, "commondir"), "../..\n");
    assert.equal(deriveProjectIdentity(path.join(main, "nested")), deriveProjectIdentity(linked));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("backend endpoint overrides are restricted to loopback HTTP", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-config-"));
  try {
    const file = path.join(root, "second-brain.json");
    fs.writeFileSync(file, JSON.stringify({ version: 1, enabled: true, openViking: { endpoint: "http://127.0.0.1:1933" }, hindsight: { endpoint: "http://127.0.0.1:8889" } }));
    assert.throws(() => readSecondBrainConfig({ file, environment: { PI_OVERDRIVE_OPENVIKING_URL: "http://memory.example.test" } }), /loopback/u);
    assert.throws(() => readSecondBrainConfig({ file, environment: { PI_OVERDRIVE_HINDSIGHT_URL: "https://127.0.0.1:8889" } }), /loopback/u);
    assert.equal(readSecondBrainConfig({ file, environment: {} }).openViking.endpoint, "http://127.0.0.1:1933");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("default memory storage follows an isolated HOME when XDG_DATA_HOME is absent", () => {
  const isolatedHome = path.join(os.tmpdir(), "pi-memory-isolated-home");
  assert.equal(
    defaultMemoryRoot({ HOME: isolatedHome }),
    path.join(isolatedHome, ".local", "share", "pi-overdrive", "second-brain"),
  );
});
