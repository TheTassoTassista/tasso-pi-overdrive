import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactSensitiveText } from "./memory-security.mjs";
import { compactToolText } from "./output-optimizer.mjs";

export const ARTIFACT_STORE_VERSION = 1;
export const ARTIFACT_ID = /^[0-9a-f]{64}$/u;
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const policyFile = path.join(packageRoot, "config", "artifacts.json");
const MIME_TYPES = new Set(["text/plain", "text/markdown", "application/json"]);
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_PREVIEW_BYTES = 48 * 1024;
const MAX_RETENTION_SCOPES = 1024;
const MILLISECONDS_PER_DAY = 86_400_000;
const KNOWN_FILE = /^(?:[0-9a-f]{64}\.(?:data|json)|\.[0-9a-f]{64}\.[0-9]+\.[0-9a-f]{16}\.tmp)$/u;

export class ArtifactStoreError extends Error {
  constructor(code) {
    super(code);
    this.name = "ArtifactStoreError";
    this.code = code;
  }
}

function fail(code) { throw new ArtifactStoreError(code); }
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

export function validateArtifactPolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== ARTIFACT_STORE_VERSION) fail("artifact_policy_invalid");
  const keys = ["version", "inlineThresholdBytes", "previewMaxChars", "maxArtifactBytes", "maxScopeBytes", "maxArtifactsPerScope", "readMaxLines", "searchMaxResults", "retentionDays", "redactSecrets", "trust"];
  if (Object.keys(value).some((key) => !keys.includes(key))) fail("artifact_policy_unknown_field");
  const policy = {
    version: value.version,
    inlineThresholdBytes: exactInteger(value.inlineThresholdBytes, 1024, 1024 * 1024, "artifact_policy_inline_threshold_invalid"),
    previewMaxChars: exactInteger(value.previewMaxChars, 1000, 64 * 1024, "artifact_policy_preview_invalid"),
    maxArtifactBytes: exactInteger(value.maxArtifactBytes, 64 * 1024, 64 * 1024 * 1024, "artifact_policy_item_quota_invalid"),
    maxScopeBytes: exactInteger(value.maxScopeBytes, value.maxArtifactBytes, 1024 * 1024 * 1024, "artifact_policy_scope_quota_invalid"),
    maxArtifactsPerScope: exactInteger(value.maxArtifactsPerScope, 1, 4096, "artifact_policy_count_invalid"),
    readMaxLines: exactInteger(value.readMaxLines, 1, 2000, "artifact_policy_read_limit_invalid"),
    searchMaxResults: exactInteger(value.searchMaxResults, 1, 1000, "artifact_policy_search_limit_invalid"),
    retentionDays: exactInteger(value.retentionDays, 1, 3650, "artifact_policy_retention_invalid"),
    redactSecrets: value.redactSecrets,
    trust: value.trust,
  };
  if (policy.redactSecrets !== true || policy.trust !== "TOOL_OUTPUT_UNTRUSTED" || policy.inlineThresholdBytes > policy.maxArtifactBytes || policy.previewMaxChars > policy.inlineThresholdBytes) fail("artifact_policy_security_invalid");
  return freeze(policy);
}

export function readArtifactPolicy(file = policyFile) {
  try { return validateArtifactPolicy(JSON.parse(fs.readFileSync(file, "utf8"))); }
  catch (error) { if (error instanceof ArtifactStoreError) throw error; fail("artifact_policy_unreadable"); }
}

export function defaultArtifactRoot(environment = process.env) {
  const stateHome = environment.XDG_STATE_HOME || path.join(environment.HOME || os.homedir(), ".local", "state");
  return path.join(stateHome, "pi-overdrive", "artifacts");
}

export function artifactSessionIdentity(sessionFile, cwd, processId = process.pid) {
  const session = typeof sessionFile === "string" && sessionFile ? path.resolve(sessionFile) : `ephemeral-process:${processId}`;
  let workspace;
  try { workspace = fs.realpathSync(cwd); } catch { workspace = path.resolve(cwd); }
  return freeze({ sessionDigest: hash(`session-v1\0${session}`), scopeDigest: hash(`scope-v1\0${session}\0${workspace}`) });
}

function ensurePrivateDirectory(candidate) {
  const target = path.resolve(candidate);
  const missing = [];
  let existing = target;
  while (!fs.existsSync(existing)) {
    missing.unshift(existing);
    const parent = path.dirname(existing);
    if (parent === existing) fail("artifact_root_missing_ancestor");
    existing = parent;
  }
  const base = fs.lstatSync(existing);
  if (!base.isDirectory() || base.isSymbolicLink() || fs.realpathSync(existing) !== existing) fail("artifact_root_unsafe_ancestor");
  let cursor = existing;
  for (const item of missing) {
    if (path.dirname(item) !== cursor) fail("artifact_root_invalid_chain");
    try { fs.mkdirSync(item, { mode: 0o700 }); } catch (error) { if (error?.code !== "EEXIST") throw error; }
    const stat = fs.lstatSync(item);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) fail("artifact_root_creation_race");
    cursor = item;
  }
  const canonical = fs.realpathSync(target);
  const stat = fs.lstatSync(canonical);
  if (canonical !== target || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) fail("artifact_root_unsafe");
  let descriptor;
  try {
    descriptor = fs.openSync(canonical, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_DIRECTORY ?? 0));
    const opened = fs.fstatSync(descriptor);
    const pathname = fs.lstatSync(canonical);
    if (!opened.isDirectory() || opened.uid !== process.getuid() || pathname.isSymbolicLink() || !sameIdentity(opened, pathname)) fail("artifact_root_identity_changed");
    fs.fchmodSync(descriptor, 0o700);
    const after = fs.lstatSync(canonical);
    if (!sameIdentity(opened, after) || after.isSymbolicLink()) fail("artifact_root_identity_changed");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  return canonical;
}

function openPrivateFile(file, maximumBytes) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(descriptor);
    const pathname = fs.lstatSync(file);
    if (!opened.isFile() || opened.uid !== process.getuid() || opened.nlink !== 1 || (opened.mode & 0o077) !== 0 || pathname.isSymbolicLink() || !sameIdentity(opened, pathname)) fail("artifact_file_unsafe");
    if (opened.size > maximumBytes) fail("artifact_file_too_large");
    const bytes = fs.readFileSync(descriptor);
    const after = fs.lstatSync(file);
    if (!sameIdentity(opened, after) || after.isSymbolicLink()) fail("artifact_file_identity_changed");
    return { bytes, stat: opened };
  } catch (error) {
    if (error instanceof ArtifactStoreError) throw error;
    if (error?.code === "ENOENT") fail("artifact_not_found");
    fail("artifact_file_open_failed");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function writePrivateAtomic(directory, basename, bytes) {
  if (!/^(?:[0-9a-f]{64}\.(?:data|json))$/u.test(basename)) fail("artifact_filename_invalid");
  const destination = path.join(directory, basename);
  if (fs.existsSync(destination)) openPrivateFile(destination, Math.max(MAX_MANIFEST_BYTES, bytes.length + 1));
  const temporary = path.join(directory, `.${basename.slice(0, 64)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (fs.realpathSync(directory) !== directory) fail("artifact_root_changed");
    fs.renameSync(temporary, destination);
    openPrivateFile(destination, Math.max(MAX_MANIFEST_BYTES, bytes.length + 1));
    const directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
  }
}

export function sanitizeArtifactText(value) {
  const original = String(value ?? "");
  const controls = original
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "�");
  const withoutPrivateKeys = controls.replace(/-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|$)/gu, "[REDACTED PRIVATE KEY]");
  const text = redactSensitiveText(withoutPrivateKeys);
  return freeze({ text, redacted: text !== controls, sanitizedControls: controls !== original, sourceBytes: Buffer.byteLength(original), storedBytes: Buffer.byteLength(text) });
}

function producerName(value) {
  const sanitized = String(value ?? "tool").replace(/[^A-Za-z0-9_.:-]+/gu, "_").slice(0, 64).replace(/^_+|_+$/gu, "");
  return sanitized || "tool";
}

function digestValue(value, fallback) {
  return ARTIFACT_ID.test(String(value ?? "")) ? String(value) : hash(fallback);
}

function validateManifest(value, scopeDigest, id) {
  const allowedKeys = ["version", "kind", "id", "uri", "sha256", "sizeBytes", "sourceBytes", "characters", "lines", "mime", "producerTools", "createdAt", "expiresAt", "retentionDays", "sessionDigest", "scopeDigest", "taskDigests", "trust", "immutable", "redacted", "sanitizedControls"];
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== ARTIFACT_STORE_VERSION || value.kind !== "ARTIFACT_MANIFEST" || value.id !== id || value.sha256 !== id || value.uri !== `artifact://${id}` || value.scopeDigest !== scopeDigest) fail("artifact_manifest_invalid");
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) fail("artifact_manifest_invalid");
  const producersValid = Array.isArray(value.producerTools) && value.producerTools.length >= 1 && value.producerTools.length <= 16 && value.producerTools.every((entry) => typeof entry === "string" && /^[A-Za-z0-9_.:-]{1,64}$/u.test(entry)) && new Set(value.producerTools).size === value.producerTools.length;
  const tasksValid = Array.isArray(value.taskDigests) && value.taskDigests.length >= 1 && value.taskDigests.length <= 32 && value.taskDigests.every((entry) => ARTIFACT_ID.test(entry)) && new Set(value.taskDigests).size === value.taskDigests.length;
  if (!ARTIFACT_ID.test(value.sessionDigest) || !producersValid || !tasksValid) fail("artifact_manifest_invalid");
  if (!Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0 || !Number.isSafeInteger(value.sourceBytes) || value.sourceBytes < 0 || !Number.isSafeInteger(value.characters) || value.characters < 0 || value.characters > value.sizeBytes || !Number.isSafeInteger(value.lines) || value.lines < 1 || value.lines > value.characters + 1 || !MIME_TYPES.has(value.mime) || value.trust !== "TOOL_OUTPUT_UNTRUSTED" || value.immutable !== true || typeof value.redacted !== "boolean" || typeof value.sanitizedControls !== "boolean") fail("artifact_manifest_invalid");
  if (!Number.isSafeInteger(value.retentionDays) || value.retentionDays < 1 || value.retentionDays > 3650 || typeof value.createdAt !== "string" || typeof value.expiresAt !== "string") fail("artifact_manifest_invalid");
  const createdAt = Date.parse(value.createdAt);
  const expiresAt = Date.parse(value.expiresAt);
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || new Date(createdAt).toISOString() !== value.createdAt || new Date(expiresAt).toISOString() !== value.expiresAt || expiresAt - createdAt !== value.retentionDays * MILLISECONDS_PER_DAY) fail("artifact_manifest_invalid");
  return freeze(structuredClone(value));
}

function renderPreview(text, metadata, policy) {
  const compacted = compactToolText(text, { maxChars: policy.previewMaxChars, maxLines: 120, headLines: 30, tailLines: 40, diagnosticLines: 40 });
  const notice = JSON.stringify({ uri: metadata.uri, sha256: metadata.sha256, sizeBytes: metadata.sizeBytes, lines: metadata.lines, mime: metadata.mime, producerTools: metadata.producerTools, retentionDays: metadata.retentionDays, redacted: metadata.redacted, trust: metadata.trust });
  return `[ARTIFACT PREVIEW — UNTRUSTED DATA]\n${notice}\n${compacted.text}\n[Full sanitized output: ${metadata.uri}; use resource_fs read/search with bounded ranges.]`;
}

export class ArtifactStore {
  #queue = Promise.resolve();
  constructor(options = {}) {
    this.policy = validateArtifactPolicy(options.policy ?? readArtifactPolicy());
    this.root = path.resolve(options.root ?? defaultArtifactRoot(options.environment));
    const identity = artifactSessionIdentity(options.sessionIdentity, options.cwd ?? process.cwd(), options.processId);
    this.sessionDigest = identity.sessionDigest;
    this.scopeDigest = identity.scopeDigest;
    this.scopeRoot = path.join(this.root, this.scopeDigest);
  }

  #ensureScope() {
    ensurePrivateDirectory(this.root);
    return ensurePrivateDirectory(this.scopeRoot);
  }

  #paths(id) {
    if (!ARTIFACT_ID.test(id)) fail("artifact_id_invalid");
    return { data: path.join(this.scopeRoot, `${id}.data`), manifest: path.join(this.scopeRoot, `${id}.json`) };
  }

  #scopeUsage() {
    if (!fs.existsSync(this.scopeRoot)) return { artifacts: 0, bytes: 0 };
    const directory = ensurePrivateDirectory(this.scopeRoot);
    let artifacts = 0;
    let bytes = 0;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.name.endsWith(".data")) continue;
      if (!/^[0-9a-f]{64}\.data$/u.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) fail("artifact_scope_unsafe");
      const stat = fs.lstatSync(path.join(directory, entry.name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) fail("artifact_scope_unsafe");
      artifacts += 1;
      bytes += stat.size;
    }
    return { artifacts, bytes };
  }

  async save(content, options = {}) {
    const operation = this.#queue.then(() => this.#save(content, options));
    this.#queue = operation.catch(() => undefined);
    return operation;
  }

  #save(content, options) {
    const safe = sanitizeArtifactText(content);
    if (Math.max(safe.sourceBytes, safe.storedBytes) > this.policy.maxArtifactBytes) fail("artifact_item_quota_exceeded");
    const id = hash(Buffer.from(safe.text, "utf8"));
    const uri = `artifact://${id}`;
    const directory = this.#ensureScope();
    const paths = this.#paths(id);
    const exists = fs.existsSync(paths.data);
    const usage = this.#scopeUsage();
    if (!exists && usage.artifacts >= this.policy.maxArtifactsPerScope) fail("artifact_count_quota_exceeded");
    if (!exists && usage.bytes + safe.storedBytes > this.policy.maxScopeBytes) fail("artifact_scope_quota_exceeded");
    if (exists) {
      const stored = openPrivateFile(paths.data, this.policy.maxArtifactBytes).bytes;
      if (hash(stored) !== id || !stored.equals(Buffer.from(safe.text, "utf8"))) fail("artifact_digest_collision");
    } else {
      writePrivateAtomic(directory, `${id}.data`, Buffer.from(safe.text, "utf8"));
    }
    const producer = producerName(options.producerTool);
    const taskDigest = digestValue(options.taskDigest, "artifact-task-unassigned");
    const nowMs = options.nowMs === undefined ? Date.now() : Number(options.nowMs);
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > 8_640_000_000_000_000 - this.policy.retentionDays * MILLISECONDS_PER_DAY) fail("artifact_timestamp_invalid");
    let manifest;
    if (fs.existsSync(paths.manifest)) {
      const current = validateManifest(JSON.parse(openPrivateFile(paths.manifest, MAX_MANIFEST_BYTES).bytes.toString("utf8")), this.scopeDigest, id);
      manifest = { ...current, sourceBytes: Math.max(current.sourceBytes, safe.sourceBytes), producerTools: [...new Set([...current.producerTools, producer])].slice(0, 16), taskDigests: [...new Set([...current.taskDigests, taskDigest])].slice(0, 32), redacted: current.redacted || safe.redacted, sanitizedControls: current.sanitizedControls || safe.sanitizedControls };
    } else {
      manifest = {
        version: ARTIFACT_STORE_VERSION, kind: "ARTIFACT_MANIFEST", id, uri, sha256: id,
        sizeBytes: safe.storedBytes, sourceBytes: safe.sourceBytes, characters: safe.text.length,
        lines: safe.text.split("\n").length, mime: MIME_TYPES.has(options.mime) ? options.mime : "text/plain",
        producerTools: [producer], createdAt: new Date(nowMs).toISOString(), expiresAt: new Date(nowMs + this.policy.retentionDays * MILLISECONDS_PER_DAY).toISOString(), retentionDays: this.policy.retentionDays,
        sessionDigest: this.sessionDigest, scopeDigest: this.scopeDigest, taskDigests: [taskDigest], trust: this.policy.trust, immutable: true,
        redacted: safe.redacted, sanitizedControls: safe.sanitizedControls,
      };
    }
    const checked = validateManifest(manifest, this.scopeDigest, id);
    writePrivateAtomic(directory, `${id}.json`, Buffer.from(`${JSON.stringify(checked)}\n`, "utf8"));
    const metadata = freeze({ ...checked, deduplicated: exists });
    return freeze({ metadata, preview: renderPreview(safe.text, metadata, this.policy) });
  }

  #load(id) {
    const paths = this.#paths(id);
    const manifest = validateManifest(JSON.parse(openPrivateFile(paths.manifest, MAX_MANIFEST_BYTES).bytes.toString("utf8")), this.scopeDigest, id);
    const data = openPrivateFile(paths.data, this.policy.maxArtifactBytes).bytes;
    if (data.length !== manifest.sizeBytes || hash(data) !== id) fail("artifact_integrity_failed");
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { fail("artifact_encoding_invalid"); }
    return { manifest, text };
  }

  read(id, options = {}) {
    const { manifest, text } = this.#load(id);
    const lines = text.split("\n");
    const offsetLine = options.offsetLine === undefined ? 1 : exactInteger(options.offsetLine, 1, Math.max(1, lines.length), "artifact_range_offset_invalid");
    const limitLines = options.limitLines === undefined ? Math.min(200, this.policy.readMaxLines) : exactInteger(options.limitLines, 1, this.policy.readMaxLines, "artifact_range_limit_invalid");
    const selected = lines.slice(offsetLine - 1, offsetLine - 1 + limitLines);
    const rows = [];
    let partialLine = false;
    let usedBytes = 0;
    for (const [index, line] of selected.entries()) {
      const row = `${offsetLine + index}|${line}`;
      const rowBytes = Buffer.byteLength(`${row}${rows.length ? "\n" : ""}`);
      if (usedBytes + rowBytes > MAX_PREVIEW_BYTES) {
        const remaining = Math.max(0, MAX_PREVIEW_BYTES - usedBytes);
        if (remaining) rows.push(`${row.slice(0, remaining)} [line truncated; search artifact or request a narrower range]`);
        partialLine = true;
        break;
      }
      rows.push(row);
      usedBytes += rowBytes;
    }
    const shown = rows.length;
    const end = Math.min(lines.length, offsetLine + Math.max(0, shown - 1));
    const omittedBefore = offsetLine - 1;
    const omittedAfter = Math.max(0, lines.length - end);
    const content = [
      ...(omittedBefore ? [`[${omittedBefore} artifact lines omitted before]`] : []),
      ...rows,
      ...(omittedAfter ? [`[${omittedAfter} artifact lines omitted after]`] : []),
    ].join("\n");
    return freeze({ content, contentType: manifest.mime, truncated: omittedBefore > 0 || omittedAfter > 0 || partialLine, details: { id, totalLines: lines.length, range: { start: offsetLine, end }, partialLine, sha256: id, sizeBytes: manifest.sizeBytes, producerTools: manifest.producerTools, trust: manifest.trust, retentionDays: manifest.retentionDays } });
  }

  search(id, query, options = {}) {
    const needle = String(query ?? "");
    if (!needle || needle.length > 1000 || /[\u0000-\u001f\u007f]/u.test(needle)) fail("artifact_search_query_invalid");
    const maxResults = options.maxResults === undefined ? Math.min(50, this.policy.searchMaxResults) : exactInteger(options.maxResults, 1, this.policy.searchMaxResults, "artifact_search_limit_invalid");
    const { manifest, text } = this.#load(id);
    const folded = needle.toLocaleLowerCase("en-US");
    const matches = [];
    for (const [index, line] of text.split("\n").entries()) {
      if (!line.toLocaleLowerCase("en-US").includes(folded)) continue;
      matches.push({ line: index + 1, preview: line.slice(0, 300) });
      if (matches.length >= maxResults) break;
    }
    return freeze({ content: JSON.stringify({ artifact: `artifact://${id}`, matches, truncated: matches.length >= maxResults }), contentType: "application/json", truncated: matches.length >= maxResults, details: { id, sha256: id, sizeBytes: manifest.sizeBytes, matches: matches.length, maxResults, trust: manifest.trust } });
  }

  list() {
    if (!fs.existsSync(this.scopeRoot)) return freeze([]);
    const directory = ensurePrivateDirectory(this.scopeRoot);
    const manifests = [];
    for (const entry of fs.readdirSync(directory).filter((name) => /^[0-9a-f]{64}\.json$/u.test(name)).sort().slice(0, this.policy.maxArtifactsPerScope)) {
      const id = entry.slice(0, 64);
      manifests.push(validateManifest(JSON.parse(openPrivateFile(path.join(directory, entry), MAX_MANIFEST_BYTES).bytes.toString("utf8")), this.scopeDigest, id));
    }
    return freeze(manifests);
  }
}

export function createArtifactStore(options = {}) { return new ArtifactStore(options); }

function unlinkVerified(file) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(descriptor);
    const pathname = fs.lstatSync(file);
    if (!opened.isFile() || opened.uid !== process.getuid() || opened.nlink !== 1 || (opened.mode & 0o077) !== 0 || pathname.isSymbolicLink() || !sameIdentity(opened, pathname)) return false;
    fs.unlinkSync(file);
    return fs.fstatSync(descriptor).nlink === 0;
  } catch { return false; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

export function pruneArtifactStore(options = {}) {
  const root = path.resolve(options.root ?? defaultArtifactRoot(options.environment));
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const apply = options.apply !== false;
  const summary = { status: "PASS", apply, scannedScopes: 0, scannedArtifacts: 0, eligibleArtifacts: 0, removedArtifacts: 0, scannedOrphans: 0, eligibleOrphans: 0, removedOrphans: 0, skipped: 0, capped: false };
  let policy;
  try { policy = validateArtifactPolicy(options.policy ?? readArtifactPolicy()); }
  catch { return freeze({ ...summary, status: "SKIPPED_ARTIFACT_POLICY" }); }
  if (!fs.existsSync(root)) return freeze({ ...summary, status: "SKIPPED_ARTIFACT_ROOT" });
  let safeRoot;
  try { safeRoot = ensurePrivateDirectory(root); } catch { return freeze({ ...summary, status: "SKIPPED_UNSAFE_ARTIFACT_ROOT" }); }
  const scopes = fs.readdirSync(safeRoot, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of scopes) {
    if (summary.scannedScopes >= MAX_RETENTION_SCOPES) { summary.capped = true; break; }
    if (!ARTIFACT_ID.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) { summary.skipped += 1; continue; }
    summary.scannedScopes += 1;
    const scope = path.join(safeRoot, entry.name);
    let directory;
    try { directory = ensurePrivateDirectory(scope); } catch { summary.skipped += 1; continue; }
    const names = fs.readdirSync(directory).sort();
    summary.skipped += names.filter((name) => !KNOWN_FILE.test(name)).length;
    for (const name of names.filter((candidate) => candidate.endsWith(".json"))) {
      const id = name.slice(0, 64);
      summary.scannedArtifacts += 1;
      let manifest;
      try { manifest = validateManifest(JSON.parse(openPrivateFile(path.join(directory, name), MAX_MANIFEST_BYTES).bytes.toString("utf8")), entry.name, id); }
      catch { summary.skipped += 1; continue; }
      const expiresAt = Date.parse(manifest.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt > nowMs) continue;
      summary.eligibleArtifacts += 1;
      if (!apply) continue;
      const data = path.join(directory, `${id}.data`);
      const manifestFile = path.join(directory, name);
      const dataRemoved = !names.includes(`${id}.data`) || unlinkVerified(data);
      if (dataRemoved && unlinkVerified(manifestFile)) summary.removedArtifacts += 1;
      else summary.skipped += 1;
    }
    const remaining = fs.readdirSync(directory).filter((name) => KNOWN_FILE.test(name)).sort();
    const remainingSet = new Set(remaining);
    for (const name of remaining) {
      const isTemporary = name.startsWith(".") && name.endsWith(".tmp");
      const id = isTemporary ? name.slice(1, 65) : name.slice(0, 64);
      const isOrphanData = name.endsWith(".data") && !remainingSet.has(`${id}.json`);
      const isOrphanManifest = name.endsWith(".json") && !remainingSet.has(`${id}.data`);
      if (!isTemporary && !isOrphanData && !isOrphanManifest) continue;
      summary.scannedOrphans += 1;
      const file = path.join(directory, name);
      let stat;
      try { stat = fs.lstatSync(file); } catch { summary.skipped += 1; continue; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) { summary.skipped += 1; continue; }
      if (stat.mtimeMs + policy.retentionDays * MILLISECONDS_PER_DAY > nowMs) continue;
      summary.eligibleOrphans += 1;
      if (apply && unlinkVerified(file)) summary.removedOrphans += 1;
      else if (apply) summary.skipped += 1;
    }
    if (apply) {
      try { if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory); } catch { summary.skipped += 1; }
    }
  }
  return freeze(summary);
}
