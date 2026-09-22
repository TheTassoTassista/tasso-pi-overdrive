import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ResourceFsError, RESOURCE_TRUST } from "./resource-fs.mjs";
import { isSecretPath } from "./safety.mjs";

export const GIT_RESOURCE_VERSION = 1;
const policyFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../config/git-resources.json");
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const FORBIDDEN_PATH_SEGMENTS = new Set([".git", "node_modules"]);

function fail(code) { throw new ResourceFsError(code); }
function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

export function validateGitResourcePolicy(value) {
  if (!value || value.version !== GIT_RESOURCE_VERSION || value.enabled !== true || value.platform !== "linux-x64") fail("resource_git_policy_invalid");
  if (Object.keys(value).some((key) => !["version", "enabled", "platform", "binaryPath", "binaryVersion", "binarySha256", "timeoutMs", "maxOutputBytes", "maxLogEntries", "maxConflictFiles"].includes(key))) fail("resource_git_policy_field");
  if (!path.isAbsolute(value.binaryPath) || typeof value.binaryVersion !== "string" || !/^git version \d+\.\d+\.\d+$/u.test(value.binaryVersion) || !/^[0-9a-f]{64}$/u.test(value.binarySha256)) fail("resource_git_binary_invalid");
  for (const [key, minimum, maximum] of [["timeoutMs", 1000, 30000], ["maxOutputBytes", 4096, 1024 * 1024], ["maxLogEntries", 1, 200], ["maxConflictFiles", 1, 200]]) if (!Number.isSafeInteger(value[key]) || value[key] < minimum || value[key] > maximum) fail("resource_git_limit_invalid");
  return freeze(structuredClone(value));
}

export function readGitResourcePolicy(file = policyFile) {
  return validateGitResourcePolicy(JSON.parse(fs.readFileSync(file, "utf8")));
}

export function hardenedGitArguments(args) {
  if (!Array.isArray(args) || args.length === 0 || args.some((value) => typeof value !== "string" || value.includes("\u0000"))) fail("resource_git_arguments_invalid");
  return [
    "--no-pager", "--no-optional-locks",
    "-c", "color.ui=false",
    "-c", "core.fsmonitor=false",
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.pager=cat",
    "-c", "core.quotePath=true",
    "-c", "core.untrackedCache=false",
    "-c", "diff.external=",
    "-c", "interactive.diffFilter=",
    "-c", "log.showSignature=false",
    "-c", "protocol.ext.allow=never",
    "-c", "protocol.file.allow=never",
    ...args,
  ];
}

export function hardenedGitEnvironment() {
  return Object.freeze({
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NO_COLOR: "1",
  });
}

function binaryIdentity(policy) {
  let canonical;
  let stat;
  try {
    canonical = fs.realpathSync(policy.binaryPath);
    stat = fs.lstatSync(policy.binaryPath);
  } catch { fail("resource_git_binary_unavailable"); }
  if (canonical !== policy.binaryPath || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o111) === 0 || (stat.mode & 0o022) !== 0) fail("resource_git_binary_unsafe");
  return freeze({ path: canonical, dev: stat.dev, ino: stat.ino, size: stat.size, mode: stat.mode, uid: stat.uid, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
}

function sameBinary(left, right) {
  return left?.path === right.path && left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mode === right.mode && left.uid === right.uid && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function decodeOutput(chunks) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { return "\uFFFD"; }
}

function spawnBounded(policy, cwd, args, signal) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(policy.binaryPath, hardenedGitArguments(args), { cwd, env: hardenedGitEnvironment(), shell: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch { resolve({ stdout: "", stderr: "", code: 1, killed: false, outputExceeded: false }); return; }
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let killed = false;
    let outputExceeded = false;
    let settled = false;
    let forceTimer;
    const terminate = () => {
      if (killed) return;
      killed = true;
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 250);
      forceTimer.unref?.();
    };
    const collect = (target) => (chunk) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += value.length;
      if (outputBytes > policy.maxOutputBytes) {
        outputExceeded = true;
        terminate();
        return;
      }
      target.push(value);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    const timeout = setTimeout(terminate, policy.timeoutMs);
    timeout.unref?.();
    const abort = () => terminate();
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      signal?.removeEventListener("abort", abort);
      resolve({ stdout: decodeOutput(stdout), stderr: decodeOutput(stderr), code: code ?? 1, killed, outputExceeded });
    };
    child.once("error", () => finish(1));
    child.once("close", finish);
  });
}

export function createPinnedGitRunner(inputPolicy = readGitResourcePolicy()) {
  const policy = validateGitResourcePolicy(inputPolicy);
  let attested;
  const ensureAttested = async (cwd, signal) => {
    const current = binaryIdentity(policy);
    if (sameBinary(attested, current)) return;
    const digest = createHash("sha256").update(fs.readFileSync(current.path)).digest("hex");
    if (digest !== policy.binarySha256) fail("resource_git_binary_digest_mismatch");
    const version = await spawnBounded(policy, cwd, ["--version"], signal);
    if (version.code !== 0 || version.killed || version.outputExceeded || version.stdout.trim() !== policy.binaryVersion) fail("resource_git_binary_version_mismatch");
    attested = current;
  };
  return async ({ cwd, args, signal }) => {
    await ensureAttested(cwd, signal);
    const before = binaryIdentity(policy);
    if (!sameBinary(attested, before)) fail("resource_git_binary_changed");
    const result = await spawnBounded(policy, cwd, args, signal);
    const after = binaryIdentity(policy);
    if (!sameBinary(before, after)) fail("resource_git_binary_changed");
    if (result.outputExceeded) fail("resource_git_output_limit_exceeded");
    return result;
  };
}

function cleanText(text, maxBytes, { preserveNul = false } = {}) {
  if (typeof text !== "string" || text.includes("\uFFFD")) fail("resource_git_output_invalid");
  const controls = preserveNul ? /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu : /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;
  const normalized = text.replace(/\r/gu, "").replace(controls, " ");
  const bytes = Buffer.from(normalized, "utf8");
  if (bytes.length <= maxBytes) return { text: normalized, truncated: false };
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return { text: `${bytes.subarray(0, end).toString("utf8")}\n[git resource truncated]`, truncated: true };
}

function resourcePath(segments) {
  if (!Array.isArray(segments) || segments.length === 0) fail("resource_git_path_required");
  if (segments.some((segment) => segment.startsWith("-") || /[\u0000-\u001f\u007f]/u.test(segment) || FORBIDDEN_PATH_SEGMENTS.has(segment) || isSecretPath(segment))) fail("resource_git_path_protected");
  const relative = segments.join("/");
  if (relative.length > 2048 || isSecretPath(relative)) fail("resource_git_path_protected");
  return relative;
}

async function verifiedRepository(input, runGit, policy) {
  if (typeof input.cwd !== "string" || !input.cwd) fail("resource_caller_workspace_required");
  const requested = path.resolve(input.cwd);
  const root = fs.realpathSync(requested);
  if (requested !== root) fail("resource_git_workspace_symlink");
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("resource_git_workspace_invalid");
  const result = await runGit({ cwd: root, args: ["rev-parse", "--show-toplevel"], signal: input.signal, policy });
  if (!result || result.code !== 0 || result.killed === true) fail("resource_git_repository_required");
  let reported;
  try { reported = fs.realpathSync(String(result.stdout).trim()); } catch { fail("resource_git_repository_required"); }
  if (reported !== root) fail("resource_git_workspace_mismatch");
  const after = fs.lstatSync(root);
  if (after.dev !== stat.dev || after.ino !== stat.ino || !after.isDirectory() || after.isSymbolicLink()) fail("resource_git_workspace_changed");
  return { root, identity: { dev: after.dev, ino: after.ino } };
}

async function execute(input, runGit, policy, args, code, options) {
  const repository = await verifiedRepository(input, runGit, policy);
  const result = await runGit({ cwd: repository.root, args, signal: input.signal, policy });
  if (!result || result.code !== 0 || result.killed === true) fail(code);
  const after = fs.lstatSync(repository.root);
  if (after.dev !== repository.identity.dev || after.ino !== repository.identity.ino || !after.isDirectory() || after.isSymbolicLink()) fail("resource_git_workspace_changed");
  return cleanText(result.stdout, policy.maxOutputBytes, options);
}

function gitDetails(view, extra = {}) { return { resourceVersion: GIT_RESOURCE_VERSION, view, ...extra }; }

async function resolveGit(input, runGit, policy) {
  if (input.parsed.authority !== "repo" || input.operation !== "READ") fail("resource_git_uri_invalid");
  const [view, scope, ...tail] = input.parsed.segments;
  if (view === "status" && !scope) {
    const output = await execute(input, runGit, policy, ["status", "--short", "--branch", "--untracked-files=normal"], "resource_git_status_failed");
    return { content: output.text || "## clean", contentType: "text/plain", truncated: output.truncated, details: gitDetails("status") };
  }
  if (view === "log" && !scope) {
    if (input.limitLines !== undefined && (!Number.isSafeInteger(input.limitLines) || input.limitLines < 1)) fail("resource_git_limit_invalid");
    const limit = input.limitLines === undefined ? Math.min(30, policy.maxLogEntries) : Math.min(input.limitLines, policy.maxLogEntries);
    const output = await execute(input, runGit, policy, ["log", `--max-count=${limit}`, "--date=iso-strict", "--format=%H%x09%aI%x09%an%x09%s"], "resource_git_log_failed");
    return { content: output.text || "(no commits)", contentType: "text/plain", truncated: output.truncated, details: gitDetails("log", { entriesLimit: limit }) };
  }
  if (view === "branches" && !scope) {
    const output = await execute(input, runGit, policy, ["for-each-ref", "--count=100", "--format=%(refname:short)%09%(objectname)%09%(upstream:short)", "refs/heads", "refs/remotes"], "resource_git_branches_failed");
    return { content: output.text || "(no branches)", contentType: "text/plain", truncated: output.truncated, details: gitDetails("branches") };
  }
  if (view === "commit" && scope && OID.test(scope) && tail.length === 0) {
    const output = await execute(input, runGit, policy, ["show", "--no-patch", "--date=iso-strict", "--format=%H%n%P%n%aI%n%an%n%B", scope], "resource_git_commit_failed");
    return { content: output.text, contentType: "text/plain", truncated: output.truncated, details: gitDetails("commit", { oid: scope }) };
  }
  if (view === "diff" && ["worktree", "staged"].includes(scope)) {
    const relative = tail.length ? resourcePath(tail) : undefined;
    const args = ["diff", "--no-ext-diff", "--no-textconv", "--unified=3", ...(scope === "staged" ? ["--cached"] : []), ...(relative ? ["--", relative] : [])];
    const output = await execute(input, runGit, policy, args, "resource_git_diff_failed");
    return { content: output.text || "(no diff)", contentType: "text/plain", truncated: output.truncated, details: gitDetails("diff", { scope, pathScoped: Boolean(relative) }) };
  }
  fail("resource_git_uri_invalid");
}

function parseConflictList(text, maxFiles) {
  const files = new Map();
  for (const record of text.split("\0").filter(Boolean)) {
    const match = /^(\d{6}) ([0-9a-f]{40,64}) ([123])\t(.+)$/u.exec(record);
    if (!match) fail("resource_conflict_index_invalid");
    const relative = resourcePath(match[4].split("/"));
    const entry = files.get(relative) ?? { path: relative, stages: [] };
    entry.stages.push(Number(match[3]));
    files.set(relative, entry);
    if (files.size > maxFiles) fail("resource_conflict_limit_exceeded");
  }
  return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
}

async function resolveConflict(input, runGit, policy) {
  if (input.parsed.authority !== "repo" || input.operation !== "READ") fail("resource_conflict_uri_invalid");
  const [view, ...tail] = input.parsed.segments;
  if (view === "list" && tail.length === 0) {
    const output = await execute(input, runGit, policy, ["ls-files", "-u", "-z"], "resource_conflict_list_failed", { preserveNul: true });
    const files = parseConflictList(output.text, policy.maxConflictFiles);
    return { content: JSON.stringify({ files }), contentType: "application/json", truncated: output.truncated, details: { resourceVersion: GIT_RESOURCE_VERSION, view: "conflict-list", files: files.length } };
  }
  if (["base", "ours", "theirs"].includes(view) && tail.length > 0) {
    const relative = resourcePath(tail);
    const stage = { base: 1, ours: 2, theirs: 3 }[view];
    const output = await execute(input, runGit, policy, ["cat-file", "blob", `:${stage}:${relative}`], "resource_conflict_side_failed");
    return { content: output.text, contentType: "text/plain", truncated: output.truncated, details: { resourceVersion: GIT_RESOURCE_VERSION, view: "conflict-side", side: view, pathScoped: true } };
  }
  fail("resource_conflict_uri_invalid");
}

export function createGitResourceDefinition(runGit, policy = readGitResourcePolicy()) {
  if (typeof runGit !== "function") fail("resource_git_runner_required");
  const checked = validateGitResourcePolicy(policy);
  return { scheme: "git", capabilities: ["READ"], trust: RESOURCE_TRUST.WORKSPACE, immutable: true, resolve: (input) => resolveGit(input, runGit, checked) };
}

export function createConflictResourceDefinition(runGit, policy = readGitResourcePolicy()) {
  if (typeof runGit !== "function") fail("resource_git_runner_required");
  const checked = validateGitResourcePolicy(policy);
  return { scheme: "conflict", capabilities: ["READ"], trust: RESOURCE_TRUST.WORKSPACE, immutable: true, resolve: (input) => resolveConflict(input, runGit, checked) };
}
