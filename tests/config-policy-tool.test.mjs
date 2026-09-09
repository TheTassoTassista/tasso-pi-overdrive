import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const script = new URL("../scripts/config-policy-tool.mjs", import.meta.url);

test("managed web policy is reversible and never overwrites credentials or later user choices", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-config-policy-"));
  try {
    const target = path.join(root, "config", "web.json");
    const patch = path.join(root, "policy.json");
    const manifest = path.join(root, "agent", "manifest.json");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify({ provider: "tavily", apiKeys: { brave: "preserve-me" }, otherField: "keep" })}\n`, { mode: 0o600 });
    fs.writeFileSync(patch, `${JSON.stringify({ provider: "brave", guidance: { web_search: { promptGuidelines: ["policy"] } } })}\n`);
    for (const action of ["snapshot", "enable"]) {
      const run = spawnSync(process.execPath, [script.pathname, action, target, patch, manifest], { encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
    }
    const enabled = JSON.parse(fs.readFileSync(target, "utf8"));
    assert.equal(enabled.provider, "brave");
    assert.equal(enabled.apiKeys.brave, "preserve-me");
    assert.equal(enabled.otherField, "keep");
    enabled.provider = "perplexity";
    enabled.apiKeys.perplexity = "also-preserve-me";
    fs.writeFileSync(target, `${JSON.stringify(enabled)}\n`, { mode: 0o600 });
    const disable = spawnSync(process.execPath, [script.pathname, "disable", target, patch, manifest], { encoding: "utf8" });
    assert.equal(disable.status, 0, disable.stderr);
    const restored = JSON.parse(fs.readFileSync(target, "utf8"));
    assert.equal(restored.provider, "perplexity");
    assert.equal(restored.guidance, undefined);
    assert.deepEqual(restored.apiKeys, { brave: "preserve-me", perplexity: "also-preserve-me" });
    assert.equal(fs.statSync(target).mode & 0o077, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
