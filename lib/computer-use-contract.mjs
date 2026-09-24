import { createHash, randomUUID } from "node:crypto";

export const COMPUTER_ACTIONS = Object.freeze(["screenshot", "inspect", "click", "type", "key", "scroll", "focus"]);
export const COMPUTER_CAPABILITY_STATES = Object.freeze(["UNAVAILABLE", "REQUIRES_APPROVAL", "AVAILABLE"]);
const actionFields = Object.freeze({
  screenshot: new Set(["sessionId", "action"]),
  inspect: new Set(["sessionId", "action", "elementId"]),
  click: new Set(["sessionId", "action", "frameDigest", "x", "y", "elementId"]),
  type: new Set(["sessionId", "action", "elementId", "text"]),
  key: new Set(["sessionId", "action", "elementId", "key"]),
  scroll: new Set(["sessionId", "action", "frameDigest", "deltaX", "deltaY", "elementId"]),
  focus: new Set(["sessionId", "action", "elementId"]),
});
const digestPattern = /^[0-9a-f]{64}$/u;
const idPattern = /^[A-Za-z0-9_.:-]{1,128}$/u;
const safeKeys = new Set(["Enter", "Escape", "Tab", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

export class ComputerUseError extends Error {
  constructor(code) { super(code); this.name = "ComputerUseError"; this.code = code; }
}
function fail(code) { throw new ComputerUseError(code); }
function digest(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function boundedId(value, code) { if (typeof value !== "string" || !idPattern.test(value)) fail(code); return value; }
function positiveInteger(value, maximum, code) { if (!Number.isSafeInteger(value) || value < 0 || value > maximum) fail(code); return value; }
function targetIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("COMPUTER_TARGET_INVALID");
  const target = {
    id: boundedId(value.id, "COMPUTER_TARGET_INVALID"),
    applicationId: boundedId(value.applicationId, "COMPUTER_TARGET_INVALID"),
    windowId: boundedId(value.windowId, "COMPUTER_TARGET_INVALID"),
    processId: positiveInteger(value.processId, 2 ** 31 - 1, "COMPUTER_TARGET_INVALID"),
    epoch: boundedId(value.epoch, "COMPUTER_TARGET_INVALID"),
    classification: value.classification,
    width: positiveInteger(value.width, 16384, "COMPUTER_TARGET_INVALID"),
    height: positiveInteger(value.height, 16384, "COMPUTER_TARGET_INVALID"),
  };
  if (target.processId === 0 || target.width === 0 || target.height === 0) fail("COMPUTER_TARGET_INVALID");
  if (target.classification !== "ORDINARY") fail("COMPUTER_SENSITIVE_TARGET_DENIED");
  return target;
}
function validateRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(actionFields, value.action)) fail("COMPUTER_ACTION_INVALID");
  if (Object.keys(value).some((key) => !actionFields[value.action].has(key))) fail("COMPUTER_ACTION_INVALID");
  boundedId(value.sessionId, "COMPUTER_SESSION_INVALID");
  if (value.elementId !== undefined) boundedId(value.elementId, "COMPUTER_ELEMENT_INVALID");
  if (value.action === "click") {
    if (!digestPattern.test(value.frameDigest ?? "")) fail("COMPUTER_FRAME_REQUIRED");
    positiveInteger(value.x, 16384, "COMPUTER_COORDINATE_INVALID");
    positiveInteger(value.y, 16384, "COMPUTER_COORDINATE_INVALID");
  }
  if (value.action === "scroll") {
    if (!digestPattern.test(value.frameDigest ?? "")) fail("COMPUTER_FRAME_REQUIRED");
    for (const amount of [value.deltaX, value.deltaY]) if (!Number.isSafeInteger(amount) || Math.abs(amount) > 2000) fail("COMPUTER_SCROLL_INVALID");
  }
  if (["type", "key", "focus"].includes(value.action) && value.elementId === undefined) fail("COMPUTER_ELEMENT_REQUIRED");
  if (value.action === "type" && (typeof value.text !== "string" || value.text.length === 0 || value.text.length > 1024 || /[\u0000-\u001f\u007f]/u.test(value.text))) fail("COMPUTER_TEXT_INVALID");
  if (value.action === "key" && !safeKeys.has(value.key)) fail("COMPUTER_KEY_DENIED");
  return Object.freeze({ ...value });
}

export function unavailableComputerBackend(platform) {
  if (!['linux', 'win32'].includes(platform)) fail("COMPUTER_PLATFORM_UNSUPPORTED");
  return Object.freeze({
    platform,
    capabilities: Object.freeze(Object.fromEntries(COMPUTER_ACTIONS.map((action) => [action, "UNAVAILABLE"]))),
    async resolveTarget() { fail("COMPUTER_BACKEND_UNAVAILABLE"); },
    async resolveElement() { fail("COMPUTER_BACKEND_UNAVAILABLE"); },
    async currentFrameDigest() { fail("COMPUTER_BACKEND_UNAVAILABLE"); },
    async perform() { fail("COMPUTER_BACKEND_UNAVAILABLE"); },
    async close() {},
  });
}

export class ComputerUseController {
  constructor({ backend, approve, now = Date.now, sessionTtlMs = 60_000, frameTtlMs = 5_000 }) {
    if (!backend || !['linux', 'win32'].includes(backend.platform) || !backend.capabilities || typeof backend.resolveTarget !== "function" || typeof backend.resolveElement !== "function" || typeof backend.currentFrameDigest !== "function" || typeof backend.perform !== "function" || typeof backend.close !== "function") fail("COMPUTER_BACKEND_INVALID");
    if (COMPUTER_ACTIONS.some((action) => !COMPUTER_CAPABILITY_STATES.includes(backend.capabilities[action]))) fail("COMPUTER_BACKEND_INVALID");
    if (typeof approve !== "function" || typeof now !== "function" || !Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 1000 || sessionTtlMs > 60_000 || !Number.isSafeInteger(frameTtlMs) || frameTtlMs < 100 || frameTtlMs > 5000) fail("COMPUTER_BROKER_INVALID");
    this.backend = backend;
    this.approve = approve;
    this.now = now;
    this.sessionTtlMs = sessionTtlMs;
    this.frameTtlMs = frameTtlMs;
    this.sessions = new Map();
  }

  capabilities() { return Object.freeze({ platform: this.backend.platform, ...this.backend.capabilities }); }

  async #bounded(call, session, timeoutMs) {
    if (session.abort.signal.aborted) fail("COMPUTER_ACTION_CANCELLED");
    const controller = new AbortController();
    const abort = () => controller.abort();
    session.abort.signal.addEventListener("abort", abort, { once: true });
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => call(controller.signal)),
        new Promise((_, reject) => {
          const onAbort = () => reject(new ComputerUseError("COMPUTER_ACTION_CANCELLED"));
          controller.signal.addEventListener("abort", onAbort, { once: true });
          timer = setTimeout(() => { reject(new ComputerUseError("COMPUTER_ACTION_TIMEOUT")); controller.abort(); }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      session.abort.signal.removeEventListener("abort", abort);
      controller.abort();
    }
  }

  async open(targetId) {
    boundedId(targetId, "COMPUTER_TARGET_INVALID");
    const target = targetIdentity(await this.backend.resolveTarget(targetId));
    if (target.id !== targetId) fail("COMPUTER_TARGET_CHANGED");
    const sessionId = randomUUID();
    this.sessions.set(sessionId, { target, openedAt: this.now(), frame: undefined, revoked: false, busy: false, abort: new AbortController() });
    return Object.freeze({ sessionId, platform: this.backend.platform, targetDigest: digest(target), expiresAt: this.now() + this.sessionTtlMs });
  }

  async execute(request) {
    const action = validateRequest(request);
    const session = this.sessions.get(action.sessionId);
    if (!session || session.revoked || this.now() - session.openedAt > this.sessionTtlMs) fail("COMPUTER_SESSION_EXPIRED");
    if (session.busy) fail("COMPUTER_SESSION_BUSY");
    if (this.backend.capabilities[action.action] === "UNAVAILABLE") fail("COMPUTER_CAPABILITY_UNAVAILABLE");
    session.busy = true;
    try {
      const sameTarget = (current) => digest(targetIdentity(current)) === digest(session.target);
      if (!sameTarget(await this.backend.resolveTarget(session.target.id))) fail("COMPUTER_TARGET_CHANGED");
      let element;
      if (action.elementId !== undefined) {
        element = await this.backend.resolveElement(session.target, action.elementId);
        if (!element || element.id !== action.elementId || element.targetId !== session.target.id || element.classification !== "ORDINARY" || !idPattern.test(element.epoch ?? "")) fail("COMPUTER_ELEMENT_UNSAFE");
      }
      if (["click", "scroll"].includes(action.action)) {
        if (!session.frame || action.frameDigest !== session.frame.digest || this.now() - session.frame.capturedAt > this.frameTtlMs) fail("COMPUTER_FRAME_STALE");
        if (action.action === "click" && (action.x >= session.target.width || action.y >= session.target.height)) fail("COMPUTER_COORDINATE_INVALID");
      }
      const actionDigest = digest({ sessionId: action.sessionId, target: session.target, element, action });
      const approvalExpiresAt = this.now() + 5000;
      const approvalRequest = Object.freeze({ platform: this.backend.platform, action: action.action, actionDigest, targetDigest: digest(session.target), expiresAt: approvalExpiresAt });
      const verdict = await this.#bounded((signal) => this.approve(approvalRequest, signal), session, 5000);
      if (verdict?.approved !== true || verdict.actionDigest !== actionDigest) fail("COMPUTER_APPROVAL_DENIED");
      if (this.now() > approvalExpiresAt || session.revoked || this.now() - session.openedAt > this.sessionTtlMs) fail("COMPUTER_SESSION_EXPIRED");
      if (!sameTarget(await this.backend.resolveTarget(session.target.id))) fail("COMPUTER_TARGET_CHANGED");
      if (element && digest(await this.backend.resolveElement(session.target, action.elementId)) !== digest(element)) fail("COMPUTER_ELEMENT_CHANGED");
      if (["click", "scroll"].includes(action.action) && (this.now() - session.frame.capturedAt > this.frameTtlMs || await this.backend.currentFrameDigest(session.target) !== session.frame.digest)) fail("COMPUTER_FRAME_STALE");
      const result = await this.#bounded((signal) => this.backend.perform(action, session.target, signal), session, 10000);
      if (session.revoked) fail("COMPUTER_SESSION_EXPIRED");
      if (action.action === "screenshot") {
        if (!digestPattern.test(result?.frameDigest ?? "") || !digestPattern.test(result?.artifactDigest ?? "") || result?.classification !== "REDACTED_SAFE") fail("COMPUTER_CAPTURE_UNSAFE");
        session.frame = { digest: result.frameDigest, capturedAt: this.now() };
      }
      if (action.action === "inspect" && (result?.classification !== "REDACTED_SAFE" || !digestPattern.test(result?.artifactDigest ?? ""))) fail("COMPUTER_INSPECTION_UNSAFE");
      return Object.freeze({ status: "PASS", action: action.action, platform: this.backend.platform, sessionId: action.sessionId, targetDigest: digest(session.target), actionDigest, frameDigest: action.action === "screenshot" ? result.frameDigest : undefined, artifactDigest: ["screenshot", "inspect"].includes(action.action) ? result.artifactDigest : undefined });
    } finally { session.busy = false; }
  }

  async revoke(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return Object.freeze({ status: "ALREADY_CLOSED" });
    session.revoked = true;
    session.abort.abort();
    this.sessions.delete(sessionId);
    await this.backend.close(session.target.id);
    return Object.freeze({ status: "REVOKED", sessionId });
  }
}
