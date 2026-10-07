import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertUniqueManagedWorktreeRecord, cleanupRuntimeResources, createRuntimeWorktree, findRuntimeAllocation, recoverStaleRuntimeAllocations, releaseRuntimeResources, resumeRuntimeResources } from "../lib/runtime-isolation.mjs";
import { assertProtectedArtifact } from "../lib/protected-artifact.mjs";

function fixture(root) {
  const repo = path.join(root, "repo");
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Runtime Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "runtime@invalid"]);
  writeFileSync(path.join(repo, "file.txt"), "baseline\n");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "baseline"]);
  return repo;
}

test("worktree runtime allocations have independent branches, ports, state, profiles, and identifiers", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-runtime-"));
  const repo = path.join(root, "repo");
  const options = { shareRoot: path.join(root, "worktrees"), stateRoot: path.join(root, "runtime") };
  try {
    fixture(root);
    const first = await createRuntimeWorktree(repo, options);
    const second = await createRuntimeWorktree(repo, options);
    assert.notEqual(first.worktree, second.worktree);
    assert.notEqual(first.branch, second.branch);
    assert.notEqual(first.port, second.port);
    assert.notEqual(first.stateDir, second.stateDir);
    assert.notEqual(first.browserProfile, second.browserProfile);
    assert.notEqual(first.database, second.database);
    assert.equal(findRuntimeAllocation(path.join(first.worktree), options)?.allocationId, first.allocationId);
    if (process.platform === "win32") {
      assert.equal(JSON.parse(readFileSync(path.join(options.stateRoot, "allocations", first.allocationId, "allocation.json"), "utf8")).version, 3);
      assert.match(first.portReservation, /\.win-v1\.lock$/u);
    }
    const secondAllocationFile = path.join(options.stateRoot, "allocations", second.allocationId, "allocation.json");
    const secondOriginal = readFileSync(secondAllocationFile, "utf8");
    const unsupported = JSON.parse(secondOriginal);
    unsupported.process.kind = "unknown";
    writeFileSync(secondAllocationFile, `${JSON.stringify(unsupported)}\n`);
    const unknownRecovery = recoverStaleRuntimeAllocations(options);
    assert.equal(unknownRecovery.unknown.some((entry) => entry.allocationId === second.allocationId), true);
    assert.equal(existsSync(second.portReservation), true);
    writeFileSync(secondAllocationFile, secondOriginal);
    assertProtectedArtifact(path.join(options.stateRoot, "allocations", first.allocationId, "allocation.json"), "file", "runtime allocation is not protected");
    const firstAllocationFile = path.join(options.stateRoot, "allocations", first.allocationId, "allocation.json");
    const stale = JSON.parse(readFileSync(firstAllocationFile, "utf8"));
    if (process.platform === "win32") stale.process.creationTime = "0000000000000000";
    else stale.process.bootId = "00000000-0000-0000-0000-000000000000";
    writeFileSync(firstAllocationFile, `${JSON.stringify(stale, null, 2)}\n`, { mode: 0o600 });
    const recovery = recoverStaleRuntimeAllocations(options);
    assert.deepEqual(recovery.recovered.map((entry) => entry.allocationId), [first.allocationId]);
    assert.equal(existsSync(first.portReservation), false);
    assert.equal(existsSync(first.worktree), true);
    const gitRecords = execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain", "-z"], { encoding: "utf8" }).split("\0\0");
    const firstRecord = gitRecords.find((record) => record.split("\0").includes(`branch refs/heads/${first.branch}`));
    assert.ok(firstRecord, "Git must report the managed branch");
    const reportedPath = firstRecord.split("\0")[0].slice("worktree ".length);
    const rawEqual = reportedPath === first.worktree;
    const canonicalEqual = realpathSync(reportedPath) === realpathSync(first.worktree);
    if (process.platform === "win32") console.log(`# worktree-representation ${JSON.stringify({ rawEqual, canonicalEqual, gitForwardSeparators: reportedPath.includes("/"), gitBackSeparators: reportedPath.includes("\\"), nodeForwardSeparators: first.worktree.includes("/"), nodeBackSeparators: first.worktree.includes("\\") })}`);
    assert.equal(canonicalEqual, true, "Git-reported and allocated roots must identify the same filesystem directory");
    assert.doesNotThrow(() => assertUniqueManagedWorktreeRecord(`${firstRecord}\0\0`, first.worktree, first.branch));
    if (process.platform !== "win32") {
      const alias = path.join(root, "git-spelling-alias");
      symlinkSync(first.worktree, alias, "dir");
      const aliasedRecord = firstRecord.replace(`worktree ${reportedPath}`, `worktree ${alias}`);
      assert.notEqual(alias, first.worktree);
      assert.doesNotThrow(() => assertUniqueManagedWorktreeRecord(`${aliasedRecord}\0\0`, first.worktree, first.branch));
    }
    assert.throws(() => assertUniqueManagedWorktreeRecord(`${firstRecord}\0\0${firstRecord}\0\0`, first.worktree, first.branch), /not uniquely registered/u);
    assert.throws(() => assertUniqueManagedWorktreeRecord(`${firstRecord}\0\0`, second.worktree, first.branch), /not uniquely registered/u);
    assert.throws(() => assertUniqueManagedWorktreeRecord(`worktree relative-root\0branch refs/heads/${first.branch}\0\0`, first.worktree, first.branch), /registration is malformed/u);
    assert.throws(() => assertUniqueManagedWorktreeRecord(`worktree ${path.join(root, "missing-worktree")}\0branch refs/heads/${first.branch}\0\0${firstRecord}\0\0`, first.worktree, first.branch), /identity is unknown/u);
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

test("runtime resume refuses a managed path checked out on the wrong branch", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-runtime-wrong-branch-"));
  const options = { shareRoot: path.join(root, "worktrees"), stateRoot: path.join(root, "runtime") };
  try {
    const repo = fixture(root);
    const allocation = await createRuntimeWorktree(repo, options);
    const allocationFile = path.join(options.stateRoot, "allocations", allocation.allocationId, "allocation.json");
    const interrupted = { ...JSON.parse(readFileSync(allocationFile, "utf8")), status: "interrupted" };
    writeFileSync(allocationFile, `${JSON.stringify(interrupted, null, 2)}\n`, { mode: 0o600 });
    execFileSync("git", ["-C", allocation.worktree, "checkout", "-qb", "fixture-wrong-branch"]);
    await assert.rejects(resumeRuntimeResources(allocation.allocationId, options), /branch identity rejected/u);
    assert.equal(existsSync(allocation.portReservation), true, "rejected resume must not alter the existing reservation");
    execFileSync("git", ["-C", allocation.worktree, "checkout", "-q", allocation.branch]);
    cleanupRuntimeResources(allocation.allocationId, options);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runtime roots reject symlink and repository overlap before allocation", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-runtime-boundary-"));
  try {
    const repo = fixture(root);
    const outside = path.join(root, "outside");
    const linked = path.join(root, "linked-worktrees");
    mkdirSync(outside, { mode: 0o755 });
    symlinkSync(outside, linked);
    const beforeMode = statSync(outside).mode & 0o777;
    await assert.rejects(createRuntimeWorktree(repo, { shareRoot: linked, stateRoot: path.join(root, "runtime") }), /symlink/u);
    assert.equal(statSync(outside).mode & 0o777, beforeMode, "a rejected root must not chmod its target");
    await assert.rejects(createRuntimeWorktree(repo, { shareRoot: path.join(repo, ".runtime-worktrees"), stateRoot: path.join(root, "runtime") }), /must not overlap/u);
    assert.equal(existsSync(path.join(repo, ".runtime-worktrees")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tampered allocation paths and symlinked records fail closed before cleanup", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-runtime-tamper-"));
  const options = { shareRoot: path.join(root, "worktrees"), stateRoot: path.join(root, "runtime") };
  try {
    const repo = fixture(root);
    const allocation = await createRuntimeWorktree(repo, options);
    const allocationFile = path.join(options.stateRoot, "allocations", allocation.allocationId, "allocation.json");
    const original = readFileSync(allocationFile, "utf8");
    const outside = path.join(root, "must-survive");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "sentinel"), "preserve\n");
    const tampered = { ...JSON.parse(original), worktree: outside };
    writeFileSync(allocationFile, `${JSON.stringify(tampered, null, 2)}\n`, { mode: 0o600 });
    await assert.rejects(async () => cleanupRuntimeResources(allocation.allocationId, options), /canonical identity/u);
    assert.equal(readFileSync(path.join(outside, "sentinel"), "utf8"), "preserve\n");

    writeFileSync(allocationFile, original, { mode: 0o600 });
    const backup = `${allocationFile}.backup`;
    const hostile = path.join(root, "hostile-allocation.json");
    writeFileSync(hostile, original, { mode: 0o600 });
    renameSync(allocationFile, backup);
    symlinkSync(hostile, allocationFile);
    assert.throws(() => releaseRuntimeResources(allocation.allocationId, options), /ELOOP|symbolic link|runtime allocation file rejected/iu);
    rmSync(allocationFile);
    renameSync(backup, allocationFile);
    const cleaned = cleanupRuntimeResources(allocation.allocationId, options);
    assert.equal(cleaned.cleaned, true);
  } finally {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});
