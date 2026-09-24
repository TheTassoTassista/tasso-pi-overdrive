import embedded from "../config/edit-benchmark-evidence.json" with { type: "json" };

const CONTRACTS = new Set(["HASH_ANCHORED", "APPLY_PATCH", "REPLACE", "AST_STRUCTURAL"]);
const MODES = new Set(["ordinary", "structural"]);
const SCOPES = new Set(["family", "provider", "model"]);
const DIGEST = /^[0-9a-f]{64}$/u;
const EMPTY = Object.freeze({ level: "UNKNOWN", preferred: null, sourceDigest: null, measuredAt: null });
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => Object.hasOwn(value, key));
const count = (value) => Number.isSafeInteger(value) && value >= 0;

function validResult(result) {
  return exactKeys(result, ["contract", "attempts", "exactSuccesses", "formatFailures", "retries", "unsafeOutcomes", "modelCalls", "inputTokens", "outputTokens"])
    && CONTRACTS.has(result.contract) && count(result.attempts) && result.attempts >= 20
    && count(result.exactSuccesses) && result.exactSuccesses <= result.attempts
    && count(result.formatFailures) && result.formatFailures <= result.attempts - result.exactSuccesses
    && count(result.retries) && count(result.unsafeOutcomes) && result.unsafeOutcomes === 0
    && count(result.modelCalls) && result.modelCalls >= result.attempts
    && count(result.inputTokens) && count(result.outputTokens);
}

function validRecord(record, now) {
  if (!exactKeys(record, ["scope", "key", "mode", "fixtureCount", "costBasis", "sourceDigest", "measuredAt", "results"])) return false;
  if (!SCOPES.has(record.scope) || typeof record.key !== "string" || !/^[A-Za-z0-9_.\/-]{1,128}$/u.test(record.key) || !MODES.has(record.mode)) return false;
  if (!count(record.fixtureCount) || record.fixtureCount < 20 || !["ZERO_EXTRA_COST_VERIFIED", "SUBSCRIPTION_BACKED"].includes(record.costBasis) || !DIGEST.test(record.sourceDigest)) return false;
  const measured = Date.parse(record.measuredAt);
  if (!Number.isFinite(measured) || new Date(measured).toISOString() !== record.measuredAt || measured > now || now - measured > 30 * 86_400_000) return false;
  return Array.isArray(record.results) && record.results.length === 2 && record.results.every(validResult) && record.results[0].contract !== record.results[1].contract;
}

/** Trusted, tracked metadata only. Invalid, stale or inconclusive evidence never changes a profile. */
export function resolveEditBenchmarkPreference(input = {}) {
  const { evidence = embedded, scope, key, mode, candidates, now = Date.now() } = input;
  if (!evidence || evidence.version !== 1 || !Array.isArray(evidence.records) || !MODES.has(mode) || !Array.isArray(candidates) || candidates.length !== 2) return EMPTY;
  const record = evidence.records.find((item) => item?.scope === scope && item?.key === key && item?.mode === mode);
  if (!validRecord(record, now)) return EMPTY;
  if (new Set(record.results.map((result) => result.contract)).size !== 2 || record.results.some((result) => !candidates.includes(result.contract))) return EMPTY;
  const sorted = [...record.results].sort((left, right) => right.exactSuccesses - left.exactSuccesses);
  const winner = sorted[0];
  const runnerUp = sorted[1];
  if (winner.exactSuccesses < runnerUp.exactSuccesses + 2 || winner.formatFailures > runnerUp.formatFailures || winner.retries > runnerUp.retries) return EMPTY;
  return Object.freeze({ level: "BENCHMARKED", preferred: winner.contract, sourceDigest: record.sourceDigest, measuredAt: record.measuredAt });
}

export function resolveProfileEditBenchmarks(input = {}) {
  const { evidence = embedded, identity, provider, family, editContracts, now } = input;
  const resolveMode = (mode) => {
    const candidates = editContracts?.[mode];
    for (const [scope, key] of [["model", identity], ["provider", provider], ["family", family]]) {
      const decision = resolveEditBenchmarkPreference({ evidence, scope, key, mode, candidates, now });
      if (decision.level === "BENCHMARKED") return decision;
    }
    return EMPTY;
  };
  return Object.freeze({ ordinary: resolveMode("ordinary"), structural: resolveMode("structural") });
}
