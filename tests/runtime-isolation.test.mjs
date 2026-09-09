import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanupRuntimeResources, createRuntimeWorktree, findRuntimeAllocation, recoverStaleRuntimeAllocations, releaseRuntimeResources, resumeRuntimeResources } from "../lib/runtime-isolation.mjs";

test("worktree runtime allocations have independent branches, ports, state, profiles, and identifiers", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-runtime-"));
  const repo = path.join(root, "repo");
  const options = { shareRoot: path.join(root, "worktrees"), stateRoot: path.join(root, "runtime") };
  try {
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Runtime Test"]);
    execFileSync("git", ["-C", repo, "config", "user.email", "runtime@invalid"]);
    writeFileSync(path.join(repo, "file.txt"), "baseline\n");
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "commit", "-qm", "baseline"]);
    const first = await createRuntimeWorktree(repo, options);
    const second = await createRuntimeWorktree(repo, options);
    assert.notEqual(first.worktree, second.worktree);
    assert.notEqual(first.branch, second.branch);
    assert.notEqual(first.port, second.port);
    assert.notEqual(first.stateDir, second.stateDir);
    assert.notEqual(first.browserProfile, second.browserProfile);
    assert.notEqual(first.database, second.database);
    assert.equal(findRuntimeAllocation(path.join(first.worktree), options)?.allocationId, first.allocationId);
    assert.equal(statSync(path.join(options.stateRoot, "allocations", first.allocationId, "allocation.json")).mode & 0o077, 0);
    const firstAllocationFile = path.join(options.stateRoot, "allocations", first.allocationId, "allocation.json");
    const stale = JSON.parse(readFileSync(firstAllocationFile, "utf8"));
    stale.process.bootId = "00000000-0000-0000-0000-000000000000";
    writeFileSync(firstAllocationFile, `${JSON.stringify(stale, null, 2)}\n`, { mode: 0o600 });
    const recovery = recoverStaleRuntimeAllocations(options);
    assert.deepEqual(recovery.recovered.map((entry) => entry.allocationId), [first.allocationId]);
    assert.equal(existsSync(first.portReservation), false);
    assert.equal(existsSync(first.worktree), true);
    const resumed = await resumeRuntimeResources(first.allocationId, options);
    assert.notEqual(resumed.port, first.port);
    assert.notEqual(resumed.browserProfile, first.browserProfile);
    assert.equal(resumed.status, "active");
    const released = releaseRuntimeResources(first.allocationId, options);
    assert.equal(released.status, "released");
    assert.equal(existsSync(resumed.portReservation), false);
    writeFileSync(path.join(second.worktree, "uncommitted.txt"), "disposable\n");
    const cleaned = cleanupRuntimeResources(second.allocationId, options);
    assert.equal(cleaned.cleaned, true);
    assert.equal(existsSync(second.worktree), false);
    assert.equal(existsSync(path.join(options.stateRoot, "allocations", second.allocationId)), false);
    assert.throws(() => execFileSync("git", ["-C", repo, "show-ref", "--verify", `refs/heads/${second.branch}`], { stdio: "ignore" }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
