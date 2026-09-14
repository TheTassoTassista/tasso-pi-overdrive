import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { smartReadMetadata, smartReadRepo } from "../lib/smart-read.mjs";

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smart-read-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function largeTypeScript(count = 70) {
  const functions = Array.from({ length: count }, (_, index) => [
    `export function handler${index}(value: string): string {`,
    `  const normalized = value.trim(); // body ${index}`,
    `  return normalized + "-${index}";`,
    `}`,
  ].join("\n"));
  return `import fs from "node:fs";\nimport path from "node:path";\n\nexport class ModelRouter {\n  resolve(input: string): string { return input; }\n}\n\n${functions.join("\n\n")}\n`;
}

test("auto preserves small source verbatim and invokes no symbol provider", async (t) => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, "small.ts"), "import x from 'x';\nexport function small() { return x; }\n");
  let calls = 0;
  const result = await smartReadRepo({ cwd: root, source: "small.ts", mode: "auto", symbolProvider: async () => { calls += 1; } });
  assert.equal(result.selectedMode, "raw");
  assert.equal(result.content, "import x from 'x';\nexport function small() { return x; }\n");
  assert.equal(calls, 0);
});

test("task focus can retain a relevant declaration beyond the first 200 symbols", async (t) => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, "many-symbols.ts"), largeTypeScript(240).replaceAll("handler239", "targetHandler"));
  const result = await smartReadRepo({ cwd: root, source: "many-symbols.ts", mode: "smart", targetChars: 3000, taskContext: "Inspect targetHandler." });
  assert.equal(result.declarationCount, 241);
  assert.match(result.content, /function targetHandler lines 1203-1206/u);
  assert.ok(result.suggestedRanges.some((entry) => entry.name === "targetHandler" && entry.start === 1203));
});

test("auto summarizes a large source with metadata, imports, declarations, omissions, and exact ranges", async (t) => {
  const root = workspace(t);
  const source = largeTypeScript();
  fs.writeFileSync(path.join(root, "router.ts"), source);
  const result = await smartReadRepo({ cwd: root, source: "repo://root/router.ts", mode: "auto", targetChars: 3000, taskContext: "Inspect handler69 routing." });
  assert.equal(result.selectedMode, "smart");
  assert.equal(result.parser, "deterministic-parser");
  assert.match(result.content, /Imports\/includes:/u);
  assert.match(result.content, /class ModelRouter lines \d+-\d+/u);
  assert.match(result.content, /function handler69 lines \d+-\d+/u);
  assert.match(result.content, /Suggested exact ranges:/u);
  assert.match(result.content, /source lines omitted from structural view/u);
  assert.ok(result.outputChars <= 3000);
  assert.ok(result.reductionPercent > 50);
  assert.equal(result.untrustedData, true);
});

test("LSP symbols enrich deterministic structure and LSP failure falls back", async (t) => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, "symbols.ts"), largeTypeScript());
  const enriched = await smartReadRepo({
    cwd: root,
    source: "symbols.ts",
    mode: "smart",
    symbolProvider: async () => ({ status: "PASS", entries: [{ name: "ModelRouter", kind: 5, location: { start: { line: 4 }, end: { line: 4 } } }] }),
  });
  assert.equal(enriched.lspStatus, "PASS");
  assert.equal(enriched.parser, "lsp+deterministic-parser");
  assert.match(enriched.content, /class ModelRouter/u);
  const degraded = await smartReadRepo({ cwd: root, source: "symbols.ts", mode: "smart", symbolProvider: async () => { throw new Error("backend secret"); } });
  assert.equal(degraded.lspStatus, "FAIL");
  assert.equal(degraded.parser, "deterministic-parser");
  assert.doesNotMatch(JSON.stringify(smartReadMetadata(degraded)), /backend secret/u);
});

test("range mode is exact, numbered, bounded, and carries reopen markers", async (t) => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, "lines.ts"), Array.from({ length: 600 }, (_, index) => `line-${index + 1}`).join("\n"));
  const result = await smartReadRepo({ cwd: root, source: "lines.ts", mode: "range", offsetLine: 250, limitLines: 3 });
  assert.equal(result.selectedMode, "range");
  assert.match(result.content, /^\[249 lines omitted before;/u);
  assert.match(result.content, /250\|line-250\n251\|line-251\n252\|line-252/u);
  assert.match(result.content, /\[348 lines omitted after;/u);
  assert.deepEqual(result.range, { start: 250, end: 252 });
  await assert.rejects(smartReadRepo({ cwd: root, source: "lines.ts", mode: "range", offsetLine: 1, limitLines: 501 }), /smart_read_range_limit_invalid/u);
});

test("raw mode is bounded and explicitly directs oversized content to ranges", async (t) => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, "raw.ts"), `export const value = "${"x".repeat(70_000)}";\n`);
  const result = await smartReadRepo({ cwd: root, source: "raw.ts", mode: "raw" });
  assert.equal(result.selectedMode, "raw");
  assert.equal(result.truncated, true);
  assert.ok(result.content.length < 66_000);
  assert.match(result.content, /characters omitted; use range mode/u);
});

test("forced smart mode has a bounded deterministic line fallback for prose", async (t) => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, "notes.txt"), Array.from({ length: 300 }, (_, index) => `prose ${index + 1}`).join("\n"));
  const auto = await smartReadRepo({ cwd: root, source: "notes.txt", mode: "auto" });
  assert.equal(auto.selectedMode, "raw");
  const smart = await smartReadRepo({ cwd: root, source: "notes.txt", mode: "smart", targetChars: 2000 });
  assert.equal(smart.parser, "line-fallback");
  assert.match(smart.content, /Deterministic line fallback:/u);
  assert.match(smart.content, /1\|prose 1/u);
  assert.match(smart.content, /300\|prose 300/u);
  assert.ok(smart.outputChars <= 2000);
});

test("language fallbacks locate major declarations across supported syntax families", async (t) => {
  const root = workspace(t);
  const fixtures = {
    "main.py": "import os\n\nclass Router:\n    pass\n\ndef resolve(value):\n    return value\n",
    "main.go": "package main\n\ntype Router struct {}\nfunc Resolve(value string) string { return value }\n",
    "main.rs": "use std::path::Path;\n\npub struct Router {}\npub fn resolve(value: &str) -> &str { value }\n",
    "main.cpp": "#include <string>\nclass Router {};\nstd::string resolve(std::string value) { return value; }\n",
    "main.sh": "source ./common.sh\nresolve() {\n  printf '%s' \"$1\"\n}\n",
  };
  for (const [file, content] of Object.entries(fixtures)) {
    fs.writeFileSync(path.join(root, file), content);
    const result = await smartReadRepo({ cwd: root, source: file, mode: "smart" });
    assert.ok(result.declarationCount >= 1, file);
    assert.match(result.content, /Router|resolve|Resolve/u, file);
  }
});

test("SmartRead inherits ResourceFS secret, traversal, symlink, and hard-link denial", async (t) => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, ".env"), "SECRET_VALUE\n");
  fs.writeFileSync(path.join(root, "safe.ts"), "export const safe = true;\n");
  fs.symlinkSync("safe.ts", path.join(root, "link.ts"));
  fs.linkSync(path.join(root, "safe.ts"), path.join(root, "hard.ts"));
  await assert.rejects(smartReadRepo({ cwd: root, source: ".env", mode: "raw" }), /resource_repo_path_protected/u);
  await assert.rejects(smartReadRepo({ cwd: root, source: "../outside.ts", mode: "raw" }), /resource_repo_path_denied/u);
  await assert.rejects(smartReadRepo({ cwd: root, source: "link.ts", mode: "raw" }), /resource_repo_path_denied/u);
  await assert.rejects(smartReadRepo({ cwd: root, source: "hard.ts", mode: "raw" }), /resource_repo_hardlink_denied/u);
});

test("SmartRead metadata contains only bounded metrics and digests", async (t) => {
  const root = workspace(t);
  const marker = "PRIVATE_TASK_MARKER_0291";
  fs.writeFileSync(path.join(root, "private-name.ts"), largeTypeScript());
  const result = await smartReadRepo({ cwd: root, source: "private-name.ts", mode: "smart", taskContext: marker });
  const metadata = smartReadMetadata(result);
  const serialized = JSON.stringify(metadata);
  assert.equal(serialized.includes(marker), false);
  assert.equal(serialized.includes("private-name.ts"), false);
  assert.equal(serialized.includes("handler0"), false);
  assert.match(metadata.uriDigest, /^[0-9a-f]{64}$/u);
  assert.match(metadata.contentDigest, /^[0-9a-f]{64}$/u);
});
