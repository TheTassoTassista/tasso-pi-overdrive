import test from "node:test";
import assert from "node:assert/strict";
import { CORE_TOOLS, selectInitialToolSurface } from "../extensions/tool-surface.ts";

test("default surface is reduced to the compact core plus one MCP proxy", () => {
  const all = [...CORE_TOOLS, "bash", "fffind", "agent_browser", "subagent"];
  assert.deepEqual(selectInitialToolSurface(all, all, ["--offline"]), [...CORE_TOOLS]);
});

test("explicit CLI tool policies are never overridden", () => {
  for (const flag of ["--tools", "-t", "--no-tools", "-nt", "--exclude-tools", "-xt"]) {
    assert.deepEqual(selectInitialToolSurface(["fffind"], [...CORE_TOOLS, "fffind"], [flag, "fffind"]), ["fffind"]);
  }
});
