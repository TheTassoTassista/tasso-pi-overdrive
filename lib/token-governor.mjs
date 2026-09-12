import routingPolicy from "../config/routing-policy.json" with { type: "json" };
import { QUALITY_LEVELS, parseQuality } from "./routing-session.mjs";

export const DIFFICULTY_LEVELS = Object.freeze(["simple", "normal", "hard", "critical"]);
const RANK = Object.freeze({ low: 0, medium: 1, high: 2, max: 3 });
const SECURITY = /\b(?:auth(?:entication|orization)?|credential|secret|token|permission|sandbox|bubblewrap|injection|path traversal|symlink|destructive|private key|cookie|payment|security|vulnerab(?:ility|le)|privilege)\b/iu;
const CRITICAL = /\b(?:data loss|production migration|release gate|incident|remote code execution|privilege escalation|supply chain)\b/iu;
const HARD = /\b(?:architecture|concurren(?:cy|t)|race condition|deadlock|migration|recovery|distributed|state machine|end-to-end|\be2e\b|integration|refactor|protocol|crash)\b/iu;

export function classifyTaskDifficulty(task, options = {}) {
  const text = String(task ?? "");
  const securitySensitive = SECURITY.test(text);
  const fileReferences = new Set(text.match(/(?:^|\s)(?:[\w.-]+\/)+[\w.-]+/gu) ?? []).size;
  const lineCount = text.split(/\r?\n/u).length;
  let difficulty = "simple";
  const reasons = [];
  if (options.includeOracle === true || CRITICAL.test(text)) {
    difficulty = "critical";
    reasons.push(options.includeOracle === true ? "explicit-high-risk" : "critical-risk-signal");
  } else if (HARD.test(text) || text.length > 1800 || fileReferences >= 5 || lineCount >= 24) {
    difficulty = "hard";
    reasons.push(HARD.test(text) ? "complexity-signal" : "large-task-surface");
  } else if (text.length > 320 || fileReferences >= 2 || /\b(?:implement|fix|change|test|debug|add|remove|update)\b/iu.test(text)) {
    difficulty = "normal";
    reasons.push("implementation-signal");
  } else reasons.push("small-bounded-task");
  if (securitySensitive) reasons.push("security-sensitive");
  return Object.freeze({ difficulty, securitySensitive, reasons: Object.freeze(reasons), evidence: Object.freeze({ characters: text.length, lines: lineCount, fileReferences }) });
}

function adaptiveQuality(difficulty) {
  return ({ simple: "low", normal: "medium", hard: "high", critical: "max" })[difficulty];
}

function atLeast(level, minimum) { return RANK[level] >= RANK[minimum]; }

export function resolveTokenGovernor(input) {
  const preset = input?.preset === "token-saver" ? "token-saver" : "normal";
  const requestedQuality = parseQuality(input?.quality ?? "auto");
  const classification = classifyTaskDifficulty(input?.task, { includeOracle: input?.includeOracle === true });
  const adaptive = requestedQuality === "auto" ? adaptiveQuality(classification.difficulty) : requestedQuality;
  const effectiveQuality = classification.securitySensitive && !atLeast(adaptive, "high") ? "high" : adaptive;
  const hard = ["hard", "critical"].includes(classification.difficulty);
  const critical = classification.difficulty === "critical";
  const high = atLeast(effectiveQuality, "high");
  const maximum = effectiveQuality === "max";
  const tokenSaver = preset === "token-saver";
  const explicitCouncil = input?.includeOracle === true;

  const roles = {
    scout: !tokenSaver && classification.difficulty !== "simple" && (hard || requestedQuality === "auto"),
    planner: hard || (classification.difficulty === "normal" && high && !tokenSaver),
    oracle: critical || explicitCouncil,
    worker: true,
    tester: !tokenSaver && (critical || (hard && high)),
    correctness: critical || (hard && high) || (maximum && classification.difficulty !== "simple"),
    security: classification.securitySensitive || (input?.includeSecurity === true && critical),
    simplicity: maximum && hard && !tokenSaver,
  };
  const council = {
    initial: explicitCouncil || (critical && high),
    disagreement: high || critical,
    repeatedFailure: true,
    authorized: explicitCouncil || high || critical,
  };
  const context = routingPolicy.context[preset];
  const limitProfile = effectiveQuality === "max" || critical ? "max" : effectiveQuality;
  const maxModelCalls = routingPolicy.governor.maxModelCalls[preset][limitProfile];
  return Object.freeze({
    version: 1,
    preset,
    qualityRequested: requestedQuality,
    effectiveQuality,
    difficulty: classification.difficulty,
    difficultyReasons: classification.reasons,
    difficultyEvidence: classification.evidence,
    securitySensitive: classification.securitySensitive,
    toolsFirst: true,
    roles: Object.freeze(roles),
    council: Object.freeze(council),
    context: Object.freeze(context),
    maxModelCalls,
    maxRetriesPerDelegation: routingPolicy.governor.maxRetriesPerDelegation,
    maxCorrectionRounds: routingPolicy.governor.maxCorrectionRounds,
  });
}

export function validateTokenGovernor(value) {
  if (!value || value.version !== 1 || !["normal", "token-saver"].includes(value.preset)) throw new Error("routing_governor_invalid");
  if (!QUALITY_LEVELS.includes(value.qualityRequested) || !QUALITY_LEVELS.filter((level) => level !== "auto").includes(value.effectiveQuality)) throw new Error("routing_governor_quality_invalid");
  if (!DIFFICULTY_LEVELS.includes(value.difficulty) || value.toolsFirst !== true) throw new Error("routing_governor_difficulty_invalid");
  if (!value.roles || value.roles.worker !== true || Object.values(value.roles).some((enabled) => typeof enabled !== "boolean")) throw new Error("routing_governor_roles_invalid");
  if (!value.council || Object.values(value.council).some((enabled) => typeof enabled !== "boolean")) throw new Error("routing_governor_council_invalid");
  if (!Number.isSafeInteger(value.maxModelCalls) || value.maxModelCalls < 1 || value.maxModelCalls > routingPolicy.governor.absoluteModelCallCeiling || value.maxRetriesPerDelegation !== routingPolicy.governor.maxRetriesPerDelegation || value.maxCorrectionRounds !== routingPolicy.governor.maxCorrectionRounds) throw new Error("routing_governor_limits_invalid");
  for (const key of ["handoffChars", "evidenceChars", "councilChars"]) if (!Number.isSafeInteger(value.context?.[key]) || value.context[key] < 1000 || value.context[key] > 12000) throw new Error("routing_governor_context_invalid");
  return structuredClone(value);
}
