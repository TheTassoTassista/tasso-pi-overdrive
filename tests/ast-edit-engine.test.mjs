import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AstEditError, TransactionalAstEdit, validateAstEditPolicy } from "../lib/ast-edit-engine.mjs";
import { AST_EDIT_CONTRACT, EditEngine } from "../lib/edit-engine.mjs";

const editPolicy = Object.freeze({
  version: 1, maxFileBytes: 1024 * 1024, maxSnapshots: 8, maxTransactions: 8, snapshotTtlMs: 60_000,
  maxEditsPerTransaction: 8, maxEditChars: 64 * 1024, maxPreviewChars: 12_000,
  recoveryMaxLineShift: 8, recoveryContextChars: 64, maxReceiptsPerSession: 16,
});
const astPolicy = Object.freeze({
  version: 1, binaryVersion: "ast-grep 0.45.3", binarySha256: "7a5ab30160186184c0bf8bffc87da4af25123c183964cd98c11b0b354137db0a",
  maxMatches: 8, maxPatternChars: 1024, maxRewriteChars: 1024, maxCliOutputBytes: 64 * 1024, timeoutMs: 5000,
});

function actualRunner(args) {
  const result = spawnSync(process.env.PI_OVERDRIVE_AST_GREP_BIN ?? "ast-grep", args, { encoding: "utf8", maxBuffer: 3 * 1024 * 1024 });
  return { code: result.status ?? 127, killed: result.signal !== null, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function fixture(t, runner = actualRunner) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ast-edit-test-"));
  const receipts = path.join(root, "state", "receipts");
  const temp = path.join(root, "temporary");
  fs.mkdirSync(receipts, { recursive: true });
  fs.mkdirSync(temp);
  const editEngine = new EditEngine({ cwd: root, receiptRoot: receipts, sessionIdentity: "ast-test", policy: editPolicy });
  const astEngine = new TransactionalAstEdit({ editEngine, runner, policy: astPolicy, temporaryRoot: temp });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, temp, editEngine, astEngine };
}

test("real ast-grep duplicate matches preview and apply through one atomic transaction", async (t) => {
  const { root, temp, editEngine, astEngine } = fixture(t);
  const file = path.join(root, "calls.js");
  fs.writeFileSync(file, "const π = legacy(value);\nconst b = legacy(value);\n");
  const snapshot = editEngine.capture({ source: "calls.js", seenAll: true });
  const preview = await astEngine.preview({ snapshotId: snapshot.id, pattern: "legacy($X)", rewrite: "modern($X)", lang: "javascript", expectedMatches: 2 });
  assert.equal(preview.contract, AST_EDIT_CONTRACT);
  assert.equal(preview.matchCount, 2);
  assert.equal(fs.readFileSync(file, "utf8"), "const π = legacy(value);\nconst b = legacy(value);\n");
  assert.deepEqual(fs.readdirSync(temp), []);
  const applied = astEngine.apply({ transactionId: preview.transactionId });
  assert.equal(applied.contract, AST_EDIT_CONTRACT);
  assert.equal(fs.readFileSync(file, "utf8"), "const π = modern(value);\nconst b = modern(value);\n");
  const receipt = JSON.parse(fs.readFileSync(path.join(editEngine.receiptDirectory, `${preview.transactionId}.json`), "utf8"));
  assert.equal(receipt.contract, AST_EDIT_CONTRACT);
  assert.doesNotMatch(JSON.stringify(receipt), /calls\.js|legacy|modern/u);
});

test("explicit expected match count prevents a broader structural rewrite", async (t) => {
  const { root, editEngine, astEngine } = fixture(t);
  fs.writeFileSync(path.join(root, "count.js"), "legacy(a);\nlegacy(b);\n");
  const snapshot = editEngine.capture({ source: "count.js", seenAll: true });
  await assert.rejects(astEngine.preview({ snapshotId: snapshot.id, pattern: "legacy($X)", rewrite: "modern($X)", lang: "javascript", expectedMatches: 1 }), /AST_MATCH_COUNT_CHANGED/u);
  assert.equal(fs.readFileSync(path.join(root, "count.js"), "utf8"), "legacy(a);\nlegacy(b);\n");
});

test("structural matches outside an observed range fail closed", async (t) => {
  const { root, editEngine, astEngine } = fixture(t);
  fs.writeFileSync(path.join(root, "unseen.js"), "const visible = 1;\nlegacy(hidden);\n");
  const snapshot = editEngine.capture({ source: "unseen.js", seenRanges: [{ start: 1, end: 1 }] });
  await assert.rejects(astEngine.preview({ snapshotId: snapshot.id, pattern: "legacy($X)", rewrite: "modern($X)", lang: "javascript", expectedMatches: 1 }), /EDIT_UNSEEN_RANGE/u);
});

test("any source change after the structural snapshot requires a fresh preview", async (t) => {
  const { root, editEngine, astEngine } = fixture(t);
  const file = path.join(root, "stale.js");
  fs.writeFileSync(file, "legacy(value);\n");
  const snapshot = editEngine.capture({ source: "stale.js", seenAll: true });
  fs.writeFileSync(file, "external();\nlegacy(value);\n");
  await assert.rejects(astEngine.preview({ snapshotId: snapshot.id, pattern: "legacy($X)", rewrite: "modern($X)", lang: "javascript", expectedMatches: 1 }), /STALE_EDIT/u);
  assert.equal(fs.readFileSync(file, "utf8"), "external();\nlegacy(value);\n");
});

test("overlapping, malformed, and failed ast-grep output is rejected", async (t) => {
  const overlapping = JSON.stringify([
    { text: "abc", replacement: "x", range: { byteOffset: { start: 0, end: 3 } } },
    { text: "bc", replacement: "y", range: { byteOffset: { start: 1, end: 3 } } },
  ]);
  const overlap = fixture(t, async () => ({ code: 0, killed: false, stdout: overlapping, stderr: "" }));
  fs.writeFileSync(path.join(overlap.root, "overlap.js"), "abc\n");
  const overlapSnapshot = overlap.editEngine.capture({ source: "overlap.js", seenAll: true });
  await assert.rejects(overlap.astEngine.preview({ snapshotId: overlapSnapshot.id, pattern: "$A", rewrite: "x", lang: "javascript", expectedMatches: 2 }), /AST_OVERLAP_DENIED/u);

  const malformed = fixture(t, async () => ({ code: 0, killed: false, stdout: "not-json", stderr: "" }));
  fs.writeFileSync(path.join(malformed.root, "bad.js"), "value\n");
  const malformedSnapshot = malformed.editEngine.capture({ source: "bad.js", seenAll: true });
  await assert.rejects(malformed.astEngine.preview({ snapshotId: malformedSnapshot.id, pattern: "$A", rewrite: "x", lang: "javascript", expectedMatches: 1 }), /AST_OUTPUT_INVALID/u);

  const failed = fixture(t, async () => ({ code: 2, killed: false, stdout: "", stderr: "parse error" }));
  fs.writeFileSync(path.join(failed.root, "failed.js"), "value\n");
  const failedSnapshot = failed.editEngine.capture({ source: "failed.js", seenAll: true });
  await assert.rejects(failed.astEngine.preview({ snapshotId: failedSnapshot.id, pattern: "$A", rewrite: "x", lang: "javascript", expectedMatches: 1 }), /AST_QUERY_FAILED/u);
});

test("an exact-replace transaction cannot be applied through the AST contract", (t) => {
  const { root, editEngine, astEngine } = fixture(t);
  const file = path.join(root, "contract.js");
  fs.writeFileSync(file, "old\n");
  const snapshot = editEngine.capture({ source: "contract.js", seenAll: true });
  const exact = editEngine.preview({ snapshotId: snapshot.id, edits: [{ oldText: "old", newText: "new" }] });
  assert.throws(() => astEngine.apply({ transactionId: exact.transactionId }), /EDIT_CONTRACT_MISMATCH/u);
  assert.equal(fs.readFileSync(file, "utf8"), "old\n");
});

test("AST policy rejects unknown or unsafe bounds", () => {
  assert.throws(() => validateAstEditPolicy({ ...astPolicy, unknown: true }), AstEditError);
  assert.throws(() => validateAstEditPolicy({ ...astPolicy, maxMatches: 0 }), /AST_POLICY_MATCH_LIMIT_INVALID/u);
  assert.throws(() => validateAstEditPolicy({ ...astPolicy, binarySha256: "0" }), /AST_POLICY_BINARY_DIGEST_INVALID/u);
});
