import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AtomicCommitPlanner, commitPlanMetadata, parseCommitDiffHunks, readCommitPlannerPolicy, validateCommitPlannerPolicy } from "../lib/commit-planner.mjs";
import { createPinnedGitRunner, readGitResourcePolicy } from "../lib/git-resources.mjs";

function git(root, args) { return execFileSync("/usr/bin/git", ["-C", root, ...args], { encoding: "utf8" }).trim(); }

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-commit-plan-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Fixture"]);
  git(root, ["config", "user.email", "fixture@invalid"]);
  fs.writeFileSync(path.join(root, "alpha.txt"), `${Array.from({ length: 30 }, (_, index) => `alpha-${index}`).join("\n")}\n`);
  fs.writeFileSync(path.join(root, "beta.txt"), "beta\n");
  git(root, ["add", "alpha.txt", "beta.txt"]);
  git(root, ["commit", "-qm", "base"]);
  return root;
}

function planner(root, options = {}) {
  const gitPolicy = readGitResourcePolicy();
  const runGit = options.runGit ?? createPinnedGitRunner(gitPolicy);
  return new AtomicCommitPlanner({ cwd: root, runGit, gitPolicy, policy: options.policy });
}

test("inspection includes only explicitly selected changed files and binds the current snapshot", async (t) => {
  const root = fixture(t);
  fs.appendFileSync(path.join(root, "alpha.txt"), "owned-change\n");
  fs.appendFileSync(path.join(root, "beta.txt"), "unrelated-user-change\n");
  const result = await planner(root).inspect({ scope: "worktree", paths: ["alpha.txt"] });
  assert.equal(result.kind, "COMMIT_CHANGESET");
  assert.equal(result.authority, "PROPOSAL_ONLY");
  assert.equal(result.decisionModelCalls, 0);
  assert.equal(result.changedFileCount, 2);
  assert.equal(result.excludedChangedFileCount, 1);
  assert.deepEqual(result.changes.map((entry) => entry.path), ["alpha.txt"]);
  assert.match(result.snapshotDigest, /^[0-9a-f]{64}$/u);
  assert.doesNotMatch(JSON.stringify(commitPlanMetadata(result)), /alpha\.txt|owned-change|unrelated-user-change/u);
});

test("proposal can split disjoint hunks while remaining non-executable", async (t) => {
  const root = fixture(t);
  const lines = fs.readFileSync(path.join(root, "alpha.txt"), "utf8").split("\n");
  lines[1] = "first-hunk";
  lines[26] = "second-hunk";
  fs.writeFileSync(path.join(root, "alpha.txt"), lines.join("\n"));
  const result = await planner(root).propose({
    scope: "worktree",
    groups: [
      { id: "first", changes: [{ path: "alpha.txt", hunks: [1] }] },
      { id: "second", changes: [{ path: "alpha.txt", hunks: [2] }] },
    ],
  });
  assert.equal(result.kind, "ATOMIC_COMMIT_PLAN");
  assert.equal(result.status, "PROPOSAL_ONLY");
  assert.equal(result.canStage, false);
  assert.equal(result.canCommit, false);
  assert.equal(result.canPublish, false);
  assert.equal(result.selectedHunkCount, 2);
  assert.equal(result.unassignedSelectedHunkCount, 0);
  assert.equal(result.groups.length, 2);
  assert.match(result.planDigest, /^[0-9a-f]{64}$/u);
});

test("duplicate, nonexistent, binary, and invalid hunk selections fail closed", async (t) => {
  const root = fixture(t);
  fs.appendFileSync(path.join(root, "alpha.txt"), "change\n");
  const engine = planner(root);
  await assert.rejects(engine.propose({ scope: "worktree", groups: [{ id: "a", changes: [{ path: "alpha.txt", hunks: [1] }] }, { id: "b", changes: [{ path: "alpha.txt", hunks: [1] }] }] }), /commit_plan_hunk_duplicate/u);
  await assert.rejects(engine.propose({ scope: "worktree", groups: [{ id: "a", changes: [{ path: "alpha.txt", hunks: [99] }] }] }), /commit_plan_hunk_selection_missing/u);
  await assert.rejects(engine.inspect({ scope: "worktree", paths: ["missing.txt"] }), /commit_plan_path_not_changed/u);
  fs.writeFileSync(path.join(root, "binary.bin"), Buffer.from([0, 255, 1, 2]));
  git(root, ["add", "binary.bin"]);
  await assert.rejects(engine.propose({ scope: "staged", groups: [{ id: "binary", changes: [{ path: "binary.bin", hunks: [1] }] }] }), /commit_plan_binary_hunk_denied/u);
});

test("staged and worktree scopes remain independent", async (t) => {
  const root = fixture(t);
  fs.appendFileSync(path.join(root, "alpha.txt"), "staged\n");
  git(root, ["add", "alpha.txt"]);
  fs.appendFileSync(path.join(root, "beta.txt"), "worktree\n");
  const engine = planner(root);
  assert.equal((await engine.inspect({ scope: "staged", paths: ["alpha.txt"] })).changes[0].status, "STAGED");
  assert.equal((await engine.inspect({ scope: "worktree", paths: ["beta.txt"] })).changes[0].status, "WORKTREE");
  await assert.rejects(engine.inspect({ scope: "staged", paths: ["beta.txt"] }), /commit_plan_path_not_changed/u);
});

test("untracked text is proposal-safe while secrets, symlinks, and binaries are denied", async (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "new.txt"), "new text\n");
  const result = await planner(root).inspect({ scope: "worktree", paths: ["new.txt"] });
  assert.equal(result.changes[0].status, "UNTRACKED");
  assert.equal(result.changes[0].hunks[0].additions, 1);
  fs.writeFileSync(path.join(root, ".env"), "SECRET=value\n");
  await assert.rejects(planner(root).inspect({ scope: "worktree", paths: [".env"] }), /commit_plan_path_protected/u);
  fs.symlinkSync("alpha.txt", path.join(root, "linked.txt"));
  await assert.rejects(planner(root).inspect({ scope: "worktree", paths: ["linked.txt"] }), /resource_repo_/u);
  fs.writeFileSync(path.join(root, "raw.bin"), Buffer.from([0, 255, 0]));
  await assert.rejects(planner(root).inspect({ scope: "worktree", paths: ["raw.bin"] }), /resource_repo_binary_denied/u);
});

test("a selected source change during planning invalidates the proposal", async (t) => {
  const root = fixture(t);
  fs.appendFileSync(path.join(root, "alpha.txt"), "first\n");
  const gitPolicy = readGitResourcePolicy();
  const base = createPinnedGitRunner(gitPolicy);
  let diffs = 0;
  const runGit = async (input) => {
    const result = await base(input);
    if (input.args[0] === "diff" && input.args.includes("--binary") && ++diffs === 1) fs.appendFileSync(path.join(root, "alpha.txt"), "raced\n");
    return result;
  };
  await assert.rejects(planner(root, { runGit }).inspect({ scope: "worktree", paths: ["alpha.txt"] }), /commit_plan_source_changed/u);
});

test("HEAD or unrelated inventory changes during planning invalidate the snapshot", async (t) => {
  const root = fixture(t);
  fs.appendFileSync(path.join(root, "alpha.txt"), "first\n");
  const gitPolicy = readGitResourcePolicy();
  const base = createPinnedGitRunner(gitPolicy);
  let inventories = 0;
  const runGit = async (input) => {
    const result = await base(input);
    if (input.args[0] === "diff" && input.args.includes("--name-only") && ++inventories === 1) fs.appendFileSync(path.join(root, "beta.txt"), "raced\n");
    return result;
  };
  await assert.rejects(planner(root, { runGit }).inspect({ scope: "worktree", paths: ["alpha.txt"] }), /commit_plan_repository_changed/u);
});

test("planning never changes HEAD, index, or working tree", async (t) => {
  const root = fixture(t);
  fs.appendFileSync(path.join(root, "alpha.txt"), "change\n");
  const indexPath = path.resolve(root, git(root, ["rev-parse", "--git-path", "index"]));
  const before = { head: git(root, ["rev-parse", "HEAD"]), index: fs.readFileSync(indexPath), worktree: fs.readFileSync(path.join(root, "alpha.txt")) };
  await planner(root).propose({ scope: "worktree", groups: [{ id: "only", changes: [{ path: "alpha.txt" }] }] });
  assert.equal(git(root, ["rev-parse", "HEAD"]), before.head);
  assert.deepEqual(fs.readFileSync(indexPath), before.index);
  assert.deepEqual(fs.readFileSync(path.join(root, "alpha.txt")), before.worktree);
});

test("diff parser is bounded and policy rejects unknown or unsafe fields", () => {
  const parsed = parseCommitDiffHunks("@@ -1 +1 @@\n-old\n+new\n");
  assert.equal(parsed.hunks.length, 1);
  assert.equal(parsed.hunks[0].additions, 1);
  assert.equal(parsed.hunks[0].deletions, 1);
  assert.equal(parseCommitDiffHunks("Binary files a/x and b/x differ\n").binary, true);
  assert.throws(() => parseCommitDiffHunks("@@ -1 +1 @@\n-a\n+b\n@@ -3 +3 @@\n-c\n+d\n", 1), /commit_plan_hunk_limit_exceeded/u);
  const policy = readCommitPlannerPolicy();
  assert.throws(() => validateCommitPlannerPolicy({ ...policy, maxGroups: 500 }), /commit_plan_policy_limit_invalid/u);
  assert.throws(() => validateCommitPlannerPolicy({ ...policy, surprise: true }), /commit_plan_policy_invalid/u);
});
