import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupE2EChildSessions } from "../lib/e2e-child-cleanup.mjs";

const id = "00000000-0000-4000-8000-000000000001";
const receipt = { allocation: { worktree: "/tmp/owned-fixture/worktree" }, delegationAttempts: [{ runId: id }] };
function session(root, suffix, cwd, runId = id) {
  const directory = path.join(root, `pi-subagent-session-${suffix}`);
  const child = path.join(directory, runId, "run-0");
  fs.mkdirSync(child, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(child, "session.jsonl"), JSON.stringify({ type: "session", cwd }) + "\n");
  return directory;
}

test("E2E cleanup removes only run-ID and worktree-bound private child session roots", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-cleanup-test-"));
  try {
    const owned = session(root, "owned1", receipt.allocation.worktree);
    const foreign = session(root, "other1", "/tmp/foreign", "00000000-0000-4000-8000-000000000002");
    const result = cleanupE2EChildSessions(receipt, root);
    assert.equal(result.status, "PASS");
    assert.equal(result.removedDirectories, 1);
    assert.equal(fs.existsSync(owned), false);
    assert.equal(fs.existsSync(foreign), true);
    assert.equal(cleanupE2EChildSessions(receipt, root).removedDirectories, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("same run ID with foreign cwd, loose permissions, or symlinked session fails closed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-cleanup-test-"));
  try {
    const foreign = session(root, "other1", "/tmp/foreign");
    const loose = session(root, "loose1", receipt.allocation.worktree);
    fs.chmodSync(loose, 0o755);
    const linked = session(root, "links1", receipt.allocation.worktree);
    const file = path.join(linked, id, "run-0", "session.jsonl");
    fs.renameSync(file, path.join(root, "outside.jsonl"));
    fs.symlinkSync(path.join(root, "outside.jsonl"), file);
    const result = cleanupE2EChildSessions(receipt, root);
    assert.equal(result.status, "FAIL");
    assert.equal(result.removedDirectories, 0);
    for (const dir of [foreign, loose, linked]) assert.equal(fs.existsSync(dir), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
