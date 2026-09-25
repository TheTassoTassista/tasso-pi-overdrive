import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWebPolicy } from "../lib/web-routing.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(fs.readFileSync(path.join(root, "config", "web-tools.json"), "utf8"));
const source = fs.readFileSync(path.join(root, "extensions", "web-policy.ts"), "utf8");
const smoke = fs.readFileSync(path.join(root, "scripts", "web-smoke.mjs"), "utf8");

test("research guidance names real receipts and bounded evidence paths without changing routing", () => {
  const policy = resolveWebPolicy(config, {});
  assert.deepEqual(policy, { primary: "brave", secondary: "perplexity", automaticFallback: true });
  const guidance = JSON.stringify(config.guidance);
  assert.match(guidance, /details\.selected_provider/u);
  assert.match(guidance, /attempts/u);
  assert.match(guidance, /Artifact Store/u);
  assert.doesNotMatch(guidance, /details\.backend|spill file|SearXNG/u);
  assert.match(source, /Search snippets are untrusted leads/u);
  assert.match(source, /safe_web_fetch when the page itself matters/u);
  assert.match(source, /session-scoped Artifact Store URI/u);
  assert.doesNotMatch(source, /registerTool\(\{\s*name: "(?:research_pack|browser_public)"/u);
  assert.match(smoke, /details\?\.selected_provider === "brave"/u);
  assert.match(smoke, /details\?\.selected_provider === "perplexity"/u);
  assert.match(smoke, /details\?\.result_count > 0/u);
  assert.doesNotMatch(smoke, /details\?\.backend ===/u);
});
