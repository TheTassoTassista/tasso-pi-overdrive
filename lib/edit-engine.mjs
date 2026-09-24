import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectWorkspacePath, isAlwaysProtectedWritePath } from "./safety.mjs";
import { parseResourceUri } from "./resource-fs.mjs";

export const EDIT_ENGINE_VERSION = 1;
export const EDIT_CONTRACT = "hash-replace-v1";
export const AST_EDIT_CONTRACT = "ast-grep-v1";
const RECOVERY_GUIDANCE = Object.freeze({
  STALE_EDIT: "The target changed or the anchor cannot be recovered safely. Read the exact range again, then create a new preview; never retry the old transaction.",
  EDIT_ANCHOR_AMBIGUOUS: "The old text is not unique. Read the target range and include enough adjacent unchanged context to make one exact anchor.",
  EDIT_UNSEEN_RANGE: "The proposed anchor was outside the source range shown to you. Reopen that exact range before previewing.",
  EDIT_SNAPSHOT_MISSING: "The read snapshot expired or belongs to another session. Read the target again before previewing.",
  EDIT_TRANSACTION_MISSING: "The preview transaction is no longer active. Create a fresh preview before applying.",
  EDIT_OVERLAP_DENIED: "Edits overlap in the original snapshot. Combine or separate them into disjoint exact replacements.",
  EDIT_SYNTAX_INVALID: "The candidate has invalid syntax. Revise the replacement and preview it again; no file was changed.",
  EDIT_NOOP_DENIED: "The candidate makes no change. Do not repeat the same edit; inspect the current file first.",
  EDIT_RECEIPT_LIMIT_REACHED: "The receipt quota is exhausted. Stop and ask for controller or user review; do not bypass the receipt gate.",
});

/** Fixed, source-free recovery text. Never echo rejected model input or file content. */
export function editRecoveryGuidance(code) { return typeof code === "string" && Object.hasOwn(RECOVERY_GUIDANCE, code) ? RECOVERY_GUIDANCE[code] : null; }
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const policyFile = path.join(packageRoot, "config", "edit-engine.json");
const DIGEST = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RECEIPT_FILE = /^[0-9a-f-]{36}\.json$/iu;

export class EditEngineError extends Error {
  constructor(code) {
    super(code);
    this.name = "EditEngineError";
    this.code = code;
  }
}

function fail(code) { throw new EditEngineError(code); }
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function sameIdentity(left, right) { return left?.dev === right?.dev && left?.ino === right?.ino; }
function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}
function exactInteger(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code);
  return value;
}

export function validateEditEnginePolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== EDIT_ENGINE_VERSION) fail("EDIT_POLICY_INVALID");
  const keys = ["version", "maxFileBytes", "maxSnapshots", "maxTransactions", "snapshotTtlMs", "maxEditsPerTransaction", "maxEditChars", "maxPreviewChars", "recoveryMaxLineShift", "recoveryContextChars", "maxReceiptsPerSession"];
  if (Object.keys(value).some((key) => !keys.includes(key))) fail("EDIT_POLICY_UNKNOWN_FIELD");
  const policy = {
    version: value.version,
    maxFileBytes: exactInteger(value.maxFileBytes, 1024, 16 * 1024 * 1024, "EDIT_POLICY_FILE_LIMIT_INVALID"),
    maxSnapshots: exactInteger(value.maxSnapshots, 1, 1024, "EDIT_POLICY_SNAPSHOT_LIMIT_INVALID"),
    maxTransactions: exactInteger(value.maxTransactions, 1, 512, "EDIT_POLICY_TRANSACTION_LIMIT_INVALID"),
    snapshotTtlMs: exactInteger(value.snapshotTtlMs, 60_000, 24 * 60 * 60 * 1000, "EDIT_POLICY_TTL_INVALID"),
    maxEditsPerTransaction: exactInteger(value.maxEditsPerTransaction, 1, 128, "EDIT_POLICY_EDIT_COUNT_INVALID"),
    maxEditChars: exactInteger(value.maxEditChars, 1024, 4 * 1024 * 1024, "EDIT_POLICY_EDIT_SIZE_INVALID"),
    maxPreviewChars: exactInteger(value.maxPreviewChars, 1000, 64 * 1024, "EDIT_POLICY_PREVIEW_INVALID"),
    recoveryMaxLineShift: exactInteger(value.recoveryMaxLineShift, 0, 1000, "EDIT_POLICY_RECOVERY_SHIFT_INVALID"),
    recoveryContextChars: exactInteger(value.recoveryContextChars, 32, 1024, "EDIT_POLICY_RECOVERY_CONTEXT_INVALID"),
    maxReceiptsPerSession: exactInteger(value.maxReceiptsPerSession, 1, 4096, "EDIT_POLICY_RECEIPT_LIMIT_INVALID"),
  };
  if (policy.maxPreviewChars > policy.maxEditChars || policy.maxTransactions > policy.maxReceiptsPerSession) fail("EDIT_POLICY_LIMIT_ORDER_INVALID");
  return freeze(policy);
}

export function readEditEnginePolicy(file = policyFile) {
  try { return validateEditEnginePolicy(JSON.parse(fs.readFileSync(file, "utf8"))); }
  catch (error) { if (error instanceof EditEngineError) throw error; fail("EDIT_POLICY_UNREADABLE"); }
}

export function defaultEditReceiptRoot(environment = process.env) {
  const stateHome = environment.XDG_STATE_HOME || path.join(environment.HOME || os.homedir(), ".local", "state");
  return path.join(stateHome, "pi-overdrive", "edit-receipts");
}

function ensurePrivateDirectory(candidate) {
  const target = path.resolve(candidate);
  const missing = [];
  let existing = target;
  while (!fs.existsSync(existing)) {
    missing.unshift(existing);
    const parent = path.dirname(existing);
    if (parent === existing) fail("EDIT_RECEIPT_ROOT_INVALID");
    existing = parent;
  }
  const base = fs.lstatSync(existing);
  if (!base.isDirectory() || base.isSymbolicLink() || fs.realpathSync(existing) !== existing) fail("EDIT_RECEIPT_ROOT_UNSAFE");
  let cursor = existing;
  for (const item of missing) {
    if (path.dirname(item) !== cursor) fail("EDIT_RECEIPT_ROOT_INVALID");
    try { fs.mkdirSync(item, { mode: 0o700 }); } catch (error) { if (error?.code !== "EEXIST") throw error; }
    const stat = fs.lstatSync(item);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) fail("EDIT_RECEIPT_ROOT_RACE");
    cursor = item;
  }
  const canonical = fs.realpathSync(target);
  const stat = fs.lstatSync(canonical);
  if (canonical !== target || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) fail("EDIT_RECEIPT_ROOT_UNSAFE");
  fs.chmodSync(canonical, 0o700);
  return canonical;
}

function syncDirectory(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_DIRECTORY ?? 0));
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function readDescriptorBytes(descriptor, size) {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const read = fs.readSync(descriptor, bytes, offset, size - offset, offset);
    if (read === 0) fail("EDIT_DESCRIPTOR_SHORT_READ");
    offset += read;
  }
  return bytes;
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
  return value;
}

function sourceRelative(source) {
  if (typeof source !== "string" || !source.trim() || source.includes("\0")) fail("EDIT_SOURCE_INVALID");
  if (!source.startsWith("repo://")) return source;
  const parsed = parseResourceUri(source);
  if (parsed.scheme !== "repo" || parsed.authority !== "root") fail("EDIT_SOURCE_INVALID");
  return parsed.segments.join(path.sep);
}

function openTarget(cwd, source, maxBytes) {
  const relativeSource = sourceRelative(source);
  if (isAlwaysProtectedWritePath(relativeSource)) fail("EDIT_PATH_PROTECTED");
  const inspected = inspectWorkspacePath(cwd, relativeSource, { mustExist: true, forWrite: true });
  if (!inspected.allowed || !inspected.stat?.isFile() || inspected.stat.nlink !== 1) fail("EDIT_PATH_DENIED");
  if (isAlwaysProtectedWritePath(inspected.canonical)) fail("EDIT_PATH_PROTECTED");
  const parentPath = path.dirname(inspected.lexical);
  const basename = path.basename(inspected.lexical);
  let parentFd;
  let targetFd;
  try {
    parentFd = fs.openSync(parentPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_DIRECTORY ?? 0));
    const parentStat = fs.fstatSync(parentFd);
    const parentPathStat = fs.lstatSync(parentPath);
    if (!parentStat.isDirectory() || parentPathStat.isSymbolicLink() || !sameIdentity(parentStat, parentPathStat)) fail("EDIT_PARENT_CHANGED");
    const targetAt = `/proc/self/fd/${parentFd}/${basename}`;
    targetFd = fs.openSync(targetAt, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(targetFd);
    const pathStat = fs.lstatSync(targetAt);
    if (!stat.isFile() || stat.nlink !== 1 || pathStat.isSymbolicLink() || !sameIdentity(stat, pathStat) || !sameIdentity(stat, inspected.stat)) fail("EDIT_TARGET_CHANGED");
    if (stat.size > maxBytes) fail("EDIT_FILE_TOO_LARGE");
    const bytes = readDescriptorBytes(targetFd, stat.size);
    const after = fs.lstatSync(targetAt);
    if (!sameIdentity(stat, after) || after.isSymbolicLink()) fail("EDIT_TARGET_CHANGED");
    let raw;
    try { raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { fail("EDIT_BINARY_DENIED"); }
    const relative = path.relative(inspected.workspace, inspected.lexical);
    return { inspected, parentFd, parentStat, targetFd, targetAt, stat, bytes, raw, relative, basename };
  } catch (error) {
    if (targetFd !== undefined) fs.closeSync(targetFd);
    if (parentFd !== undefined) fs.closeSync(parentFd);
    if (error instanceof EditEngineError) throw error;
    fail("EDIT_OPEN_FAILED");
  }
}

function closeTarget(opened) {
  try { if (opened?.targetFd !== undefined) fs.closeSync(opened.targetFd); } catch {}
  try { if (opened?.parentFd !== undefined) fs.closeSync(opened.parentFd); } catch {}
}

function normalizedText(raw) {
  const bom = raw.startsWith("\ufeff") ? "\ufeff" : "";
  const body = bom ? raw.slice(1) : raw;
  const lineEnding = body.includes("\r\n") ? "\r\n" : "\n";
  return { bom, lineEnding, text: body.replace(/\r\n/gu, "\n") };
}

function restoreText(normalized, bom, lineEnding) {
  return `${bom}${lineEnding === "\n" ? normalized : normalized.replace(/\n/gu, lineEnding)}`;
}

function normalizeRanges(ranges, totalLines) {
  if (!Array.isArray(ranges)) fail("EDIT_SEEN_RANGES_INVALID");
  const ordered = ranges.map((entry) => {
    if (!entry || !Number.isSafeInteger(entry.start) || !Number.isSafeInteger(entry.end) || entry.start < 1 || entry.end < entry.start || entry.start > totalLines) fail("EDIT_SEEN_RANGES_INVALID");
    return { start: entry.start, end: Math.min(entry.end, totalLines) };
  }).sort((left, right) => left.start - right.start || left.end - right.end);
  const merged = [];
  for (const range of ordered) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 1) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function rangesCover(ranges, start, end) {
  return ranges.some((range) => range.start <= start && range.end >= end);
}

function countLinesBefore(text, index) {
  let lines = 1;
  for (let offset = 0; offset < index; offset += 1) if (text.charCodeAt(offset) === 10) lines += 1;
  return lines;
}

function lineRange(text, start, length) {
  const first = countLinesBefore(text, start);
  let newlines = 0;
  for (let offset = start; offset < start + length; offset += 1) if (text.charCodeAt(offset) === 10) newlines += 1;
  return { start: first, end: first + newlines };
}

function occurrences(text, needle) {
  const found = [];
  let from = 0;
  while (from <= text.length) {
    const index = text.indexOf(needle, from);
    if (index < 0) break;
    found.push(index);
    if (found.length > 2) break;
    from = index + Math.max(1, needle.length);
  }
  return found;
}

function validateEdits(edits, policy) {
  if (!Array.isArray(edits) || edits.length < 1 || edits.length > policy.maxEditsPerTransaction) fail("EDIT_INPUT_INVALID");
  let characters = 0;
  const normalized = edits.map((entry) => {
    if (!entry || typeof entry.oldText !== "string" || typeof entry.newText !== "string" || !entry.oldText) fail("EDIT_INPUT_INVALID");
    const oldText = entry.oldText.replace(/\r\n/gu, "\n");
    const newText = entry.newText.replace(/\r\n/gu, "\n");
    if (!oldText || oldText === newText) fail("EDIT_NOOP_DENIED");
    characters += oldText.length + newText.length;
    return { oldText, newText };
  });
  if (characters > policy.maxEditChars) fail("EDIT_INPUT_TOO_LARGE");
  return normalized;
}

function locateSnapshotEdits(snapshot, edits) {
  const located = edits.map((edit) => {
    const found = occurrences(snapshot.text, edit.oldText);
    if (found.length !== 1) fail(found.length ? "EDIT_ANCHOR_AMBIGUOUS" : "STALE_EDIT");
    const start = found[0];
    const end = start + edit.oldText.length;
    const lines = lineRange(snapshot.text, start, edit.oldText.length);
    if (!rangesCover(snapshot.seenRanges, lines.start, lines.end)) fail("EDIT_UNSEEN_RANGE");
    return { ...edit, start, end, lines };
  }).sort((left, right) => left.start - right.start);
  for (let index = 1; index < located.length; index += 1) if (located[index].start < located[index - 1].end) fail("EDIT_OVERLAP_DENIED");
  return located;
}

function locateSnapshotRanges(snapshot, edits, policy) {
  if (!Array.isArray(edits) || edits.length < 1 || edits.length > policy.maxEditsPerTransaction) fail("EDIT_INPUT_INVALID");
  let characters = 0;
  const located = edits.map((edit) => {
    if (!edit || !Number.isSafeInteger(edit.start) || !Number.isSafeInteger(edit.end) || edit.start < 0 || edit.end <= edit.start || edit.end > snapshot.text.length || typeof edit.newText !== "string") fail("EDIT_INPUT_INVALID");
    const oldText = snapshot.text.slice(edit.start, edit.end);
    const newText = edit.newText.replace(/\r\n/gu, "\n");
    characters += oldText.length + newText.length;
    const lines = lineRange(snapshot.text, edit.start, oldText.length);
    if (!rangesCover(snapshot.seenRanges, lines.start, lines.end)) fail("EDIT_UNSEEN_RANGE");
    return { oldText, newText, start: edit.start, end: edit.end, lines };
  }).sort((left, right) => left.start - right.start);
  if (characters > policy.maxEditChars) fail("EDIT_INPUT_TOO_LARGE");
  for (let index = 1; index < located.length; index += 1) if (located[index].start < located[index - 1].end) fail("EDIT_OVERLAP_DENIED");
  return located;
}

function recoverLocations(snapshot, current, located, policy) {
  const currentLocations = [];
  const shifts = [];
  for (const edit of located) {
    const found = occurrences(current, edit.oldText);
    if (found.length !== 1) fail("STALE_EDIT");
    const start = found[0];
    const currentLines = lineRange(current, start, edit.oldText.length);
    const shift = currentLines.start - edit.lines.start;
    if (Math.abs(shift) > policy.recoveryMaxLineShift) fail("STALE_EDIT");
    const left = snapshot.text.slice(Math.max(0, edit.start - policy.recoveryContextChars), edit.start);
    const right = snapshot.text.slice(edit.end, Math.min(snapshot.text.length, edit.end + policy.recoveryContextChars));
    const leftMatches = left.length > 0 && current.slice(Math.max(0, start - left.length), start) === left;
    const rightMatches = right.length > 0 && current.slice(start + edit.oldText.length, start + edit.oldText.length + right.length) === right;
    if (!leftMatches && !rightMatches) fail("STALE_EDIT");
    currentLocations.push({ ...edit, start, end: start + edit.oldText.length, lines: currentLines });
    shifts.push(shift);
  }
  if (shifts.some((shift) => shift !== shifts[0])) fail("STALE_EDIT");
  const sorted = currentLocations.sort((left, right) => left.start - right.start);
  for (let index = 1; index < sorted.length; index += 1) if (sorted[index].start < sorted[index - 1].end) fail("STALE_EDIT");
  return sorted;
}

function applyLocated(text, edits) {
  let output = text;
  for (const edit of [...edits].sort((left, right) => right.start - left.start)) output = `${output.slice(0, edit.start)}${edit.newText}${output.slice(edit.end)}`;
  return output;
}

function previewText(relative, status, edits, syntaxStatus, maxChars, contract) {
  const hunks = edits.map((edit) => {
    const removed = edit.oldText.split("\n").map((line) => `-${line}`).join("\n");
    const added = edit.newText.split("\n").map((line) => `+${line}`).join("\n");
    return `@@ seen lines ${edit.lines.start}-${edit.lines.end} @@\n${removed}\n${added}`;
  }).join("\n");
  const output = `[EDIT PREVIEW — WORKSPACE DATA]\ncontract=${contract}; status=${status}; file=${relative}; syntax=${syntaxStatus}\n${hunks}`;
  if (output.length > maxChars) fail("EDIT_PREVIEW_TOO_LARGE");
  return output;
}

function validationReceipt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("EDIT_VALIDATION_INVALID");
  const keys = ["kind", "status", "language", "backendDigest", "projectDigest", "baselineErrorCount", "candidateErrorCount", "postErrorCount", "baselineDigest", "candidateDigest", "postDigest"];
  if (Object.keys(value).some((key) => !keys.includes(key)) || value.kind !== "LSP_WRITE_GUARD" || value.status !== "PASS") fail("EDIT_VALIDATION_INVALID");
  if (typeof value.language !== "string" || !/^[A-Za-z][A-Za-z0-9_+-]{0,31}$/u.test(value.language)) fail("EDIT_VALIDATION_INVALID");
  for (const key of ["baselineErrorCount", "candidateErrorCount", "postErrorCount"]) if (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 2000) fail("EDIT_VALIDATION_INVALID");
  for (const key of ["backendDigest", "projectDigest", "baselineDigest", "candidateDigest", "postDigest"]) if (!DIGEST.test(value[key] ?? "")) fail("EDIT_VALIDATION_INVALID");
  return freeze(Object.fromEntries(keys.map((key) => [key, value[key]])));
}

function syntaxStatus(relative, normalized) {
  if (path.extname(relative).toLowerCase() !== ".json") return "NOT_APPLICABLE_PHASE9";
  try { JSON.parse(normalized); return "PASS"; }
  catch { fail("EDIT_SYNTAX_INVALID"); }
}

function writeStage(opened, basename, bytes, mode) {
  const stageAt = `/proc/self/fd/${opened.parentFd}/${basename}`;
  let descriptor;
  try {
    descriptor = fs.openSync(stageAt, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode & 0o777);
    fs.writeFileSync(descriptor, bytes);
    fs.fchmodSync(descriptor, mode & 0o777);
    fs.fsyncSync(descriptor);
    const stat = fs.fstatSync(descriptor);
    const pathname = fs.lstatSync(stageAt);
    if (!stat.isFile() || stat.nlink !== 1 || pathname.isSymbolicLink() || !sameIdentity(stat, pathname) || !readDescriptorBytes(descriptor, stat.size).equals(bytes)) fail("EDIT_STAGE_INVALID");
    return { descriptor, stageAt, stat };
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(stageAt); } catch {}
    if (error instanceof EditEngineError) throw error;
    fail("EDIT_STAGE_FAILED");
  }
}

function closeStage(stage, remove = false) {
  try { if (stage?.descriptor !== undefined) fs.closeSync(stage.descriptor); } catch {}
  if (remove) try { fs.unlinkSync(stage.stageAt); } catch {}
}

function verifyOpenTarget(opened, expectedDigest, expectedIdentity) {
  try {
    const parentPath = path.dirname(opened.inspected.lexical);
    const parentPathStat = fs.lstatSync(parentPath);
    if (parentPathStat.isSymbolicLink() || !sameIdentity(parentPathStat, opened.parentStat)) fail("STALE_EDIT");
    const targetStat = fs.fstatSync(opened.targetFd);
    const pathname = fs.lstatSync(opened.targetAt);
    if (!sameIdentity(targetStat, expectedIdentity) || !sameIdentity(pathname, targetStat) || pathname.isSymbolicLink() || targetStat.nlink !== 1) fail("STALE_EDIT");
    const bytes = readDescriptorBytes(opened.targetFd, targetStat.size);
    if (hash(bytes) !== expectedDigest) fail("STALE_EDIT");
  } catch (error) {
    if (error instanceof EditEngineError) throw error;
    fail("STALE_EDIT");
  }
}

function atomicReplace(opened, stage, onRenamed) {
  verifyOpenTarget(opened, hash(opened.bytes), opened.stat);
  fs.renameSync(stage.stageAt, opened.targetAt);
  onRenamed();
  const installed = fs.lstatSync(opened.targetAt);
  const staged = fs.fstatSync(stage.descriptor);
  const old = fs.fstatSync(opened.targetFd);
  if (!sameIdentity(installed, staged) || installed.isSymbolicLink() || old.nlink !== 0) fail("EDIT_ATOMIC_VERIFY_FAILED");
  fs.fsyncSync(opened.parentFd);
}

function verifyInstalledTarget(opened, installedStage, expectedInstalledDigest) {
  try {
    const parentPathStat = fs.lstatSync(path.dirname(opened.inspected.lexical));
    const pathname = fs.lstatSync(opened.targetAt);
    const installed = fs.fstatSync(installedStage.descriptor);
    if (parentPathStat.isSymbolicLink() || !sameIdentity(parentPathStat, opened.parentStat) || pathname.isSymbolicLink() || !sameIdentity(pathname, installed) || installed.nlink !== 1) fail("EDIT_ROLLBACK_CONFLICT");
    if (hash(readDescriptorBytes(installedStage.descriptor, installed.size)) !== expectedInstalledDigest) fail("EDIT_ROLLBACK_CONFLICT");
  } catch (error) {
    if (error instanceof EditEngineError) throw error;
    fail("EDIT_ROLLBACK_CONFLICT");
  }
}

function rollback(opened, bytes, installedStage, expectedInstalledDigest) {
  verifyInstalledTarget(opened, installedStage, expectedInstalledDigest);
  const name = `.pi-overdrive-edit-rollback-${process.pid}-${randomBytes(8).toString("hex")}.tmp`;
  const stage = writeStage(opened, name, bytes, opened.stat.mode);
  try {
    fs.renameSync(stage.stageAt, opened.targetAt);
    const installed = fs.lstatSync(opened.targetAt);
    const staged = fs.fstatSync(stage.descriptor);
    if (!sameIdentity(installed, staged) || hash(readDescriptorBytes(stage.descriptor, staged.size)) !== hash(bytes)) fail("EDIT_ROLLBACK_FAILED");
    fs.fsyncSync(opened.parentFd);
  } finally { closeStage(stage, true); }
}

function reserveReceipt(directory, transactionId, limit) {
  if (!UUID.test(transactionId)) fail("EDIT_TRANSACTION_INVALID");
  const entries = fs.readdirSync(directory).filter((name) => RECEIPT_FILE.test(name));
  if (entries.length >= limit) fail("EDIT_RECEIPT_LIMIT_REACHED");
  const temporary = path.join(directory, `.receipt-${transactionId}-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  const target = path.join(directory, `${transactionId}.json`);
  const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  return { descriptor, temporary, target };
}

function commitReceipt(reservation, receipt) {
  const bytes = Buffer.from(`${JSON.stringify(stableJson(receipt), null, 2)}\n`);
  let linked = false;
  try {
    fs.writeFileSync(reservation.descriptor, bytes);
    fs.fsyncSync(reservation.descriptor);
    fs.closeSync(reservation.descriptor);
    reservation.descriptor = undefined;
    fs.linkSync(reservation.temporary, reservation.target);
    linked = true;
    fs.chmodSync(reservation.target, 0o400);
    syncDirectory(path.dirname(reservation.target));
    fs.unlinkSync(reservation.temporary);
    syncDirectory(path.dirname(reservation.target));
    return { id: receipt.transactionId, sha256: hash(bytes) };
  } catch (error) {
    if (linked) try { fs.unlinkSync(reservation.target); } catch {}
    throw error;
  }
}

function closeReservation(reservation) {
  try { if (reservation?.descriptor !== undefined) fs.closeSync(reservation.descriptor); } catch {}
  try { if (reservation?.temporary) fs.unlinkSync(reservation.temporary); } catch {}
}

export class EditEngine {
  constructor(options = {}) {
    this.policy = validateEditEnginePolicy(options.policy ?? readEditEnginePolicy());
    const inspected = inspectWorkspacePath(options.cwd ?? process.cwd(), ".", { mustExist: true });
    if (!inspected.allowed || !inspected.stat?.isDirectory()) fail("EDIT_WORKSPACE_INVALID");
    this.cwd = inspected.workspace;
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.beforeRename = typeof options.beforeRename === "function" ? options.beforeRename : undefined;
    this.beforeReceipt = typeof options.beforeReceipt === "function" ? options.beforeReceipt : undefined;
    const session = typeof options.sessionIdentity === "string" && options.sessionIdentity ? options.sessionIdentity : `ephemeral:${process.pid}`;
    this.workspaceDigest = hash(`workspace-v1\0${this.cwd}`);
    this.sessionDigest = hash(`edit-session-v1\0${session}\0${this.cwd}`);
    this.receiptDirectory = ensurePrivateDirectory(path.join(options.receiptRoot ?? defaultEditReceiptRoot(options.environment), this.sessionDigest));
    this.snapshots = new Map();
    this.transactions = new Map();
    this.stats = { snapshots: 0, previews: 0, recoveries: 0, applied: 0, stale: 0, denied: 0, rollbacks: 0 };
  }

  #prune() {
    const now = this.now();
    for (const [id, snapshot] of this.snapshots) if (snapshot.expiresAt <= now) this.snapshots.delete(id);
    for (const [id, transaction] of this.transactions) if (transaction.expiresAt <= now || transaction.status !== "PREVIEWED") this.transactions.delete(id);
    while (this.snapshots.size > this.policy.maxSnapshots) this.snapshots.delete(this.snapshots.keys().next().value);
    while (this.transactions.size > this.policy.maxTransactions) this.transactions.delete(this.transactions.keys().next().value);
  }

  capture(input = {}) {
    this.#prune();
    const opened = openTarget(this.cwd, input.source, this.policy.maxFileBytes);
    try {
      const normalized = normalizedText(opened.raw);
      const totalLines = normalized.text.split("\n").length;
      const seenRanges = input.seenAll === true ? [{ start: 1, end: totalLines }] : normalizeRanges(input.seenRanges ?? [], totalLines);
      const contentDigest = hash(normalized.text);
      const pathDigest = hash(`path-v1\0${opened.relative}`);
      const existing = [...this.snapshots.values()].find((snapshot) => snapshot.pathDigest === pathDigest && snapshot.contentDigest === contentDigest && snapshot.expiresAt > this.now());
      if (existing) {
        existing.seenRanges = normalizeRanges([...existing.seenRanges, ...seenRanges], totalLines);
        existing.expiresAt = this.now() + this.policy.snapshotTtlMs;
        existing.touchedAt = this.now();
        return this.snapshotMetadata(existing);
      }
      const snapshot = {
        id: randomUUID(), contract: EDIT_CONTRACT, relative: opened.relative, pathDigest, workspaceDigest: this.workspaceDigest,
        rawDigest: hash(opened.bytes), contentDigest, text: normalized.text, seenRanges,
        totalLines, createdAt: this.now(), touchedAt: this.now(), expiresAt: this.now() + this.policy.snapshotTtlMs,
      };
      this.snapshots.set(snapshot.id, snapshot);
      this.stats.snapshots += 1;
      this.#prune();
      return this.snapshotMetadata(snapshot);
    } finally { closeTarget(opened); }
  }

  snapshotMetadata(snapshot) {
    return freeze({ id: snapshot.id, contract: snapshot.contract, pathDigest: snapshot.pathDigest, contentDigest: snapshot.contentDigest, totalLines: snapshot.totalLines, seenRanges: structuredClone(snapshot.seenRanges), expiresAt: new Date(snapshot.expiresAt).toISOString() });
  }

  adapterSnapshot(snapshotId) {
    this.#prune();
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot || snapshot.expiresAt <= this.now()) fail("EDIT_SNAPSHOT_MISSING");
    return freeze({ id: snapshot.id, relative: snapshot.relative, text: snapshot.text, contentDigest: snapshot.contentDigest, seenRanges: structuredClone(snapshot.seenRanges), expiresAt: snapshot.expiresAt });
  }

  adapterTransaction(transactionId, expectedContract) {
    this.#prune();
    const transaction = this.transactions.get(transactionId);
    if (!transaction || transaction.status !== "PREVIEWED" || transaction.expiresAt <= this.now()) fail("EDIT_TRANSACTION_MISSING");
    if (expectedContract !== undefined && expectedContract !== transaction.contract) fail("EDIT_CONTRACT_MISMATCH");
    return freeze({
      id: transaction.id, contract: transaction.contract, relative: transaction.relative, pathDigest: transaction.pathDigest,
      beforeDigest: transaction.beforeRawDigest, afterDigest: hash(transaction.afterBytes),
      beforeText: normalizedText(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(transaction.beforeBytes)).text,
      afterText: normalizedText(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(transaction.afterBytes)).text,
      expiresAt: transaction.expiresAt,
    });
  }

  discardTransaction(transactionId) {
    this.#prune();
    const transaction = this.transactions.get(transactionId);
    if (!transaction || transaction.status !== "PREVIEWED") return false;
    transaction.status = "CANCELLED";
    transaction.beforeBytes.fill(0);
    transaction.afterBytes.fill(0);
    this.transactions.delete(transactionId);
    this.stats.denied += 1;
    return true;
  }

  #recordPreview(snapshot, opened, current, appliedLocations, input = {}) {
    const contract = input.contract ?? EDIT_CONTRACT;
    if (![EDIT_CONTRACT, AST_EDIT_CONTRACT].includes(contract)) fail("EDIT_CONTRACT_INVALID");
    const recovered = input.recovered === true;
    const status = input.status ?? (recovered ? "SAFE_RECOVERY" : "READY");
    const next = applyLocated(current.text, appliedLocations);
    if (next === current.text) fail("EDIT_NOOP_DENIED");
    const validation = syntaxStatus(snapshot.relative, next);
    const preview = previewText(snapshot.relative, status, appliedLocations, validation, this.policy.maxPreviewChars, contract);
    const transaction = {
      id: randomUUID(), contract, snapshotId: snapshot.id, relative: snapshot.relative,
      pathDigest: snapshot.pathDigest, workspaceDigest: this.workspaceDigest, status: "PREVIEWED", recovered,
      beforeRawDigest: hash(opened.bytes), beforeContentDigest: hash(current.text), beforeIdentity: { dev: opened.stat.dev, ino: opened.stat.ino },
      beforeBytes: Buffer.from(opened.bytes), afterBytes: Buffer.from(restoreText(next, current.bom, current.lineEnding), "utf8"),
      afterContentDigest: hash(next), editRanges: appliedLocations.map((entry) => entry.lines), editCount: appliedLocations.length,
      syntaxStatus: validation, createdAt: this.now(), expiresAt: this.now() + this.policy.snapshotTtlMs,
    };
    this.transactions.set(transaction.id, transaction);
    this.stats.previews += 1;
    if (recovered) this.stats.recoveries += 1;
    this.#prune();
    return freeze({ version: EDIT_ENGINE_VERSION, kind: "EDIT_PREVIEW", status, transactionId: transaction.id, snapshotId: snapshot.id, contract, pathDigest: snapshot.pathDigest, beforeDigest: transaction.beforeRawDigest, afterDigest: hash(transaction.afterBytes), editCount: transaction.editCount, editRanges: structuredClone(transaction.editRanges), syntaxStatus: validation, expiresAt: new Date(transaction.expiresAt).toISOString(), preview });
  }

  preview(input = {}) {
    this.#prune();
    const snapshot = this.snapshots.get(input.snapshotId);
    if (!snapshot || snapshot.expiresAt <= this.now()) fail("EDIT_SNAPSHOT_MISSING");
    const edits = validateEdits(input.edits, this.policy);
    const located = locateSnapshotEdits(snapshot, edits);
    const opened = openTarget(this.cwd, snapshot.relative, this.policy.maxFileBytes);
    try {
      const current = normalizedText(opened.raw);
      const currentDigest = hash(current.text);
      const recovered = currentDigest !== snapshot.contentDigest;
      const appliedLocations = recovered ? recoverLocations(snapshot, current.text, located, this.policy) : located;
      const status = recovered ? "SAFE_RECOVERY" : "READY";
      return this.#recordPreview(snapshot, opened, current, appliedLocations, { contract: EDIT_CONTRACT, recovered, status });
    } catch (error) {
      if (error instanceof EditEngineError && error.code === "STALE_EDIT") this.stats.stale += 1;
      else this.stats.denied += 1;
      throw error;
    } finally { closeTarget(opened); }
  }

  previewRanges(input = {}) {
    this.#prune();
    const snapshot = this.snapshots.get(input.snapshotId);
    if (!snapshot || snapshot.expiresAt <= this.now()) fail("EDIT_SNAPSHOT_MISSING");
    const located = locateSnapshotRanges(snapshot, input.edits, this.policy);
    const opened = openTarget(this.cwd, snapshot.relative, this.policy.maxFileBytes);
    try {
      const current = normalizedText(opened.raw);
      if (hash(current.text) !== snapshot.contentDigest) fail("STALE_EDIT");
      return this.#recordPreview(snapshot, opened, current, located, { contract: input.contract });
    } catch (error) {
      if (error instanceof EditEngineError && error.code === "STALE_EDIT") this.stats.stale += 1;
      else this.stats.denied += 1;
      throw error;
    } finally { closeTarget(opened); }
  }

  apply(input = {}) {
    this.#prune();
    const transaction = this.transactions.get(input.transactionId);
    if (!transaction || transaction.status !== "PREVIEWED" || transaction.expiresAt <= this.now()) fail("EDIT_TRANSACTION_MISSING");
    if (input.expectedContract !== undefined && input.expectedContract !== transaction.contract) fail("EDIT_CONTRACT_MISMATCH");
    const opened = openTarget(this.cwd, transaction.relative, this.policy.maxFileBytes);
    let stage;
    let reservation;
    let renamed = false;
    try {
      if (!sameIdentity(opened.stat, transaction.beforeIdentity) || hash(opened.bytes) !== transaction.beforeRawDigest) fail("STALE_EDIT");
      const stageName = `.pi-overdrive-edit-${transaction.id}-${randomBytes(6).toString("hex")}${path.extname(transaction.relative)}.tmp`;
      stage = writeStage(opened, stageName, transaction.afterBytes, opened.stat.mode);
      reservation = reserveReceipt(this.receiptDirectory, transaction.id, this.policy.maxReceiptsPerSession);
      this.beforeRename?.({ transactionId: transaction.id, relative: transaction.relative });
      verifyOpenTarget(opened, transaction.beforeRawDigest, transaction.beforeIdentity);
      atomicReplace(opened, stage, () => { renamed = true; });
      this.beforeReceipt?.({ transactionId: transaction.id, relative: transaction.relative });
      verifyInstalledTarget(opened, stage, hash(transaction.afterBytes));
      const appliedAt = new Date(this.now()).toISOString();
      const receipt = {
        version: EDIT_ENGINE_VERSION, kind: "EDIT_RECEIPT", contract: transaction.contract, transactionId: transaction.id,
        snapshotId: transaction.snapshotId, workspaceDigest: transaction.workspaceDigest, pathDigest: transaction.pathDigest,
        status: "APPLIED", recovered: transaction.recovered, editCount: transaction.editCount, editRanges: transaction.editRanges,
        beforeDigest: transaction.beforeRawDigest, afterDigest: hash(transaction.afterBytes), syntaxStatus: transaction.syntaxStatus,
        previewedAt: new Date(transaction.createdAt).toISOString(), appliedAt,
      };
      const receiptReference = commitReceipt(reservation, receipt);
      reservation = undefined;
      transaction.status = "APPLIED";
      transaction.beforeBytes.fill(0);
      transaction.afterBytes.fill(0);
      this.stats.applied += 1;
      return freeze({ version: EDIT_ENGINE_VERSION, kind: "EDIT_APPLIED", status: "APPLIED", contract: transaction.contract, transactionId: transaction.id, snapshotId: transaction.snapshotId, pathDigest: transaction.pathDigest, beforeDigest: receipt.beforeDigest, afterDigest: receipt.afterDigest, editCount: transaction.editCount, recovered: transaction.recovered, syntaxStatus: transaction.syntaxStatus, receipt: receiptReference });
    } catch (error) {
      let failure = error;
      if (renamed) {
        try { rollback(opened, transaction.beforeBytes, stage, hash(transaction.afterBytes)); this.stats.rollbacks += 1; }
        catch (rollbackError) { failure = rollbackError instanceof EditEngineError ? rollbackError : new EditEngineError("EDIT_ROLLBACK_FAILED"); }
      }
      if (failure instanceof EditEngineError && failure.code === "STALE_EDIT") this.stats.stale += 1;
      else this.stats.denied += 1;
      transaction.status = "FAILED";
      transaction.beforeBytes.fill(0);
      transaction.afterBytes.fill(0);
      throw failure;
    } finally {
      closeReservation(reservation);
      closeStage(stage, !renamed);
      closeTarget(opened);
    }
  }

  async applyValidated(input = {}, validate) {
    if (typeof validate !== "function") fail("EDIT_VALIDATION_INVALID");
    this.#prune();
    const transaction = this.transactions.get(input.transactionId);
    if (!transaction || transaction.status !== "PREVIEWED" || transaction.expiresAt <= this.now()) fail("EDIT_TRANSACTION_MISSING");
    if (input.expectedContract !== undefined && input.expectedContract !== transaction.contract) fail("EDIT_CONTRACT_MISMATCH");
    const opened = openTarget(this.cwd, transaction.relative, this.policy.maxFileBytes);
    let stage;
    let reservation;
    let renamed = false;
    try {
      if (!sameIdentity(opened.stat, transaction.beforeIdentity) || hash(opened.bytes) !== transaction.beforeRawDigest) fail("STALE_EDIT");
      const stageName = `.pi-overdrive-edit-${transaction.id}-${randomBytes(6).toString("hex")}${path.extname(transaction.relative)}.tmp`;
      stage = writeStage(opened, stageName, transaction.afterBytes, opened.stat.mode);
      reservation = reserveReceipt(this.receiptDirectory, transaction.id, this.policy.maxReceiptsPerSession);
      this.beforeRename?.({ transactionId: transaction.id, relative: transaction.relative });
      verifyOpenTarget(opened, transaction.beforeRawDigest, transaction.beforeIdentity);
      atomicReplace(opened, stage, () => { renamed = true; });
      const validation = validationReceipt(await validate({
        transactionId: transaction.id, contract: transaction.contract, relative: transaction.relative,
        pathDigest: transaction.pathDigest, beforeDigest: transaction.beforeRawDigest, afterDigest: hash(transaction.afterBytes),
      }));
      this.beforeReceipt?.({ transactionId: transaction.id, relative: transaction.relative });
      verifyInstalledTarget(opened, stage, hash(transaction.afterBytes));
      const appliedAt = new Date(this.now()).toISOString();
      const receipt = {
        version: EDIT_ENGINE_VERSION, kind: "EDIT_RECEIPT", contract: transaction.contract, transactionId: transaction.id,
        snapshotId: transaction.snapshotId, workspaceDigest: transaction.workspaceDigest, pathDigest: transaction.pathDigest,
        status: "APPLIED", recovered: transaction.recovered, editCount: transaction.editCount, editRanges: transaction.editRanges,
        beforeDigest: transaction.beforeRawDigest, afterDigest: hash(transaction.afterBytes), syntaxStatus: transaction.syntaxStatus,
        validation, previewedAt: new Date(transaction.createdAt).toISOString(), appliedAt,
      };
      const receiptReference = commitReceipt(reservation, receipt);
      reservation = undefined;
      transaction.status = "APPLIED";
      transaction.beforeBytes.fill(0);
      transaction.afterBytes.fill(0);
      this.stats.applied += 1;
      return freeze({
        version: EDIT_ENGINE_VERSION, kind: "EDIT_APPLIED", status: "APPLIED", contract: transaction.contract,
        transactionId: transaction.id, snapshotId: transaction.snapshotId, pathDigest: transaction.pathDigest,
        beforeDigest: receipt.beforeDigest, afterDigest: receipt.afterDigest, editCount: transaction.editCount,
        recovered: transaction.recovered, syntaxStatus: transaction.syntaxStatus, validation, receipt: receiptReference,
      });
    } catch (error) {
      let failure = error;
      if (renamed) {
        try { rollback(opened, transaction.beforeBytes, stage, hash(transaction.afterBytes)); this.stats.rollbacks += 1; }
        catch (rollbackError) { failure = rollbackError instanceof EditEngineError ? rollbackError : new EditEngineError("EDIT_ROLLBACK_FAILED"); }
      }
      if (failure instanceof EditEngineError && failure.code === "STALE_EDIT") this.stats.stale += 1;
      else this.stats.denied += 1;
      transaction.status = "FAILED";
      transaction.beforeBytes.fill(0);
      transaction.afterBytes.fill(0);
      throw failure;
    } finally {
      closeReservation(reservation);
      closeStage(stage, !renamed);
      closeTarget(opened);
    }
  }

  status() {
    this.#prune();
    return freeze({ version: EDIT_ENGINE_VERSION, contract: EDIT_CONTRACT, snapshots: this.snapshots.size, transactions: this.transactions.size, receipts: fs.readdirSync(this.receiptDirectory).filter((name) => RECEIPT_FILE.test(name)).length, stats: { ...this.stats } });
  }
}

export function snapshotFooter(metadata) {
  if (!metadata || !UUID.test(metadata.id ?? "") || !DIGEST.test(metadata.contentDigest ?? "")) fail("EDIT_SNAPSHOT_METADATA_INVALID");
  const seen = metadata.seenRanges.length ? metadata.seenRanges.map((range) => `${range.start}-${range.end}`).join(",") : "none";
  return `[EDIT SNAPSHOT] id=${metadata.id}; contract=${metadata.contract}; content=${metadata.contentDigest.slice(0, 16)}; seen=${seen}; expires=${metadata.expiresAt}`;
}
