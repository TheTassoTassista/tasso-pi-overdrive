import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createPinnedGitRunner, verifyGitRepositoryRoot } from "./git-resources.mjs";
import { inspectWorkspacePath, isAlwaysProtectedWritePath } from "./safety.mjs";
import { validateTaskPolicy } from "./task-governor.mjs";

const HEADER = "## Local Git prewalk — UNTRUSTED PATH HINTS";
const EXPLANATION = "Path names only; verify each candidate before reading or editing.";
const SAFE_PATH = /^[A-Za-z0-9._/-]{1,120}$/u;
const MAX_PATHS = 8;
const MAX_TEXT = 960;
const MAX_FILE_BYTES = 256 * 1024;
const IGNORED_WORDS = new Set(["add", "and", "change", "code", "file", "fix", "for", "from", "implement", "into", "module", "test", "the", "this", "with"]);

function words(value) {
  return [...new Set(String(value).toLowerCase().match(/[a-z][a-z0-9]{2,}/gu) ?? [])].filter((word) => !IGNORED_WORDS.has(word));
}

export function validateLocalPrewalkText(text) {
  if (text === "") return "";
  if (typeof text !== "string" || text.length > MAX_TEXT) throw new Error("local prewalk is invalid or unbounded");
  const lines = text.split("\n");
  if (lines[0] !== HEADER || lines[1] !== EXPLANATION || lines.length < 3 || lines.length > MAX_PATHS + 2 || lines.slice(2).some((line) => !line.startsWith("- ") || !SAFE_PATH.test(line.slice(2)) || line.slice(2).split("/").some((part) => part === ".." || part === ".") || isAlwaysProtectedWritePath(line.slice(2)))) throw new Error("local prewalk path boundary rejected");
  return text;
}

/** Task Governor is the only authority to enable this hint. */
export function localPrewalkEligibility(task, taskPolicy) {
  const policy = validateTaskPolicy(taskPolicy);
  if (policy.routingStrategy.roles.scout) return "SKIPPED_SCOUT";
  if (!policy.classification.signals.code || !policy.toolNeed.capabilities.includes("search") || policy.classification.signals.directSmallEdit) return "SKIPPED_POLICY";
  const explicitPaths = String(task).match(/(?:^|\s)(?:[\w.-]+\/)*[\w.-]+\.(?:c|cc|cpp|css|go|html|java|js|json|jsx|mjs|py|rs|sh|ts|tsx|yaml|yml)\b/gu) ?? [];
  if (explicitPaths.length === 1 && String(task).length <= 180 && !policy.classification.signals.localSearch && !policy.classification.signals.debugging) return "SKIPPED_EXACT_FILE";
  return "ELIGIBLE";
}

function safeRegularFile(workspace, relative) {
  const inspected = inspectWorkspacePath(workspace, relative, { mustExist: true });
  if (!inspected.allowed || isAlwaysProtectedWritePath(inspected.canonical)) return false;
  let descriptor;
  try {
    descriptor = fs.openSync(inspected.canonical, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES) return false;
    const sample = Buffer.alloc(Math.min(stat.size, 4096));
    const length = fs.readSync(descriptor, sample, 0, sample.length, 0);
    if (sample.subarray(0, length).includes(0)) return false;
    const after = fs.lstatSync(path.join(workspace, relative));
    return after.isFile() && !after.isSymbolicLink() && after.dev === stat.dev && after.ino === stat.ino;
  } catch { return false; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

/** A name-only, local, fail-soft hint; never launches a model. */
export async function buildLocalPrewalk(cwd, task, taskPolicy) {
  const unavailable = (reason) => Object.freeze({ status: reason, text: "", candidateCount: 0, scannedCount: 0, digest: null });
  if (typeof task !== "string" || !task.trim()) return unavailable("SKIPPED_NO_TASK");
  let eligibility;
  try { eligibility = localPrewalkEligibility(task, taskPolicy); }
  catch { return unavailable("SKIPPED_POLICY"); }
  if (eligibility !== "ELIGIBLE") return unavailable(eligibility);
  let workspace;
  let tracked;
  try {
    const runGit = createPinnedGitRunner();
    const repository = await verifyGitRepositoryRoot({ cwd }, runGit);
    workspace = repository.root;
    const listed = await runGit({ cwd: workspace, args: ["ls-files", "-z", "--cached"] });
    const after = fs.lstatSync(workspace);
    if (listed.code !== 0 || listed.killed || listed.outputExceeded || after.dev !== repository.identity.dev || after.ino !== repository.identity.ino || listed.stdout.includes("\uFFFD")) return unavailable("UNAVAILABLE_GIT_INDEX");
    tracked = listed.stdout.split("\0").filter(Boolean);
  }
  catch { return unavailable("UNAVAILABLE_WORKTREE"); }
  const query = words(task);
  const taskLower = task.toLowerCase();
  const candidates = [];
  for (const relative of tracked) {
    if (!SAFE_PATH.test(relative) || relative.startsWith("/") || relative.split("/").some((part) => part === ".." || part === ".") || isAlwaysProtectedWritePath(relative)) continue;
    const score = (taskLower.includes(relative.toLowerCase()) ? 20 : 0) + words(relative).reduce((total, word) => total + (query.includes(word) ? 3 : 0), 0);
    if (score <= 0) continue;
    if (!safeRegularFile(workspace, relative)) continue;
    candidates.push({ relative, score });
  }
  candidates.sort((left, right) => right.score - left.score || left.relative.localeCompare(right.relative));
  const selected = [];
  for (const candidate of candidates) {
    if (selected.length >= MAX_PATHS) break;
    const next = [HEADER, EXPLANATION, ...selected.map((entry) => `- ${entry}`), `- ${candidate.relative}`].join("\n");
    if (next.length > MAX_TEXT) break;
    selected.push(candidate.relative);
  }
  if (selected.length === 0) return Object.freeze({ status: "NO_SAFE_MATCH", text: "", candidateCount: candidates.length, scannedCount: tracked.length, digest: null });
  const text = validateLocalPrewalkText([HEADER, EXPLANATION, ...selected.map((entry) => `- ${entry}`)].join("\n"));
  return Object.freeze({ status: "HINTS", text, candidateCount: selected.length, scannedCount: tracked.length, digest: createHash("sha256").update(text).digest("hex") });
}
