import fs from "node:fs";
import path from "node:path";

const SECRET_BASENAMES = new Set([
  ".env", "auth.json", "credentials", "credentials.json", "id_dsa",
  "id_ed25519", "id_ecdsa", "id_rsa", "known_hosts", "netrc",
]);
const SECRET_SEGMENTS = new Set([".aws", ".gnupg", ".password-store", ".ssh", "browser-data", "keyrings"]);
const ALWAYS_PROTECTED_WRITE_SEGMENTS = new Set([".git", "node_modules"]);

function hasNul(value) {
  return typeof value === "string" && value.includes("\0");
}

export function resolveToolPath(cwd, candidate) {
  if (typeof candidate !== "string" || candidate.trim() === "" || hasNul(candidate)) return undefined;
  return path.resolve(cwd, candidate);
}

export function isSecretPath(candidate) {
  if (typeof candidate !== "string" || candidate.trim() === "" || hasNul(candidate)) return false;
  const normalized = path.normalize(candidate);
  const parts = normalized.split(path.sep).filter(Boolean);
  const base = path.basename(normalized).toLowerCase();
  if (SECRET_BASENAMES.has(base) || base.startsWith(".env.") || /\.(pem|p12|pfx|key)$/iu.test(base)) return true;
  return parts.some((part) => SECRET_SEGMENTS.has(part.toLowerCase()));
}

export function isAlwaysProtectedWritePath(candidate) {
  if (isSecretPath(candidate)) return true;
  const parts = path.normalize(candidate).split(path.sep).filter(Boolean);
  return parts.some((part) => ALWAYS_PROTECTED_WRITE_SEGMENTS.has(part));
}

export function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

/** Validate FFF-style path/glob constraints without allowing its auxiliary
 * index feature to escape the active workspace. Literal path components that
 * exist are still inspected so a symlink cannot disguise an external root. */
export function inspectWorkspaceConstraint(cwd, candidate) {
  if (typeof candidate !== "string" || candidate.trim() === "") return { allowed: true };
  if (hasNul(candidate)) return failure("NUL bytes are not allowed in path constraints");
  const trimmed = candidate.trim();
  if (path.isAbsolute(trimmed) || trimmed === "~" || trimmed.startsWith(`~${path.sep}`)) {
    return failure("absolute and home-relative path constraints are disabled");
  }
  const segments = trimmed.split(path.sep).filter(Boolean);
  if (segments.includes("..")) return failure("parent traversal is disabled in path constraints");
  if (isSecretPath(trimmed)) return failure("secret path constraint is denied");

  const literal = [];
  for (const segment of segments) {
    if (/[*?[{]/u.test(segment)) break;
    literal.push(segment);
  }
  if (literal.length === 0) return { allowed: true };
  const inspected = inspectWorkspacePath(cwd, literal.join(path.sep), { mustExist: false });
  if (!inspected.allowed) return inspected;
  return { allowed: true };
}

function failure(reason, extra = {}) {
  return { allowed: false, reason, ...extra };
}

/**
 * Validate a path against a canonical workspace without following symlink
 * components. A missing target is accepted only after its closest existing
 * parent has been canonicalized. Existing multiply-linked files are not
 * writable because a hard link could otherwise mutate an out-of-tree inode.
 */
export function inspectWorkspacePath(cwd, candidate, options = {}) {
  const { mustExist = true, forWrite = false } = options;
  if (typeof candidate !== "string" || candidate.trim() === "") return failure("path is required");
  if (hasNul(candidate)) return failure("NUL bytes are not allowed in paths");

  let workspace;
  try {
    workspace = fs.realpathSync(cwd);
  } catch (error) {
    return failure(`workspace cannot be canonicalized: ${error.code ?? error.message}`);
  }

  const lexical = path.resolve(workspace, candidate);
  if (!isInside(workspace, lexical)) return failure("path is outside the active workspace", { workspace, lexical });

  const relative = path.relative(workspace, lexical);
  const segments = relative === "" ? [] : relative.split(path.sep);
  let cursor = workspace;
  let stat;
  if (segments.length === 0) {
    try {
      stat = fs.lstatSync(workspace);
    } catch (error) {
      return failure(`workspace cannot be inspected: ${error.code ?? error.message}`, { workspace, lexical });
    }
  }
  for (let index = 0; index < segments.length; index += 1) {
    cursor = path.join(cursor, segments[index]);
    try {
      stat = fs.lstatSync(cursor);
    } catch (error) {
      if (error?.code !== "ENOENT") return failure(`path component cannot be inspected: ${error.code ?? error.message}`, { workspace, lexical });
      if (mustExist) return failure("path does not exist", { workspace, lexical });
      let canonicalParent;
      try {
        canonicalParent = fs.realpathSync(path.dirname(cursor));
      } catch (parentError) {
        return failure(`new path parent cannot be canonicalized: ${parentError.code ?? parentError.message}`, { workspace, lexical });
      }
      if (!isInside(workspace, canonicalParent)) return failure("new path parent escapes the workspace", { workspace, lexical, canonicalParent });
      return { allowed: true, workspace, lexical, canonical: path.join(canonicalParent, ...segments.slice(index)), exists: false };
    }
    if (stat.isSymbolicLink()) return failure("symlink path components are not allowed", { workspace, lexical, component: cursor });
    const canonical = fs.realpathSync(cursor);
    if (!isInside(workspace, canonical)) return failure("canonical path escapes the workspace", { workspace, lexical, canonical });
    if (index < segments.length - 1 && !stat.isDirectory()) return failure("non-directory path component", { workspace, lexical, component: cursor });
  }

  const canonical = fs.realpathSync(lexical);
  if (!isInside(workspace, canonical)) return failure("canonical path escapes the workspace", { workspace, lexical, canonical });
  if (forWrite && stat?.isFile() && stat.nlink > 1) {
    return failure("writing multiply-linked files is denied to prevent hard-link escapes", { workspace, lexical, canonical });
  }
  return { allowed: true, workspace, lexical, canonical, exists: true, stat };
}

function sameFileIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

/**
 * Remove a workspace file while holding an O_NOFOLLOW descriptor to the
 * validated inode. The post-unlink link count proves that the held inode—not
 * a pathname replacement—lost its only directory entry. Node does not expose
 * unlinkat(2) by descriptor, so a same-user racer can still make the operation
 * fail, but cannot make a raced deletion look successful.
 */
export function removeVerifiedWorkspaceFile(cwd, candidate, options = {}) {
  if (isAlwaysProtectedWritePath(candidate)) throw new Error("Protected paths cannot be removed.");
  const inspected = inspectWorkspacePath(cwd, candidate, { mustExist: true, forWrite: true });
  if (!inspected.allowed || !inspected.stat?.isFile() || inspected.stat.nlink !== 1) {
    throw new Error(`File removal denied: ${inspected.allowed ? "only single-linked regular files may be removed" : inspected.reason}`);
  }
  if (isAlwaysProtectedWritePath(inspected.canonical)) throw new Error("Protected canonical paths cannot be removed.");

  let descriptor;
  try {
    descriptor = fs.openSync(inspected.lexical, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || !sameFileIdentity(opened, inspected.stat)) throw new Error("File changed while opening for removal.");
    const pathname = fs.lstatSync(inspected.lexical);
    if (!pathname.isFile() || pathname.isSymbolicLink() || pathname.nlink !== 1 || !sameFileIdentity(pathname, opened)) throw new Error("File changed during removal validation.");
    if (typeof options.beforeUnlink === "function") options.beforeUnlink({ ...inspected, descriptor, stat: opened });
    fs.unlinkSync(inspected.lexical);
    const after = fs.fstatSync(descriptor);
    if (!sameFileIdentity(after, opened) || after.nlink !== 0) throw new Error("File identity changed during removal; deletion was not admitted.");
    try {
      fs.lstatSync(inspected.lexical);
      throw new Error("File path reappeared during removal; deletion was not admitted.");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return { workspace: inspected.workspace, canonical: inspected.canonical, device: opened.dev, inode: opened.ino };
  } catch (error) {
    if (error?.code === "ELOOP") throw new Error("File changed to a symlink during removal.");
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

/** Unsandboxed free-form shell is intentionally unavailable to autonomous roles. */
export function classifyCommand(command) {
  if (typeof command !== "string" || command.trim() === "") return undefined;
  return { level: "block", reason: "unsandboxed shell execution is disabled; use safe_exec" };
}

export function validateSubagentCall(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return failure("subagent input must be an object");
  const persistentMutations = new Set(["create", "update", "delete", "eject", "reset", "disable", "enable", "refine", "refine.rollback", "schedule.create", "schedule.update", "schedule.delete"]);
  if (typeof input.action === "string" && persistentMutations.has(input.action)) return failure("model-driven persistent subagent configuration changes are disabled");
  const forbidden = new Set(["workflowScript", "workflowScriptPath", "globalConcurrencyLimit", "concurrency", "maxTasks", "maxSubagentDepth", "maxDepth", "allowNestedSubagents", "model", "provider", "thinking"]);
  const visit = (value, location = "input") => {
    if (!value || typeof value !== "object") return undefined;
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const nested = visit(value[index], `${location}[${index}]`);
        if (nested) return nested;
      }
      return undefined;
    }
    for (const [key, nestedValue] of Object.entries(value)) {
      if (forbidden.has(key)) return `caller-controlled '${location}.${key}' is disabled`;
      const nested = visit(nestedValue, `${location}.${key}`);
      if (nested) return nested;
    }
    return undefined;
  };
  const forbiddenField = visit(input);
  if (forbiddenField) return failure(forbiddenField);
  if (Array.isArray(input.tasks) && input.tasks.length > 3) return failure("subagent task fanout exceeds the hard concurrency limit of 3");
  if (input.worktree === false) return failure("autonomous subagents may not disable worktree isolation");
  if ((input.agent === "worker" || input.agent === "tester") && input.worktree !== true) return failure(`${input.agent} requires an isolated worktree`);
  return { allowed: true };
}

export function validateAllocatedBrowserCall(input, allocation) {
  if (!allocation) return { allowed: true };
  if (!input || typeof input !== "object" || Array.isArray(input)) return failure("browser input must be an object");
  const args = Array.isArray(input.args) && input.args.every((item) => typeof item === "string") ? input.args : [];
  const profileIndex = args.indexOf("--profile");
  const sessionIndex = args.indexOf("--session");
  const launchNameIndex = args.indexOf("--session-name");
  const correctProfile = profileIndex >= 0 && args[profileIndex + 1] === allocation.browserProfile;
  const correctSession = (sessionIndex >= 0 && args[sessionIndex + 1] === allocation.browserSession)
    || (launchNameIndex >= 0 && args[launchNameIndex + 1] === allocation.browserSession);
  if (!correctProfile && !correctSession) return failure("allocated browser calls require the assigned profile or session name");
  if (correctProfile && input.sessionMode !== "fresh") return failure("an allocated profile launch requires sessionMode=fresh");
  if (args.includes("open") && (!correctProfile || !correctSession || input.sessionMode !== "fresh")) {
    return failure("an allocated browser launch requires the assigned profile, assigned session, and sessionMode=fresh");
  }
  return { allowed: true };
}

/** ast-grep is subprocess-backed. Keep its traversal semantics no broader
 * than the canonical target path approved by the tool hook. In particular,
 * `follow` could otherwise traverse a symlink nested below an approved
 * directory, and auxiliary config/rule files could be opened independently
 * of the primary target. */
export function validateAstGrepCall(cwd, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return failure("ast-grep input must be an object");
  if (input.follow === true) return failure("ast-grep symlink traversal is disabled");
  for (const key of ["rule_file", "config"]) {
    const candidate = input[key];
    if (candidate === undefined) continue;
    if (typeof candidate !== "string" || candidate.trim() === "") return failure(`ast-grep ${key} must be a non-empty path`);
    if (isSecretPath(candidate)) return failure(`ast-grep ${key} cannot reference a protected secret path`);
    const inspected = inspectWorkspacePath(cwd, candidate, { mustExist: true });
    if (!inspected.allowed || !("stat" in inspected) || !inspected.stat?.isFile()) {
      return failure(`ast-grep ${key} is outside the canonical workspace or is not a regular file`);
    }
    if (isSecretPath(inspected.canonical)) return failure(`ast-grep ${key} resolves to a protected secret path`);
  }
  return { allowed: true };
}
