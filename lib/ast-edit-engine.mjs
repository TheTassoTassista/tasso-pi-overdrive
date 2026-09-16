import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AST_EDIT_CONTRACT } from "./edit-engine.mjs";

export const AST_EDIT_ENGINE_VERSION = 1;
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const policyFile = path.join(packageRoot, "config", "ast-edit.json");

export class AstEditError extends Error {
  constructor(code) { super(code); this.name = "AstEditError"; this.code = code; }
}

function fail(code) { throw new AstEditError(code); }
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function exactInteger(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code);
  return value;
}

export function validateAstEditPolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== AST_EDIT_ENGINE_VERSION) fail("AST_POLICY_INVALID");
  const keys = ["version", "binaryVersion", "binarySha256", "maxMatches", "maxPatternChars", "maxRewriteChars", "maxCliOutputBytes", "timeoutMs"];
  if (Object.keys(value).some((key) => !keys.includes(key))) fail("AST_POLICY_UNKNOWN_FIELD");
  if (typeof value.binaryVersion !== "string" || !/^ast-grep \d+\.\d+\.\d+$/u.test(value.binaryVersion)) fail("AST_POLICY_BINARY_VERSION_INVALID");
  if (typeof value.binarySha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.binarySha256)) fail("AST_POLICY_BINARY_DIGEST_INVALID");
  return Object.freeze({
    version: value.version,
    binaryVersion: value.binaryVersion,
    binarySha256: value.binarySha256,
    maxMatches: exactInteger(value.maxMatches, 1, 128, "AST_POLICY_MATCH_LIMIT_INVALID"),
    maxPatternChars: exactInteger(value.maxPatternChars, 64, 16_384, "AST_POLICY_PATTERN_LIMIT_INVALID"),
    maxRewriteChars: exactInteger(value.maxRewriteChars, 64, 16_384, "AST_POLICY_REWRITE_LIMIT_INVALID"),
    maxCliOutputBytes: exactInteger(value.maxCliOutputBytes, 64 * 1024, 8 * 1024 * 1024, "AST_POLICY_OUTPUT_LIMIT_INVALID"),
    timeoutMs: exactInteger(value.timeoutMs, 1000, 120_000, "AST_POLICY_TIMEOUT_INVALID"),
  });
}

export function readAstEditPolicy(file = policyFile) {
  try { return validateAstEditPolicy(JSON.parse(fs.readFileSync(file, "utf8"))); }
  catch (error) { if (error instanceof AstEditError) throw error; fail("AST_POLICY_UNREADABLE"); }
}

function boundedString(value, maximum, code, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > maximum || value.includes("\0")) fail(code);
  return value;
}

function language(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_+-]{0,31}$/u.test(value)) fail("AST_LANGUAGE_INVALID");
  return value;
}

function stringRangeFromBytes(text, byteStart, byteEnd) {
  const bytes = Buffer.from(text, "utf8");
  if (!Number.isSafeInteger(byteStart) || !Number.isSafeInteger(byteEnd) || byteStart < 0 || byteEnd <= byteStart || byteEnd > bytes.length) fail("AST_RANGE_INVALID");
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const before = decoder.decode(bytes.subarray(0, byteStart));
    const matched = decoder.decode(bytes.subarray(byteStart, byteEnd));
    return { start: before.length, end: before.length + matched.length, text: matched };
  } catch { fail("AST_RANGE_INVALID"); }
}

function parseMatches(stdout, snapshot, policy, expectedMatches) {
  if (Buffer.byteLength(stdout, "utf8") > policy.maxCliOutputBytes) fail("AST_OUTPUT_TOO_LARGE");
  let records;
  try { records = JSON.parse(stdout); } catch { fail("AST_OUTPUT_INVALID"); }
  if (!Array.isArray(records)) fail("AST_OUTPUT_INVALID");
  if (records.length !== expectedMatches) fail("AST_MATCH_COUNT_CHANGED");
  if (records.length < 1 || records.length > policy.maxMatches) fail("AST_MATCH_LIMIT_EXCEEDED");
  const edits = records.map((record) => {
    const byteStart = record?.range?.byteOffset?.start;
    const byteEnd = record?.range?.byteOffset?.end;
    const range = stringRangeFromBytes(snapshot.text, byteStart, byteEnd);
    if (typeof record?.text !== "string" || record.text !== range.text || typeof record?.replacement !== "string") fail("AST_OUTPUT_MISMATCH");
    return { start: range.start, end: range.end, newText: record.replacement.replace(/\r\n/gu, "\n") };
  }).sort((left, right) => left.start - right.start);
  for (let index = 1; index < edits.length; index += 1) if (edits[index].start < edits[index - 1].end) fail("AST_OVERLAP_DENIED");
  return edits;
}

function safeSuffix(relative) {
  const extension = path.extname(relative);
  return /^\.[A-Za-z0-9]{1,12}$/u.test(extension) ? extension : ".txt";
}

export class TransactionalAstEdit {
  constructor(options = {}) {
    if (!options.editEngine || typeof options.runner !== "function") fail("AST_ENGINE_INVALID");
    this.editEngine = options.editEngine;
    this.runner = options.runner;
    this.policy = validateAstEditPolicy(options.policy ?? readAstEditPolicy());
    this.temporaryRoot = options.temporaryRoot ?? os.tmpdir();
    this.stats = { previews: 0, applied: 0, denied: 0 };
  }

  async preview(input = {}, signal) {
    const pattern = boundedString(input.pattern, this.policy.maxPatternChars, "AST_PATTERN_INVALID");
    const rewrite = boundedString(input.rewrite, this.policy.maxRewriteChars, "AST_REWRITE_INVALID", true);
    const lang = language(input.lang);
    const expectedMatches = exactInteger(input.expectedMatches, 1, this.policy.maxMatches, "AST_EXPECTED_MATCHES_INVALID");
    const snapshot = this.editEngine.adapterSnapshot(input.snapshotId);
    const directory = fs.mkdtempSync(path.join(this.temporaryRoot, "pi-overdrive-ast-edit-"));
    fs.chmodSync(directory, 0o700);
    const fixture = path.join(directory, `snapshot${safeSuffix(snapshot.relative)}`);
    try {
      fs.writeFileSync(fixture, snapshot.text, { mode: 0o600, flag: "wx" });
      const args = ["run", "--pattern", pattern, "--rewrite", rewrite, ...(lang ? ["--lang", lang] : []), "--json=compact", "--color", "never", fixture];
      const result = await this.runner(args, { signal, timeoutMs: this.policy.timeoutMs });
      if (!result || result.killed === true || ![0, 1].includes(result.code) || typeof result.stdout !== "string" || typeof result.stderr !== "string") fail("AST_QUERY_FAILED");
      if (result.stderr.trim()) fail("AST_QUERY_FAILED");
      const edits = parseMatches(result.stdout, snapshot, this.policy, expectedMatches);
      const transaction = this.editEngine.previewRanges({ snapshotId: snapshot.id, contract: AST_EDIT_CONTRACT, edits });
      this.stats.previews += 1;
      return Object.freeze({ ...transaction, kind: "AST_EDIT_PREVIEW", matchCount: edits.length, patternDigest: hash(pattern), rewriteDigest: hash(rewrite), language: lang ?? "inferred" });
    } catch (error) {
      this.stats.denied += 1;
      throw error;
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }

  apply(input = {}) {
    try {
      const result = this.editEngine.apply({ transactionId: input.transactionId, expectedContract: AST_EDIT_CONTRACT });
      this.stats.applied += 1;
      return Object.freeze({ ...result, kind: "AST_EDIT_APPLIED" });
    } catch (error) { this.stats.denied += 1; throw error; }
  }

  status() { return Object.freeze({ version: AST_EDIT_ENGINE_VERSION, contract: AST_EDIT_CONTRACT, stats: { ...this.stats } }); }
}
