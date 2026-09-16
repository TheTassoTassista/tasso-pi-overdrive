import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EditEngine, snapshotFooter, validateEditEnginePolicy } from "../lib/edit-engine.mjs";

const policy = Object.freeze({
  version: 1,
  maxFileBytes: 1024 * 1024,
  maxSnapshots: 8,
  maxTransactions: 8,
  snapshotTtlMs: 60_000,
  maxEditsPerTransaction: 8,
  maxEditChars: 64 * 1024,
  maxPreviewChars: 12_000,
  recoveryMaxLineShift: 8,
  recoveryContextChars: 64,
  maxReceiptsPerSession: 16,
});

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-edit-engine-test-"));
  const receipts = path.join(root, "state", "receipts");
  fs.mkdirSync(receipts, { recursive: true });
  const engine = new EditEngine({ cwd: root, receiptRoot: receipts, sessionIdentity: options.sessionIdentity ?? "test-session", policy: options.policy ?? policy, now: options.now, beforeRename: options.beforeRename, beforeReceipt: options.beforeReceipt });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, receipts, engine };
}

test("preview is non-mutating and apply is atomic with a private immutable metadata receipt", (t) => {
  const { root, engine } = fixture(t);
  const file = path.join(root, "app.js");
  fs.writeFileSync(file, "const before = 1;\nconsole.log(before);\n", { mode: 0o640 });
  const snapshot = engine.capture({ source: "app.js", seenAll: true });
  assert.match(snapshotFooter(snapshot), /EDIT SNAPSHOT/u);
  const preview = engine.preview({ snapshotId: snapshot.id, edits: [{ oldText: "const before = 1;", newText: "const after = 2;" }] });
  assert.equal(preview.status, "READY");
  assert.match(preview.preview, /^\[EDIT PREVIEW/u);
  assert.equal(fs.readFileSync(file, "utf8"), "const before = 1;\nconsole.log(before);\n");
  const applied = engine.apply({ transactionId: preview.transactionId });
  assert.equal(applied.status, "APPLIED");
  assert.equal(fs.readFileSync(file, "utf8"), "const after = 2;\nconsole.log(before);\n");
  const receipt = path.join(engine.receiptDirectory, `${preview.transactionId}.json`);
  const receiptText = fs.readFileSync(receipt, "utf8");
  assert.equal(fs.lstatSync(receipt).mode & 0o777, 0o400);
  assert.doesNotMatch(receiptText, /app\.js|const before|const after/u);
  assert.match(receiptText, /"status": "APPLIED"/u);
});

test("an anchored replacement must be unique and entirely inside a seen range", (t) => {
  const { root, engine } = fixture(t);
  fs.writeFileSync(path.join(root, "seen.txt"), "one\ntwo\nthree\nfour\n");
  const partial = engine.capture({ source: "seen.txt", seenRanges: [{ start: 2, end: 2 }] });
  assert.throws(() => engine.preview({ snapshotId: partial.id, edits: [{ oldText: "three", newText: "THREE" }] }), /EDIT_UNSEEN_RANGE/u);
  assert.throws(() => engine.preview({ snapshotId: partial.id, edits: [{ oldText: "missing", newText: "x" }] }), /STALE_EDIT/u);
  fs.writeFileSync(path.join(root, "duplicates.txt"), "same\nsame\n");
  const duplicate = engine.capture({ source: "duplicates.txt", seenAll: true });
  assert.throws(() => engine.preview({ snapshotId: duplicate.id, edits: [{ oldText: "same", newText: "different" }] }), /EDIT_ANCHOR_AMBIGUOUS/u);
});

test("safe recovery permits one bounded uniform relocation with adjacent context", (t) => {
  const { root, engine } = fixture(t);
  const file = path.join(root, "recover.txt");
  fs.writeFileSync(file, "header\nalpha\ntarget old\nomega\n");
  const snapshot = engine.capture({ source: "recover.txt", seenRanges: [{ start: 2, end: 4 }] });
  fs.writeFileSync(file, "inserted\nheader\nalpha\ntarget old\nomega\n");
  const preview = engine.preview({ snapshotId: snapshot.id, edits: [{ oldText: "target old", newText: "target new" }] });
  assert.equal(preview.status, "SAFE_RECOVERY");
  const applied = engine.apply({ transactionId: preview.transactionId });
  assert.equal(applied.recovered, true);
  assert.equal(fs.readFileSync(file, "utf8"), "inserted\nheader\nalpha\ntarget new\nomega\n");
});

test("content changes at the anchor return STALE_EDIT without overwriting external work", (t) => {
  const { root, engine } = fixture(t);
  const file = path.join(root, "stale.txt");
  fs.writeFileSync(file, "before\ntarget old\nafter\n");
  const snapshot = engine.capture({ source: "stale.txt", seenAll: true });
  fs.writeFileSync(file, "before\nexternal change\nafter\n");
  assert.throws(() => engine.preview({ snapshotId: snapshot.id, edits: [{ oldText: "target old", newText: "target new" }] }), /STALE_EDIT/u);
  assert.equal(fs.readFileSync(file, "utf8"), "before\nexternal change\nafter\n");
});

test("a change between preview and apply fails closed and removes the staged file", (t) => {
  let target;
  const data = fixture(t, { beforeRename: () => fs.writeFileSync(target, "external-after-preview\n") });
  const { root, engine } = data;
  target = path.join(root, "race.txt");
  fs.writeFileSync(target, "old\ncontext\n");
  const snapshot = engine.capture({ source: "race.txt", seenAll: true });
  const preview = engine.preview({ snapshotId: snapshot.id, edits: [{ oldText: "old", newText: "new" }] });
  assert.throws(() => engine.apply({ transactionId: preview.transactionId }), /STALE_EDIT/u);
  assert.equal(fs.readFileSync(target, "utf8"), "external-after-preview\n");
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.startsWith(".pi-overdrive-edit-")), []);
  assert.equal(fs.readdirSync(engine.receiptDirectory).filter((name) => name.endsWith(".json")).length, 0);
});

test("a parent-directory replacement between preview and apply fails closed", (t) => {
  let root;
  const data = fixture(t, {
    beforeRename: () => {
      fs.renameSync(path.join(root, "nested"), path.join(root, "moved"));
      fs.mkdirSync(path.join(root, "nested"));
      fs.writeFileSync(path.join(root, "nested", "race.txt"), "external replacement\n");
    },
  });
  ({ root } = data);
  const { engine } = data;
  fs.mkdirSync(path.join(root, "nested"));
  fs.writeFileSync(path.join(root, "nested", "race.txt"), "old\ncontext\n");
  const snapshot = engine.capture({ source: "nested/race.txt", seenAll: true });
  const preview = engine.preview({ snapshotId: snapshot.id, edits: [{ oldText: "old", newText: "new" }] });
  assert.throws(() => engine.apply({ transactionId: preview.transactionId }), /STALE_EDIT/u);
  assert.equal(fs.readFileSync(path.join(root, "nested", "race.txt"), "utf8"), "external replacement\n");
  assert.equal(fs.readFileSync(path.join(root, "moved", "race.txt"), "utf8"), "old\ncontext\n");
  assert.equal(fs.readdirSync(engine.receiptDirectory).filter((name) => name.endsWith(".json")).length, 0);
});

test("receipt persistence failure rolls the already-renamed target back", (t) => {
  let engineRef;
  const data = fixture(t, { beforeRename: () => fs.chmodSync(engineRef.receiptDirectory, 0o500) });
  const { root, engine } = data;
  engineRef = engine;
  const file = path.join(root, "rollback.txt");
  fs.writeFileSync(file, "old\ncontext\n");
  const snapshot = engine.capture({ source: "rollback.txt", seenAll: true });
  const preview = engine.preview({ snapshotId: snapshot.id, edits: [{ oldText: "old", newText: "new" }] });
  assert.throws(() => engine.apply({ transactionId: preview.transactionId }));
  fs.chmodSync(engine.receiptDirectory, 0o700);
  assert.equal(fs.readFileSync(file, "utf8"), "old\ncontext\n");
  assert.equal(engine.status().stats.rollbacks, 1);
});

test("rollback never overwrites an external change made after the atomic rename", (t) => {
  let target;
  const data = fixture(t, {
    beforeReceipt: () => {
      fs.writeFileSync(target, "external after atomic rename\n");
      throw new Error("forced receipt failure");
    },
  });
  const { root, engine } = data;
  target = path.join(root, "rollback-race.txt");
  fs.writeFileSync(target, "old\ncontext\n");
  const snapshot = engine.capture({ source: "rollback-race.txt", seenAll: true });
  const preview = engine.preview({ snapshotId: snapshot.id, edits: [{ oldText: "old", newText: "new" }] });
  assert.throws(() => engine.apply({ transactionId: preview.transactionId }), /EDIT_ROLLBACK_CONFLICT/u);
  assert.equal(fs.readFileSync(target, "utf8"), "external after atomic rename\n");
  assert.equal(engine.status().stats.rollbacks, 0);
  assert.equal(fs.readdirSync(engine.receiptDirectory).filter((name) => name.endsWith(".json")).length, 0);
});

test("protected, symlinked, and multiply-linked targets never become snapshots", (t) => {
  const { root, engine } = fixture(t);
  fs.writeFileSync(path.join(root, "safe.txt"), "safe\n");
  fs.symlinkSync("safe.txt", path.join(root, "link.txt"));
  fs.linkSync(path.join(root, "safe.txt"), path.join(root, "hard.txt"));
  fs.mkdirSync(path.join(root, ".git"));
  fs.writeFileSync(path.join(root, ".git", "config"), "secret\n");
  assert.throws(() => engine.capture({ source: "link.txt", seenAll: true }), /EDIT_PATH_DENIED/u);
  assert.throws(() => engine.capture({ source: "hard.txt", seenAll: true }), /EDIT_PATH_DENIED/u);
  assert.throws(() => engine.capture({ source: ".git/config", seenAll: true }), /EDIT_PATH_PROTECTED/u);
});

test("JSON syntax regression is rejected before a transaction exists", (t) => {
  const { root, engine } = fixture(t);
  const file = path.join(root, "data.json");
  fs.writeFileSync(file, "{\n  \"ok\": true\n}\n");
  const snapshot = engine.capture({ source: "data.json", seenAll: true });
  assert.throws(() => engine.preview({ snapshotId: snapshot.id, edits: [{ oldText: "true", newText: "}" }] }), /EDIT_SYNTAX_INVALID/u);
  assert.equal(fs.readFileSync(file, "utf8"), "{\n  \"ok\": true\n}\n");
  assert.equal(engine.status().transactions, 0);
});

test("BOM and CRLF are preserved by a successful replacement", (t) => {
  const { root, engine } = fixture(t);
  const file = path.join(root, "windows.txt");
  fs.writeFileSync(file, "\ufefffirst\r\nsecond\r\n");
  const snapshot = engine.capture({ source: "windows.txt", seenAll: true });
  const preview = engine.preview({ snapshotId: snapshot.id, edits: [{ oldText: "second", newText: "changed" }] });
  engine.apply({ transactionId: preview.transactionId });
  assert.equal(fs.readFileSync(file, "utf8"), "\ufefffirst\r\nchanged\r\n");
});

test("expired snapshots and malformed policy fail closed", (t) => {
  let now = 1_000_000;
  const { root, engine } = fixture(t, { now: () => now });
  fs.writeFileSync(path.join(root, "expiry.txt"), "old\n");
  const snapshot = engine.capture({ source: "expiry.txt", seenAll: true });
  now += policy.snapshotTtlMs + 1;
  assert.throws(() => engine.preview({ snapshotId: snapshot.id, edits: [{ oldText: "old", newText: "new" }] }), /EDIT_SNAPSHOT_MISSING/u);
  assert.throws(() => validateEditEnginePolicy({ ...policy, unknown: true }), /EDIT_POLICY_UNKNOWN_FIELD/u);
});
