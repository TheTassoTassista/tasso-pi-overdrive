import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { isInside } from "./safety.mjs";
import { captureProcessIdentity, inspectProcessIdentity } from "./process-identity.mjs";
import { syncDirectory } from "./portable-directory-sync.mjs";

export const RUNTIME_ALLOCATION_VERSION = 2;
export const RUNTIME_ISOLATION_BACKEND = "git-worktree-v2";

function assertNoSymlinkComponents(candidate, code = "runtime path contains a symlink") {
  const absolute = path.resolve(candidate);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(code);
      if (!stat.isDirectory() && current !== absolute) throw new Error("runtime path component is not a directory");
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
  }
  return absolute;
}

function mkdirPrivate(directory) {
  const absolute = assertNoSymlinkComponents(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(absolute) !== absolute || fs.lstatSync(absolute).isSymbolicLink()) throw new Error("runtime directory canonical boundary rejected");
  fs.chmodSync(absolute, 0o700);
  return absolute;
}

function writeJsonPrivate(file, value) {
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
    syncDirectory(path.dirname(file));
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function readJsonPrivate(file, code = "runtime metadata rejected") {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error(code);
    return JSON.parse(fs.readFileSync(descriptor, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(code);
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function git(repo, args, allowFailure = false) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (!allowFailure && result.status !== 0) throw new Error((result.stderr || result.stdout || `git ${args[0]} failed`).trim());
  return result;
}

function slug(value, max = 36) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, max) || "repo";
}

function canBind(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

async function reservePort(portDirectory, allocationId, excluded = new Set()) {
  const processIdentity = captureProcessIdentity();
  for (let attempt = 0; attempt < 512; attempt += 1) {
    const port = 30000 + Number.parseInt(randomBytes(2).toString("hex"), 16) % 20000;
    if (excluded.has(port)) continue;
    const lockFile = path.join(portDirectory, `${port}.json`);
    try {
      fs.writeFileSync(lockFile, `${JSON.stringify({ allocationId, process: processIdentity, createdAt: new Date().toISOString() })}\n`, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error?.code === "EEXIST") continue;
      throw error;
    }
    if (await canBind(port)) return { port, lockFile };
    fs.unlinkSync(lockFile);
  }
  throw new Error("unable to reserve a free runtime port");
}

export function runtimeRoots(options = {}) {
  const shareRoot = path.resolve(options.shareRoot ?? process.env.PI_OVERDRIVE_WORKTREE_ROOT ?? path.join(os.homedir(), ".local", "share", "pi-overdrive", "worktrees"));
  const stateRoot = path.resolve(options.stateRoot ?? process.env.PI_OVERDRIVE_RUNTIME_ROOT ?? path.join(os.homedir(), ".local", "state", "pi-overdrive", "runtime"));
  return { shareRoot, stateRoot };
}

function runtimeLayout(allocationId, repo, roots, resumeCount = 0) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(allocationId)) throw new Error("invalid allocation id");
  const shortId = allocationId.replaceAll("-", "").slice(0, 12);
  const repoName = slug(path.basename(repo));
  const allocationRoot = path.join(roots.stateRoot, "allocations", allocationId);
  return {
    shortId,
    repoName,
    branch: `pi-overdrive/auto-${shortId}`,
    worktree: path.join(roots.shareRoot, repoName, shortId),
    allocationRoot,
    allocationFile: path.join(allocationRoot, "allocation.json"),
    stateDir: path.join(allocationRoot, "state"),
    browserProfile: path.join(allocationRoot, resumeCount > 0 ? `browser-profile-resume-${resumeCount}` : "browser-profile"),
    database: `pi_${repoName.replaceAll("-", "_")}_${shortId}`.slice(0, 63),
    schema: `pi_${shortId}`,
  };
}

function assertSeparatedRuntimeRoots(repo, roots) {
  for (const root of [roots.shareRoot, roots.stateRoot]) {
    assertNoSymlinkComponents(root);
    if (isInside(repo, root) || isInside(root, repo)) throw new Error("runtime roots must not overlap the source repository");
  }
  if (isInside(roots.shareRoot, roots.stateRoot) || isInside(roots.stateRoot, roots.shareRoot)) throw new Error("runtime roots must be independent");
}

function validateAllocation(allocation, allocationId, roots, allowedStatuses) {
  if (!allocation || allocation.version !== RUNTIME_ALLOCATION_VERSION || allocation.isolationBackend !== RUNTIME_ISOLATION_BACKEND || allocation.allocationId !== allocationId || !allowedStatuses.has(allocation.status)) throw new Error("runtime allocation metadata rejected");
  const repo = fs.realpathSync(allocation.repo);
  if (path.resolve(allocation.repo) !== repo) throw new Error("runtime repository must be canonical");
  assertSeparatedRuntimeRoots(repo, roots);
  const resumeCount = Number.isSafeInteger(allocation.resumeCount) && allocation.resumeCount > 0 ? allocation.resumeCount : 0;
  const expected = runtimeLayout(allocationId, repo, roots, resumeCount);
  const exact = [
    [allocation.branch, expected.branch], [path.resolve(allocation.worktree), expected.worktree], [path.resolve(allocation.stateDir), expected.stateDir],
    [path.resolve(allocation.browserProfile), expected.browserProfile], [allocation.database, expected.database], [allocation.schema, expected.schema],
  ];
  if (exact.some(([actual, wanted]) => actual !== wanted)) throw new Error("runtime allocation canonical identity rejected");
  const unreservedAllocating = allocation.status === "allocating" && allocation.port === null && allocation.portReservation === null;
  if (!unreservedAllocating) {
    if (!Number.isSafeInteger(allocation.port) || allocation.port < 30000 || allocation.port > 49999) throw new Error("runtime allocation port rejected");
    const expectedPort = path.join(roots.stateRoot, "ports", `${allocation.port}.json`);
    if (typeof allocation.portReservation !== "string" || path.resolve(allocation.portReservation) !== expectedPort) throw new Error("runtime allocation port reservation rejected");
  }
  assertNoSymlinkComponents(expected.allocationRoot);
  for (const directory of [expected.worktree, expected.stateDir, expected.browserProfile]) {
    assertNoSymlinkComponents(directory);
    if (fs.existsSync(directory) && (fs.realpathSync(directory) !== directory || !fs.lstatSync(directory).isDirectory())) throw new Error("runtime allocation directory boundary rejected");
  }
  return { ...allocation, repo };
}

function readAllocation(allocationId, options, allowedStatuses = new Set(["active", "allocating", "interrupted", "released"])) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(allocationId)) throw new Error("invalid allocation id");
  const roots = runtimeRoots(options);
  const root = path.join(roots.stateRoot, "allocations", allocationId);
  if (!isInside(path.join(roots.stateRoot, "allocations"), root)) throw new Error("allocation path escape");
  assertNoSymlinkComponents(root);
  const value = readJsonPrivate(path.join(root, "allocation.json"), "runtime allocation file rejected");
  const allocation = validateAllocation(value, allocationId, roots, allowedStatuses);
  const resumeCount = Number.isSafeInteger(allocation.resumeCount) && allocation.resumeCount > 0 ? allocation.resumeCount : 0;
  return { roots, allocation, layout: runtimeLayout(allocationId, allocation.repo, roots, resumeCount) };
}

export async function createRuntimeWorktree(repoCandidate, options = {}) {
  const source = fs.realpathSync(repoCandidate);
  const topResult = git(source, ["rev-parse", "--show-toplevel"]);
  const repo = fs.realpathSync(topResult.stdout.trim());
  const sourceStatus = git(repo, ["status", "--porcelain"], true);
  if (sourceStatus.status !== 0) throw new Error("source repository status cannot be inspected");
  if (sourceStatus.stdout.trim()) throw new Error("source repository must be clean before creating an autonomous worktree");

  const roots = runtimeRoots(options);
  assertSeparatedRuntimeRoots(repo, roots);
  const { shareRoot, stateRoot } = roots;
  const allocationId = randomUUID();
  const layout = runtimeLayout(allocationId, repo, roots);
  const { shortId, repoName, branch, worktree, allocationRoot, stateDir, browserProfile } = layout;
  const worktreeParent = path.dirname(worktree);
  const portDirectory = path.join(stateRoot, "ports");
  mkdirPrivate(worktreeParent);
  mkdirPrivate(stateDir);
  mkdirPrivate(browserProfile);
  mkdirPrivate(portDirectory);

  let portReservation;
  const allocationFile = path.join(allocationRoot, "allocation.json");
  const baseAllocation = {
    version: RUNTIME_ALLOCATION_VERSION,
    isolationBackend: RUNTIME_ISOLATION_BACKEND,
    allocationId,
    createdAt: new Date().toISOString(),
    repo,
    worktree,
    branch,
    port: null,
    portReservation: null,
    stateDir: fs.realpathSync(stateDir),
    browserProfile: fs.realpathSync(browserProfile),
    browserSession: `pi-${shortId}`,
    database: layout.database,
    schema: layout.schema,
    status: "allocating",
    process: captureProcessIdentity(),
    evidenceRunId: options.evidenceRunId ?? null,
    ownerRunId: options.ownerRunId ?? null,
  };
  writeJsonPrivate(allocationFile, baseAllocation);
  try {
    portReservation = await reservePort(portDirectory, allocationId);
    writeJsonPrivate(allocationFile, { ...baseAllocation, port: portReservation.port, portReservation: portReservation.lockFile });
    const added = git(repo, ["worktree", "add", "-b", branch, worktree, options.baseRef ?? "HEAD"], true);
    if (added.status !== 0) throw new Error((added.stderr || added.stdout || "git worktree add failed").trim());
    const allocation = {
      ...baseAllocation,
      worktree: fs.realpathSync(worktree),
      port: portReservation.port,
      portReservation: portReservation.lockFile,
      status: "active",
    };
    writeJsonPrivate(allocationFile, allocation);
    return allocation;
  } catch (error) {
    if (portReservation?.lockFile && fs.existsSync(portReservation.lockFile)) fs.unlinkSync(portReservation.lockFile);
    if (fs.existsSync(worktree)) git(repo, ["worktree", "remove", "--force", worktree], true);
    git(repo, ["branch", "-D", branch], true);
    fs.rmSync(allocationRoot, { recursive: true, force: true });
    throw error;
  }
}

export function listRuntimeAllocations(options = {}) {
  const roots = runtimeRoots(options);
  const { stateRoot } = roots;
  const root = path.join(stateRoot, "allocations");
  if (!fs.existsSync(root)) return [];
  assertNoSymlinkComponents(root);
  const allocations = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/u.test(entry.name)) continue;
    const file = path.join(root, entry.name, "allocation.json");
    try {
      const allocation = readJsonPrivate(file);
      allocations.push(validateAllocation(allocation, entry.name, roots, new Set(["active", "allocating", "interrupted", "released"])));
    } catch {}
  }
  return allocations;
}

export function auditRuntimeState(options = {}) {
  const { shareRoot, stateRoot } = runtimeRoots(options);
  const allocations = listRuntimeAllocations(options);
  const allocationIds = new Set(allocations.map((allocation) => allocation.allocationId));
  const invalidAllocations = [];
  const allocationRoot = path.join(stateRoot, "allocations");
  if (fs.existsSync(allocationRoot)) {
    for (const entry of fs.readdirSync(allocationRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && /^[0-9a-f-]{36}$/u.test(entry.name) && !allocationIds.has(entry.name)) invalidAllocations.push(path.join(allocationRoot, entry.name));
    }
  }
  const orphanPorts = [];
  const portRoot = path.join(stateRoot, "ports");
  if (fs.existsSync(portRoot)) {
    for (const entry of fs.readdirSync(portRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !/^\d{4,5}\.json$/u.test(entry.name)) continue;
      const file = path.join(portRoot, entry.name);
      try {
        const stat = fs.lstatSync(file);
        const lock = readJsonPrivate(file, "runtime port reservation rejected");
        if ((stat.mode & 0o077) !== 0 || !allocationIds.has(lock.allocationId)) orphanPorts.push({ file, process: lock.process, reason: (stat.mode & 0o077) !== 0 ? "insecure-port-reservation" : "allocation-missing" });
      } catch { orphanPorts.push({ file, process: null, reason: "malformed-port-reservation" }); }
    }
  }
  const knownWorktrees = new Set(allocations.map((allocation) => path.resolve(allocation.worktree)));
  const orphanWorktrees = [];
  if (fs.existsSync(shareRoot)) {
    for (const repoEntry of fs.readdirSync(shareRoot, { withFileTypes: true })) {
      const repoDirectory = path.join(shareRoot, repoEntry.name);
      if (!repoEntry.isDirectory() || repoEntry.isSymbolicLink()) continue;
      for (const worktreeEntry of fs.readdirSync(repoDirectory, { withFileTypes: true })) {
        const candidate = path.join(repoDirectory, worktreeEntry.name);
        if (worktreeEntry.isDirectory() && !worktreeEntry.isSymbolicLink() && /^[0-9a-f]{12}$/u.test(worktreeEntry.name) && !knownWorktrees.has(path.resolve(candidate))) orphanWorktrees.push(candidate);
      }
    }
  }
  return { allocations, invalidAllocations, orphanPorts, orphanWorktrees };
}

export function findRuntimeAllocation(cwd, options = {}) {
  let canonical;
  try { canonical = fs.realpathSync(cwd); } catch { return undefined; }
  return listRuntimeAllocations(options).find((allocation) => {
    try {
      const worktree = fs.realpathSync(allocation.worktree);
      return isInside(worktree, canonical) && allocation.status === "active";
    } catch { return false; }
  });
}

export function releaseRuntimeResources(allocationId, options = {}) {
  const { roots: { stateRoot }, allocation, layout } = readAllocation(allocationId, options, new Set(["active", "interrupted"]));
  const file = layout.allocationFile;
  if (typeof allocation.portReservation === "string" && isInside(path.join(stateRoot, "ports"), allocation.portReservation)) {
    try {
      const lock = readJsonPrivate(allocation.portReservation, "runtime port reservation rejected");
      if (lock.allocationId === allocationId) fs.unlinkSync(allocation.portReservation);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const updated = { ...allocation, status: "released", releasedAt: new Date().toISOString(), process: null };
  writeJsonPrivate(file, updated);
  return updated;
}

export async function resumeRuntimeResources(allocationId, options = {}) {
  const { roots: { shareRoot, stateRoot }, allocation, layout } = readAllocation(allocationId, options, new Set(["interrupted"]));
  const { allocationRoot, allocationFile: file } = layout;
  const repo = allocation.repo;
  const worktree = fs.realpathSync(allocation.worktree);
  if (!isInside(shareRoot, worktree) || worktree === repo) throw new Error("resumed worktree boundary rejected");
  const common = git(repo, ["worktree", "list", "--porcelain"]);
  if (!common.stdout.split("\n").some((line) => line === `worktree ${worktree}`)) throw new Error("resumed worktree is not registered by Git");
  const portDirectory = path.join(stateRoot, "ports");
  mkdirPrivate(portDirectory);
  const reservation = await reservePort(portDirectory, allocationId, new Set([allocation.port]));
  const resumeNumber = Number.isSafeInteger(allocation.resumeCount) ? allocation.resumeCount + 1 : 1;
  const browserProfile = runtimeLayout(allocationId, repo, runtimeRoots(options), resumeNumber).browserProfile;
  mkdirPrivate(browserProfile);
  const resumed = {
    ...allocation,
    repo,
    worktree,
    port: reservation.port,
    portReservation: reservation.lockFile,
    browserProfile: fs.realpathSync(browserProfile),
    browserSession: `${allocation.browserSession}-r${resumeNumber}`,
    status: "active",
    process: captureProcessIdentity(),
    resumeCount: resumeNumber,
    resumedAt: new Date().toISOString(),
  };
  writeJsonPrivate(file, resumed);
  return resumed;
}

export function recoverStaleRuntimeAllocations(options = {}) {
  const { stateRoot } = runtimeRoots(options);
  const audit = auditRuntimeState(options);
  const recovered = [];
  const active = [];
  for (const allocation of listRuntimeAllocations(options)) {
    if (!new Set(["active", "allocating"]).has(allocation.status)) continue;
    const processStatus = inspectProcessIdentity(allocation.process);
    if (processStatus.alive) {
      active.push({ allocationId: allocation.allocationId, pid: allocation.process.pid });
      continue;
    }
    if (typeof allocation.portReservation === "string" && isInside(path.join(stateRoot, "ports"), allocation.portReservation)) {
      try {
        const lock = readJsonPrivate(allocation.portReservation, "runtime port reservation rejected");
        if (lock.allocationId === allocation.allocationId) fs.unlinkSync(allocation.portReservation);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    const file = path.join(stateRoot, "allocations", allocation.allocationId, "allocation.json");
    if (allocation.status === "allocating") {
      if (typeof allocation.worktree === "string" && isInside(runtimeRoots(options).shareRoot, allocation.worktree) && fs.existsSync(allocation.worktree)) {
        const removed = git(allocation.repo, ["worktree", "remove", "--force", allocation.worktree], true);
        if (removed.status !== 0) throw new Error("stale allocating worktree could not be removed safely");
      }
      if (typeof allocation.branch === "string" && /^pi-overdrive\/auto-[0-9a-f]{12}$/u.test(allocation.branch)) git(allocation.repo, ["branch", "-D", allocation.branch], true);
      const allocationRoot = path.dirname(file);
      if (!isInside(path.join(stateRoot, "allocations"), allocationRoot)) throw new Error("stale allocation cleanup path escape");
      fs.rmSync(allocationRoot, { recursive: true, force: true });
      recovered.push({ allocationId: allocation.allocationId, evidenceRunId: allocation.evidenceRunId, worktree: allocation.worktree, reason: processStatus.reason, cleanedIncomplete: true });
      continue;
    }
    allocation.status = "interrupted";
    allocation.interruptedAt = new Date().toISOString();
    allocation.interruptionReason = processStatus.reason;
    writeJsonPrivate(file, allocation);
    recovered.push({ allocationId: allocation.allocationId, evidenceRunId: allocation.evidenceRunId, worktree: allocation.worktree, reason: processStatus.reason });
  }
  const cleanedOrphanPorts = [];
  for (const port of audit.orphanPorts) {
    const processStatus = inspectProcessIdentity(port.process);
    if (!processStatus.alive && isInside(path.join(stateRoot, "ports"), port.file)) {
      fs.unlinkSync(port.file);
      cleanedOrphanPorts.push(port.file);
    }
  }
  return { recovered, active, cleanedOrphanPorts, invalidAllocations: audit.invalidAllocations, orphanWorktrees: audit.orphanWorktrees };
}

/** Permanently remove only resources identified by a controller-created
 * allocation. This is explicit because normal successful coding workflows
 * retain their worktree for human review/merge. */
export function cleanupRuntimeResources(allocationId, options = {}) {
  const { shareRoot, stateRoot } = runtimeRoots(options);
  const allocation = releaseRuntimeResources(allocationId, options);
  if (!isInside(shareRoot, allocation.worktree) || allocation.worktree === allocation.repo) throw new Error("managed worktree cleanup boundary rejected");
  if (!/^pi-overdrive\/auto-[0-9a-f]{12}$/u.test(allocation.branch)) throw new Error("managed branch identity rejected");
  if (fs.existsSync(allocation.worktree)) {
    const removed = git(allocation.repo, ["worktree", "remove", "--force", allocation.worktree], true);
    if (removed.status !== 0) throw new Error((removed.stderr || removed.stdout || "managed worktree cleanup failed").trim());
  }
  const deleted = git(allocation.repo, ["branch", "-D", allocation.branch], true);
  const stillRegistered = git(allocation.repo, ["worktree", "list", "--porcelain"], true).stdout.split("\n").some((line) => line === `worktree ${allocation.worktree}`);
  const branchStillExists = git(allocation.repo, ["show-ref", "--verify", `refs/heads/${allocation.branch}`], true).status === 0;
  if (stillRegistered || branchStillExists || (deleted.status !== 0 && branchStillExists)) throw new Error("managed worktree or branch survived cleanup");
  const allocationRoot = path.join(stateRoot, "allocations", allocationId);
  if (!isInside(path.join(stateRoot, "allocations"), allocationRoot)) throw new Error("allocation cleanup path escape");
  fs.rmSync(allocationRoot, { recursive: true, force: true });
  return { ...allocation, cleaned: true };
}
