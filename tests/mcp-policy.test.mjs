import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const config = JSON.parse(fs.readFileSync(new URL("../config/mcp.json", import.meta.url), "utf8"));

test("MCP exposes one lazy proxy with a two-tool read-only server allowlist", () => {
  assert.equal(config.settings.directTools, false);
  assert.equal(config.settings.scriptMode, false);
  assert.equal(config.settings.approveTools, true);
  assert.equal(config.settings.sampling, false);
  assert.equal(config.settings.elicitation, false);
  assert.deepEqual(Object.keys(config.mcpServers), ["context7"]);
  assert.equal(config.mcpServers.context7.lifecycle, "lazy");
  assert.equal(config.mcpServers.context7.exposeResources, false);
  assert.equal(config.mcpServers.context7.directTools, false);
  assert.deepEqual(config.mcpServers.context7.includeTools, ["resolve-library-id", "query-docs"]);
  assert.equal(config.mcpServers.context7.approveTools, false);
});
