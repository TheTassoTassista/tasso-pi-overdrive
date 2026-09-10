import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DIGEST = /^[0-9a-f]{64}$/u;
const ROLE = /^[a-z][a-z0-9-]{0,63}$/u;
const TERMINAL = new Set(["completed", "failed", "timed_out", "cancelled", "interrupted", "tool_budget_exhausted", "structured_output_failed", "acceptance_failed", "invalid_request", "unavailable_context", "duplicate_node", "transport_failed", "protocol_rejected"]);
const FAILURE_CATEGORY = new Set(["TRANSIENT", "DETERMINISTIC", "POLICY", "AUTH", "UNSUPPORTED_MODEL", "STRUCTURED_OUTPUT"]);

function privateDirectory(directory) {
  if (fs.existsSync(directory)) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("role receipt directory is not a real directory");
  } else {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  fs.chmodSync(directory, 0o700);
}

function syncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
  return value;
}

export function valueDigest(value) {
  return createHash("sha256").update(JSON.stringify(stableJson(value))).digest("hex");
}

function validateIdentity(receipt) {
  if (receipt?.version !== 1) throw new Error("role receipt version mismatch");
  if (!UUID.test(receipt.run_id ?? "")) throw new Error("role receipt run id is invalid");
  if (!DIGEST.test(receipt.task_id ?? "")) throw new Error("role receipt task id is invalid");
  if (!DIGEST.test(receipt.protocol_nonce ?? "")) throw new Error("role receipt protocol nonce is invalid");
  if (!UUID.test(receipt.execution_id ?? "")) throw new Error("role receipt execution id is invalid");
  if (!ROLE.test(receipt.role ?? "")) throw new Error("role receipt role is invalid");
  if (!Number.isSafeInteger(receipt.sequence) || receipt.sequence < 0) throw new Error("role receipt sequence is invalid");
  if (!Number.isSafeInteger(receipt.attempt) || receipt.attempt < 1) throw new Error("role receipt attempt is invalid");
  if (!Number.isSafeInteger(receipt.round) || receipt.round < 0) throw new Error("role receipt round is invalid");
  if (!Number.isSafeInteger(receipt.iteration) || receipt.iteration < 0) throw new Error("role receipt iteration is invalid");
  if (!TERMINAL.has(receipt.status)) throw new Error("role receipt status is not terminal");
  if (receipt.failure_category !== null && receipt.failure_category !== undefined && !FAILURE_CATEGORY.has(receipt.failure_category)) throw new Error("role receipt failure category is invalid");
  if (!DIGEST.test(receipt.result_digest ?? "") || !DIGEST.test(receipt.error_digest ?? "")) throw new Error("role receipt payload digests are invalid");
  if (receipt.launch_contract_digest !== null && receipt.launch_contract_digest !== undefined && !DIGEST.test(receipt.launch_contract_digest)) throw new Error("role receipt launch contract digest is invalid");
}

function receiptFilename(receipt) {
  return `${String(receipt.sequence).padStart(6, "0")}-${receipt.execution_id}.json`;
}

export function openRoleReceiptStore(run) {
  if (!run?.directory || !UUID.test(run.runId ?? "")) throw new Error("invalid workflow evidence run for role receipts");
  const directory = path.join(run.directory, "role-receipts");
  privateDirectory(directory);
  return { runId: run.runId, directory };
}

export function makeRoleReceipt(options) {
  const response = options.response ?? {};
  const claimedRole = typeof response.agent === "string" ? response.agent : options.role;
  const identityMatches = claimedRole === options.role && response.ownerRunId === options.ownerRunId && response.nodeId === options.nodeId;
  const status = identityMatches && TERMINAL.has(response.status) ? response.status : "protocol_rejected";
  const receipt = {
    version: 1,
    run_id: options.runId,
    task_id: options.taskId,
    protocol_nonce: options.protocolNonce,
    execution_id: options.executionId,
    sequence: options.sequence,
    role: options.role,
    round: options.round ?? 0,
    iteration: options.iteration ?? 0,
    attempt: options.attempt,
    node_id: options.nodeId,
    owner_run_id: options.ownerRunId,
    response_run_id: typeof response.runId === "string" ? response.runId : null,
    response_role: claimedRole,
    status,
    failure_category: status === "completed" ? null : (FAILURE_CATEGORY.has(response.failureCategory) ? response.failureCategory : "DETERMINISTIC"),
    exit_code: Number.isSafeInteger(response.exitCode) ? response.exitCode : null,
    model: typeof response.model === "string" ? response.model : null,
    thinking: typeof response.thinking === "string" ? response.thinking : null,
    launch_contract_digest: DIGEST.test(response.launchContractDigest ?? "") ? response.launchContractDigest : null,
    result_digest: valueDigest(response.result ?? null),
    error_digest: valueDigest(typeof response.error === "string" ? response.error : null),
    recorded_at: new Date().toISOString(),
  };
  validateIdentity(receipt);
  return receipt;
}

export function writeRoleReceipt(store, receipt) {
  validateIdentity(receipt);
  if (store.runId !== receipt.run_id || path.dirname(store.directory) === store.directory) throw new Error("role receipt store/run mismatch");
  privateDirectory(store.directory);
  const target = path.join(store.directory, receiptFilename(receipt));
  const content = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  const temporary = path.join(store.directory, `.receipt-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    try {
      fs.linkSync(temporary, target);
      fs.chmodSync(target, 0o400);
      syncDirectory(store.directory);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = fs.readFileSync(target);
      if (!existing.equals(content)) throw new Error("conflicting duplicate role receipt");
    }
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(temporary); } catch {}
    syncDirectory(store.directory);
  }
  return { file: target, sha256: createHash("sha256").update(content).digest("hex") };
}

export function readRoleReceipt(store, filename) {
  const target = path.resolve(store.directory, filename);
  if (path.dirname(target) !== store.directory) throw new Error("role receipt path escapes its store");
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("role receipt is not an owner-only regular file");
  const content = fs.readFileSync(target);
  let receipt;
  try { receipt = JSON.parse(content); } catch { throw new Error("role receipt is malformed"); }
  validateIdentity(receipt);
  if (receipt.run_id !== store.runId || receiptFilename(receipt) !== path.basename(target)) throw new Error("role receipt filename/identity mismatch");
  return { receipt, file: target, sha256: createHash("sha256").update(content).digest("hex") };
}

export function admitRoleReceipt(store, reference, expected, admittedExecutionIds = new Set()) {
  const loaded = readRoleReceipt(store, path.basename(reference.file));
  const receipt = loaded.receipt;
  for (const [field, value] of Object.entries(expected)) {
    if (receipt[field] !== value) throw new Error(`role receipt ${field} mismatch`);
  }
  if (receipt.status !== "completed") throw new Error(`role receipt is not completed: ${receipt.status}`);
  if (admittedExecutionIds.has(receipt.execution_id)) throw new Error("role receipt was already admitted");
  admittedExecutionIds.add(receipt.execution_id);
  return { ...loaded, executionId: receipt.execution_id, sequence: receipt.sequence };
}

export function listRoleReceipts(store) {
  if (!fs.existsSync(store.directory)) return [];
  return fs.readdirSync(store.directory).filter((name) => /^\d{6}-[0-9a-f-]{36}\.json$/iu.test(name)).sort().map((name) => readRoleReceipt(store, name));
}
