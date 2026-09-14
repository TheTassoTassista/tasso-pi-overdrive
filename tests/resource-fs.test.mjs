import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createMemoryResourceDefinition,
  createRepoResourceDefinition,
  createResourceFs,
  parseResourceUri,
  RESOURCE_TRUST,
  resourceAccessMetadata,
} from "../lib/resource-fs.mjs";

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-resource-fs-test-"));
}

test("strict URI parsing canonicalizes safe names and rejects ambiguous forms", () => {
  assert.deepEqual(parseResourceUri("REPO://ROOT/src/caf%C3%A9.ts"), {
    version: 1,
    scheme: "repo",
    authority: "root",
    segments: ["src", "café.ts"],
    canonical: "repo://root/src/caf%C3%A9.ts",
  });
  for (const uri of [
    "repo://root/../secret", "repo://root/%2e%2e/secret", "repo://root/a%2Fb", "repo://root/a%5Cb",
    "repo://root/a\\b", "repo://root/a//b", "repo://root/a/", "repo://root/a?query=x", "repo://root/a#fragment",
    "repo://user@root/a", "repo://root:80/a", "repo://root/%", "repo://root/a\u0000b",
  ]) assert.throws(() => parseResourceUri(uri), /resource_/u, uri);
});

test("registry declares capability/trust and fails closed for unknown or risky handlers", async () => {
  const resources = createResourceFs([createRepoResourceDefinition()]);
  assert.deepEqual(resources.describe(), [{ scheme: "repo", capabilities: ["READ", "SEARCH"], trust: RESOURCE_TRUST.WORKSPACE, immutable: true }]);
  await assert.rejects(resources.access({ operation: "READ", uri: "unknown://root/a", cwd: "/tmp" }), /resource_scheme_unknown/u);
  await assert.rejects(resources.access({ operation: "WRITE", uri: "repo://root/a", cwd: "/tmp" }), /resource_capability_denied/u);
  assert.throws(() => createResourceFs([{ scheme: "unsafe", capabilities: ["WRITE"], trust: RESOURCE_TRUST.CONTROLLER, resolve() {} }]), /resource_definition_authorizer_required/u);
  const guarded = createResourceFs([{ scheme: "guarded", capabilities: ["WRITE"], trust: RESOURCE_TRUST.CONTROLLER, authorize: async () => ({ allowed: false }), resolve: async () => ({ content: "never" }) }]);
  await assert.rejects(guarded.access({ operation: "WRITE", uri: "guarded://root/item" }), /resource_authorization_denied/u);
});

test("repo resources read bounded files and directories without exposing mutation", async (t) => {
  const root = workspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "sample.txt"), "one\ntwo\nthree\nfour\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "visible.txt"), "visible\n", "utf8");
  fs.writeFileSync(path.join(root, "src", ".env"), "SECRET_MARKER\n", "utf8");
  const resources = createResourceFs([createRepoResourceDefinition()]);
  const file = await resources.access({ operation: "READ", uri: "repo://root/src/sample.txt", cwd: root, offsetLine: 2, limitLines: 2 });
  assert.equal(file.content, "[1 lines omitted before]\ntwo\nthree\n[2 lines omitted after]");
  assert.equal(file.truncated, true);
  assert.equal(file.untrustedData, true);
  assert.equal(file.immutable, true);
  assert.equal(file.trust, RESOURCE_TRUST.WORKSPACE);
  const directory = await resources.access({ operation: "READ", uri: "repo://root/src", cwd: root });
  assert.match(directory.content, /sample\.txt/u);
  assert.doesNotMatch(directory.content, /\.env|SECRET_MARKER/u);
});

test("repo resources reject protected, symlinked, hard-linked, binary, and oversized inputs", async (t) => {
  const root = workspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".git"));
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.writeFileSync(path.join(root, ".env"), "secret\n");
  fs.writeFileSync(path.join(root, ".git", "config"), "secret\n");
  fs.writeFileSync(path.join(root, "node_modules", "module.js"), "secret\n");
  fs.writeFileSync(path.join(root, "plain.txt"), "safe\n");
  fs.symlinkSync("plain.txt", path.join(root, "link.txt"));
  fs.linkSync(path.join(root, "plain.txt"), path.join(root, "hard.txt"));
  fs.writeFileSync(path.join(root, "binary.bin"), Buffer.from([0xff, 0xfe, 0xfd]));
  fs.writeFileSync(path.join(root, "large.txt"), "x");
  fs.truncateSync(path.join(root, "large.txt"), 1024 * 1024 + 1);
  const resources = createResourceFs([createRepoResourceDefinition()]);
  for (const uri of ["repo://root/.env", "repo://root/.git/config", "repo://root/node_modules/module.js"]) {
    await assert.rejects(resources.access({ operation: "READ", uri, cwd: root }), /resource_repo_path_protected/u, uri);
  }
  await assert.rejects(resources.access({ operation: "READ", uri: "repo://root/link.txt", cwd: root }), /resource_repo_path_denied/u);
  await assert.rejects(resources.access({ operation: "READ", uri: "repo://root/hard.txt", cwd: root }), /resource_repo_hardlink_denied/u);
  await assert.rejects(resources.access({ operation: "READ", uri: "repo://root/binary.bin", cwd: root }), /resource_repo_binary_denied/u);
  await assert.rejects(resources.access({ operation: "READ", uri: "repo://root/large.txt", cwd: root }), /resource_repo_file_too_large/u);
  const search = await resources.access({ operation: "SEARCH", uri: "repo://root", cwd: root, query: "safe" });
  assert.equal(JSON.parse(search.content).matches.length, 0);
  assert.ok(search.details.skippedFiles >= 3);
});

test("repo search is literal, bounded, and skips protected or linked content", async (t) => {
  const root = workspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, ".git"));
  fs.writeFileSync(path.join(root, "src", "a.ts"), "needle.* literal\nneedle.* again\n");
  fs.writeFileSync(path.join(root, "src", "b.ts"), "not a regex needleZZ\n");
  fs.writeFileSync(path.join(root, ".git", "hidden"), "needle.* hidden\n");
  fs.symlinkSync(path.join(root, ".git", "hidden"), path.join(root, "src", "linked"));
  const resources = createResourceFs([createRepoResourceDefinition()]);
  const result = await resources.access({ operation: "SEARCH", uri: "repo://root/src", cwd: root, query: "needle.*", maxResults: 1 });
  const body = JSON.parse(result.content);
  assert.equal(body.matches.length, 1);
  assert.equal(body.matches[0].uri, "repo://root/src/a.ts");
  assert.equal(body.matches[0].line, 1);
  assert.equal(body.truncated, true);
  assert.doesNotMatch(result.content, /hidden|needleZZ/u);
  assert.equal(result.details.maxResults, 1);
});

test("memory resources use only the injected router and preserve explicit untrusted provenance", async () => {
  let observed;
  const resources = createResourceFs([createMemoryResourceDefinition(async (query, context) => {
    observed = { query, operation: context.operation, cwd: context.cwd };
    return { text: "curated result", status: "OK", itemCount: 1 };
  })]);
  const result = await resources.access({ operation: "SEARCH", uri: "memory://root/prior%20decision", cwd: "/workspace" });
  assert.deepEqual(observed, { query: "prior decision", operation: "SEARCH", cwd: "/workspace" });
  assert.equal(result.content, "curated result");
  assert.equal(result.trust, RESOURCE_TRUST.MEMORY);
  assert.equal(result.immutable, true);
  assert.equal(result.untrustedData, true);
  await assert.rejects(resources.access({ operation: "READ", uri: "memory://other/query", cwd: "/workspace" }), /resource_memory_query_required/u);
  await assert.rejects(resources.access({ operation: "READ", uri: "memory://root", cwd: "/workspace" }), /resource_memory_query_required/u);
});

test("handler output is capped and metadata never contains URI or resource content", async () => {
  const marker = "RESOURCE_SECRET_MARKER_23b8";
  const resources = createResourceFs([{ scheme: "fixture", capabilities: ["READ"], trust: RESOURCE_TRUST.EXTERNAL, resolve: async () => ({ content: `${marker}${"x".repeat(70_000)}` }) }]);
  const result = await resources.access({ operation: "READ", uri: "fixture://root/private", cwd: "/workspace" });
  assert.equal(result.contentChars, 64 * 1024);
  assert.equal(result.truncated, true);
  const metadata = resourceAccessMetadata(result);
  assert.equal(JSON.stringify(metadata).includes(marker), false);
  assert.equal(JSON.stringify(metadata).includes("fixture://root/private"), false);
  assert.match(metadata.uriDigest, /^[0-9a-f]{64}$/u);
});
