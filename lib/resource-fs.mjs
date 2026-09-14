import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { inspectWorkspacePath, isSecretPath } from "./safety.mjs";

export const RESOURCE_FS_VERSION = 1;
export const RESOURCE_CAPABILITIES = Object.freeze(["READ", "SEARCH", "WRITE", "MUTATE", "EXECUTE"]);
export const RESOURCE_TRUST = Object.freeze({
  WORKSPACE: "WORKSPACE_UNTRUSTED",
  MEMORY: "CURATED_MEMORY_UNTRUSTED",
  EXTERNAL: "EXTERNAL_UNTRUSTED",
  CONTROLLER: "CONTROLLER_METADATA",
});

const SCHEME = /^[a-z][a-z0-9+.-]{0,31}$/u;
const AUTHORITY = /^[a-z0-9](?:[a-z0-9._-]{0,62})$/u;
const URI = /^([A-Za-z][A-Za-z0-9+.-]{0,31}):\/\/([^/?#]*)(\/[^?#]*)?$/u;
const RISKY_CAPABILITIES = new Set(["WRITE", "MUTATE", "EXECUTE"]);
const OPERATIONS = new Set(["DESCRIBE", ...RESOURCE_CAPABILITIES]);
const MAX_URI_CHARS = 4096;
const MAX_CONTENT_CHARS = 64 * 1024;
const DEFAULT_LINE_LIMIT = 200;
const MAX_LINE_LIMIT = 500;
const MAX_REPO_FILE_BYTES = 1024 * 1024;
const MAX_INTERNAL_REPO_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_FILE_BYTES = 256 * 1024;
const MAX_SEARCH_BYTES = 4 * 1024 * 1024;
const MAX_SEARCH_FILES = 512;
const MAX_SEARCH_RESULTS = 100;
const SKIP_DIRECTORIES = new Set([".git", "node_modules"]);

export class ResourceFsError extends Error {
  constructor(code) {
    super(code);
    this.name = "ResourceFsError";
    this.code = code;
  }
}

function fail(code) { throw new ResourceFsError(code); }

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function strictDecode(value) {
  try { return decodeURIComponent(value); }
  catch { fail("resource_uri_encoding_invalid"); }
}

function encodeSegment(value) {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) => `%${character.codePointAt(0).toString(16).toUpperCase()}`);
}

export function parseResourceUri(input) {
  if (typeof input !== "string" || input.length < 4 || input.length > MAX_URI_CHARS) fail("resource_uri_invalid");
  if (/[\u0000-\u001f\u007f\\]/u.test(input)) fail("resource_uri_forbidden_character");
  if (/%(?:2f|5c)/iu.test(input)) fail("resource_uri_encoded_separator");
  const match = URI.exec(input);
  if (!match) fail("resource_uri_invalid");
  const scheme = match[1].toLowerCase();
  if (!SCHEME.test(scheme)) fail("resource_scheme_invalid");
  const authority = strictDecode(match[2]).normalize("NFC").toLowerCase();
  if (!AUTHORITY.test(authority) || match[2].includes("@") || match[2].includes(":")) fail("resource_authority_invalid");
  const rawPath = match[3] ?? "";
  if (rawPath.includes("//")) fail("resource_path_empty_segment");
  const rawSegments = rawPath === "" || rawPath === "/" ? [] : rawPath.slice(1).split("/");
  if (rawSegments.at(-1) === "") fail("resource_path_empty_segment");
  const segments = rawSegments.map((raw) => {
    const decoded = strictDecode(raw).normalize("NFC");
    if (!decoded || decoded === "." || decoded === "..") fail("resource_path_traversal");
    if (/[\u0000-\u001f\u007f/\\]/u.test(decoded)) fail("resource_path_forbidden_character");
    return decoded;
  });
  const canonical = `${scheme}://${authority}${segments.length ? `/${segments.map(encodeSegment).join("/")}` : ""}`;
  return deepFreeze({ version: RESOURCE_FS_VERSION, scheme, authority, segments, canonical });
}

function validateDefinition(definition) {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) fail("resource_definition_invalid");
  const scheme = String(definition.scheme ?? "").toLowerCase();
  if (!SCHEME.test(scheme)) fail("resource_definition_scheme_invalid");
  if (!Array.isArray(definition.capabilities) || definition.capabilities.length === 0) fail("resource_definition_capabilities_invalid");
  const capabilities = [...new Set(definition.capabilities)];
  if (capabilities.some((value) => !RESOURCE_CAPABILITIES.includes(value))) fail("resource_definition_capabilities_invalid");
  if (typeof definition.trust !== "string" || !Object.values(RESOURCE_TRUST).includes(definition.trust)) fail("resource_definition_trust_invalid");
  if (typeof definition.resolve !== "function") fail("resource_definition_resolver_required");
  if (capabilities.some((value) => RISKY_CAPABILITIES.has(value)) && typeof definition.authorize !== "function") fail("resource_definition_authorizer_required");
  return deepFreeze({ ...definition, scheme, capabilities, immutable: definition.immutable !== false });
}

function boundedInteger(value, fallback, minimum, maximum, error) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) fail(error);
  return resolved;
}

function normalizeResult(definition, parsed, operation, raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof raw.content !== "string") fail("resource_result_invalid");
  const originalChars = raw.content.length;
  const content = raw.content.slice(0, MAX_CONTENT_CHARS);
  const truncated = raw.truncated === true || originalChars > content.length;
  return deepFreeze({
    version: RESOURCE_FS_VERSION,
    kind: "RESOURCE_RESULT",
    uri: parsed.canonical,
    uriDigest: createHash("sha256").update(parsed.canonical).digest("hex"),
    scheme: parsed.scheme,
    operation,
    capabilities: [...definition.capabilities],
    trust: definition.trust,
    immutable: definition.immutable,
    contentType: ["text/plain", "text/markdown", "application/json"].includes(raw.contentType) ? raw.contentType : "text/plain",
    content,
    contentChars: content.length,
    contentBytes: Buffer.byteLength(content),
    truncated,
    untrustedData: true,
    details: raw.details && typeof raw.details === "object" && !Array.isArray(raw.details) ? structuredClone(raw.details) : {},
  });
}

export function createResourceFs(initialDefinitions = []) {
  const handlers = new Map();
  const api = {
    register(definition) {
      const checked = validateDefinition(definition);
      if (handlers.has(checked.scheme)) fail("resource_scheme_duplicate");
      handlers.set(checked.scheme, checked);
      return api;
    },
    describe() {
      return deepFreeze([...handlers.values()].map((entry) => ({ scheme: entry.scheme, capabilities: [...entry.capabilities], trust: entry.trust, immutable: entry.immutable })));
    },
    async access(input = {}) {
      const operation = String(input.operation ?? "").toUpperCase();
      if (!OPERATIONS.has(operation)) fail("resource_operation_invalid");
      if (operation === "DESCRIBE") return deepFreeze({ version: RESOURCE_FS_VERSION, kind: "RESOURCE_CATALOG", schemes: api.describe() });
      const parsed = parseResourceUri(input.uri);
      const definition = handlers.get(parsed.scheme);
      if (!definition) fail("resource_scheme_unknown");
      if (!definition.capabilities.includes(operation)) fail("resource_capability_denied");
      if (RISKY_CAPABILITIES.has(operation)) {
        const authorized = await definition.authorize({ ...input, operation, parsed });
        if (authorized?.allowed !== true) fail("resource_authorization_denied");
      }
      const raw = await definition.resolve({ ...input, operation, parsed });
      return normalizeResult(definition, parsed, operation, raw);
    },
  };
  for (const definition of initialDefinitions) api.register(definition);
  return Object.freeze(api);
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function protectedRepoRelative(relative) {
  if (!relative) return false;
  const segments = relative.split(path.sep);
  return segments.some((segment) => SKIP_DIRECTORIES.has(segment)) || isSecretPath(relative);
}

function openVerifiedRepoEntry(cwd, relative) {
  if (protectedRepoRelative(relative)) fail("resource_repo_path_protected");
  const inspected = inspectWorkspacePath(cwd, relative || ".", { mustExist: true });
  if (!inspected.allowed || !inspected.stat) fail("resource_repo_path_denied");
  let descriptor;
  try {
    descriptor = fs.openSync(inspected.workspace, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_DIRECTORY ?? 0));
    const segments = path.relative(inspected.workspace, inspected.lexical).split(path.sep).filter(Boolean);
    for (const [index, segment] of segments.entries()) {
      const final = index === segments.length - 1;
      const next = fs.openSync(
        `/proc/self/fd/${descriptor}/${segment}`,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (final ? 0 : (fs.constants.O_DIRECTORY ?? 0)),
      );
      fs.closeSync(descriptor);
      descriptor = next;
    }
    const opened = fs.fstatSync(descriptor);
    const pathname = fs.lstatSync(inspected.lexical);
    if (!sameIdentity(opened, inspected.stat) || !sameIdentity(opened, pathname) || pathname.isSymbolicLink()) fail("resource_repo_identity_changed");
    if (!opened.isFile() && !opened.isDirectory()) fail("resource_repo_type_denied");
    if (opened.isFile() && opened.nlink !== 1) fail("resource_repo_hardlink_denied");
    return { descriptor, stat: opened, inspected };
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (error instanceof ResourceFsError) throw error;
    fail("resource_repo_open_failed");
  }
}

function closeEntry(entry) {
  try { fs.closeSync(entry.descriptor); } catch {}
}

function textFromDescriptor(entry, maxBytes) {
  if (!entry.stat.isFile()) fail("resource_repo_file_required");
  if (entry.stat.size > maxBytes) fail("resource_repo_file_too_large");
  const bytes = fs.readFileSync(entry.descriptor);
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { fail("resource_repo_binary_denied"); }
  const pathname = fs.lstatSync(entry.inspected.lexical);
  if (!sameIdentity(pathname, entry.stat) || pathname.isSymbolicLink()) fail("resource_repo_identity_changed");
  return text;
}

function repoRelative(parsed) {
  if (parsed.authority !== "root") fail("resource_repo_authority_invalid");
  const relative = parsed.segments.join(path.sep);
  if (path.isAbsolute(relative) || relative.split(path.sep).includes("..")) fail("resource_repo_path_denied");
  return relative;
}

export function repoResourceUri(relative) {
  if (typeof relative !== "string" || path.isAbsolute(relative) || /[\u0000-\u001f\u007f\\]/u.test(relative)) fail("resource_repo_path_denied");
  if (relative.includes("//")) fail("resource_repo_path_denied");
  const raw = relative.split(path.sep).filter(Boolean);
  if (raw.some((segment) => segment === "." || segment === "..")) fail("resource_repo_path_denied");
  const segments = raw.map(encodeSegment);
  return `repo://root${segments.length ? `/${segments.join("/")}` : ""}`;
}

export function readVerifiedRepoText(cwd, relative, options = {}) {
  const maxBytes = boundedInteger(options.maxBytes, MAX_REPO_FILE_BYTES, 1, MAX_INTERNAL_REPO_FILE_BYTES, "resource_repo_max_bytes_invalid");
  const entry = openVerifiedRepoEntry(cwd, relative);
  try {
    const text = textFromDescriptor(entry, maxBytes);
    return deepFreeze({ text, bytes: entry.stat.size, modifiedMs: Math.trunc(entry.stat.mtimeMs), relative, uri: repoResourceUri(relative) });
  } finally {
    closeEntry(entry);
  }
}

function readRepo(input) {
  const relative = repoRelative(input.parsed);
  const entry = openVerifiedRepoEntry(input.cwd, relative);
  try {
    if (entry.stat.isDirectory()) {
      const names = fs.readdirSync(`/proc/self/fd/${entry.descriptor}`, { withFileTypes: true })
        .filter((item) => !item.isSymbolicLink() && !SKIP_DIRECTORIES.has(item.name) && !isSecretPath(item.name))
        .sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name))
        .slice(0, 500)
        .map((item) => `${item.name}${item.isDirectory() ? "/" : ""}`);
      return { content: names.join("\n") || "(empty directory)", contentType: "text/plain", details: { type: "directory", entries: names.length } };
    }
    const text = textFromDescriptor(entry, MAX_REPO_FILE_BYTES);
    const lines = text.split(/\r?\n/u);
    const offset = boundedInteger(input.offsetLine, 1, 1, Math.max(1, lines.length), "resource_range_offset_invalid");
    const limit = boundedInteger(input.limitLines, DEFAULT_LINE_LIMIT, 1, MAX_LINE_LIMIT, "resource_range_limit_invalid");
    const selected = lines.slice(offset - 1, offset - 1 + limit);
    const end = Math.min(lines.length, offset - 1 + selected.length);
    const omittedBefore = offset - 1;
    const omittedAfter = Math.max(0, lines.length - end);
    const content = [
      ...(omittedBefore ? [`[${omittedBefore} lines omitted before]`] : []),
      ...selected,
      ...(omittedAfter ? [`[${omittedAfter} lines omitted after]`] : []),
    ].join("\n");
    return { content, contentType: "text/plain", truncated: omittedBefore > 0 || omittedAfter > 0, details: { type: "file", totalLines: lines.length, range: { start: offset, end }, source: repoResourceUri(relative) } };
  } finally {
    closeEntry(entry);
  }
}

function searchRepo(input) {
  const query = String(input.query ?? "");
  if (!query || query.length > 1000 || /[\u0000-\u001f\u007f]/u.test(query)) fail("resource_search_query_invalid");
  const maxResults = boundedInteger(input.maxResults, 50, 1, MAX_SEARCH_RESULTS, "resource_search_limit_invalid");
  const base = repoRelative(input.parsed);
  const root = fs.realpathSync(input.cwd);
  const initial = openVerifiedRepoEntry(root, base);
  const stack = [];
  const files = [];
  try {
    if (initial.stat.isFile()) files.push(base);
    else stack.push({ relative: base, depth: 0 });
  } finally { closeEntry(initial); }

  while (stack.length && files.length < MAX_SEARCH_FILES) {
    const current = stack.pop();
    if (current.depth > 16) continue;
    const directory = openVerifiedRepoEntry(root, current.relative);
    try {
      if (!directory.stat.isDirectory()) continue;
      const entries = fs.readdirSync(`/proc/self/fd/${directory.descriptor}`, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
      for (const item of entries) {
        const relative = path.join(current.relative, item.name);
        if (item.isSymbolicLink() || protectedRepoRelative(relative)) continue;
        if (item.isDirectory()) stack.push({ relative, depth: current.depth + 1 });
        else if (item.isFile()) files.push(relative);
        if (files.length >= MAX_SEARCH_FILES) break;
      }
    } finally { closeEntry(directory); }
  }

  let scannedBytes = 0;
  let scannedFiles = 0;
  let skippedFiles = 0;
  const matches = [];
  const needle = query.toLocaleLowerCase("en-US");
  for (const relative of files.sort((left, right) => left.localeCompare(right))) {
    if (matches.length >= maxResults || scannedBytes >= MAX_SEARCH_BYTES) break;
    let entry;
    try {
      entry = openVerifiedRepoEntry(root, relative);
      if (entry.stat.size > MAX_SEARCH_FILE_BYTES || scannedBytes + entry.stat.size > MAX_SEARCH_BYTES) { skippedFiles += 1; continue; }
      const text = textFromDescriptor(entry, MAX_SEARCH_FILE_BYTES);
      scannedBytes += entry.stat.size;
      scannedFiles += 1;
      for (const [index, line] of text.split(/\r?\n/u).entries()) {
        if (!line.toLocaleLowerCase("en-US").includes(needle)) continue;
        matches.push({ uri: repoResourceUri(relative), line: index + 1, preview: line.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 300) });
        if (matches.length >= maxResults) break;
      }
    } catch (error) {
      if (!(error instanceof ResourceFsError) || !["resource_repo_binary_denied", "resource_repo_file_too_large", "resource_repo_hardlink_denied"].includes(error.code)) throw error;
      skippedFiles += 1;
    } finally {
      if (entry) closeEntry(entry);
    }
  }
  return { content: JSON.stringify({ matches, truncated: matches.length >= maxResults || files.length >= MAX_SEARCH_FILES || scannedBytes >= MAX_SEARCH_BYTES }), contentType: "application/json", truncated: matches.length >= maxResults, details: { matches: matches.length, scannedFiles, scannedBytes, skippedFiles, maxResults } };
}

export function createRepoResourceDefinition() {
  return {
    scheme: "repo",
    capabilities: ["READ", "SEARCH"],
    trust: RESOURCE_TRUST.WORKSPACE,
    immutable: true,
    resolve(input) {
      if (typeof input.cwd !== "string" || !input.cwd) fail("resource_caller_workspace_required");
      return input.operation === "READ" ? readRepo(input) : searchRepo(input);
    },
  };
}

export function createMemoryResourceDefinition(resolveMemory) {
  if (typeof resolveMemory !== "function") fail("resource_memory_resolver_required");
  return {
    scheme: "memory",
    capabilities: ["READ", "SEARCH"],
    trust: RESOURCE_TRUST.MEMORY,
    immutable: true,
    async resolve(input) {
      if (input.parsed.authority !== "root" || input.parsed.segments.length === 0) fail("resource_memory_query_required");
      const query = input.parsed.segments.join(" ");
      const result = await resolveMemory(query, { cwd: input.cwd, signal: input.signal, operation: input.operation });
      if (!result || typeof result.text !== "string") fail("resource_memory_result_invalid");
      return { content: result.text || "No accepted memory result.", contentType: "text/markdown", truncated: result.truncated === true, details: { status: typeof result.status === "string" ? result.status : "UNKNOWN", itemCount: Number.isSafeInteger(result.itemCount) ? result.itemCount : 0 } };
    },
  };
}

export function resourceAccessMetadata(result) {
  if (!result || result.kind !== "RESOURCE_RESULT") fail("resource_metadata_invalid");
  return deepFreeze({ kind: "resource_access", version: result.version, scheme: result.scheme, operation: result.operation, trust: result.trust, immutable: result.immutable, contentChars: result.contentChars, contentBytes: result.contentBytes, truncated: result.truncated, uriDigest: result.uriDigest });
}
