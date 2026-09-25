import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { containsSecret } from "./memory-security.mjs";
import { validateTaskPolicy } from "./task-governor.mjs";

export const WATCHDOG_VERSION = 1;
export const WATCHDOG_EVENT = "pi-overdrive:watchdog-observation";
export const WATCHDOG_ADVICE_EVENT = "pi-overdrive:watchdog-advice";
export const WATCHDOG_METADATA_EVENT = "pi-overdrive:watchdog-metadata";
export const WATCHDOG_MESSAGE_TYPE = "tasso-pi-overdrive.watchdog-advice";
export const WATCHDOG_AUTHORITY = Object.freeze({ tools: 0, modelCalls: 0, mutations: false, routingChanges: false, spawns: false, councilAccess: false });
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIGEST = /^[0-9a-f]{64}$/u;
const PHASE = /^[A-Z][A-Z0-9_]{0,47}$/u;
const SEVERITIES = new Set(["NIT", "CONCERN", "BLOCKER"]);
const OBSERVATION_KEYS = Object.freeze(["version", "kind", "runDigest", "taskPolicyDigest", "difficulty", "risk", "preset", "directSmallEdit", "phase", "round", "verificationStatus", "finalVerificationStatus", "failedRoleCount", "verificationFailureCount", "correctionCount", "blockingFindingsCount"]);
const ADVICE_KEYS = Object.freeze(["version", "severity", "finding", "evidence", "recommendation", "stateDigest"]);

function hash(value) { return createHash("sha256").update(String(value)).digest("hex"); }
function exact(value, keys) { return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function finiteCount(value, maximum = 1000) { return Number.isSafeInteger(value) && value >= 0 && value <= maximum; }
function boundedText(value, maximum) { return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value) && !containsSecret(value); }

export function validateWatchdogPolicy(value) {
  const keys = ["version", "enabledByDefault", "maxReviewsPerTask", "tokenSaverMaxReviews", "cooldownMs", "failureThreshold", "tokenSaverFailureThreshold", "maxDeltaChars", "maxAdviceChars"];
  if (!exact(value, keys) || value.version !== WATCHDOG_VERSION || value.enabledByDefault !== false || value.maxReviewsPerTask !== 2 || value.tokenSaverMaxReviews !== 1 || value.cooldownMs !== 30_000 || value.failureThreshold !== 2 || value.tokenSaverFailureThreshold !== 3 || value.maxDeltaChars !== 768 || value.maxAdviceChars !== 600) throw new Error("WATCHDOG_POLICY_INVALID");
  return Object.freeze(structuredClone(value));
}

export function readWatchdogPolicy(file = path.join(ROOT, "config", "watchdog.json")) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    if (!fs.fstatSync(descriptor).isFile()) throw new Error("WATCHDOG_POLICY_UNAVAILABLE");
    return validateWatchdogPolicy(JSON.parse(fs.readFileSync(descriptor, "utf8")));
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

/** Extract only aggregate controller-owned metadata; never transcript, paths or Council results. */
export function watchdogObservationFromWorkflow(state, taskPolicy, runId) {
  const task = validateTaskPolicy(taskPolicy);
  if (typeof runId !== "string" || !runId || !state || typeof state !== "object") throw new Error("WATCHDOG_WORKFLOW_INVALID");
  const evidence = state.evidence ?? {};
  const roles = Array.isArray(evidence.roles) ? evidence.roles : [];
  const verifications = Array.isArray(evidence.verifications) ? evidence.verifications : [];
  const transitions = Array.isArray(evidence.transitions) ? evidence.transitions : [];
  const value = {
    version: WATCHDOG_VERSION, kind: "WORKFLOW_DELTA", runDigest: hash(`watchdog-run-v1\0${runId}`), taskPolicyDigest: task.digest,
    difficulty: task.classification.difficulty, risk: task.classification.risk.level, preset: task.preset,
    directSmallEdit: task.classification.signals.directSmallEdit === true,
    phase: String(state.currentPhase ?? "INITIALIZING"), round: Number.isSafeInteger(state.round) ? state.round : 0,
    verificationStatus: String(state.verificationStatus ?? "NOT_RUN"), finalVerificationStatus: String(state.finalVerificationStatus ?? "NOT_RUN"),
    failedRoleCount: roles.filter((entry) => entry?.status === "failed" && typeof entry?.agent === "string" && !entry.agent.startsWith("council-")).length,
    verificationFailureCount: verifications.filter((entry) => entry?.status === "FAIL").length,
    correctionCount: transitions.filter((entry) => entry?.state === "CORRECTION_REQUIRED" && entry?.phase === "enforced").length,
    blockingFindingsCount: Number.isSafeInteger(state.blockingFindingsCount) ? state.blockingFindingsCount : 0,
  };
  return validateWatchdogObservation(value);
}

export function validateWatchdogObservation(value) {
  if (!exact(value, OBSERVATION_KEYS) || value.version !== WATCHDOG_VERSION || value.kind !== "WORKFLOW_DELTA" || !DIGEST.test(value.runDigest ?? "") || !DIGEST.test(value.taskPolicyDigest ?? "")) throw new Error("WATCHDOG_OBSERVATION_INVALID");
  if (!["simple", "normal", "hard", "critical"].includes(value.difficulty) || !["minimal", "low", "medium", "high", "critical"].includes(value.risk) || !["token-saver", "normal"].includes(value.preset) || typeof value.directSmallEdit !== "boolean") throw new Error("WATCHDOG_OBSERVATION_INVALID");
  if (!PHASE.test(value.phase) || !["NOT_RUN", "RUNNING", "PASS", "FAIL"].includes(value.verificationStatus) || !["NOT_RUN", "RUNNING", "PASS", "FAIL"].includes(value.finalVerificationStatus)) throw new Error("WATCHDOG_OBSERVATION_INVALID");
  for (const key of ["round", "failedRoleCount", "verificationFailureCount", "correctionCount", "blockingFindingsCount"]) if (!finiteCount(value[key])) throw new Error("WATCHDOG_OBSERVATION_INVALID");
  if (JSON.stringify(value).length > 768) throw new Error("WATCHDOG_DELTA_TOO_LARGE");
  return Object.freeze(structuredClone(value));
}

export function validateWatchdogAdvice(value, policy = readWatchdogPolicy()) {
  validateWatchdogPolicy(policy);
  if (!exact(value, ADVICE_KEYS) || value.version !== WATCHDOG_VERSION || !SEVERITIES.has(value.severity) || !DIGEST.test(value.stateDigest ?? "")) throw new Error("WATCHDOG_ADVICE_INVALID");
  if (!boundedText(value.finding, 200) || !boundedText(value.recommendation, 240) || !Array.isArray(value.evidence) || value.evidence.length < 1 || value.evidence.length > 3 || value.evidence.some((entry) => !boundedText(entry, 96))) throw new Error("WATCHDOG_ADVICE_INVALID");
  const serialized = JSON.stringify(value);
  if (serialized.length > policy.maxAdviceChars || /\b(?:run shell|execute command|spawn agent|change routing|disable guardrail)\b/iu.test(serialized)) throw new Error("WATCHDOG_ADVICE_INVALID");
  return Object.freeze(structuredClone(value));
}

function eligibility(observation) {
  if (observation.directSmallEdit || ["simple", "normal"].includes(observation.difficulty) && !["high", "critical"].includes(observation.risk)) return false;
  return ["hard", "critical"].includes(observation.difficulty) || ["high", "critical"].includes(observation.risk);
}

function reasonFor(current, lastVerificationResult, policy) {
  if (lastVerificationResult === "PASS" && current.verificationStatus === "FAIL") return "VERIFICATION_REGRESSION";
  const threshold = current.preset === "token-saver" ? policy.tokenSaverFailureThreshold : policy.failureThreshold;
  if (current.verificationFailureCount >= threshold || current.failedRoleCount >= threshold) return "REPEATED_FAILURE";
  if (current.correctionCount >= 2 && current.blockingFindingsCount > 0) return "REPEATED_CORRECTION";
  return null;
}

function fixedAdvice(reason, stateDigest, delta, policy) {
  const phrase = reason === "VERIFICATION_REGRESSION" ? "Verification regressed after a prior pass."
    : reason === "REPEATED_CORRECTION" ? "Blocking findings remain after repeated correction."
    : "Repeated failures need a focused review.";
  return validateWatchdogAdvice({
    version: WATCHDOG_VERSION, severity: reason === "REPEATED_CORRECTION" ? "BLOCKER" : "CONCERN",
    finding: phrase, evidence: [`reason=${reason}`, `verificationFailures=${delta.verificationFailureCount}`, `failedRoles=${delta.failedRoleCount}`],
    recommendation: "Inspect the latest bounded verification and receipts before the next normal workflow step.", stateDigest,
  }, policy);
}

export class WatchdogController {
  constructor(options = {}) {
    this.policy = validateWatchdogPolicy(options.policy ?? readWatchdogPolicy());
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.enabled = false;
    this.runDigest = null;
    this.lastVerificationResult = null;
    this.lastReviewDigest = null;
    this.lastReviewAt = -Infinity;
    this.reviewCount = 0;
    this.findings = 0;
  }

  enable() { this.enabled = true; return this.status(); }
  disable() { this.enabled = false; return this.status(); }
  reset() { this.enabled = false; this.runDigest = null; this.lastVerificationResult = null; this.lastReviewDigest = null; this.lastReviewAt = -Infinity; this.reviewCount = 0; this.findings = 0; }
  status() { return Object.freeze({ version: WATCHDOG_VERSION, enabled: this.enabled, runActive: this.runDigest !== null, reviewCount: this.reviewCount, findingCount: this.findings, maxReviewsPerTask: this.policy.maxReviewsPerTask, authority: WATCHDOG_AUTHORITY }); }

  observe(input) {
    const delta = validateWatchdogObservation(input);
    if (this.runDigest !== delta.runDigest) {
      this.runDigest = delta.runDigest; this.lastVerificationResult = null; this.lastReviewDigest = null; this.lastReviewAt = -Infinity; this.reviewCount = 0; this.findings = 0;
    }
    const lastVerificationResult = this.lastVerificationResult;
    if (["PASS", "FAIL"].includes(delta.verificationStatus)) this.lastVerificationResult = delta.verificationStatus;
    if (!this.enabled) return Object.freeze({ status: "SKIPPED_DISABLED", modelCalls: 0 });
    if (!eligibility(delta)) return Object.freeze({ status: "SKIPPED_INELIGIBLE", modelCalls: 0 });
    if (delta.phase.startsWith("COUNCIL") || delta.phase === "COUNCIL_JUDGE") return Object.freeze({ status: "SKIPPED_COUNCIL", modelCalls: 0 });
    const reason = reasonFor(delta, lastVerificationResult, this.policy);
    if (!reason) return Object.freeze({ status: "SKIPPED_NO_TRIGGER", modelCalls: 0 });
    const stateDigest = hash(JSON.stringify({ runDigest: delta.runDigest, reason, verificationStatus: delta.verificationStatus, failedRoleCount: delta.failedRoleCount, verificationFailureCount: delta.verificationFailureCount, correctionCount: delta.correctionCount, blockingFindingsCount: delta.blockingFindingsCount }));
    if (stateDigest === this.lastReviewDigest) return Object.freeze({ status: "SKIPPED_DUPLICATE", reason, stateDigest, modelCalls: 0 });
    const maximum = delta.preset === "token-saver" ? this.policy.tokenSaverMaxReviews : this.policy.maxReviewsPerTask;
    if (this.reviewCount >= maximum) return Object.freeze({ status: "SKIPPED_BUDGET", reason, stateDigest, modelCalls: 0 });
    if (this.now() - this.lastReviewAt < this.policy.cooldownMs) return Object.freeze({ status: "SKIPPED_COOLDOWN", reason, stateDigest, modelCalls: 0 });
    const advice = fixedAdvice(reason, stateDigest, delta, this.policy);
    this.lastReviewDigest = stateDigest; this.lastReviewAt = this.now(); this.reviewCount += 1; this.findings += 1;
    return Object.freeze({ status: "REVIEWED", reason, runDigest: delta.runDigest, stateDigest, advice, contextChars: JSON.stringify(delta).length, provider: "LOCAL_DETERMINISTIC", modelCalls: 0 });
  }
}
