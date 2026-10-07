import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectWorkspacePath } from "./safety.mjs";
import { captureProcessIdentity, inspectProcessIdentity } from "./process-identity.mjs";
import { syncDirectory } from "./portable-directory-sync.mjs";
import { assertProtectedArtifact, createProtectedFile, ensureProtectedDirectory } from "./protected-artifact.mjs";

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DIGEST = /^[0-9a-f]{64}$/u;

function privateDirectory(directory) {
  ensureProtectedDirectory(directory);
}

function stateFilename() { return process.platform === "win32" ? "state.win-v1.json" : "state.json"; }

function writeAtomicPrivate(file, value) {
  const directory = path.dirname(file);
  privateDirectory(directory);
  const temporary = path.join(directory, `.${path.basename(file)}-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  let descriptor;
  try {
    if (process.platform === "win32") createProtectedFile(temporary);
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | (process.platform === "win32" ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL) | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
    if (process.platform === "win32") assertProtectedArtifact(file, "file", "workflow journal is not protected");
    else fs.chmodSync(file, 0o600);
    syncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

export function defaultEvidenceRoot() {
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "pi-overdrive", "workflow-evidence");
}

export function createEvidenceRun(options = {}) {
  const root = path.resolve(options.root ?? process.env.PI_OVERDRIVE_EVIDENCE_ROOT ?? defaultEvidenceRoot());
  const runId = options.runId ?? process.env.PI_OVERDRIVE_EVIDENCE_RUN_ID ?? randomUUID();
  if (!RUN_ID.test(runId)) throw new Error("workflow evidence run id must be a UUID");
  privateDirectory(root);
  const directory = path.join(root, runId);
  ensureProtectedDirectory(directory, { exclusive: true });
  syncDirectory(root);
  return {
    root,
    runId,
    directory,
    executionFile: path.join(directory, "execution.json"),
    receiptFile: path.join(directory, "receipt.json"),
    stateFile: path.join(directory, stateFilename()),
  };
}

export function openEvidenceRun(options = {}) {
  const root = path.resolve(options.root ?? process.env.PI_OVERDRIVE_EVIDENCE_ROOT ?? defaultEvidenceRoot());
  const runId = options.runId ?? process.env.PI_OVERDRIVE_EVIDENCE_RUN_ID;
  if (!RUN_ID.test(runId ?? "")) throw new Error("workflow evidence run id must be a UUID");
  const directory = path.join(root, runId);
  if (process.platform === "win32") assertProtectedArtifact(root, "directory", "workflow evidence root is not private");
  assertProtectedArtifact(directory, "directory", "workflow evidence directory is not private");
  return { root, runId, directory, executionFile: path.join(directory, "execution.json"), receiptFile: path.join(directory, "receipt.json"), stateFile: path.join(directory, stateFilename()) };
}

const JOURNAL_STATES = new Set(["RUNNING", "INTERRUPTED", "FAILED", "COMPLETED", "INCONSISTENT"]);

export function writeWorkflowJournal(run, journal) {
  if (!run || !RUN_ID.test(run.runId) || journal?.run_id !== run.runId) throw new Error("workflow journal run id mismatch");
  if (!JOURNAL_STATES.has(journal?.status)) throw new Error("workflow journal status is invalid");
  if (journal.task_id !== null && !DIGEST.test(journal?.task_id ?? "")) throw new Error("workflow journal task id is invalid");
  if (process.platform === "win32" && (journal.identity_format_version !== 1 || journal.process?.kind !== "windows-process-creation" || journal.process?.version !== 1)) throw new Error("workflow journal process identity format is invalid");
  if (journal.workflow_version >= 4 && (!DIGEST.test(journal?.protocol_nonce ?? "") || !Number.isSafeInteger(journal?.checkpoint_seq) || journal.checkpoint_seq < 0)) throw new Error("workflow journal protocol ordering is invalid");
  writeAtomicPrivate(run.stateFile, journal);
  return run.stateFile;
}

export function readWorkflowJournal(run) {
  assertProtectedArtifact(run.stateFile, "file", "workflow journal is not a private regular file");
  let journal;
  try { journal = JSON.parse(fs.readFileSync(run.stateFile, "utf8")); }
  catch { throw new Error("workflow journal is malformed"); }
  if (journal?.run_id !== run.runId || !JOURNAL_STATES.has(journal?.status)) throw new Error("workflow journal identity/status is invalid");
  if (process.platform === "win32" && (journal.identity_format_version !== 1 || journal.process?.kind !== "windows-process-creation" || journal.process?.version !== 1)) throw new Error("workflow journal process identity format is invalid");
  if (journal.workflow_version >= 4 && (!DIGEST.test(journal?.protocol_nonce ?? "") || !Number.isSafeInteger(journal?.checkpoint_seq) || journal.checkpoint_seq < 0)) throw new Error("workflow journal protocol ordering is invalid");
  return journal;
}

export function initialWorkflowJournal(run, options) {
  const now = new Date().toISOString();
  const protocolNonce = options.protocolNonce ?? taskDigest(`${run.runId}:${options.ownerRunId}:role-receipts`);
  return {
    run_id: run.runId,
    task_id: options.taskDigest,
    protocol_nonce: protocolNonce,
    checkpoint_seq: 0,
    workflow_version: options.workflowVersion,
    ...(process.platform === "win32" ? { identity_format_version: 1 } : {}),
    status: "RUNNING",
    workflow_status: "RUNNING",
    current_phase: "INITIALIZING",
    round: 0,
    worker_status: "NOT_RUN",
    tester_status: "NOT_RUN",
    verification_status: "NOT_RUN",
    review_status: "NOT_RUN",
    blocking_findings_count: 0,
    correction_performed: false,
    final_verification_status: "NOT_RUN",
    cleanup_status: "NOT_RUN",
    evidence_status: "NOT_RUN",
    source_repository: options.sourceRepository,
    owner_run_id: options.ownerRunId,
    process: captureProcessIdentity(),
    allocation_id: options.allocationId ?? null,
    workflow_state: options.workflowState,
    timestamps: { started_at: now, updated_at: now },
  };
}

export function checkpointWorkflowJournal(run, previous, update = {}) {
  const now = new Date().toISOString();
  const journal = {
    ...previous,
    ...update,
    run_id: run.runId,
    protocol_nonce: previous.protocol_nonce,
    checkpoint_seq: (Number.isSafeInteger(previous.checkpoint_seq) ? previous.checkpoint_seq : 0) + 1,
    process: update.status === "RUNNING" ? captureProcessIdentity() : (update.process ?? previous.process),
    timestamps: { ...previous.timestamps, ...update.timestamps, updated_at: now },
  };
  writeWorkflowJournal(run, journal);
  return journal;
}

function safeRunDirectories(root) {
  if (!fs.existsSync(root)) return [];
  assertProtectedArtifact(root, "directory", "workflow evidence root is not private");
  return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && RUN_ID.test(entry.name)).map((entry) => entry.name);
}

export function recoverInterruptedWorkflowRuns(options = {}) {
  const root = path.resolve(options.root ?? process.env.PI_OVERDRIVE_EVIDENCE_ROOT ?? defaultEvidenceRoot());
  const recovered = [];
  const active = [];
  const inconsistent = [];
  const unknown = [];
  for (const runId of safeRunDirectories(root)) {
    const run = openEvidenceRun({ root, runId });
    if (!fs.existsSync(run.stateFile)) continue;
    let journal;
    try { journal = readWorkflowJournal(run); }
    catch (error) {
      if (process.platform === "win32") {
        inconsistent.push({ runId, reason: "workflow journal untrusted; no recovery mutation" });
        continue;
      }
      const corruptFile = path.join(run.directory, `state.corrupt-${Date.now()}.json`);
      fs.renameSync(run.stateFile, corruptFile);
      const now = new Date().toISOString();
      journal = {
        run_id: runId, task_id: null, workflow_version: null, status: "INCONSISTENT", workflow_status: "UNKNOWN",
        current_phase: "UNKNOWN", round: 0, worker_status: "UNKNOWN", tester_status: "UNKNOWN", verification_status: "UNKNOWN",
        review_status: "UNKNOWN", blocking_findings_count: 0, correction_performed: false, final_verification_status: "UNKNOWN",
        cleanup_status: "UNKNOWN", evidence_status: "INVALID", source_repository: null, owner_run_id: null, process: null,
        allocation_id: null, timestamps: { recovered_at: now, updated_at: now }, recovery_reason: "malformed-workflow-journal",
      };
      writeWorkflowJournal(run, journal);
      inconsistent.push({ runId, reason: error.message, preservedAs: corruptFile });
      continue;
    }
    if (journal.status !== "RUNNING") continue;
    const processStatus = inspectProcessIdentity(journal.process);
    if (processStatus.alive) {
      active.push({ runId, pid: journal.process.pid });
      continue;
    }
    if (processStatus.alive !== false) {
      unknown.push({ runId, reason: processStatus.reason });
      continue;
    }
    let receiptStatus;
    if (fs.existsSync(run.receiptFile)) {
      try { receiptStatus = readEvidenceReceipt({ root, runId, taskDigest: journal.task_id }).receipt.status; }
      catch { receiptStatus = "INVALID"; }
    }
    const terminal = receiptStatus === "PASS" ? "COMPLETED" : receiptStatus === "FAIL" ? "FAILED" : "INTERRUPTED";
    journal = checkpointWorkflowJournal(run, journal, {
      status: terminal,
      evidence_status: receiptStatus === "PASS" || receiptStatus === "FAIL" ? "PASS" : receiptStatus === "INVALID" ? "INVALID" : "INCOMPLETE",
      process: journal.process,
      timestamps: { ...(terminal === "INTERRUPTED" ? { interrupted_at: new Date().toISOString() } : { recovered_at: new Date().toISOString() }) },
      recovery_reason: processStatus.reason,
    });
    recovered.push({ runId, status: journal.status, phase: journal.current_phase, reason: processStatus.reason, allocationId: journal.allocation_id });
  }
  return { root, recovered, active, inconsistent, unknown };
}

export function findResumableWorkflow(options) {
  const root = path.resolve(options.root ?? process.env.PI_OVERDRIVE_EVIDENCE_ROOT ?? defaultEvidenceRoot());
  const candidates = [];
  for (const runId of safeRunDirectories(root)) {
    try {
      const run = openEvidenceRun({ root, runId });
      const journal = readWorkflowJournal(run);
      if (journal.status === "INTERRUPTED" && journal.task_id === options.taskDigest && journal.source_repository === options.sourceRepository && !fs.existsSync(run.receiptFile)) {
        candidates.push({ run, journal, updated: Date.parse(journal.timestamps?.updated_at ?? "") || 0 });
      }
    } catch {}
  }
  return candidates.sort((left, right) => right.updated - left.updated)[0];
}

export function taskDigest(task) {
  return createHash("sha256").update(task).digest("hex");
}

function git(cwd, args) {
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
}

function nulList(text) {
  return text.split("\0").filter(Boolean);
}

export function snapshotWorktree(worktree) {
  const root = fs.realpathSync(worktree);
  const headResult = git(root, ["rev-parse", "HEAD"]);
  const diffResult = git(root, ["diff", "--binary", "--no-ext-diff"]);
  const namesResult = git(root, ["diff", "--name-only", "-z", "--no-ext-diff"]);
  const untrackedResult = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const checkResult = git(root, ["diff", "--check"]);
  if (headResult.status !== 0 || diffResult.status !== 0 || namesResult.status !== 0 || untrackedResult.status !== 0) {
    throw new Error("working tree evidence could not be collected");
  }
  const changed = [...new Set([...nulList(namesResult.stdout), ...nulList(untrackedResult.stdout)])].sort();
  const files = changed.map((relative) => {
    const inspected = inspectWorkspacePath(root, relative, { mustExist: false });
    if (!inspected.allowed) return { path: relative, status: "DENIED" };
    if (!inspected.exists) return { path: relative, status: "DELETED" };
    if (!inspected.stat?.isFile()) return { path: relative, status: inspected.stat?.isDirectory() ? "DIRECTORY" : "NON_REGULAR" };
    const content = fs.readFileSync(inspected.canonical);
    return { path: relative, status: "FILE", size: content.byteLength, sha256: createHash("sha256").update(content).digest("hex") };
  });
  return {
    head: headResult.stdout.trim(),
    branch: git(root, ["branch", "--show-current"]).stdout.trim(),
    diffSha256: createHash("sha256").update(diffResult.stdout).digest("hex"),
    diffBytes: Buffer.byteLength(diffResult.stdout),
    diffCheckExitCode: checkResult.status ?? 1,
    changedFiles: files,
  };
}

function writeImmutableEvidence(run, target, value, label) {
  if (!run || !RUN_ID.test(run.runId) || path.dirname(target) !== run.directory) throw new Error("invalid workflow evidence run");
  if (value?.runId !== run.runId) throw new Error(`${label} run id mismatch`);
  if (!DIGEST.test(value?.taskDigest ?? "")) throw new Error(`${label} task digest is missing or malformed`);
  const temporary = path.join(run.directory, `.${label}-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  let descriptor;
  try {
    if (process.platform === "win32") createProtectedFile(temporary);
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | (process.platform === "win32" ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL) | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (process.platform === "win32") assertProtectedArtifact(temporary, "file", `${label} is not protected`);
    fs.linkSync(temporary, target);
    if (process.platform !== "win32") fs.chmodSync(target, 0o400);
    syncDirectory(run.directory);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    throw error;
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    syncDirectory(run.directory);
  }
  if (process.platform === "win32") assertProtectedArtifact(target, "file", `${label} is not protected`);
  return target;
}

export function writeEvidenceExecution(run, execution) {
  return writeImmutableEvidence(run, run.executionFile, execution, "execution");
}

export function writeEvidenceReceipt(run, receipt) {
  if (!DIGEST.test(receipt?.executionSha256 ?? "")) throw new Error("receipt execution digest is missing or malformed");
  if (process.platform === "win32") assertProtectedArtifact(run.executionFile, "file", "workflow execution evidence is not protected");
  const content = fs.readFileSync(run.executionFile);
  if (createHash("sha256").update(content).digest("hex") !== receipt.executionSha256) throw new Error("receipt execution digest mismatch");
  return writeImmutableEvidence(run, run.receiptFile, receipt, "receipt");
}

export function readEvidenceExecution(run, expectedTaskDigest) {
  assertProtectedArtifact(run.executionFile, "file", "workflow execution evidence is not a private regular file");
  const content = fs.readFileSync(run.executionFile);
  let execution;
  try { execution = JSON.parse(content); }
  catch { throw new Error("workflow execution evidence is malformed"); }
  if (execution?.runId !== run.runId) throw new Error("workflow execution evidence belongs to another run");
  if (expectedTaskDigest && execution?.taskDigest !== expectedTaskDigest) throw new Error("workflow execution evidence belongs to another task");
  return { execution, content, sha256: createHash("sha256").update(content).digest("hex") };
}

export function readEvidenceReceipt(options) {
  const root = path.resolve(options.root);
  const runId = options.runId;
  if (!RUN_ID.test(runId)) throw new Error("invalid expected workflow run id");
  const directory = path.join(root, runId);
  const file = path.join(directory, "receipt.json");
  if (process.platform === "win32") {
    assertProtectedArtifact(root, "directory", "workflow evidence root is not private");
    assertProtectedArtifact(directory, "directory", "workflow evidence directory is not private");
  }
  assertProtectedArtifact(file, "file", "workflow receipt is not owner-only");
  let receipt;
  try { receipt = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error("workflow receipt is malformed"); }
  if (receipt?.runId !== runId) throw new Error("workflow receipt belongs to another run");
  if (options.taskDigest && receipt?.taskDigest !== options.taskDigest) throw new Error("workflow receipt belongs to another task");
  if (!DIGEST.test(receipt?.executionSha256 ?? "")) throw new Error("workflow receipt has no execution digest");
  const executionFile = path.join(directory, "execution.json");
  assertProtectedArtifact(executionFile, "file", "workflow execution evidence is not a private regular file");
  const executionContent = fs.readFileSync(executionFile);
  if (createHash("sha256").update(executionContent).digest("hex") !== receipt.executionSha256) throw new Error("workflow execution evidence digest mismatch");
  let execution;
  try { execution = JSON.parse(executionContent); }
  catch { throw new Error("workflow execution evidence is malformed"); }
  if (execution?.runId !== runId || execution?.taskDigest !== receipt.taskDigest) throw new Error("workflow execution evidence identity mismatch");
  return { receipt, execution, file, executionFile };
}
