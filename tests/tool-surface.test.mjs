import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import toolSurface, { CORE_TOOLS, hasExplicitBackgroundWorkerSafeExec, selectInitialToolSurface } from "../extensions/tool-surface.ts";

test("default surface is reduced to the compact core plus one MCP proxy", () => {
  const all = [...CORE_TOOLS, "edit", "bash", "fffind", "agent_browser", "subagent"];
  assert.deepEqual(selectInitialToolSurface(all, all, ["--offline"]), [...CORE_TOOLS]);
  assert.equal(CORE_TOOLS.includes("edit"), false);
  assert.ok(CORE_TOOLS.includes("transactional_edit"));
});

test("explicit CLI tool policies are never overridden", () => {
  for (const flag of ["--tools", "-t", "--no-tools", "-nt", "--exclude-tools", "-xt"]) {
    assert.deepEqual(selectInitialToolSurface(["fffind"], [...CORE_TOOLS, "fffind"], [flag, "fffind"]), ["fffind"]);
  }
  assert.deepEqual(selectInitialToolSurface(["read"], [...CORE_TOOLS], ["--tools=read"]), ["read"]);
});

test("only an explicit background Worker SDK surface can preserve safe_exec", () => {
  const base = {
    active: ["read", "safe_exec"],
    available: ["read", "safe_exec"],
    systemPrompt: '<active_agent name="worker"/>\n\nWork in the assigned worktree.',
    environment: { PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_RUNNER_PID: "4312" },
    pid: 4312,
  };
  assert.equal(hasExplicitBackgroundWorkerSafeExec(base), true);
  assert.equal(hasExplicitBackgroundWorkerSafeExec({ ...base, active: ["read"] }), false);
  assert.equal(hasExplicitBackgroundWorkerSafeExec({ ...base, available: ["read"] }), false);
  assert.equal(hasExplicitBackgroundWorkerSafeExec({ ...base, systemPrompt: '<active_agent name="tester"/>' }), false);
  assert.equal(hasExplicitBackgroundWorkerSafeExec({ ...base, environment: { PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_RUNNER_PID: "9999" } }), false);
  assert.equal(hasExplicitBackgroundWorkerSafeExec({ ...base, environment: {} }), false);
});

test("Pi before_agent_start contract activates task-governed tools without a messageType field", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "phi-tool-surface-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const policyFile = path.join(directory, "model-policy.json");
  fs.writeFileSync(policyFile, JSON.stringify({ version: 2, preset: "normal", basePreset: "normal", overrides: {} }), { mode: 0o600 });
  const priorPolicy = process.env.PI_OVERDRIVE_MODEL_POLICY;
  process.env.PI_OVERDRIVE_MODEL_POLICY = policyFile;
  t.after(() => { if (priorPolicy === undefined) delete process.env.PI_OVERDRIVE_MODEL_POLICY; else process.env.PI_OVERDRIVE_MODEL_POLICY = priorPolicy; });

  const hooks = new Map();
  const names = [...new Set([...CORE_TOOLS, "ffgrep", "fffind", "ast_grep_run", "semantic_nav", "task_notebook", "verification_gate", "secure_coding_workflow", "debug_engine", "persistent_python", "persistent_javascript", "safe_exec", "bash", "mcp", "web_research", "safe_web_fetch"])];
  let active = [...names];
  const metadata = [];
  const pi = {
    on: (event, handler) => hooks.set(event, handler),
    getActiveTools: () => [...active],
    getAllTools: () => names.map((name) => ({ name })),
    setActiveTools: (tools) => { active = [...tools]; },
    registerCommand: () => {},
    events: { emit: (_name, value) => metadata.push(value) },
  };
  toolSurface(pi);
  hooks.get("session_start")({}, { getSystemPrompt: () => "fixture system prompt" });
  const model = { provider: "openai-codex", id: "gpt-6-sol", reasoning: true, contextWindow: 128000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const ctx = { cwd: directory, model, modelRegistry: { getAll: () => [model], getAvailable: () => [model] }, getContextUsage: () => undefined, getSystemPrompt: () => "fixture system prompt", ui: { setStatus: () => {} } };
  const event = (prompt) => ({ type: "before_agent_start", prompt, images: undefined, systemPrompt: "fixture system prompt", systemPromptOptions: {} });
  assert.equal(Object.hasOwn(event("Change one string value."), "messageType"), false);

  hooks.get("before_agent_start")(event("Change one string value in src/config.ts."), ctx);
  assert.ok(active.includes("transactional_edit"), "ordinary edit uses the governed transactional editor");
  assert.equal(active.includes("write"), false, "raw write remains excluded by the exact model edit contract");
  assert.equal(active.includes("bash"), false, "controller-only shell is not exposed");

  hooks.get("before_agent_start")(event("Find and fix the intermittent race condition under load in src/queue.ts."), ctx);
  for (const name of ["debug_engine", "persistent_python", "persistent_javascript"]) assert.ok(active.includes(name), name);
  assert.equal(active.includes("write"), false);
  assert.equal(active.includes("safe_exec"), false, "hidden execution remains unavailable outside the explicit Worker SDK binding");
  assert.ok(metadata.some((item) => item?.kind === "tool_governor_surface" && item.activeTools.includes("debug_engine")));
});

test("the explicit background Worker safe_exec survives the real Pi prompt event only for an allowed model profile", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "phi-worker-tool-surface-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const policyFile = path.join(directory, "model-policy.json");
  fs.writeFileSync(policyFile, JSON.stringify({ version: 2, preset: "normal", basePreset: "normal", overrides: {} }), { mode: 0o600 });
  const previous = {
    modelPolicy: process.env.PI_OVERDRIVE_MODEL_POLICY,
    child: process.env.PI_SUBAGENT_CHILD,
    runnerPid: process.env.PI_SUBAGENT_RUNNER_PID,
  };
  process.env.PI_OVERDRIVE_MODEL_POLICY = policyFile;
  process.env.PI_SUBAGENT_CHILD = "1";
  process.env.PI_SUBAGENT_RUNNER_PID = String(process.pid);
  t.after(() => {
    for (const [key, value] of Object.entries({
      PI_OVERDRIVE_MODEL_POLICY: previous.modelPolicy,
      PI_SUBAGENT_CHILD: previous.child,
      PI_SUBAGENT_RUNNER_PID: previous.runnerPid,
    })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  const names = [...new Set([...CORE_TOOLS, "safe_exec", "bash", "debug_engine", "persistent_python", "persistent_javascript"])];
  const run = (model) => {
    const hooks = new Map();
    let active = [...names];
    const pi = {
      on: (event, handler) => hooks.set(event, handler),
      getActiveTools: () => [...active],
      getAllTools: () => names.map((name) => ({ name })),
      setActiveTools: (tools) => { active = [...tools]; },
      registerCommand: () => {},
      events: { emit: () => {} },
    };
    toolSurface(pi);
    const ctx = {
      cwd: directory,
      model,
      modelRegistry: { getAll: () => [model], getAvailable: () => [model] },
      getContextUsage: () => undefined,
      getSystemPrompt: () => '<active_agent name="worker"/>\n\nWork in the assigned isolated worktree.',
      ui: { setStatus: () => {} },
    };
    hooks.get("session_start")({}, ctx);
    const event = { type: "before_agent_start", prompt: "Search the project for the call site and report the matching file.", images: undefined, systemPrompt: ctx.getSystemPrompt(), systemPromptOptions: {} };
    assert.equal(Object.hasOwn(event, "messageType"), false);
    hooks.get("before_agent_start")(event, ctx);
    return active;
  };

  const allowed = { provider: "openai-codex", id: "gpt-6-sol", reasoning: true, contextWindow: 128000, maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const denied = { ...allowed, provider: "unverified-fixture-provider", id: "unverified" };
  const allowedSurface = run(allowed);
  assert.ok(allowedSurface.includes("safe_exec"), "only the explicitly marked Worker retains its declared execution tool");
  assert.equal(allowedSurface.includes("write"), false, "raw write is not activated by a read-only Worker task");
  assert.equal(allowedSurface.includes("bash"), false, "general shell stays unavailable");
  for (const name of ["debug_engine", "persistent_python", "persistent_javascript"]) assert.equal(allowedSurface.includes(name), false, `${name} stays task-conditional`);
  const deniedSurface = run(denied);
  assert.equal(deniedSurface.includes("safe_exec"), false, "the generic model profile denial overrides the Worker marker");
});
