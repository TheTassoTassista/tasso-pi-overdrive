import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EditEngine } from "../lib/edit-engine.mjs";
import { LspWriteGuard, LspWriteGuardError, validateLspWriteGuardPolicy } from "../lib/lsp-write-guard.mjs";
import { shutdownLspServers } from "../lib/lsp-manager.mjs";

const editPolicy = Object.freeze({
  version: 1, maxFileBytes: 1024 * 1024, maxSnapshots: 8, maxTransactions: 8, snapshotTtlMs: 60_000,
  maxEditsPerTransaction: 8, maxEditChars: 64 * 1024, maxPreviewChars: 12_000,
  recoveryMaxLineShift: 8, recoveryContextChars: 64, maxReceiptsPerSession: 16,
});
const lspPolicy = Object.freeze({
  version: 1, enabled: true, blockingSeverities: ["Error"], maxDiagnostics: 20, requirePostMatch: true,
  unsupportedLanguageAction: "SKIP", managedServerUnavailableAction: "BLOCK", runtimeFailureAction: "BLOCK",
});

function result(entries = []) {
  return { status: "PASS", language: "typescript", backend: "vtsls@test", entries };
}

function diagnostic(message = "candidate error") {
  return { path: "source.ts", severity: "Error", source: "test-lsp", code: 2322, message };
}

function fixture(t, diagnostics) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lsp-write-guard-"));
  const receipts = path.join(root, "state", "receipts");
  fs.mkdirSync(receipts, { recursive: true });
  const engine = new EditEngine({ cwd: root, receiptRoot: receipts, sessionIdentity: "lsp-write-test", policy: editPolicy });
  const guard = new LspWriteGuard({ cwd: root, editEngine: engine, diagnostics, policy: lspPolicy });
  const file = path.join(root, "source.ts");
  fs.writeFileSync(file, "const value: number = 1;\n");
  const snapshot = engine.capture({ source: "source.ts", seenAll: true });
  const preview = engine.preview({ snapshotId: snapshot.id, edits: [{ oldText: "1", newText: "2" }] });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, file, receipts, engine, guard, preview };
}

after(async () => shutdownLspServers());

test("safe candidate and matching post diagnostics are bound into the immutable receipt", async (t) => {
  const phases = [];
  const { file, engine, guard, preview } = fixture(t, async ({ phase }) => { phases.push(phase); return result(); });
  const preflight = await guard.preview({ transactionId: preview.transactionId, expectedContract: "hash-replace-v1" });
  assert.equal(preflight.status, "PASS");
  const applied = await guard.apply({ transactionId: preview.transactionId, expectedContract: "hash-replace-v1" });
  assert.equal(applied.validation.status, "PASS");
  assert.deepEqual(phases, ["baseline", "candidate", "post"]);
  assert.equal(fs.readFileSync(file, "utf8"), "const value: number = 2;\n");
  const receipt = JSON.parse(fs.readFileSync(path.join(engine.receiptDirectory, `${preview.transactionId}.json`), "utf8"));
  assert.equal(receipt.validation.kind, "LSP_WRITE_GUARD");
  assert.match(receipt.validation.backendDigest, /^[0-9a-f]{64}$/u);
  assert.match(receipt.validation.projectDigest, /^[0-9a-f]{64}$/u);
  assert.match(receipt.validation.postDigest, /^[0-9a-f]{64}$/u);
  assert.doesNotMatch(JSON.stringify(receipt), /source\.ts|candidate error|const value/u);
});

test("a new candidate error cancels the transaction before mutation", async (t) => {
  const { file, engine, guard, preview } = fixture(t, async ({ phase }) => result(phase === "candidate" ? [diagnostic()] : []));
  await assert.rejects(guard.preview({ transactionId: preview.transactionId, expectedContract: "hash-replace-v1" }), (error) => error instanceof LspWriteGuardError && error.code === "LSP_NEW_BLOCKING_DIAGNOSTIC" && error.classification === "REGRESSED");
  assert.equal(fs.readFileSync(file, "utf8"), "const value: number = 1;\n");
  assert.throws(() => engine.adapterTransaction(preview.transactionId), /EDIT_TRANSACTION_MISSING/u);
  assert.deepEqual(fs.readdirSync(engine.receiptDirectory), []);
});

test("an unchanged existing error does not block an unrelated edit", async (t) => {
  const existing = diagnostic("pre-existing repository error");
  const { file, guard, preview } = fixture(t, async () => result([existing]));
  const preflight = await guard.preview({ transactionId: preview.transactionId, expectedContract: "hash-replace-v1" });
  assert.equal(preflight.classification, "UNCHANGED");
  assert.equal(preflight.baselineErrorCount, 1);
  assert.equal(preflight.candidateErrorCount, 1);
  await guard.apply({ transactionId: preview.transactionId, expectedContract: "hash-replace-v1" });
  assert.equal(fs.readFileSync(file, "utf8"), "const value: number = 2;\n");
});

test("a candidate that fixes an existing error is classified as improved and may apply", async (t) => {
  const { file, guard, preview } = fixture(t, async ({ phase }) => result(phase === "baseline" ? [diagnostic("fixed by candidate")] : []));
  const preflight = await guard.preview({ transactionId: preview.transactionId, expectedContract: "hash-replace-v1" });
  assert.equal(preflight.classification, "IMPROVED");
  assert.equal(preflight.baselineErrorCount, 1);
  assert.equal(preflight.candidateErrorCount, 0);
  await guard.apply({ transactionId: preview.transactionId, expectedContract: "hash-replace-v1" });
  assert.equal(fs.readFileSync(file, "utf8"), "const value: number = 2;\n");
});

test("diagnostic identity comparison is multiplicity-aware", async (t) => {
  const repeated = diagnostic("same semantic error");
  const { file, guard, preview } = fixture(t, async ({ phase }) => result(phase === "candidate" ? [repeated, repeated] : [repeated]));
  await assert.rejects(guard.preview({ transactionId: preview.transactionId, expectedContract: "hash-replace-v1" }), /LSP_NEW_BLOCKING_DIAGNOSTIC/u);
  assert.equal(fs.readFileSync(file, "utf8"), "const value: number = 1;\n");
});

test("a divergent post-write error rolls the atomic rename back before receipt publication", async (t) => {
  const { root, file, engine, guard, preview } = fixture(t, async ({ phase }) => result(phase === "post" ? [diagnostic("post race")] : []));
  await guard.preview({ transactionId: preview.transactionId, expectedContract: "hash-replace-v1" });
  await assert.rejects(guard.apply({ transactionId: preview.transactionId, expectedContract: "hash-replace-v1" }), /LSP_NEW_BLOCKING_DIAGNOSTIC/u);
  assert.equal(fs.readFileSync(file, "utf8"), "const value: number = 1;\n");
  assert.deepEqual(fs.readdirSync(engine.receiptDirectory), []);
  assert.equal(fs.readdirSync(root).some((name) => name.startsWith(".pi-overdrive-edit-")), false);
  assert.equal(guard.status().stats.rolledBack, 1);
});

test("unsupported languages skip the optional guard without weakening atomic edit checks", async (t) => {
  const { file, engine, guard, preview } = fixture(t, async () => ({ status: "FAIL", error: "unsupported_language", entries: [] }));
  const preflight = await guard.preview({ transactionId: preview.transactionId, expectedContract: "hash-replace-v1" });
  assert.equal(preflight.status, "SKIPPED");
  assert.equal(preflight.classification, "UNKNOWN_UNVERIFIABLE");
  const applied = await guard.apply({ transactionId: preview.transactionId, expectedContract: "hash-replace-v1" });
  assert.equal(applied.validation, undefined);
  assert.equal(fs.readFileSync(file, "utf8"), "const value: number = 2;\n");
  const receipt = JSON.parse(fs.readFileSync(path.join(engine.receiptDirectory, `${preview.transactionId}.json`), "utf8"));
  assert.equal(receipt.validation, undefined);
});

test("a configured managed language whose server is unavailable fails closed", async (t) => {
  const { file, engine, guard, preview } = fixture(t, async () => ({ status: "PARTIAL", error: "language_server_missing", language: "typescript", entries: [] }));
  await assert.rejects(guard.preview({ transactionId: preview.transactionId, expectedContract: "hash-replace-v1" }), /LSP_WRITE_BASELINE_FAILED/u);
  assert.equal(fs.readFileSync(file, "utf8"), "const value: number = 1;\n");
  assert.throws(() => engine.adapterTransaction(preview.transactionId), /EDIT_TRANSACTION_MISSING/u);
});

test("an explicitly disabled optional guard skips diagnostics but retains atomic edit checks", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lsp-write-disabled-"));
  const receipts = path.join(root, "state", "receipts");
  fs.mkdirSync(receipts, { recursive: true });
  const engine = new EditEngine({ cwd: root, receiptRoot: receipts, sessionIdentity: "disabled-lsp-write", policy: editPolicy });
  const guard = new LspWriteGuard({ cwd: root, editEngine: engine, diagnostics: async () => { throw new Error("must not run"); }, policy: { ...lspPolicy, enabled: false } });
  const file = path.join(root, "source.ts");
  fs.writeFileSync(file, "const value: number = 1;\n");
  const snapshot = engine.capture({ source: "source.ts", seenAll: true });
  const preview = engine.preview({ snapshotId: snapshot.id, edits: [{ oldText: "1", newText: "2" }] });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const preflight = await guard.preview({ transactionId: preview.transactionId, expectedContract: "hash-replace-v1" });
  assert.equal(preflight.classification, "UNKNOWN_UNVERIFIABLE");
  await guard.apply({ transactionId: preview.transactionId, expectedContract: "hash-replace-v1" });
  assert.equal(fs.readFileSync(file, "utf8"), "const value: number = 2;\n");
});

test("LSP crashes block before mutation or roll back after rename", async (t) => {
  const before = fixture(t, async ({ phase }) => {
    if (phase === "candidate") throw new Error("server crashed");
    return result();
  });
  await assert.rejects(before.guard.preview({ transactionId: before.preview.transactionId, expectedContract: "hash-replace-v1" }), /LSP_WRITE_CANDIDATE_FAILED/u);
  assert.equal(fs.readFileSync(before.file, "utf8"), "const value: number = 1;\n");

  const after = fixture(t, async ({ phase }) => {
    if (phase === "post") throw new Error("server crashed");
    return result();
  });
  await after.guard.preview({ transactionId: after.preview.transactionId, expectedContract: "hash-replace-v1" });
  await assert.rejects(after.guard.apply({ transactionId: after.preview.transactionId, expectedContract: "hash-replace-v1" }), /LSP_WRITE_POST_FAILED/u);
  assert.equal(fs.readFileSync(after.file, "utf8"), "const value: number = 1;\n");
  assert.deepEqual(fs.readdirSync(after.engine.receiptDirectory), []);
});

test("real TypeScript overlay blocks a bad candidate and validates a safe atomic write", { timeout: 60_000 }, async (t) => {
  await shutdownLspServers();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lsp-write-real-"));
  const receipts = path.join(root, "state", "receipts");
  fs.mkdirSync(receipts, { recursive: true });
  fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["source.ts"] }));
  const file = path.join(root, "source.ts");
  fs.writeFileSync(file, "const value: string = 'safe';\n");
  const engine = new EditEngine({ cwd: root, receiptRoot: receipts, sessionIdentity: "real-lsp-write", policy: editPolicy });
  const guard = new LspWriteGuard({ cwd: root, editEngine: engine, policy: lspPolicy });
  t.after(async () => { await shutdownLspServers(); fs.rmSync(root, { recursive: true, force: true }); });

  const unsafeSnapshot = engine.capture({ source: "source.ts", seenAll: true });
  const unsafe = engine.preview({ snapshotId: unsafeSnapshot.id, edits: [{ oldText: "'safe'", newText: "1" }] });
  await assert.rejects(guard.preview({ transactionId: unsafe.transactionId, expectedContract: "hash-replace-v1" }), /LSP_NEW_BLOCKING_DIAGNOSTIC/u);
  assert.equal(fs.readFileSync(file, "utf8"), "const value: string = 'safe';\n");

  const safeSnapshot = engine.capture({ source: "source.ts", seenAll: true });
  const safe = engine.preview({ snapshotId: safeSnapshot.id, edits: [{ oldText: "'safe'", newText: "'safer'" }] });
  const preflight = await guard.preview({ transactionId: safe.transactionId, expectedContract: "hash-replace-v1" });
  assert.equal(preflight.status, "PASS");
  assert.equal(preflight.classification, "UNCHANGED");
  const applied = await guard.apply({ transactionId: safe.transactionId, expectedContract: "hash-replace-v1" });
  assert.equal(applied.validation.status, "PASS");
  assert.equal(fs.readFileSync(file, "utf8"), "const value: string = 'safer';\n");
});

test("write-guard policy and contract confusion fail closed", async (t) => {
  assert.throws(() => validateLspWriteGuardPolicy({ ...lspPolicy, maxDiagnostics: 0 }), LspWriteGuardError);
  const { guard, preview } = fixture(t, async () => result());
  await assert.rejects(guard.preview({ transactionId: preview.transactionId, expectedContract: "ast-grep-v1" }), /EDIT_CONTRACT_MISMATCH/u);
});
