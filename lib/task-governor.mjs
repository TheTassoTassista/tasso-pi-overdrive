import { createHash } from "node:crypto";
import { resolveMemoryPolicy } from "./memory-policy.mjs";
import { routeMemoryQuery } from "./memory-router.mjs";
import { resolveTokenGovernor, validateTokenGovernor } from "./token-governor.mjs";

export const TASK_POLICY_VERSION = 1;

const MUTATION = /\b(?:add|change|delete|edit|fix|implement|migrate|modify|patch|refactor|remove|rename|replace|rewrite|update|write|aggiungi|cambia|correggi|elimina|implementa|modifica|rimuovi|rinomina|sostituisci)\b/iu;
const DEBUG = /\b(?:crash|deadlock|debug|flaky|hang|intermittent|race condition|regression|reproduce|timeout|under load)\b/iu;
const BROWSER = /\b(?:browser|chromium|dom|frontend|html|page|playwright|website|ui|web app)\b/iu;
const WEB = /\b(?:browse|internet|latest|online|research|search the web|web search)\b/iu;
const DATA = /\b(?:database|data loss|migration|schema|transaction)\b/iu;
const PRODUCTION = /\b(?:deploy|incident|production|release gate|rollback)\b/iu;
const DESTRUCTIVE = /\b(?:delete|destroy|drop|erase|force push|purge|reset --hard|wipe)\b/iu;
const EXTERNAL = /\b(?:api|cloud|github|network|provider|remote|webhook)\b/iu;
const CODE = /(?:\b(?:code|class|compile|function|implementation|module|repository|source|test|typecheck)\b|(?:^|\s)(?:[\w.-]+\/)*[\w.-]+\.(?:c|cc|cpp|css|go|html|java|js|json|jsx|mjs|py|rs|sh|ts|tsx|yaml|yml)\b)/iu;
const CONCURRENCY = /\b(?:atomic|concurren(?:cy|t)|deadlock|intermittent|race condition|thread|under load)\b/iu;
const SMALL_DIRECT_EDIT = /\b(?:change|edit|rename|replace|update|modifica|rinomina|sostituisci)\b[\s\S]{0,100}\b(?:label|string|text|value|word)\b/iu;
const POLICY_CHOICES = Object.freeze(["planner", "secondBrain", "debugger", "eval", "sentinel", "reviewer", "council", "browser", "web"]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function digestPolicy(value) {
  const copy = structuredClone(value);
  delete copy.digest;
  return createHash("sha256").update(JSON.stringify(copy)).digest("hex");
}

function normalizeChoices(input) {
  const choices = input?.userChoices ?? {};
  if (!choices || typeof choices !== "object" || Array.isArray(choices)) throw new Error("task_policy_choices_invalid");
  if (Object.keys(choices).some((key) => !POLICY_CHOICES.includes(key))) throw new Error("task_policy_choice_unknown");
  for (const value of Object.values(choices)) if (typeof value !== "boolean") throw new Error("task_policy_choice_invalid");
  return choices;
}

function normalizeAvailableContext(value) {
  if (value === undefined) return Object.freeze({ status: "unknown", maxChars: null, usedChars: null, remainingChars: null, pressure: "unknown" });
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("task_policy_context_invalid");
  const { maxChars, usedChars } = value;
  if (!Number.isSafeInteger(maxChars) || !Number.isSafeInteger(usedChars) || maxChars < 1_000 || maxChars > 10_000_000 || usedChars < 0 || usedChars > maxChars) throw new Error("task_policy_context_invalid");
  const ratio = usedChars / maxChars;
  const pressure = ratio >= 0.9 ? "critical" : ratio >= 0.75 ? "high" : ratio >= 0.5 ? "medium" : "low";
  return Object.freeze({ status: "known", maxChars, usedChars, remainingChars: maxChars - usedChars, pressure });
}

export function availableContextFromPiUsage(usage) {
  if (!usage || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0 || !Number.isFinite(usage.tokens) || usage.tokens < 0) return undefined;
  const maxChars = Math.ceil(usage.contextWindow * 4);
  const usedChars = Math.min(maxChars, Math.ceil(usage.tokens * 4));
  return { maxChars, usedChars };
}

function riskClassification(text, tokenGovernor) {
  const categories = [];
  if (tokenGovernor.securitySensitive) categories.push("security");
  if (CONCURRENCY.test(text)) categories.push("concurrency");
  if (DATA.test(text)) categories.push("data-integrity");
  if (PRODUCTION.test(text)) categories.push("production");
  if (DESTRUCTIVE.test(text)) categories.push("destructive-operation");
  if (EXTERNAL.test(text)) categories.push("external-system");
  const level = tokenGovernor.difficulty === "critical"
    ? "critical"
    : categories.some((entry) => ["security", "concurrency", "data-integrity", "production", "destructive-operation"].includes(entry))
      ? "high"
      : tokenGovernor.difficulty === "hard" || categories.length > 0
        ? "medium"
        : tokenGovernor.difficulty === "normal"
          ? "low"
          : "minimal";
  return Object.freeze({ level, categories: Object.freeze(categories) });
}

function expectedScope(tokenGovernor) {
  const files = tokenGovernor.difficultyEvidence.fileReferences;
  if (tokenGovernor.difficulty === "simple") return Object.freeze({ class: "single-change", estimatedFiles: Object.freeze([1, 1]), explicitFileReferences: files });
  if (tokenGovernor.difficulty === "normal") return Object.freeze({ class: "bounded", estimatedFiles: Object.freeze([1, Math.max(3, files)]), explicitFileReferences: files });
  if (tokenGovernor.difficulty === "hard") return Object.freeze({ class: "cross-cutting", estimatedFiles: Object.freeze([Math.max(2, files), Math.max(10, files)]), explicitFileReferences: files });
  return Object.freeze({ class: "system-critical", estimatedFiles: Object.freeze([Math.max(2, files), Math.max(20, files)]), explicitFileReferences: files });
}

function applyChoice(name, automatic, choices, mandatory, applied, blocked) {
  if (!Object.hasOwn(choices, name)) return automatic;
  if (choices[name] === false && mandatory) {
    blocked.push(`${name}:mandatory-high-risk-control`);
    return true;
  }
  applied.push(`${name}:${choices[name] ? "enabled" : "disabled"}`);
  return choices[name];
}

function roleNames(strategy) {
  const names = Object.entries(strategy.roles).filter(([, enabled]) => enabled).map(([role]) => role);
  if (strategy.council.initial) names.push("council-1", "council-2", "council-3", "council-judge");
  return names;
}

export function resolveTaskPolicy(input = {}) {
  const text = String(input.task ?? "").trim();
  if (!text) throw new Error("task_policy_task_required");
  const choices = normalizeChoices(input);
  const tokenGovernor = resolveTokenGovernor({
    task: text,
    preset: input.preset,
    quality: input.quality,
    includeOracle: input.includeOracle === true || choices.council === true,
    includeSecurity: input.includeSecurity,
  });
  const risk = riskClassification(text, tokenGovernor);
  const context = normalizeAvailableContext(input.availableContext);
  const debugging = DEBUG.test(text);
  const mutating = MUTATION.test(text);
  const code = CODE.test(text) || mutating || debugging;
  const directSmallEdit = tokenGovernor.difficulty !== "hard" && tokenGovernor.difficulty !== "critical" && text.length <= 180 && SMALL_DIRECT_EDIT.test(text);
  const memoryRoute = routeMemoryQuery(text, {
    currentContextSufficient: directSmallEdit ? true : undefined,
    project: tokenGovernor.difficulty === "hard" || tokenGovernor.difficulty === "critical" || debugging ? true : undefined,
  });
  const memoryPolicy = resolveMemoryPolicy({ preset: tokenGovernor.preset, qualityRequested: tokenGovernor.qualityRequested, effectiveQuality: tokenGovernor.effectiveQuality });
  const applied = [];
  const blocked = [];
  const highRisk = ["high", "critical"].includes(risk.level);
  const critical = risk.level === "critical";

  const planner = applyChoice("planner", tokenGovernor.roles.planner, choices, ["hard", "critical"].includes(tokenGovernor.difficulty), applied, blocked);
  const secondBrain = applyChoice("secondBrain", memoryRoute.decision !== "NONE", choices, false, applied, blocked);
  const debuggerNeeded = applyChoice("debugger", debugging, choices, false, applied, blocked);
  const evalNeeded = applyChoice("eval", debugging && /\b(?:intermittent|race condition|reproduce|under load)\b/iu.test(text), choices, false, applied, blocked);
  const sentinel = applyChoice("sentinel", debugging && ["hard", "critical"].includes(tokenGovernor.difficulty), choices, false, applied, blocked);
  const reviewer = applyChoice("reviewer", tokenGovernor.roles.correctness || tokenGovernor.roles.security || tokenGovernor.roles.simplicity, choices, highRisk, applied, blocked);
  const council = applyChoice("council", tokenGovernor.council.initial, choices, critical, applied, blocked);
  const browser = applyChoice("browser", BROWSER.test(text), choices, false, applied, blocked);
  const web = applyChoice("web", WEB.test(text), choices, false, applied, blocked);

  const roles = {
    ...tokenGovernor.roles,
    scout: directSmallEdit ? false : tokenGovernor.roles.scout,
    planner,
    correctness: reviewer ? tokenGovernor.roles.correctness || !tokenGovernor.roles.security : false,
    security: tokenGovernor.roles.security,
    simplicity: reviewer ? tokenGovernor.roles.simplicity : false,
  };
  const routingStrategy = deepFreeze({
    ...structuredClone(tokenGovernor),
    roles,
    council: { ...tokenGovernor.council, initial: council, authorized: tokenGovernor.council.authorized || council },
  });
  validateTokenGovernor(routingStrategy);

  const capabilities = ["read"];
  if ((tokenGovernor.difficulty !== "simple" && !directSmallEdit) || debugging) capabilities.push("search");
  if (mutating) capabilities.push("edit");
  if (code) capabilities.push("lsp");
  if (secondBrain) capabilities.push("memory");
  if (debuggerNeeded) capabilities.push("debug");
  if (evalNeeded) capabilities.push("eval");
  if (sentinel) capabilities.push("sentinel");
  if (browser) capabilities.push("browser");
  if (web) capabilities.push("web");
  if (mutating || debugging) capabilities.push("verify");

  const memoryNeed = secondBrain ? (memoryRoute.sources.length > 1 || highRisk ? "required" : "useful") : "none";
  const policyWithoutDigest = {
    version: TASK_POLICY_VERSION,
    kind: "TASK_POLICY",
    source: "deterministic-v1",
    decisionModelCalls: 0,
    preset: routingStrategy.preset,
    qualityRequested: routingStrategy.qualityRequested,
    effectiveQuality: routingStrategy.effectiveQuality,
    classification: {
      difficulty: routingStrategy.difficulty,
      difficultyReasons: [...routingStrategy.difficultyReasons],
      risk,
      expectedScope: expectedScope(routingStrategy),
      signals: { mutating, code, debugging, browser: BROWSER.test(text), web: WEB.test(text) },
    },
    availableContext: context,
    needs: {
      planner,
      secondBrain,
      smartRead: code && tokenGovernor.difficulty !== "simple",
      lsp: code,
      debugger: debuggerNeeded,
      eval: evalNeeded,
      sentinel,
      reviewer,
      council,
      browser,
      web,
      verification: mutating || debugging,
    },
    memory: {
      need: memoryNeed,
      decision: secondBrain ? memoryRoute.decision : "NONE",
      sources: secondBrain ? [...memoryRoute.sources] : [],
      reflect: secondBrain && memoryRoute.reflect && (memoryPolicy.hindsight.reflect || memoryPolicy.hindsight.reflectExceptional),
      candidateLimit: secondBrain ? memoryPolicy.candidateLimit : 0,
      packCharLimit: secondBrain ? memoryPolicy.packCharLimit : 0,
      approximateTokenLimit: secondBrain ? memoryPolicy.approximateTokenLimit : 0,
    },
    contextBudget: {
      handoffChars: routingStrategy.context.handoffChars,
      evidenceChars: routingStrategy.context.evidenceChars,
      councilChars: routingStrategy.context.councilChars,
      memoryPackChars: secondBrain ? memoryPolicy.packCharLimit : 0,
      smartReadTargetChars: routingStrategy.preset === "token-saver" ? 3000 : 6000,
      reserveChars: context.status === "known" ? Math.min(context.remainingChars, Math.ceil(context.maxChars * 0.15)) : null,
    },
    toolNeed: { level: capabilities.length <= 3 ? "minimal" : capabilities.length <= 6 ? "focused" : "expanded", capabilities },
    modelNeed: { required: true, primaryRole: "worker", roles: roleNames(routingStrategy), maxCalls: routingStrategy.maxModelCalls },
    reviewNeed: { required: reviewer, roles: [roles.correctness ? "correctness" : null, roles.security ? "security" : null, roles.simplicity ? "simplicity" : null].filter(Boolean), council },
    explicitChoices: { applied, blocked },
    tokenGovernor: structuredClone(tokenGovernor),
    routingStrategy: structuredClone(routingStrategy),
    hardLimits: { maxRetriesPerDelegation: routingStrategy.maxRetriesPerDelegation, maxCorrectionRounds: routingStrategy.maxCorrectionRounds, maxModelCalls: routingStrategy.maxModelCalls },
  };
  return deepFreeze({ ...policyWithoutDigest, digest: digestPolicy(policyWithoutDigest) });
}

export function validateTaskPolicy(value) {
  if (!value || value.version !== TASK_POLICY_VERSION || value.kind !== "TASK_POLICY" || value.source !== "deterministic-v1" || value.decisionModelCalls !== 0) throw new Error("task_policy_invalid");
  const routing = validateTokenGovernor(value.routingStrategy);
  const token = validateTokenGovernor(value.tokenGovernor);
  if (value.preset !== routing.preset || value.qualityRequested !== routing.qualityRequested || value.effectiveQuality !== routing.effectiveQuality || value.classification?.difficulty !== routing.difficulty) throw new Error("task_policy_routing_mismatch");
  if (token.maxModelCalls !== routing.maxModelCalls || token.maxRetriesPerDelegation !== routing.maxRetriesPerDelegation || token.maxCorrectionRounds !== routing.maxCorrectionRounds) throw new Error("task_policy_limits_mismatch");
  if (!value.needs || Object.values(value.needs).some((entry) => typeof entry !== "boolean")) throw new Error("task_policy_needs_invalid");
  if (!Array.isArray(value.toolNeed?.capabilities) || value.toolNeed.capabilities.some((entry) => typeof entry !== "string")) throw new Error("task_policy_tools_invalid");
  if (!Array.isArray(value.modelNeed?.roles) || value.modelNeed.primaryRole !== "worker" || value.modelNeed.maxCalls !== routing.maxModelCalls) throw new Error("task_policy_models_invalid");
  if (value.hardLimits?.maxRetriesPerDelegation !== routing.maxRetriesPerDelegation || value.hardLimits?.maxCorrectionRounds !== routing.maxCorrectionRounds || value.hardLimits?.maxModelCalls !== routing.maxModelCalls) throw new Error("task_policy_limits_invalid");
  if (!/^[0-9a-f]{64}$/u.test(value.digest ?? "") || digestPolicy(value) !== value.digest) throw new Error("task_policy_digest_invalid");
  return deepFreeze(structuredClone(value));
}

export function taskPolicyMetadata(policy) {
  const checked = validateTaskPolicy(policy);
  return deepFreeze({
    kind: "task_governor_decision",
    version: checked.version,
    source: checked.source,
    decisionModelCalls: checked.decisionModelCalls,
    preset: checked.preset,
    qualityRequested: checked.qualityRequested,
    effectiveQuality: checked.effectiveQuality,
    difficulty: checked.classification.difficulty,
    risk: checked.classification.risk.level,
    expectedScope: checked.classification.expectedScope.class,
    contextStatus: checked.availableContext.status,
    memoryNeed: checked.memory.need,
    activeCapabilityCount: checked.toolNeed.capabilities.length,
    reviewer: checked.needs.reviewer,
    council: checked.needs.council,
    digest: checked.digest,
  });
}

export function renderTaskPolicy(policy, json = false) {
  const checked = validateTaskPolicy(policy);
  if (json) return JSON.stringify(checked, null, 2);
  return [
    `Task policy ${checked.digest.slice(0, 16)} (${checked.source}; ${checked.decisionModelCalls} model calls)`,
    `Difficulty/risk/scope: ${checked.classification.difficulty} / ${checked.classification.risk.level} / ${checked.classification.expectedScope.class}`,
    `Preset/quality: ${checked.preset} / ${checked.qualityRequested} → ${checked.effectiveQuality}`,
    `Models: ${checked.modelNeed.roles.join(", ")} (maximum ${checked.modelNeed.maxCalls} calls)`,
    `Capabilities: ${checked.toolNeed.capabilities.join(", ")} (${checked.toolNeed.level})`,
    `Memory: ${checked.memory.need}; ${checked.memory.decision}; ${checked.memory.packCharLimit} chars`,
    `Planner/Reviewer/Council: ${checked.needs.planner} / ${checked.needs.reviewer} / ${checked.needs.council}`,
    `Debug/Eval/Sentinel: ${checked.needs.debugger} / ${checked.needs.eval} / ${checked.needs.sentinel}`,
    `Context: ${checked.availableContext.status}; handoff ${checked.contextBudget.handoffChars}; evidence ${checked.contextBudget.evidenceChars}`,
    checked.explicitChoices.blocked.length ? `Blocked unsafe overrides: ${checked.explicitChoices.blocked.join(", ")}` : "Blocked unsafe overrides: none",
  ].join("\n");
}
