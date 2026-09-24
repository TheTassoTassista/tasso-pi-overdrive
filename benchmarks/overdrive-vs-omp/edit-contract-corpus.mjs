#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readAstEditPolicy, TransactionalAstEdit } from "../../lib/ast-edit-engine.mjs";
import { EditEngine } from "../../lib/edit-engine.mjs";

const benchmarkRoot = path.dirname(fileURLToPath(import.meta.url));
const digest = (value) => createHash("sha256").update(value).digest("hex");
const replacement = (oldText, newText) => ({ oldText, newText });
const longBody = Array.from({ length: 320 }, (_, index) => `line_${index} = ${index};\n`).join("");

// Each case has an exact oracle. Rejected edits count as safety passes, not edit successes.
const CASES = Object.freeze([
  { id: "tiny-exact", file: "tiny.js", before: "let x=1;\n", edits: [replacement("x=1", "x=2")], after: "let x=2;\n", syntax: "javascript" },
  { id: "single-line-semantic", file: "semantic.js", before: "const total = price + tax;\n", edits: [replacement("price + tax", "price - tax")], after: "const total = price - tax;\n", syntax: "javascript" },
  { id: "multiline", file: "multi.js", before: "function f() {\n  return oldValue;\n}\n", edits: [replacement("  return oldValue;\n", "  const value = 2;\n  return value;\n")], after: "function f() {\n  const value = 2;\n  return value;\n}\n", syntax: "javascript" },
  { id: "disjoint", file: "disjoint.js", before: "const first = 1;\nconst second = 2;\n", edits: [replacement("first = 1", "first = 3"), replacement("second = 2", "second = 4")], after: "const first = 3;\nconst second = 4;\n", syntax: "javascript" },
  { id: "repeated-ambiguous", file: "ambiguous.js", before: "hit();\nhit();\n", edits: [replacement("hit()", "miss()")], after: "hit();\nhit();\n", error: "EDIT_ANCHOR_AMBIGUOUS" },
  { id: "stale-target", file: "stale.js", before: "const target = 1;\n", external: "const target = 9;\n", edits: [replacement("target = 1", "target = 2")], after: "const target = 9;\n", error: "STALE_EDIT" },
  { id: "external-insertion", file: "insert.js", before: "const target = 1;\nconst stable = true;\n", external: "// external\nconst target = 1;\nconst stable = true;\n", edits: [replacement("target = 1", "target = 2")], after: "// external\nconst target = 2;\nconst stable = true;\n", recovered: true, syntax: "javascript" },
  { id: "whitespace-drift", file: "whitespace.js", before: "target();\n", external: "target ();\n", edits: [replacement("target()", "fixed()")], after: "target ();\n", error: "STALE_EDIT" },
  { id: "typescript", file: "typed.ts", before: "const n: number = 1;\n", edits: [replacement("= 1", "= 2")], after: "const n: number = 2;\n" },
  { id: "python", file: "sample.py", before: "def value():\n    return 1\n", edits: [replacement("return 1", "return 2")], after: "def value():\n    return 2\n", syntax: "python" },
  { id: "c", file: "sample.c", before: "int value(void) { return 1; }\n", edits: [replacement("return 1", "return 2")], after: "int value(void) { return 2; }\n", syntax: "c" },
  { id: "rust", file: "sample.rs", before: "pub fn value() -> i32 { 1 }\n", edits: [replacement("{ 1 }", "{ 2 }")], after: "pub fn value() -> i32 { 2 }\n", syntax: "rust" },
  { id: "go", file: "sample.go", before: "package sample\nfunc Value() int { return 1 }\n", edits: [replacement("return 1", "return 2")], after: "package sample\nfunc Value() int { return 2 }\n" },
  { id: "json", file: "sample.json", before: "{\"enabled\":false}\n", edits: [replacement("false", "true")], after: "{\"enabled\":true}\n", syntax: "json" },
  { id: "ast-structural", file: "structural.js", before: "legacy(a);\nlegacy(b);\n", after: "modern(a);\nmodern(b);\n", ast: { pattern: "legacy($X)", rewrite: "modern($X)", lang: "javascript", expectedMatches: 2 }, syntax: "javascript" },
  { id: "long-file", file: "long.js", before: `${longBody}const target = 1;\n`, edits: [replacement("target = 1", "target = 2")], after: `${longBody}const target = 2;\n`, syntax: "javascript" },
  { id: "near-end", file: "end.js", before: `${longBody}const last = 1;\n`, edits: [replacement("last = 1", "last = 2")], after: `${longBody}const last = 2;\n`, syntax: "javascript" },
  { id: "rename-like-textual", file: "rename.js", before: "const oldName = 1;\nuse(oldName);\n", edits: [replacement("const oldName", "const newName"), replacement("use(oldName)", "use(newName)")], after: "const newName = 1;\nuse(newName);\n", syntax: "javascript" },
  { id: "malformed-ast-output", file: "malformed.js", before: "legacy(a);\n", after: "legacy(a);\n", ast: { pattern: "legacy($X)", rewrite: "modern($X)", lang: "javascript", expectedMatches: 1 }, malformedAst: true, error: "AST_OUTPUT_INVALID" },
  { id: "recovery-after-first-failure", file: "retry.js", before: "const a = hit();\nconst b = hit();\n", firstEdit: replacement("hit()", "fixed()"), edits: [replacement("const b = hit()", "const b = fixed()")], after: "const a = hit();\nconst b = fixed();\n", firstError: "EDIT_ANCHOR_AMBIGUOUS", syntax: "javascript" },
]);

function astRunner(args) {
  const policy = readAstEditPolicy();
  const binary = fs.realpathSync(process.env.PI_OVERDRIVE_AST_GREP_BIN ?? path.join(os.homedir(), ".local", "share", "pi-overdrive", "lsp-node", "node_modules", "@ast-grep", "cli", "ast-grep"));
  assert.equal(digest(fs.readFileSync(binary)), policy.binarySha256, "AST binary digest must match the production policy");
  const version = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 5_000 });
  assert.equal(version.stdout?.trim(), policy.binaryVersion, "AST binary version must match the production policy");
  const result = spawnSync(binary, args, { encoding: "utf8", maxBuffer: policy.maxCliOutputBytes + 1024, timeout: policy.timeoutMs });
  return { code: result.status ?? 127, killed: result.signal !== null, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function syntaxCheck(kind, file, contents, root) {
  if (!kind) return "NOT_RUN";
  if (kind === "json") { JSON.parse(contents); return "PASS"; }
  const command = kind === "javascript" ? [process.execPath, ["--check", file]]
    : kind === "python" ? ["python3", ["-c", "import ast,sys; ast.parse(open(sys.argv[1], encoding='utf-8').read())", file]]
    : kind === "c" ? ["gcc", ["-fsyntax-only", file]]
    : ["rustc", ["--crate-type", "lib", "--emit", "metadata", "-o", path.join(root, "syntax.rmeta"), file]];
  const run = spawnSync(command[0], command[1], { cwd: root, encoding: "utf8", timeout: 10_000 });
  return run.status === 0 ? "PASS" : run.error?.code === "ENOENT" ? "UNAVAILABLE" : "FAIL";
}

async function runCase(spec, temporary) {
  const root = path.join(temporary, spec.id);
  fs.mkdirSync(root, { mode: 0o700 });
  const file = path.join(root, spec.file);
  const sidecar = path.join(root, "untouched.txt");
  fs.writeFileSync(file, spec.before);
  fs.writeFileSync(sidecar, "external-work\n");
  const engine = new EditEngine({ cwd: root, receiptRoot: path.join(root, "receipts"), sessionIdentity: spec.id });
  const snapshot = engine.capture({ source: spec.file, seenAll: true });
  if (spec.external) fs.writeFileSync(file, spec.external);
  let operations = 1;
  let firstAttempt = true;
  let failureCode = null;
  let preview;
  let applied;
  const protocolInputChars = JSON.stringify(spec.ast ?? spec.edits).length;
  const started = performance.now();
  try {
    if (spec.firstEdit) {
      operations += 1;
      try { engine.preview({ snapshotId: snapshot.id, edits: [spec.firstEdit] }); }
      catch (error) { assert.equal(error.code, spec.firstError); firstAttempt = false; }
      assert.equal(firstAttempt, false, "first attempt must actually fail");
    }
    if (spec.ast) {
      const ast = new TransactionalAstEdit({ editEngine: engine, runner: spec.malformedAst ? async () => ({ code: 0, killed: false, stdout: "not-json", stderr: "" }) : astRunner });
      operations += 1;
      preview = await ast.preview({ snapshotId: snapshot.id, ...spec.ast });
      if (!spec.error) { operations += 1; applied = ast.apply({ transactionId: preview.transactionId }); }
    } else {
      operations += 1;
      preview = engine.preview({ snapshotId: snapshot.id, edits: spec.edits });
      if (!spec.error) { operations += 1; applied = engine.apply({ transactionId: preview.transactionId }); }
    }
  } catch (error) {
    failureCode = error?.code ?? "UNCLASSIFIED";
  }
  const contents = fs.readFileSync(file, "utf8");
  const receiptFiles = fs.readdirSync(engine.receiptDirectory);
  const receipt = receiptFiles.length === 1 ? JSON.parse(fs.readFileSync(path.join(engine.receiptDirectory, receiptFiles[0]), "utf8")) : null;
  const receiptSafe = receipt === null || (!JSON.stringify(receipt).includes(spec.file) && !JSON.stringify(receipt).includes(spec.before) && (fs.statSync(path.join(engine.receiptDirectory, receiptFiles[0])).mode & 0o777) === 0o400);
  const syntax = spec.error ? "NOT_APPLICABLE_REJECTED" : syntaxCheck(spec.syntax, file, contents, root);
  const assertions = {
    exactOracle: contents === spec.after,
    expectedOutcome: spec.error ? failureCode === spec.error && !applied : failureCode === null && applied?.status === "APPLIED",
    previewCorrect: spec.error ? !preview : preview?.status === (spec.recovered ? "SAFE_RECOVERY" : "READY"),
    receiptCorrect: spec.error ? receiptFiles.length === 0 : receiptFiles.length === 1 && receipt?.contract === (spec.ast ? "ast-grep-v1" : "hash-replace-v1") && receipt?.status === "APPLIED",
    receiptSafe,
    externalWorkIntact: fs.readFileSync(sidecar, "utf8") === "external-work\n",
    noStageResidue: fs.readdirSync(root).every((name) => !name.startsWith(".pi-overdrive-edit-")),
    syntax: syntax !== "FAIL" && syntax !== "UNAVAILABLE",
  };
  return {
    id: spec.id, contract: spec.ast ? "AST_STRUCTURAL" : "HASH_ANCHORED", kind: spec.error ? "EXPECTED_DENIAL" : "EXPECTED_EDIT",
    status: Object.values(assertions).every(Boolean) ? "PASS" : "FAIL", firstAttempt, failureCode,
    model: null, provider: null, modelCalls: 0, piToolCalls: null, engineOperations: operations,
    inputTokens: null, outputTokens: null, estimatedContextTokens: null,
    protocolInputChars, protocolPreviewChars: preview?.preview?.length ?? 0,
    editSuccess: !spec.error && applied?.status === "APPLIED" && assertions.exactOracle,
    firstAttemptSuccess: !spec.error && firstAttempt && applied?.status === "APPLIED" && assertions.exactOracle,
    formatFailure: failureCode === "AST_OUTPUT_INVALID", staleFailure: failureCode === "STALE_EDIT",
    ambiguousFailure: failureCode === "EDIT_ANCHOR_AMBIGUOUS", lspRejection: false,
    retryCount: spec.firstEdit ? 1 : 0, finalDiffCorrect: assertions.exactOracle,
    rollbackUsed: engine.stats.rollbacks > 0, recoveryPath: spec.recovered ? "SAFE_RECOVERY" : spec.firstEdit ? "NARROWER_ANCHOR" : "NONE",
    receiptValid: assertions.receiptCorrect && assertions.receiptSafe,
    latencyMs: Number((performance.now() - started).toFixed(3)),
    inputBytes: Buffer.byteLength(spec.before), outputBytes: Buffer.byteLength(contents), syntax, assertions,
  };
}

export async function runEditContractCorpus() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-edit-corpus-"));
  let cases;
  try { cases = await Promise.all(CASES.map((spec) => runCase(spec, temporary))); }
  finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  return {
    version: 1, status: cases.length === 20 && cases.every((entry) => entry.status === "PASS") ? "PASS" : "FAIL",
    measurementMode: "actual-local-edit-engine-and-ast-grep-no-model",
    contracts: { HASH_ANCHORED: "EXECUTED", AST_STRUCTURAL: "EXECUTED", APPLY_PATCH: "NOT_AVAILABLE_AS_REGISTERED_PRODUCTION_TOOL", REPLACE: "NOT_EQUIVALENT_TO_TRANSACTIONAL_PATH" },
    cases, accounting: { classes: cases.length, editSuccesses: cases.filter((entry) => entry.kind === "EXPECTED_EDIT" && entry.status === "PASS").length, expectedDenials: cases.filter((entry) => entry.kind === "EXPECTED_DENIAL" && entry.status === "PASS").length, modelCalls: 0, externalProviderCalls: 0, inputTokens: null, outputTokens: null, estimatedContextTokens: null, costEur: 0 },
    cleanup: { temporaryRemoved: !fs.existsSync(temporary) },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runEditContractCorpus();
  if (process.argv.includes("--write-results")) fs.writeFileSync(path.join(benchmarkRoot, "edit-contract-corpus-results.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.status === "PASS" ? 0 : 1;
}
