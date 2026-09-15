import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createArtifactResourceDefinition, createResourceFs } from "../lib/resource-fs.mjs";
import { createArtifactStore, pruneArtifactStore, readArtifactPolicy, sanitizeArtifactText } from "../lib/artifact-store.mjs";

function fixture(t, options = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifact-store-test-"));
  const workspace = path.join(base, "workspace");
  const root = path.join(base, "state", "pi-overdrive", "artifacts");
  fs.mkdirSync(workspace, { recursive: true });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const store = createArtifactStore({ root, cwd: workspace, sessionIdentity: options.sessionIdentity ?? "session-a", policy: options.policy });
  return { base, workspace, root, store };
}

test("content-addressed artifacts round-trip with private metadata, ranges, and search", async (t) => {
  const { store } = fixture(t);
  const content = Array.from({ length: 300 }, (_, index) => index === 249 ? "ERROR deterministic failure" : `line-${index + 1}`).join("\n");
  const saved = await store.save(content, { producerTool: "safe_exec", taskDigest: "a".repeat(64), mime: "text/plain" });
  assert.match(saved.metadata.uri, /^artifact:\/\/[0-9a-f]{64}$/u);
  assert.equal(saved.metadata.sha256, saved.metadata.id);
  assert.equal(saved.metadata.sessionDigest.length, 64);
  assert.deepEqual(saved.metadata.taskDigests, ["a".repeat(64)]);
  assert.deepEqual(saved.metadata.producerTools, ["safe_exec"]);
  assert.equal(saved.metadata.trust, "TOOL_OUTPUT_UNTRUSTED");
  assert.equal(saved.metadata.immutable, true);
  const range = store.read(saved.metadata.id, { offsetLine: 249, limitLines: 3 });
  assert.match(range.content, /249\|line-249\n250\|ERROR deterministic failure\n251\|line-251/u);
  assert.deepEqual(range.details.range, { start: 249, end: 251 });
  const search = store.search(saved.metadata.id, "deterministic failure");
  assert.deepEqual(JSON.parse(search.content).matches, [{ line: 250, preview: "ERROR deterministic failure" }]);
  for (const entry of fs.readdirSync(store.scopeRoot)) {
    const stat = fs.lstatSync(path.join(store.scopeRoot, entry));
    assert.equal(stat.mode & 0o077, 0, entry);
    assert.equal(stat.nlink, 1, entry);
  }
  assert.equal(fs.lstatSync(store.scopeRoot).mode & 0o077, 0);
});

test("concurrent duplicates serialize to one object and merge bounded provenance", async (t) => {
  const { store } = fixture(t);
  const [first, second] = await Promise.all([
    store.save("same bytes", { producerTool: "safe_exec", taskDigest: "a".repeat(64) }),
    store.save("same bytes", { producerTool: "tester/log", taskDigest: "b".repeat(64) }),
  ]);
  assert.equal(first.metadata.id, second.metadata.id);
  assert.equal(first.metadata.deduplicated, false);
  assert.equal(second.metadata.deduplicated, true);
  assert.deepEqual(second.metadata.producerTools, ["safe_exec", "tester_log"]);
  assert.deepEqual(second.metadata.taskDigests, ["a".repeat(64), "b".repeat(64)]);
  assert.equal(store.list().length, 1);
  assert.equal(fs.readdirSync(store.scopeRoot).filter((name) => name.endsWith(".data")).length, 1);
});

test("artifact IDs do not grant cross-session access", async (t) => {
  const { root, workspace, store } = fixture(t);
  const saved = await store.save("isolated content", { producerTool: "fixture" });
  const other = createArtifactStore({ root, cwd: workspace, sessionIdentity: "session-b" });
  assert.notEqual(other.scopeDigest, store.scopeDigest);
  assert.throws(() => other.read(saved.metadata.id), /artifact_not_found/u);
});

test("secret-like data and terminal controls are removed before persistence and preview", async (t) => {
  const { store } = fixture(t);
  const secret = "api_key=super-secret-value-12345";
  const privateKey = "-----BEGIN PRIVATE KEY-----\nprivate-key-body\n-----END PRIVATE KEY-----";
  const saved = await store.save(`\u001b[31m${secret}\u001b[0m\n${privateKey}\nERROR visible`, { producerTool: "bash" });
  const data = fs.readFileSync(path.join(store.scopeRoot, `${saved.metadata.id}.data`), "utf8");
  assert.equal(data.includes(secret), false);
  assert.equal(saved.preview.includes(secret), false);
  assert.equal(data.includes("\u001b"), false);
  assert.equal(data.includes("private-key-body"), false);
  assert.match(data, /\[REDACTED\]/u);
  assert.equal(saved.metadata.redacted, true);
  assert.equal(saved.metadata.sanitizedControls, true);
  assert.equal(JSON.stringify(saved.metadata).includes(secret), false);
});

test("preview externalizes bulk while preserving every critical diagnostic", async (t) => {
  const { store } = fixture(t);
  const critical = ["FATAL first", "AssertionError middle", "ERROR late", "panic last"];
  const content = [critical[0], ...Array.from({ length: 300 }, (_, index) => `noise ${index}`), critical[1], ...Array.from({ length: 300 }, (_, index) => `bulk ${index}`), critical[2], ...Array.from({ length: 300 }, (_, index) => `tail-noise ${index}`), critical[3]].join("\n");
  const saved = await store.save(content, { producerTool: "verification_gate" });
  for (const marker of critical) assert.match(saved.preview, new RegExp(marker, "u"));
  assert.match(saved.preview, new RegExp(saved.metadata.uri, "u"));
  assert.doesNotMatch(saved.preview, /noise 200\n/u);
  assert.ok(saved.preview.length < content.length);
});

test("item, scope, and count quotas fail closed", async (t) => {
  const basePolicy = readArtifactPolicy();
  const itemPolicy = { ...basePolicy, maxArtifactBytes: 64 * 1024, maxScopeBytes: 128 * 1024 };
  const item = fixture(t, { policy: itemPolicy }).store;
  await assert.rejects(item.save("x".repeat(64 * 1024 + 1)), /artifact_item_quota_exceeded/u);
  await assert.rejects(item.save(`api_key=${"x".repeat(64 * 1024)}`), /artifact_item_quota_exceeded/u);
  const count = fixture(t, { policy: { ...basePolicy, maxArtifactsPerScope: 1 } }).store;
  await count.save("one");
  await assert.rejects(count.save("two"), /artifact_count_quota_exceeded/u);
  const scope = fixture(t, { policy: { ...basePolicy, maxArtifactBytes: 64 * 1024, maxScopeBytes: 64 * 1024, maxArtifactsPerScope: 2 } }).store;
  await scope.save("a".repeat(40_000));
  await assert.rejects(scope.save("b".repeat(40_000)), /artifact_scope_quota_exceeded/u);
});

test("symlink and hard-link substitution cannot escape or spoof artifact reads", async (t) => {
  const { base, store } = fixture(t);
  const outside = path.join(base, "outside");
  fs.writeFileSync(outside, "outside secret");
  const linked = await store.save("linked content", { producerTool: "fixture" });
  const data = path.join(store.scopeRoot, `${linked.metadata.id}.data`);
  fs.unlinkSync(data);
  fs.symlinkSync(outside, data);
  assert.throws(() => store.read(linked.metadata.id), /artifact_file_unsafe|artifact_file_open_failed/u);
  fs.unlinkSync(data);
  fs.linkSync(outside, data);
  assert.throws(() => store.read(linked.metadata.id), /artifact_file_unsafe/u);
  assert.equal(fs.readFileSync(outside, "utf8"), "outside secret");
});

test("artifact ResourceFS handler enforces canonical hash URIs and session scope", async (t) => {
  const { store } = fixture(t);
  const saved = await store.save("alpha\nneedle\nomega", { producerTool: "fixture" });
  const resources = createResourceFs([createArtifactResourceDefinition(() => store)]);
  const read = await resources.access({ operation: "READ", uri: saved.metadata.uri, offsetLine: 2, limitLines: 1 });
  assert.match(read.content, /2\|needle/u);
  assert.equal(read.trust, "TOOL_OUTPUT_UNTRUSTED");
  const search = await resources.access({ operation: "SEARCH", uri: saved.metadata.uri, query: "needle" });
  assert.equal(JSON.parse(search.content).matches[0].line, 2);
  await assert.rejects(resources.access({ operation: "READ", uri: "artifact://not-a-hash" }), /resource_artifact_uri_invalid/u);
  await assert.rejects(resources.access({ operation: "READ", uri: `artifact://${"a".repeat(65)}` }), /resource_authority_invalid/u);
  await assert.rejects(resources.access({ operation: "READ", uri: `${saved.metadata.uri}/escape` }), /resource_artifact_uri_invalid/u);
});

test("tampered manifest metadata fails closed before artifact bytes are returned", async (t) => {
  const { store } = fixture(t);
  const saved = await store.save("manifest integrity", { producerTool: "fixture" });
  const manifestPath = path.join(store.scopeRoot, `${saved.metadata.id}.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.producerTools = [];
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  assert.throws(() => store.read(saved.metadata.id), /artifact_manifest_invalid/u);
});

test("retention is independent, manifest-expiry based, and never follows hostile scope symlinks", async (t) => {
  const { base, root, store } = fixture(t);
  const saved = await store.save("expiring", { producerTool: "fixture", nowMs: 0 });
  const dry = pruneArtifactStore({ root, nowMs: 8 * 86_400_000, apply: false });
  assert.equal(dry.eligibleArtifacts, 1);
  assert.equal(store.read(saved.metadata.id).details.id, saved.metadata.id);
  const outside = path.join(base, "outside-retention");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "keep"), "keep");
  fs.symlinkSync(outside, path.join(root, "f".repeat(64)));
  fs.writeFileSync(path.join(store.scopeRoot, "unrelated-user-file"), "leave untouched");
  const applied = pruneArtifactStore({ root, nowMs: 8 * 86_400_000, apply: true });
  assert.equal(applied.removedArtifacts, 1);
  assert.equal(fs.readFileSync(path.join(outside, "keep"), "utf8"), "keep");
  assert.throws(() => store.read(saved.metadata.id), /artifact_not_found/u);
});

test("retention removes only stale private orphan objects and interrupted-write temporaries", async (t) => {
  const { base, root, store } = fixture(t);
  await store.save("live artifact", { producerTool: "fixture" });
  const orphanId = "c".repeat(64);
  const orphanData = path.join(store.scopeRoot, `${orphanId}.data`);
  const temporary = path.join(store.scopeRoot, `.${"d".repeat(64)}.123.${"e".repeat(16)}.tmp`);
  const outside = path.join(base, "outside-orphan");
  const linked = path.join(store.scopeRoot, `${"f".repeat(64)}.data`);
  fs.writeFileSync(orphanData, "orphan", { mode: 0o600 });
  fs.writeFileSync(temporary, "temporary", { mode: 0o600 });
  fs.writeFileSync(outside, "outside", { mode: 0o600 });
  fs.symlinkSync(outside, linked);
  fs.utimesSync(orphanData, 0, 0);
  fs.utimesSync(temporary, 0, 0);
  const result = pruneArtifactStore({ root, nowMs: 8 * 86_400_000, apply: true });
  assert.equal(result.scannedOrphans, 3);
  assert.equal(result.eligibleOrphans, 2);
  assert.equal(result.removedOrphans, 2);
  assert.equal(fs.existsSync(orphanData), false);
  assert.equal(fs.existsSync(temporary), false);
  assert.equal(fs.readFileSync(outside, "utf8"), "outside");
  assert.equal(fs.lstatSync(linked).isSymbolicLink(), true);
});

test("sanitizer is deterministic and never hashes or returns raw secret material", () => {
  const input = "Bearer abcdefghijklmnopqrstuvwxyz\nplain";
  assert.deepEqual(sanitizeArtifactText(input), sanitizeArtifactText(input));
  assert.equal(sanitizeArtifactText(input).text.includes("abcdefghijklmnopqrstuvwxyz"), false);
});
