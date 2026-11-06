const BACKENDS = new Set(["openviking", "hindsight", "ace", "ledger"]);
const TRUST_LEVELS = new Set(["VERIFIED", "USER", "PROJECT_DOC", "INFERRED", "EXTERNAL"]);
const STATUSES = new Set(["OK", "PARTIAL", "DEGRADED", "SKIPPED", "UNKNOWN"]);
const ROUTES = new Set(["NONE", "OPENVIKING", "HINDSIGHT", "ACE", "MIXED"]);
const ROUTE_REASONS = new Set([
  "current-context-sufficient",
  "project-context",
  "temporal-intent",
  "experience-intent",
  "historical-synthesis-requested",
  "no-memory-intent",
  "task-policy-current-context-sufficient",
  "retrieval-error",
]);

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeEntryId(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9._:-]{1,96}$/u.test(value)) return "entry-id-withheld";
  return value;
}

function safeEnum(value, values, fallback = "UNKNOWN") {
  return typeof value === "string" && values.has(value) ? value : fallback;
}

export function summarizeAutomaticMemory({ pack, outcome, reason } = {}) {
  const metadata = pack?.metadata ?? {};
  const route = pack?.route ?? {};
  const items = Array.isArray(pack?.items) ? pack.items : [];
  const validOutcome = new Set(["ATTACHED", "EMPTY", "SKIPPED", "UNAVAILABLE"]);
  const normalizedOutcome = validOutcome.has(outcome) ? outcome : "UNAVAILABLE";
  const reasons = Array.isArray(route.reasons) ? route.reasons : [];
  const normalizedReasons = reasons.filter((value) => ROUTE_REASONS.has(value));
  if (reason && ROUTE_REASONS.has(reason) && !normalizedReasons.includes(reason)) normalizedReasons.push(reason);

  return Object.freeze({
    outcome: normalizedOutcome,
    status: safeEnum(metadata.status, STATUSES, normalizedOutcome === "SKIPPED" ? "SKIPPED" : "UNKNOWN"),
    route: safeEnum(route.decision, ROUTES, normalizedOutcome === "SKIPPED" ? "NONE" : "UNKNOWN"),
    sources: Object.freeze((Array.isArray(route.sources) ? route.sources : []).filter((value) => BACKENDS.has(value))),
    reasons: Object.freeze(normalizedReasons),
    candidateCount: safeCount(metadata.candidateCount),
    itemCount: safeCount(metadata.itemCount ?? items.length),
    approximateTokens: safeCount(metadata.approximateTokens),
    degradationCount: safeCount(metadata.degradationCount),
    items: Object.freeze(items.map((item) => Object.freeze({
      id: safeEntryId(item?.id),
      backend: safeEnum(item?.backend, BACKENDS),
      trustLevel: safeEnum(item?.trustLevel, TRUST_LEVELS),
      level: Number.isInteger(item?.level) && item.level >= 0 && item.level <= 2 ? item.level : null,
    }))),
  });
}

export function renderAutomaticMemorySummary(snapshot) {
  if (!snapshot) return "No automatic memory decision has been recorded in this session.";
  const lines = [
    `Automatic memory context: ${snapshot.outcome}; retrieval status=${snapshot.status}.`,
    `Route=${snapshot.route}; sources=${snapshot.sources.length ? snapshot.sources.join(", ") : "none"}.`,
    `Reason=${snapshot.reasons.length ? snapshot.reasons.join(", ") : "unavailable"}.`,
    `Candidates=${snapshot.candidateCount}; entries attached=${snapshot.itemCount}; estimated context=${snapshot.approximateTokens} tokens; degraded sources=${snapshot.degradationCount}.`,
  ];
  if (snapshot.items.length) {
    lines.push("Attached entry identifiers (content and source paths omitted):");
    for (const item of snapshot.items) {
      lines.push(`- ${item.id} [${item.backend}; ${item.trustLevel}; ${item.level === null ? "level unknown" : `L${item.level}`}]`);
    }
  }
  lines.push("This reports context attached to the prompt; whether the model semantically used it cannot be observed.");
  return lines.join("\n");
}

export function createMemorySessionSummaryStore() {
  let snapshot = null;
  return Object.freeze({
    reset() { snapshot = null; },
    record(input) { snapshot = summarizeAutomaticMemory(input); return snapshot; },
    current() { return snapshot; },
    render() { return renderAutomaticMemorySummary(snapshot); },
  });
}
