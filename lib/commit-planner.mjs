import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readVerifiedRepoText } from "./resource-fs.mjs";
import { isSecretPath } from "./safety.mjs";
import { readGitResourcePolicy, verifyGitRepositoryRoot } from "./git-resources.mjs";

export const COMMIT_PLANNER_VERSION = 1;
const policyFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../config/commit-planner.json");
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const GROUP_ID = /^[a-z0-9](?:[a-z0-9._-]{0,63})$/u;
const FORBIDDEN_SEGMENTS = new Set([".git", "node_modules"]);

export class CommitPlannerError extends Error {
  constructor(code) { super(code); this.name = "CommitPlannerError"; this.code = code; }
}

function fail(code) { throw new CommitPlannerError(code); }
function hash(value) { return createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex"); }
function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

export function validateCommitPlannerPolicy(value) {
  const fields = ["version", "enabled", "maxChangedFiles", "maxSelectedFiles", "maxGroups", "maxChangesPerGroup", "maxHunksPerFile", "maxUntrackedBytes"];
  if (!value || value.version !== COMMIT_PLANNER_VERSION || value.enabled !== true || Object.keys(value).some((key) => !fields.includes(key))) fail("commit_plan_policy_invalid");
  for (const [key, minimum, maximum] of [["maxChangedFiles", 1, 500], ["maxSelectedFiles", 1, 100], ["maxGroups", 1, 50], ["maxChangesPerGroup", 1, 100], ["maxHunksPerFile", 1, 500], ["maxUntrackedBytes", 1024, 2 * 1024 * 1024]]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < minimum || value[key] > maximum) fail("commit_plan_policy_limit_invalid");
  }
  if (value.maxSelectedFiles > value.maxChangedFiles || value.maxChangesPerGroup > value.maxSelectedFiles) fail("commit_plan_policy_relationship_invalid");
  return freeze(structuredClone(value));
}

export function readCommitPlannerPolicy(file = policyFile) {
  return validateCommitPlannerPolicy(JSON.parse(fs.readFileSync(file, "utf8")));
}

function normalizeScope(value) {
  if (!new Set(["worktree", "staged"]).has(value)) fail("commit_plan_scope_invalid");
  return value;
}

function normalizePath(value) {
  if (typeof value !== "string" || !value || value.length > 2048 || value !== value.normalize("NFC") || path.posix.isAbsolute(value) || value.includes("\\") || /[\u0000-\u001f\u007f]/u.test(value)) fail("commit_plan_path_invalid");
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("-") || FORBIDDEN_SEGMENTS.has(segment) || isSecretPath(segment)) || isSecretPath(value)) fail("commit_plan_path_protected");
  return value;
}

function parseNulPaths(value, { omitProtected = false } = {}) {
  if (typeof value !== "string" || value.includes("\uFFFD")) fail("commit_plan_git_output_invalid");
  const paths = [];
  let omittedProtected = 0;
  for (const raw of value.split("\0").filter(Boolean)) {
    try { paths.push(normalizePath(raw)); }
    catch (error) {
      if (omitProtected && error instanceof CommitPlannerError && error.code === "commit_plan_path_protected") { omittedProtected += 1; continue; }
      throw error;
    }
  }
  return { paths, omittedProtected };
}

function hunkCounts(content) {
  let additions = 0;
  let deletions = 0;
  for (const line of content.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

export function parseCommitDiffHunks(diff, maximum = 200) {
  if (typeof diff !== "string" || diff.includes("\uFFFD")) fail("commit_plan_diff_invalid");
  const binary = /^(?:Binary files .* differ|GIT binary patch)$/mu.test(diff);
  if (binary) return freeze({ binary: true, hunks: [] });
  const lines = diff.replace(/\r/gu, "").split("\n");
  const hunks = [];
  let current;
  const push = () => {
    if (!current) return;
    const content = current.lines.join("\n");
    const counts = hunkCounts(content);
    hunks.push({ index: hunks.length + 1, oldStart: current.oldStart, oldLines: current.oldLines, newStart: current.newStart, newLines: current.newLines, additions: counts.additions, deletions: counts.deletions, digest: hash(content) });
    if (hunks.length > maximum) fail("commit_plan_hunk_limit_exceeded");
  };
  for (const line of lines) {
    const match = /^@@ -([0-9]+)(?:,([0-9]+))? \+([0-9]+)(?:,([0-9]+))? @@/u.exec(line);
    if (match) {
      push();
      current = { oldStart: Number(match[1]), oldLines: Number(match[2] ?? 1), newStart: Number(match[3]), newLines: Number(match[4] ?? 1), lines: [line] };
    } else if (current) current.lines.push(line);
  }
  push();
  return freeze({ binary: false, hunks });
}

async function runChecked(runGit, policy, cwd, args, signal, code) {
  const result = await runGit({ cwd, args, signal, policy });
  if (!result || result.code !== 0 || result.killed || result.outputExceeded || typeof result.stdout !== "string" || result.stdout.includes("\uFFFD")) fail(code);
  return result.stdout;
}

async function changedInventory(root, scope, runGit, gitPolicy, plannerPolicy, signal) {
  const staged = scope === "staged" ? ["--cached"] : [];
  const tracked = parseNulPaths(await runChecked(runGit, gitPolicy, root, ["diff", "--name-only", "-z", "--no-ext-diff", "--no-textconv", ...staged, "--"], signal, "commit_plan_inventory_failed"), { omitProtected: true });
  let protectedChangedFileCount = tracked.omittedProtected;
  const entries = tracked.paths.map((relative) => ({ path: relative, status: scope === "staged" ? "STAGED" : "WORKTREE" }));
  if (scope === "worktree") {
    const untracked = parseNulPaths(await runChecked(runGit, gitPolicy, root, ["ls-files", "--others", "--exclude-standard", "-z", "--"], signal, "commit_plan_inventory_failed"), { omitProtected: true });
    protectedChangedFileCount += untracked.omittedProtected;
    entries.push(...untracked.paths.map((relative) => ({ path: relative, status: "UNTRACKED" })));
  }
  const unique = new Map(entries.map((entry) => [entry.path, entry]));
  const ordered = [...unique.values()].sort((left, right) => left.path.localeCompare(right.path));
  if (ordered.length + protectedChangedFileCount > plannerPolicy.maxChangedFiles) fail("commit_plan_changed_file_limit_exceeded");
  return { entries: ordered, protectedChangedFileCount };
}

function inventorySnapshot(value) {
  const digest = hash({ entries: value.entries.map((entry) => ({ pathDigest: hash(entry.path), status: entry.status })), protectedChangedFileCount: value.protectedChangedFileCount });
  return { digest, changedFileCount: value.entries.length + value.protectedChangedFileCount, protectedChangedFileCount: value.protectedChangedFileCount };
}

function untrackedChange(root, entry, policy) {
  const read = readVerifiedRepoText(root, entry.path, { maxBytes: policy.maxUntrackedBytes });
  const lineCount = read.text === "" ? 0 : read.text.split(/\r?\n/u).length - Number(read.text.endsWith("\n"));
  const contentDigest = hash(read.text);
  return freeze({
    path: entry.path, pathDigest: hash(entry.path), status: entry.status, binary: false,
    diffDigest: hash({ kind: "untracked", contentDigest }),
    hunks: [{ index: 1, oldStart: 0, oldLines: 0, newStart: 1, newLines: lineCount, additions: lineCount, deletions: 0, digest: contentDigest }],
  });
}

async function trackedChange(root, entry, scope, runGit, gitPolicy, plannerPolicy, signal) {
  const staged = scope === "staged" ? ["--cached"] : [];
  const diff = await runChecked(runGit, gitPolicy, root, ["diff", "--no-ext-diff", "--no-textconv", "--binary", "--unified=3", ...staged, "--", entry.path], signal, "commit_plan_diff_failed");
  if (!diff) fail("commit_plan_diff_missing");
  const parsed = parseCommitDiffHunks(diff, plannerPolicy.maxHunksPerFile);
  return freeze({ path: entry.path, pathDigest: hash(entry.path), status: entry.status, binary: parsed.binary, diffDigest: hash(diff), hunks: parsed.hunks });
}

async function readChange(root, entry, scope, runGit, gitPolicy, plannerPolicy, signal) {
  return entry.status === "UNTRACKED" ? untrackedChange(root, entry, plannerPolicy) : trackedChange(root, entry, scope, runGit, gitPolicy, plannerPolicy, signal);
}

function normalizePaths(paths, policy) {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > policy.maxSelectedFiles) fail("commit_plan_paths_invalid");
  const normalized = paths.map(normalizePath);
  if (new Set(normalized).size !== normalized.length) fail("commit_plan_path_duplicate");
  return normalized;
}

export class AtomicCommitPlanner {
  constructor(options) {
    if (!options || typeof options.runGit !== "function" || typeof options.cwd !== "string") fail("commit_plan_options_invalid");
    this.cwd = options.cwd;
    this.runGit = options.runGit;
    this.policy = validateCommitPlannerPolicy(options.policy ?? readCommitPlannerPolicy());
    this.gitPolicy = options.gitPolicy ?? readGitResourcePolicy();
    this.stats = { inspections: 0, proposals: 0, failures: 0 };
  }

  async inspect({ scope, paths, signal } = {}) {
    try {
      const selectedScope = normalizeScope(scope);
      const selectedPaths = normalizePaths(paths, this.policy);
      const repository = await verifyGitRepositoryRoot({ cwd: this.cwd, signal }, this.runGit, this.gitPolicy);
      const root = repository.root;
      const head = (await runChecked(this.runGit, this.gitPolicy, root, ["rev-parse", "--verify", "HEAD"], signal, "commit_plan_head_required")).trim();
      if (!OID.test(head)) fail("commit_plan_head_invalid");
      const inventoryResult = await changedInventory(root, selectedScope, this.runGit, this.gitPolicy, this.policy, signal);
      const inventory = inventoryResult.entries;
      const inventoryState = inventorySnapshot(inventoryResult);
      const byPath = new Map(inventory.map((entry) => [entry.path, entry]));
      if (selectedPaths.some((relative) => !byPath.has(relative))) fail("commit_plan_path_not_changed");
      const changes = [];
      for (const relative of selectedPaths) changes.push(await readChange(root, byPath.get(relative), selectedScope, this.runGit, this.gitPolicy, this.policy, signal));
      for (const change of changes) {
        const checked = await readChange(root, byPath.get(change.path), selectedScope, this.runGit, this.gitPolicy, this.policy, signal);
        if (checked.diffDigest !== change.diffDigest || JSON.stringify(checked.hunks) !== JSON.stringify(change.hunks)) fail("commit_plan_source_changed");
      }
      const finalHead = (await runChecked(this.runGit, this.gitPolicy, root, ["rev-parse", "--verify", "HEAD"], signal, "commit_plan_head_required")).trim();
      const finalInventoryState = inventorySnapshot(await changedInventory(root, selectedScope, this.runGit, this.gitPolicy, this.policy, signal));
      if (finalHead !== head || finalInventoryState.digest !== inventoryState.digest || finalInventoryState.changedFileCount !== inventoryState.changedFileCount) fail("commit_plan_repository_changed");
      const snapshot = {
        version: COMMIT_PLANNER_VERSION, kind: "COMMIT_CHANGESET", authority: "PROPOSAL_ONLY", decisionModelCalls: 0,
        scope: selectedScope, head, inventoryDigest: inventoryState.digest, changedFileCount: inventoryState.changedFileCount, protectedChangedFileCount: inventoryState.protectedChangedFileCount, excludedChangedFileCount: inventoryState.changedFileCount - changes.length,
        changes,
      };
      this.stats.inspections += 1;
      return freeze({ ...snapshot, snapshotDigest: hash(snapshot) });
    } catch (error) { this.stats.failures += 1; throw error; }
  }

  async propose({ scope, groups, signal } = {}) {
    try {
      if (!Array.isArray(groups) || groups.length === 0 || groups.length > this.policy.maxGroups) fail("commit_plan_groups_invalid");
      const ids = groups.map((group) => String(group?.id ?? ""));
      if (ids.some((id) => !GROUP_ID.test(id)) || new Set(ids).size !== ids.length) fail("commit_plan_group_id_invalid");
      for (const group of groups) if (!Array.isArray(group?.changes) || group.changes.length === 0 || group.changes.length > this.policy.maxChangesPerGroup) fail("commit_plan_group_changes_invalid");
      const paths = [...new Set(groups.flatMap((group) => group.changes.map((change) => normalizePath(change?.path))))];
      const snapshot = await this.inspect({ scope, paths, signal });
      const byPath = new Map(snapshot.changes.map((change) => [change.path, change]));
      const assigned = new Set();
      const plannedGroups = groups.map((group) => {
        const plannedChanges = group.changes.map((selection) => {
          const change = byPath.get(normalizePath(selection.path));
          if (!change) fail("commit_plan_selection_missing");
          if (change.binary && selection.hunks !== undefined) fail("commit_plan_binary_hunk_denied");
          let indexes;
          if (selection.hunks === undefined) indexes = change.hunks.map((hunk) => hunk.index);
          else {
            if (!Array.isArray(selection.hunks) || selection.hunks.length === 0 || selection.hunks.some((value) => !Number.isSafeInteger(value) || value < 1) || new Set(selection.hunks).size !== selection.hunks.length) fail("commit_plan_hunk_selection_invalid");
            indexes = [...selection.hunks].sort((left, right) => left - right);
            if (indexes.some((index) => !change.hunks.some((hunk) => hunk.index === index))) fail("commit_plan_hunk_selection_missing");
          }
          const keys = indexes.length ? indexes.map((index) => `${change.pathDigest}:${index}`) : [`${change.pathDigest}:all`];
          if (keys.some((key) => assigned.has(key))) fail("commit_plan_hunk_duplicate");
          keys.forEach((key) => assigned.add(key));
          const hunks = change.hunks.filter((hunk) => indexes.includes(hunk.index));
          return { path: change.path, pathDigest: change.pathDigest, status: change.status, binary: change.binary, diffDigest: change.diffDigest, hunkIndexes: indexes, hunkDigests: hunks.map((hunk) => hunk.digest) };
        });
        const value = { id: group.id, changes: plannedChanges };
        return { ...value, groupDigest: hash(value) };
      });
      const selectedHunkCount = plannedGroups.reduce((total, group) => total + group.changes.reduce((sum, change) => sum + Math.max(1, change.hunkIndexes.length), 0), 0);
      const availableHunkCount = snapshot.changes.reduce((total, change) => total + Math.max(1, change.hunks.length), 0);
      const plan = {
        version: COMMIT_PLANNER_VERSION, kind: "ATOMIC_COMMIT_PLAN", status: "PROPOSAL_ONLY", authority: "NONE",
        decisionModelCalls: 0, canStage: false, canCommit: false, canPublish: false, scope: snapshot.scope, head: snapshot.head,
        snapshotDigest: snapshot.snapshotDigest, inventoryDigest: snapshot.inventoryDigest, changedFileCount: snapshot.changedFileCount,
        protectedChangedFileCount: snapshot.protectedChangedFileCount, excludedChangedFileCount: snapshot.excludedChangedFileCount, selectedFileCount: snapshot.changes.length,
        selectedHunkCount, unassignedSelectedHunkCount: availableHunkCount - selectedHunkCount, groups: plannedGroups,
      };
      this.stats.proposals += 1;
      return freeze({ ...plan, planDigest: hash(plan) });
    } catch (error) { this.stats.failures += 1; throw error; }
  }

  status() { return freeze({ version: COMMIT_PLANNER_VERSION, enabled: this.policy.enabled, authority: "PROPOSAL_ONLY", decisionModelCalls: 0, canStage: false, canCommit: false, canPublish: false, stats: { ...this.stats } }); }
}

export function commitPlanMetadata(value, status = "PASS") {
  if (!value || !["COMMIT_CHANGESET", "ATOMIC_COMMIT_PLAN"].includes(value.kind)) fail("commit_plan_metadata_invalid");
  return freeze({ kind: "commit_plan", version: COMMIT_PLANNER_VERSION, status, operation: value.kind === "ATOMIC_COMMIT_PLAN" ? "PROPOSE" : "INSPECT", scope: value.scope, decisionModelCalls: 0, changedFileCount: value.changedFileCount, protectedChangedFileCount: value.protectedChangedFileCount, selectedFileCount: value.selectedFileCount ?? value.changes.length, excludedChangedFileCount: value.excludedChangedFileCount, groupCount: value.groups?.length ?? 0, snapshotDigest: value.snapshotDigest, planDigest: value.planDigest });
}
