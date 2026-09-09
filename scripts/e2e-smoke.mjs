#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateWorkflowEvidence } from "../lib/e2e-evidence.mjs";
import { createEvidenceRun, initialWorkflowJournal, openEvidenceRun, readEvidenceReceipt, readWorkflowJournal, recoverInterruptedWorkflowRuns, taskDigest, writeWorkflowJournal } from "../lib/workflow-evidence.mjs";
import { runEnforcedWorkflow } from "../lib/workflow-state.mjs";
import { admitRoleReceipt, listRoleReceipts, openRoleReceiptStore } from "../lib/workflow-receipts.mjs";

const pi = process.env.PI_BIN || "pi";
const model = process.env.PI_SMOKE_MODEL || "openai-codex/gpt-5.6-luna";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-e2e-"));
const repo = path.join(root, "repo");
const runtimeRoot = path.join(root, "runtime");
const worktreeRoot = path.join(root, "worktrees");
const traceRoot = path.join(root, "state", "pi-overdrive", "traces");
const evidenceRoot = process.env.PI_OVERDRIVE_E2E_EVIDENCE_ROOT
  ? path.resolve(process.env.PI_OVERDRIVE_E2E_EVIDENCE_ROOT)
  : path.join(os.homedir(), ".local", "state", "pi-overdrive", "e2e-evidence");
const evidenceRunId = randomUUID();
const workflowTask = "Repair discountedTotal so it applies an integer discountPercent from 0 through 100, rounds the result to the nearest cent, and throws RangeError for a non-integer or out-of-range percentage. Items are already validated trusted domain objects with safe-integer cents and quantity; preserving that existing item contract and not adding item validation are explicit scope constraints. The repository also contains a hidden machine-readable review blocker referencing an unsafe helper; do not search for or change that blocker during the initial implementation. If the enforced post-implementation review reports it as BLOCKING, the correction Worker must use safe_remove_file to delete both the unsafe helper and the blocker. Security acceptance requires that no dynamic code evaluation remains. Reviewers must evaluate these stated acceptance criteria and must not block on requirements explicitly outside scope. Run every required stage, include Oracle and Security review, and trust only the tool's structured final state.";
const startedAt = Date.now();
const results = [];
let negativeControl;
let reviewerFailureControl;
let interruptionControl;
let malformedJournalControl;

function check(name, condition, detail) {
  results.push({ name, status: condition ? "PASS" : "FAIL", detail: typeof detail === "string" ? detail.slice(0, 1000) : detail });
}

function run(command, args, cwd = repo, allowFailure = false) {
  try {
    return { status: 0, stdout: execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(), stderr: "" };
  } catch (error) {
    if (!allowFailure) throw error;
    return { status: error.status ?? 1, stdout: String(error.stdout ?? "").trim(), stderr: String(error.stderr ?? error.message).trim() };
  }
}

function findFiles(directory, name) {
  const found = [];
  if (!fs.existsSync(directory)) return found;
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile() && entry.name === name) found.push(file);
    }
  }
  return found;
}

async function runNegativeControllerControl() {
  let identity = 0;
  const ownerRunId = "negative-control-owner";
  const delegate = async ({ agent, result }) => {
    const response = { status: "completed", agent, model: "negative-control-model", runId: `negative-run-${identity}`, nodeId: `negative-node-${identity++}`, ownerRunId };
    if (result.kind === "structured") return { ...response, result: { kind: "structured", value: { verdict: "PASS", summary: "control", findings: [] } } };
    return { ...response, result: { kind: "text", text: "control" } };
  };
  const allocation = { worktree: repo, port: 39999, stateDir: path.join(root, "negative-state"), browserProfile: path.join(root, "negative-browser"), browserSession: "negative-session", database: "negative_db", schema: "negative_schema" };
  const state = await runEnforcedWorkflow({
    task: "Intentional negative control: verification must remain failing.",
    allocation,
    delegate,
    verify: async () => ({ status: "FAIL", processExitCode: 7, results: [{ name: "intentional-failure", status: "FAIL", exitCode: 7, sandboxed: true }] }),
    ownerRunId,
  });
  return {
    status: state.status,
    roundCount: state.evidence.verifications.length,
    workerRuns: state.evidence.roles.filter((entry) => entry.agent === "worker").length,
    finalTransition: state.evidence.transitions.at(-1),
  };
}

async function runReviewerFailureControl() {
  let identity = 0;
  const ownerRunId = "missing-reviewer-control-owner";
  const delegate = async ({ agent, result }) => {
    if (agent === "security-reviewer") return { status: "failed", agent };
    const response = { status: "completed", agent, model: "negative-control-model", runId: `missing-review-run-${identity}`, nodeId: `missing-review-node-${identity++}`, ownerRunId };
    return result.kind === "structured"
      ? { ...response, result: { kind: "structured", value: { verdict: "PASS", summary: "control", findings: [] } } }
      : { ...response, result: { kind: "text", text: "control" } };
  };
  const allocation = { worktree: repo, port: 39998, stateDir: path.join(root, "missing-review-state"), browserProfile: path.join(root, "missing-review-browser"), browserSession: "missing-review-session", database: "missing_review_db", schema: "missing_review_schema" };
  try {
    await runEnforcedWorkflow({ task: "Intentional negative control: a mandatory reviewer is absent.", allocation, delegate, verify: async () => ({ status: "PASS", processExitCode: 0 }), ownerRunId });
    return { status: "UNEXPECTED_PASS" };
  } catch (error) {
    return { status: error.workflowState?.status, finalTransition: error.workflowState?.evidence?.transitions?.at(-1), failedReviewer: error.workflowState?.evidence?.roles?.some((entry) => entry.agent === "security-reviewer" && entry.status === "failed") === true };
  }
}

function runInterruptionControl() {
  const controlRoot = path.join(root, "interruption-evidence");
  const controlRunId = randomUUID();
  const controlDigest = taskDigest("simulated interruption fixture");
  const childScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../tests/fixtures/workflow-interrupt-child.mjs");
  const child = spawnSync(process.execPath, [childScript], { encoding: "utf8", env: { ...process.env, PI_TEST_EVIDENCE_ROOT: controlRoot, PI_TEST_RUN_ID: controlRunId, PI_TEST_TASK_DIGEST: controlDigest } });
  const recovery = recoverInterruptedWorkflowRuns({ root: controlRoot });
  const journal = readWorkflowJournal(openEvidenceRun({ root: controlRoot, runId: controlRunId }));
  let receiptRejected = false;
  try { readEvidenceReceipt({ root: controlRoot, runId: controlRunId, taskDigest: controlDigest }); } catch { receiptRejected = true; }
  return { signal: child.signal, status: journal.status, phase: journal.current_phase, receiptRejected, recovered: recovery.recovered.length };
}

function runMalformedJournalControl() {
  const controlRoot = path.join(root, "malformed-journal-evidence");
  const run = createEvidenceRun({ root: controlRoot });
  const digest = taskDigest("malformed journal fixture");
  writeWorkflowJournal(run, initialWorkflowJournal(run, { taskDigest: digest, workflowVersion: 4, sourceRepository: repo, ownerRunId: "malformed-journal-owner" }));
  fs.writeFileSync(run.stateFile, '{"run_id":');
  fs.chmodSync(run.stateFile, 0o600);
  const recovery = recoverInterruptedWorkflowRuns({ root: controlRoot });
  const recovered = readWorkflowJournal(run);
  return { status: recovered.status, evidenceStatus: recovered.evidence_status, preserved: fs.readdirSync(run.directory).some((name) => name.startsWith("state.corrupt-")), inconsistent: recovery.inconsistent.length };
}

async function runPiWorkflow() {
  const child = spawn(pi, ["--offline", "--approve", "--no-session", "--mode", "rpc", "--model", model, "--thinking", "low", "--tools", "secure_coding_workflow"], {
    cwd: repo,
    env: {
      ...process.env,
      PI_OVERDRIVE_RUNTIME_ROOT: runtimeRoot,
      PI_OVERDRIVE_WORKTREE_ROOT: worktreeRoot,
      PI_OVERDRIVE_EVIDENCE_ROOT: evidenceRoot,
      PI_OVERDRIVE_EVIDENCE_RUN_ID: evidenceRunId,
      PI_OVERDRIVE_CLEANUP_WORKFLOW: "1",
      XDG_STATE_HOME: path.join(root, "state"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events = [];
  let buffer = "";
  let stderr = "";
  const waiters = new Set();
  const receive = (event) => {
    events.push(event);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(event)) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.resolve(event);
      }
    }
  };
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/u, "");
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try { receive(JSON.parse(line)); } catch { receive({ type: "invalid_json", line: line.slice(0, 300) }); }
    }
  });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-12000); });
  const waitFor = (predicate, label, timeoutMs) => {
    const prior = events.find(predicate);
    if (prior) return Promise.resolve(prior);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: setTimeout(() => { waiters.delete(waiter); reject(new Error(`Timed out waiting for ${label}. ${stderr}`)); }, timeoutMs) };
      waiters.add(waiter);
    });
  };
  const prompt = [
    "Call secure_coding_workflow exactly once with exactly this JSON input:",
    JSON.stringify({ task: workflowTask, includeOracle: true, includeSecurity: true }),
    "Do not call any other tool. After the tool finishes, answer with only its final status.",
  ].join("\n");
  child.stdin.write(`${JSON.stringify({ id: "workflow", type: "prompt", message: prompt })}\n`);
  const accepted = await waitFor((event) => event.type === "response" && event.id === "workflow", "prompt acceptance", 30000);
  const settled = await waitFor((event) => event.type === "agent_settled", "workflow settlement", 45 * 60 * 1000);
  child.stdin.end();
  await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGTERM"); resolve(); }, 5000);
    child.once("close", () => { clearTimeout(timer); resolve(); });
  });
  return { accepted, settled, events, stderr };
}

function workflowToolSummary(invocation) {
  const event = invocation?.events?.findLast?.((item) => item.type === "tool_execution_end" && item.toolName === "secure_coding_workflow");
  if (!event) return { present: false };
  const details = event.result?.details;
  const text = (event.result?.content ?? []).filter((item) => item?.type === "text").map((item) => item.text).join("\n");
  let parsed;
  try { parsed = JSON.parse(text); } catch {}
  return {
    present: true,
    isError: event.isError === true,
    status: details?.status ?? parsed?.status,
    error: typeof (details?.error ?? parsed?.error) === "string" ? (details?.error ?? parsed?.error).slice(0, 1000) : text.slice(0, 1000),
  };
}

try {
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.mkdirSync(path.join(repo, "test"), { recursive: true });
  fs.writeFileSync(path.join(repo, "package.json"), `${JSON.stringify({ name: "pi-overdrive-e2e", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`);
  fs.writeFileSync(path.join(repo, "src", "cart.mjs"), "export function discountedTotal(items, discountPercent) {\n  const subtotal = items.reduce((sum, item) => sum + item.cents * item.quantity, 0);\n  return subtotal - discountPercent;\n}\n");
  fs.writeFileSync(path.join(repo, "src", "unsafe-helper.mjs"), "export function decodeRule(text) { return eval(text); }\n");
  fs.writeFileSync(path.join(repo, ".pi-overdrive-review-blocker.json"), `${JSON.stringify({ version: 1, file: "src/unsafe-helper.mjs", pattern: "eval(" })}\n`);
  fs.writeFileSync(path.join(repo, "test", "cart.test.mjs"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { discountedTotal } from '../src/cart.mjs';\nconst basket = [{ cents: 999, quantity: 1 }];\ntest('applies and rounds a percentage discount', () => { assert.equal(discountedTotal(basket, 15), 849); });\ntest('accepts boundary discounts', () => { assert.equal(discountedTotal(basket, 0), 999); assert.equal(discountedTotal(basket, 100), 0); });\ntest('rejects percentages outside the contract', () => { assert.throws(() => discountedTotal(basket, -1), RangeError); assert.throws(() => discountedTotal(basket, 101), RangeError); assert.throws(() => discountedTotal(basket, 10.5), RangeError); });\n");
  run("git", ["init", "-q"]);
  run("git", ["config", "user.name", "Pi E2E Smoke"]);
  run("git", ["config", "user.email", "pi-e2e@invalid"]);
  run("git", ["add", "."]);
  run("git", ["commit", "-qm", "planted defects"]);
  const before = run("npm", ["test"], repo, true);
  check("planted-test-fails-before", before.status !== 0, { exitCode: before.status });
  negativeControl = await runNegativeControllerControl();
  check("intentional-negative-control-fails-closed", negativeControl.status === "FAIL" && negativeControl.roundCount === 3 && negativeControl.workerRuns === 3 && negativeControl.finalTransition?.status === "FAIL", negativeControl);
  check("negative-control-worker-does-not-fix", negativeControl.status === "FAIL", negativeControl);
  check("negative-control-verification-fails", negativeControl.status === "FAIL" && negativeControl.finalTransition?.status === "FAIL", negativeControl);
  reviewerFailureControl = await runReviewerFailureControl();
  check("negative-control-required-reviewer-missing", reviewerFailureControl.status === "FAIL" && reviewerFailureControl.failedReviewer === true && reviewerFailureControl.finalTransition?.status === "FAIL", reviewerFailureControl);
  interruptionControl = runInterruptionControl();
  check("negative-control-interrupted-before-finalization", interruptionControl.signal === "SIGKILL" && interruptionControl.status === "INTERRUPTED" && interruptionControl.receiptRejected === true && interruptionControl.recovered === 1, interruptionControl);
  malformedJournalControl = runMalformedJournalControl();
  check("negative-control-malformed-journal-fails-closed", malformedJournalControl.status === "INCONSISTENT" && malformedJournalControl.evidenceStatus === "INVALID" && malformedJournalControl.preserved && malformedJournalControl.inconsistent === 1, malformedJournalControl);

  let invocation;
  try {
    invocation = await runPiWorkflow();
    check("pi-rpc-prompt-accepted", invocation.accepted.success === true, { success: invocation.accepted.success });
    const tool = workflowToolSummary(invocation);
    check("workflow-tool-runtime-status", tool.present && !tool.isError && tool.status === "PASS", tool);
  } catch (error) {
    check("pi-integrated-workflow", false, error.message);
  }

  let loaded;
  try {
    loaded = readEvidenceReceipt({ root: evidenceRoot, runId: evidenceRunId, taskDigest: taskDigest(workflowTask) });
  } catch (error) {
    check("run-specific-structured-workflow-receipt", false, { error: error.message, tool: workflowToolSummary(invocation) });
  }
  if (loaded) {
    const { file: receiptFile, executionFile, execution, receipt } = loaded;
    check("run-specific-structured-workflow-receipt", true, { runId: receipt.runId, taskDigest: receipt.taskDigest });
    check("receipt-owner-only", (fs.statSync(receiptFile).mode & 0o077) === 0, { mode: (fs.statSync(receiptFile).mode & 0o777).toString(8) });
    check("pre-cleanup-execution-snapshot-private", execution.status === receipt.status && (fs.statSync(executionFile).mode & 0o077) === 0, { executionFile, status: execution.status });
    const validation = validateWorkflowEvidence(receipt, { requireCorrection: true, requireCleanup: true });
    check("structured-workflow-evidence", validation.valid, validation.errors);
    const evidenceRun = openEvidenceRun({ root: evidenceRoot, runId: evidenceRunId });
    const roleStore = openRoleReceiptStore(evidenceRun);
    const durableRoleReceipts = listRoleReceipts(roleStore);
    const admittedReceipts = receipt.evidence?.receipts ?? [];
    const completedRoles = receipt.evidence?.roles?.filter((entry) => entry.status === "completed") ?? [];
    check("role-receipts-durable-private-and-unique", admittedReceipts.length === completedRoles.length && new Set(admittedReceipts.map((entry) => entry.executionId)).size === admittedReceipts.length && admittedReceipts.every((entry) => durableRoleReceipts.some((loadedReceipt) => loadedReceipt.receipt.execution_id === entry.executionId && loadedReceipt.sha256 === entry.sha256)), { admitted: admittedReceipts.length, durable: durableRoleReceipts.length });
    const scoutReceipt = durableRoleReceipts.find((entry) => entry.receipt.role === "scout" && entry.receipt.status === "completed");
    check("scout-receipt-valid", Boolean(scoutReceipt) && scoutReceipt.receipt.run_id === receipt.runId && scoutReceipt.receipt.task_id === receipt.taskDigest, scoutReceipt ? { executionId: scoutReceipt.receipt.execution_id, sequence: scoutReceipt.receipt.sequence } : "missing");
    const scoutCompleteIndex = receipt.evidence?.transitions?.findIndex((entry) => entry.state === "SCOUT" && entry.phase === "complete") ?? -1;
    const plannerStartIndex = receipt.evidence?.transitions?.findIndex((entry) => entry.state === "PLANNER" && entry.phase === "start") ?? -1;
    check("planner-admitted-after-scout-durable-completion", scoutCompleteIndex >= 0 && plannerStartIndex === scoutCompleteIndex + 1 && completedRoles.some((entry) => entry.agent === "planner" && entry.receipt), { scoutCompleteIndex, plannerStartIndex });
    const worktree = receipt.allocation?.worktree;
    const allocationRoot = path.dirname(receipt.allocation?.stateDir ?? "");
    check("isolated-worktree-was-distinct", typeof worktree === "string" && path.resolve(worktree) !== path.resolve(repo), worktree);
    check("disposable-worktree-cleaned-before-proof", typeof worktree === "string" && !fs.existsSync(worktree), worktree);
    check("disposable-runtime-cleaned-before-proof", allocationRoot !== "." && !fs.existsSync(allocationRoot) && !fs.existsSync(receipt.allocation?.portReservation ?? ""), allocationRoot);
    check("evidence-survives-runtime-cleanup", fs.existsSync(receiptFile), receiptFile);
    const changed = receipt.repositoryEvidence?.changedFiles ?? [];
    const cart = changed.find((entry) => entry.path === "src/cart.mjs");
    const initialCartHash = createHash("sha256").update(fs.readFileSync(path.join(repo, "src", "cart.mjs"))).digest("hex");
    check("worker-modified-code", cart?.status === "FILE" && cart.sha256 !== initialCartHash, cart);
    const unsafe = changed.find((entry) => entry.path === "src/unsafe-helper.mjs");
    const blocker = changed.find((entry) => entry.path === ".pi-overdrive-review-blocker.json");
    check("blocking-security-defect-corrected", ["DELETED", "FILE"].includes(unsafe?.status) && (unsafe.status === "DELETED" || unsafe.size === 0) && ["DELETED", "FILE"].includes(blocker?.status) && (blocker.status === "DELETED" || blocker.size === 0), { unsafe, blocker });
    const finalVerification = receipt.evidence?.verifications?.at(-1);
    check("tests-pass-after", finalVerification?.status === "PASS" && finalVerification?.processExitCode === 0 && finalVerification?.results?.some((entry) => entry.status === "PASS" && entry.exitCode === 0 && entry.sandboxed === true), finalVerification);
    check("diff-check", receipt.repositoryEvidence?.diffCheckExitCode === 0, receipt.repositoryEvidence);

    const falsePass = structuredClone(receipt);
    const falsePassVerification = falsePass.evidence?.verifications?.at(-1);
    if (falsePassVerification) falsePassVerification.processExitCode = 9;
    check("negative-control-verification-exit", Boolean(falsePassVerification) && !validateWorkflowEvidence(falsePass, { requireCorrection: true, requireCleanup: true }).valid, falsePassVerification ? "non-zero PASS rejected" : "workflow receipt had no verification evidence");
    const missingRole = structuredClone(receipt);
    const hadScout = missingRole.evidence?.roles?.some((entry) => entry.agent === "scout") === true;
    if (missingRole.evidence?.roles) missingRole.evidence.roles = missingRole.evidence.roles.filter((entry) => entry.agent !== "scout");
    check("negative-control-missing-role", hadScout && !validateWorkflowEvidence(missingRole, { requireCorrection: true, requireCleanup: true }).valid, hadScout ? "missing role rejected" : "workflow receipt had no Scout evidence");
    const missingScoutReceipt = structuredClone(receipt);
    const hadScoutReceipt = missingScoutReceipt.evidence?.receipts?.some((entry) => entry.agent === "scout") === true;
    if (missingScoutReceipt.evidence?.receipts) missingScoutReceipt.evidence.receipts = missingScoutReceipt.evidence.receipts.filter((entry) => entry.agent !== "scout");
    check("negative-control-missing-scout-receipt", hadScoutReceipt && !validateWorkflowEvidence(missingScoutReceipt, { requireCorrection: true, requireCleanup: true }).valid, hadScoutReceipt ? "missing Scout receipt rejected" : "workflow receipt had no Scout receipt");
    const plannerReceipt = durableRoleReceipts.find((entry) => entry.receipt.role === "planner" && entry.receipt.status === "completed");
    let wrongPlannerRunRejected = false;
    if (plannerReceipt) {
      const value = plannerReceipt.receipt;
      try {
        admitRoleReceipt(roleStore, { file: plannerReceipt.file }, { run_id: randomUUID(), task_id: value.task_id, protocol_nonce: value.protocol_nonce, execution_id: value.execution_id, sequence: value.sequence, role: value.role, round: value.round, iteration: value.iteration, owner_run_id: value.owner_run_id, node_id: value.node_id, status: "completed" }, new Set());
      } catch { wrongPlannerRunRejected = true; }
    }
    check("negative-control-planner-receipt-wrong-run", wrongPlannerRunRejected, plannerReceipt ? "cross-run Planner receipt rejected" : "Planner receipt missing");
    const missingReviewer = structuredClone(receipt);
    const hadSecurityReviewer = missingReviewer.evidence?.roles?.some((entry) => entry.agent === "security-reviewer") === true;
    if (missingReviewer.evidence?.roles) missingReviewer.evidence.roles = missingReviewer.evidence.roles.filter((entry) => entry.agent !== "security-reviewer");
    check("negative-control-missing-reviewer-evidence", hadSecurityReviewer && !validateWorkflowEvidence(missingReviewer, { requireCorrection: true, requireCleanup: true }).valid, hadSecurityReviewer ? "missing mandatory reviewer rejected" : "workflow receipt had no security reviewer evidence");
    const missingCorrection = structuredClone(receipt);
    const hadCorrection = missingCorrection.evidence?.transitions?.some((entry) => entry.state === "CORRECTION_REQUIRED") === true;
    if (missingCorrection.evidence?.transitions) missingCorrection.evidence.transitions = missingCorrection.evidence.transitions.filter((entry) => entry.state !== "CORRECTION_REQUIRED");
    check("negative-control-review-loop", hadCorrection && !validateWorkflowEvidence(missingCorrection, { requireCorrection: true, requireCleanup: true }).valid, hadCorrection ? "missing correction rejected" : "workflow receipt had no correction evidence");

    const otherRunId = randomUUID();
    const otherDirectory = path.join(evidenceRoot, otherRunId);
    fs.mkdirSync(otherDirectory, { mode: 0o700 });
    fs.copyFileSync(receiptFile, path.join(otherDirectory, "receipt.json"));
    fs.chmodSync(path.join(otherDirectory, "receipt.json"), 0o400);
    let wrongRunRejected = false;
    try { readEvidenceReceipt({ root: evidenceRoot, runId: otherRunId, taskDigest: taskDigest(workflowTask) }); } catch { wrongRunRejected = true; }
    check("negative-control-other-run-evidence", wrongRunRejected, "receipt run identity mismatch rejected");
    let staleTaskRejected = false;
    try { readEvidenceReceipt({ root: evidenceRoot, runId: evidenceRunId, taskDigest: taskDigest("stale task") }); } catch { staleTaskRejected = true; }
    check("negative-control-stale-evidence", staleTaskRejected, "receipt from a stale task identity rejected");
    let missingRejected = false;
    try { readEvidenceReceipt({ root: evidenceRoot, runId: randomUUID(), taskDigest: taskDigest(workflowTask) }); } catch { missingRejected = true; }
    check("negative-control-missing-evidence", missingRejected, "missing receipt rejected");
    const malformedRunId = randomUUID();
    const malformedDirectory = path.join(evidenceRoot, malformedRunId);
    fs.mkdirSync(malformedDirectory, { mode: 0o700 });
    fs.writeFileSync(path.join(malformedDirectory, "receipt.json"), "not-json\n", { mode: 0o400 });
    let malformedRejected = false;
    try { readEvidenceReceipt({ root: evidenceRoot, runId: malformedRunId }); } catch { malformedRejected = true; }
    check("negative-control-malformed-evidence", malformedRejected, "malformed receipt rejected");
  }

  const traces = findFiles(traceRoot, "metadata.jsonl").concat(fs.existsSync(traceRoot) ? fs.readdirSync(traceRoot).filter((name) => name.endsWith(".jsonl")).map((name) => path.join(traceRoot, name)) : []);
  const freshTraces = [...new Set(traces)].filter((file) => fs.statSync(file).mtimeMs >= startedAt - 1000);
  const traceText = freshTraces.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  check("metadata-trace-created", freshTraces.length > 0 && /"event":"tool_start"/u.test(traceText), { files: freshTraces.length });
  check("metadata-trace-private", freshTraces.every((file) => (fs.statSync(file).mode & 0o077) === 0), "mode 600");
  check("metadata-trace-value-free", !/"(?:prompt|args|output|url|command|content|text)"\s*:/iu.test(traceText), "no value-bearing fields");
} finally {
  if (!process.env.PI_OVERDRIVE_KEEP_E2E) fs.rmSync(root, { recursive: true, force: true });
}

check("temporary-repository-removed", !process.env.PI_OVERDRIVE_KEEP_E2E && !fs.existsSync(root), root);
const status = results.length >= 24 && results.every((item) => item.status === "PASS") ? "PASS" : "FAIL";
let finalVerdict;
try { finalVerdict = readEvidenceReceipt({ root: evidenceRoot, runId: evidenceRunId, taskDigest: taskDigest(workflowTask) }).receipt.finalVerdict; } catch {}
process.stdout.write(`${JSON.stringify({ status, model, evidenceRoot, negativeControl, reviewerFailureControl, interruptionControl, malformedJournalControl, finalVerdict, results }, null, 2)}\n`);
process.exit(status === "PASS" ? 0 : 1);
