import test from "node:test";
import assert from "node:assert/strict";
import { providerSystemPrompt, providerTools } from "./fixtures/provider-context-compat.ts";

const tool = (name) => ({ name, description: name, parameters: { type: "object", properties: {} } });

test("provider fixture reads legacy top-level prompt and tools", () => {
  const context = { systemPrompt: "legacy marker", tools: [tool("read")], messages: [] };
  assert.equal(providerSystemPrompt(context), "legacy marker");
  assert.deepEqual(providerTools(context).map((item) => item.name), ["read"]);
});

test("provider fixture replays normalized system prompt and tool changes", () => {
  const context = { messages: [
    { role: "system", content: "base marker", sections: { guidance: "old rule" }, toolsAdded: [tool("read"), tool("edit")] },
    { role: "user", content: "task" },
    { role: "system", content: "later marker", sections: { guidance: "new rule" }, toolsRemoved: [{ name: "edit" }], toolsAdded: [tool("search")] },
  ] };
  assert.equal(providerSystemPrompt(context), "base marker\nlater marker\nnew rule");
  assert.deepEqual(providerTools(context).map((item) => item.name), ["read", "search"]);
});
