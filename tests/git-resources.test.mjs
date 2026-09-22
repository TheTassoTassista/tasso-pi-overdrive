import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createConflictResourceDefinition, createGitResourceDefinition, createPinnedGitRunner, hardenedGitArguments, hardenedGitEnvironment, readGitResourcePolicy, validateGitResourcePolicy } from "../lib/git-resources.mjs";
import { createResourceFs, RESOURCE_TRUST } from "../lib/resource-fs.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-git-resource-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.name", "Fixture"]);
  execFileSync("git", ["-C", root, "config", "user.email", "fixture@invalid"]);
  fs.writeFileSync(path.join(root, "file.txt"), "base\n", "utf8");
  execFileSync("git", ["-C", root, "add", "file.txt"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "base"]);
  return root;
}

function localRunner(observed = []) {
  return async ({ cwd, args }) => {
    observed.push(args);
    const result = spawnSync("git", ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.external=", ...args], { cwd, encoding: "utf8", maxBuffer: 1024 * 1024 });
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.status ?? 1, killed: Boolean(result.signal) };
  };
}

test("Git and conflict schemes are immutable read-only workspace resources", () => {
  const run = localRunner();
  const resources = createResourceFs([createGitResourceDefinition(run), createConflictResourceDefinition(run)]);
  assert.deepEqual(resources.describe(), [
    { scheme: "git", capabilities: ["READ"], trust: RESOURCE_TRUST.WORKSPACE, immutable: true },
    { scheme: "conflict", capabilities: ["READ"], trust: RESOURCE_TRUST.WORKSPACE, immutable: true },
  ]);
});

test("status, bounded log, branches, exact commit, and worktree/staged diff are readable", async (t) => {
  const root = fixture(t);
  const observed = [];
  const resources = createResourceFs([createGitResourceDefinition(localRunner(observed))]);
  const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  fs.writeFileSync(path.join(root, "file.txt"), "base\nworktree\n", "utf8");
  let result = await resources.access({ operation: "READ", uri: "git://repo/status", cwd: root });
  assert.match(result.content, /M file\.txt/u);
  result = await resources.access({ operation: "READ", uri: "git://repo/log", cwd: root, limitLines: 1 });
  assert.match(result.content, new RegExp(`^${head}`, "u"));
  assert.match((await resources.access({ operation: "READ", uri: "git://repo/branches", cwd: root })).content, /master|main/u);
  assert.match((await resources.access({ operation: "READ", uri: `git://repo/commit/${head}`, cwd: root })).content, /base/u);
  assert.match((await resources.access({ operation: "READ", uri: "git://repo/diff/worktree/file.txt", cwd: root })).content, /\+worktree/u);
  execFileSync("git", ["-C", root, "add", "file.txt"]);
  assert.match((await resources.access({ operation: "READ", uri: "git://repo/diff/staged/file.txt", cwd: root })).content, /\+worktree/u);
  assert.ok(observed.some((args) => args.includes("--no-ext-diff") && args.includes("--no-textconv")));
});

test("Git resource arguments are generated, path-scoped after --, and never accept flags", async (t) => {
  const root = fixture(t);
  const observed = [];
  const resources = createResourceFs([createGitResourceDefinition(localRunner(observed))]);
  fs.writeFileSync(path.join(root, "safe name.txt"), "safe\n");
  await resources.access({ operation: "READ", uri: "git://repo/diff/worktree/safe%20name.txt", cwd: root });
  assert.deepEqual(observed.at(-1).slice(-2), ["--", "safe name.txt"]);
  for (const uri of ["git://repo/diff/worktree/--output=x", "git://repo/diff/worktree/.git/config", "git://repo/diff/worktree/.env"]) await assert.rejects(resources.access({ operation: "READ", uri, cwd: root }), /resource_git_path_protected/u);
});

test("workspace must be the exact repository root and non-repositories fail closed", async (t) => {
  const root = fixture(t);
  const resources = createResourceFs([createGitResourceDefinition(localRunner())]);
  fs.mkdirSync(path.join(root, "sub"));
  await assert.rejects(resources.access({ operation: "READ", uri: "git://repo/status", cwd: path.join(root, "sub") }), /resource_git_workspace_mismatch/u);
  const linked = `${root}-link`;
  fs.symlinkSync(root, linked);
  t.after(() => fs.rmSync(linked, { force: true }));
  await assert.rejects(resources.access({ operation: "READ", uri: "git://repo/status", cwd: linked }), /resource_git_workspace_symlink/u);
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "pi-git-resource-plain-"));
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  await assert.rejects(resources.access({ operation: "READ", uri: "git://repo/status", cwd: plain }), /resource_git_repository_required/u);
});

test("unknown views, abbreviated commits, search, and mutation fail closed", async (t) => {
  const root = fixture(t);
  const resources = createResourceFs([createGitResourceDefinition(localRunner())]);
  for (const uri of ["git://repo/reset", "git://repo/commit/deadbeef", "git://repo/diff/index", "git://elsewhere/status"]) await assert.rejects(resources.access({ operation: "READ", uri, cwd: root }), /resource_git_/u);
  await assert.rejects(resources.access({ operation: "SEARCH", uri: "git://repo/status", cwd: root }), /resource_capability_denied/u);
  await assert.rejects(resources.access({ operation: "WRITE", uri: "git://repo/status", cwd: root }), /resource_capability_denied/u);
  await assert.rejects(resources.access({ operation: "READ", uri: "git://repo/log", cwd: root, limitLines: -1 }), /resource_git_limit_invalid/u);
});

test("conflict list and base/ours/theirs sides are read-only and exact", async (t) => {
  const root = fixture(t);
  const initialBranch = execFileSync("git", ["-C", root, "branch", "--show-current"], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", root, "checkout", "-qb", "other"]);
  fs.writeFileSync(path.join(root, "file.txt"), "theirs\n");
  execFileSync("git", ["-C", root, "commit", "-qam", "theirs"]);
  execFileSync("git", ["-C", root, "checkout", "-q", initialBranch]);
  fs.writeFileSync(path.join(root, "file.txt"), "ours\n");
  execFileSync("git", ["-C", root, "commit", "-qam", "ours"]);
  spawnSync("git", ["-C", root, "merge", "other"], { encoding: "utf8" });
  const resources = createResourceFs([createConflictResourceDefinition(localRunner())]);
  const listed = JSON.parse((await resources.access({ operation: "READ", uri: "conflict://repo/list", cwd: root })).content);
  assert.deepEqual(listed.files, [{ path: "file.txt", stages: [1, 2, 3] }]);
  assert.equal((await resources.access({ operation: "READ", uri: "conflict://repo/base/file.txt", cwd: root })).content.trim(), "base");
  assert.equal((await resources.access({ operation: "READ", uri: "conflict://repo/ours/file.txt", cwd: root })).content.trim(), "ours");
  assert.equal((await resources.access({ operation: "READ", uri: "conflict://repo/theirs/file.txt", cwd: root })).content.trim(), "theirs");
});

test("conflict URI cannot resolve, bulk-write, reveal protected names, or accept missing stages", async (t) => {
  const root = fixture(t);
  const resources = createResourceFs([createConflictResourceDefinition(localRunner())]);
  for (const uri of ["conflict://repo/write/file.txt", "conflict://repo/ours/.env", "conflict://repo/list/extra"]) await assert.rejects(resources.access({ operation: "READ", uri, cwd: root }), /resource_conflict_|resource_git_path_protected/u);
  await assert.rejects(resources.access({ operation: "READ", uri: "conflict://repo/ours/file.txt", cwd: root }), /resource_conflict_side_failed/u);
});

test("output is bounded, control-sanitized, and invalid UTF-8 fails closed", async (t) => {
  const root = fixture(t);
  const policy = { ...readGitResourcePolicy(), maxOutputBytes: 4096 };
  const huge = async ({ args }) => args[0] === "rev-parse" ? ({ code: 0, stdout: `${root}\n`, stderr: "", killed: false }) : ({ code: 0, stdout: `line\u0007\n${"x".repeat(5000)}`, stderr: "", killed: false });
  const resources = createResourceFs([createGitResourceDefinition(huge, policy)]);
  const result = await resources.access({ operation: "READ", uri: "git://repo/status", cwd: root });
  assert.equal(result.truncated, true);
  assert.doesNotMatch(result.content, /\u0007/u);
  const invalid = async ({ args }) => args[0] === "rev-parse" ? ({ code: 0, stdout: `${root}\n`, stderr: "", killed: false }) : ({ code: 0, stdout: "bad\uFFFD", stderr: "", killed: false });
  await assert.rejects(createResourceFs([createGitResourceDefinition(invalid)]).access({ operation: "READ", uri: "git://repo/status", cwd: root }), /resource_git_output_invalid/u);
});

test("policy pins a bounded exact local Git runtime", () => {
  const policy = readGitResourcePolicy();
  assert.equal(policy.binaryPath, "/usr/bin/git");
  assert.equal(policy.binaryVersion, "git version 2.55.0");
  assert.match(policy.binarySha256, /^[0-9a-f]{64}$/u);
  assert.throws(() => validateGitResourcePolicy({ ...policy, maxOutputBytes: 10 * 1024 * 1024 }), /resource_git_limit_invalid/u);
});

test("production runner attests Git, clears inherited controls, and reads locally", async (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "file.txt"), "changed\n");
  const policy = readGitResourcePolicy();
  const resources = createResourceFs([createGitResourceDefinition(createPinnedGitRunner(policy), policy)]);
  assert.match((await resources.access({ operation: "READ", uri: "git://repo/status", cwd: root })).content, /M file\.txt/u);
  const environment = hardenedGitEnvironment();
  assert.deepEqual(Object.keys(environment).sort(), ["GIT_ATTR_NOSYSTEM", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_SYSTEM", "GIT_LITERAL_PATHSPECS", "GIT_OPTIONAL_LOCKS", "GIT_PAGER", "GIT_TERMINAL_PROMPT", "LANG", "LC_ALL", "NO_COLOR"]);
  const argv = hardenedGitArguments(["status"]);
  for (const required of ["--no-pager", "--no-optional-locks", "core.fsmonitor=false", "core.hooksPath=/dev/null", "diff.external=", "protocol.ext.allow=never", "protocol.file.allow=never"]) assert.ok(argv.includes(required), required);
});

test("production runner kills Git when the hard output ceiling is crossed", async (t) => {
  const root = fixture(t);
  for (let index = 0; index < 180; index += 1) fs.writeFileSync(path.join(root, `untracked-${String(index).padStart(3, "0")}-${"x".repeat(24)}.txt`), "x\n");
  const policy = { ...readGitResourcePolicy(), maxOutputBytes: 4096 };
  const resources = createResourceFs([createGitResourceDefinition(createPinnedGitRunner(policy), policy)]);
  await assert.rejects(resources.access({ operation: "READ", uri: "git://repo/status", cwd: root }), /resource_git_output_limit_exceeded/u);
});
