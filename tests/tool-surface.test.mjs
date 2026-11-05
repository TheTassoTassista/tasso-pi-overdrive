import test from "node:test";
import assert from "node:assert/strict";
import { CORE_TOOLS, hasExplicitBackgroundWorkerSafeExec, selectInitialToolSurface } from "../extensions/tool-surface.ts";

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
