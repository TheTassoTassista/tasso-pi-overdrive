import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { subagentDelegationRequest } from "../lib/subagent-delegation-request.mjs";

const upstreamRoot = path.join(process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"), "npm", "node_modules", "pi-subagents");
const requireFromUpstream = createRequire(path.join(upstreamRoot, "package.json"));
const { createJiti } = await import(requireFromUpstream.resolve("jiti"));
const jiti = createJiti(import.meta.url);
const { parseSubagentDelegationRequest } = await jiti.import(path.join(upstreamRoot, "src", "slash", "delegation-request.ts"));

test("secure workflow sends only fields accepted by the installed structured delegation API", () => {
  const source = fs.readFileSync(new URL("../extensions/secure-workflow.ts", import.meta.url), "utf8");
  assert.match(source, /pi\.events\.emit\(REQUEST_EVENT, subagentDelegationRequest\(\{/u);
  const request = subagentDelegationRequest({
    requestId: "test-request", ownerRunId: "test-owner", nodeId: "01-scout", agent: "scout",
    task: "Inspect a harmless local fixture", context: "fresh", cwd: os.tmpdir(),
    model: "openai-codex/gpt-6-luna", thinking: "low", timeoutMs: 30_000,
    toolBudget: { soft: 24, hard: 40, block: ["subagent", "bash"] },
    artifacts: false, result: { kind: "text" },
    harnessProfile: { internalOnly: true },
  });
  assert.equal(Object.hasOwn(request, "harnessProfile"), false);
  const parsed = parseSubagentDelegationRequest(request);
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.error);
  assert.equal(parseSubagentDelegationRequest({ ...request, harnessProfile: {} }).ok, false);
});
