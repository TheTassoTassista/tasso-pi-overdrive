import test from "node:test";
import assert from "node:assert/strict";
import { CORE_TOOLS, selectInitialToolSurface } from "../extensions/tool-surface.ts";

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
