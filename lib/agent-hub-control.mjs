import { createHash } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CANCELLABLE_ROLES = new Set(["worker", "tester"]);
const MAX_ATTEMPTS = 42;

function validId(value) {
  return typeof value === "string" && UUID.test(value);
}

function result(code, entry, stateAfter = entry?.state ?? null) {
  return Object.freeze({
    code,
    role: entry?.role ?? null,
    sequence: entry?.sequence ?? null,
    stateBefore: entry?.state ?? null,
    stateAfter,
    attemptDigest: entry ? createHash("sha256").update(entry.executionId).digest("hex") : null,
  });
}

/** Controller-owned, session-scoped attempt state. It cannot spawn or mutate a role. */
export class AgentAttemptController {
  constructor({ sessionId, runId, taskDigest }) {
    if (typeof sessionId !== "string" || !sessionId || !validId(runId) || !/^[0-9a-f]{64}$/u.test(taskDigest)) throw new Error("AGENT_CONTROL_IDENTITY_INVALID");
    this.sessionId = sessionId;
    this.runId = runId;
    this.taskDigest = taskDigest;
    this.attempts = new Map();
    this.requests = new Set();
    this.closed = false;
  }

  reserve({ executionId, role, sequence, attempt, cancel }) {
    if (this.closed || !validId(executionId) || typeof role !== "string" || !Number.isSafeInteger(sequence) || sequence < 0 || sequence >= MAX_ATTEMPTS || ![1, 2].includes(attempt) || typeof cancel !== "function") throw new Error("AGENT_CONTROL_RESERVATION_INVALID");
    if (this.attempts.has(executionId) || this.attempts.size >= MAX_ATTEMPTS) throw new Error("AGENT_CONTROL_DUPLICATE_OR_CAPACITY");
    this.attempts.set(executionId, { executionId, role, sequence, attempt, state: "RESERVED", version: 0, cancel, terminalStatus: null });
  }

  started(executionId) {
    const entry = this.attempts.get(executionId);
    if (!entry || entry.state !== "RESERVED") return false;
    entry.state = "RUNNING";
    entry.version = 1;
    return true;
  }

  terminal(executionId, status) {
    const entry = this.attempts.get(executionId);
    if (!entry || entry.state === "TERMINAL") return false;
    entry.state = "TERMINAL";
    entry.version += 1;
    entry.terminalStatus = status;
    entry.cancel = null;
    return true;
  }

  identity(executionId) {
    const entry = this.attempts.get(executionId);
    if (!entry) return null;
    return Object.freeze({ runId: this.runId, taskDigest: this.taskDigest, executionId, role: entry.role, sequence: entry.sequence, attempt: entry.attempt, expectedState: "RUNNING", expectedVersion: 1 });
  }

  state(executionId) {
    return this.attempts.get(executionId)?.state ?? null;
  }

  cancel(input) {
    if (!input || !validId(input.requestId) || !validId(input.executionId)) return result("MALFORMED_REQUEST");
    if (this.requests.has(input.requestId)) return result("REPLAY_DENIED", this.attempts.get(input.executionId));
    if (this.requests.size >= 256) return result("CONTROL_REQUEST_CAPACITY_EXHAUSTED");
    this.requests.add(input.requestId);
    if (this.closed) return result("SESSION_CLOSED");
    if (input.sessionId !== this.sessionId) return result("WRONG_SESSION");
    const entry = this.attempts.get(input.executionId);
    if (!entry) return result("UNKNOWN_ATTEMPT");
    if (input.runId !== this.runId || input.taskDigest !== this.taskDigest || input.role !== entry.role || input.sequence !== entry.sequence || input.attempt !== entry.attempt) return result("IDENTITY_MISMATCH", entry);
    if (!CANCELLABLE_ROLES.has(entry.role)) return result("POLICY_DENIED", entry);
    if (entry.state !== "RUNNING" || input.expectedState !== "RUNNING" || input.expectedVersion !== entry.version) return result("STALE_STATE", entry);
    const accepted = result("CANCEL_REQUESTED", entry, "CANCEL_REQUESTED");
    entry.state = "CANCEL_REQUESTED";
    entry.version += 1;
    try { entry.cancel(); }
    catch { return result("DISPATCH_UNCERTAIN", entry); }
    return accepted;
  }

  close() {
    this.closed = true;
    for (const entry of this.attempts.values()) entry.cancel = null;
  }
}

/** The CLI adapter supplies only an exact attempt ID; the controller supplies all authority-bearing identity fields. */
export function requestExactUserCancellation(controller, { sessionId, executionId, requestId }) {
  const identity = controller?.identity(executionId);
  return controller.cancel({ requestId, sessionId, ...(identity ?? { executionId }) });
}
