const USAGE_VERSION = 1;
const SOURCE = "pi-subagents-terminal";
const CONTRACT_FIELDS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd", "turns", "toolCalls", "durationMs"];
const TOKEN_FIELDS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "totalTokens"];
const ALL_FIELDS = [...TOKEN_FIELDS, "costUsd", "turns", "toolCalls", "durationMs"];

function blankUsage() {
  return {
    version: USAGE_VERSION,
    status: "UNAVAILABLE",
    source: SOURCE,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    totalTokensSource: "UNAVAILABLE",
    costUsd: null,
    turns: null,
    toolCalls: null,
    durationMs: null,
    invalidFields: [],
    estimated: { status: "NOT_COMPUTED" },
  };
}

function plainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value : undefined;
}

function readNumber(record, aliases, integer, invalidFields, label) {
  for (const key of aliases) {
    if (!Object.hasOwn(record, key)) continue;
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && (!integer || Number.isSafeInteger(value))) return value;
    invalidFields.push(label);
    return null;
  }
  return null;
}

export function normalizeProviderUsage(value) {
  const normalized = blankUsage();
  const record = plainRecord(value);
  if (!record) return normalized;
  const invalid = normalized.invalidFields;
  normalized.inputTokens = readNumber(record, ["input", "inputTokens"], true, invalid, "inputTokens");
  normalized.outputTokens = readNumber(record, ["output", "outputTokens"], true, invalid, "outputTokens");
  normalized.cacheReadTokens = readNumber(record, ["cacheRead", "cacheReadTokens", "cachedInputTokens"], true, invalid, "cacheReadTokens");
  normalized.cacheWriteTokens = readNumber(record, ["cacheWrite", "cacheWriteTokens"], true, invalid, "cacheWriteTokens");
  normalized.reasoningTokens = readNumber(record, ["reasoning", "reasoningTokens"], true, invalid, "reasoningTokens");
  normalized.totalTokens = readNumber(record, ["totalTokens"], true, invalid, "totalTokens");
  const rawCost = plainRecord(record.cost);
  normalized.costUsd = readNumber(rawCost ?? record, rawCost ? ["total"] : ["cost", "costUsd"], false, invalid, "costUsd");
  normalized.turns = readNumber(record, ["turns"], true, invalid, "turns");
  normalized.toolCalls = readNumber(record, ["toolCalls"], true, invalid, "toolCalls");
  normalized.durationMs = readNumber(record, ["durationMs"], true, invalid, "durationMs");

  if (normalized.totalTokens !== null) {
    normalized.totalTokensSource = "PROVIDER_REPORTED";
  } else if ([normalized.inputTokens, normalized.outputTokens, normalized.cacheReadTokens, normalized.cacheWriteTokens].every((entry) => entry !== null)) {
    normalized.totalTokens = normalized.inputTokens + normalized.outputTokens + normalized.cacheReadTokens + normalized.cacheWriteTokens;
    normalized.totalTokensSource = "DERIVED_FROM_REPORTED_COMPONENTS";
  }
  const reportedContractFields = CONTRACT_FIELDS.filter((field) => normalized[field] !== null).length;
  normalized.status = reportedContractFields === CONTRACT_FIELDS.length && invalid.length === 0
    ? "REPORTED"
    : ALL_FIELDS.some((field) => normalized[field] !== null) ? "PARTIAL" : "UNAVAILABLE";
  return normalized;
}

export function validateNormalizedUsage(value) {
  const record = plainRecord(value);
  if (!record || record.version !== USAGE_VERSION || !["REPORTED", "PARTIAL", "UNAVAILABLE"].includes(record.status) || record.source !== SOURCE) throw new Error("usage accounting envelope is invalid");
  const allowed = new Set(["version", "status", "source", ...ALL_FIELDS, "totalTokensSource", "invalidFields", "estimated"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new Error("usage accounting contains an unexpected field");
  for (const field of ALL_FIELDS) {
    const valueAtField = record[field];
    const integer = field !== "costUsd";
    if (valueAtField !== null && (typeof valueAtField !== "number" || !Number.isFinite(valueAtField) || valueAtField < 0 || (integer && !Number.isSafeInteger(valueAtField)))) throw new Error(`usage accounting ${field} is invalid`);
  }
  if (!["PROVIDER_REPORTED", "DERIVED_FROM_REPORTED_COMPONENTS", "UNAVAILABLE"].includes(record.totalTokensSource)) throw new Error("usage accounting total token source is invalid");
  if (!Array.isArray(record.invalidFields) || record.invalidFields.some((field) => !ALL_FIELDS.includes(field)) || new Set(record.invalidFields).size !== record.invalidFields.length) throw new Error("usage accounting invalid-field list is invalid");
  if (!record.estimated || Object.keys(record.estimated).length !== 1 || record.estimated.status !== "NOT_COMPUTED") throw new Error("usage accounting estimates are not separated");
  const contractCount = CONTRACT_FIELDS.filter((field) => record[field] !== null).length;
  const any = ALL_FIELDS.some((field) => record[field] !== null);
  const expectedStatus = contractCount === CONTRACT_FIELDS.length && record.invalidFields.length === 0 ? "REPORTED" : any ? "PARTIAL" : "UNAVAILABLE";
  if (record.status !== expectedStatus) throw new Error("usage accounting status does not match field coverage");
  if (record.totalTokensSource === "PROVIDER_REPORTED" && record.totalTokens === null) throw new Error("provider-reported total tokens are missing");
  if (record.totalTokensSource === "DERIVED_FROM_REPORTED_COMPONENTS") {
    const components = [record.inputTokens, record.outputTokens, record.cacheReadTokens, record.cacheWriteTokens];
    if (components.some((entry) => entry === null) || record.totalTokens !== components.reduce((sum, entry) => sum + entry, 0)) throw new Error("derived token total does not match reported components");
  }
  if (record.totalTokensSource === "UNAVAILABLE" && record.totalTokens !== null) throw new Error("unavailable token total has a value");
  return record;
}

function asNormalizedUsage(value) {
  try { return validateNormalizedUsage(value); }
  catch { return normalizeProviderUsage(value); }
}

function metric(attempts, field) {
  const values = attempts.map((entry) => entry.usage[field]);
  const reported = values.filter((entry) => entry !== null);
  return {
    status: reported.length === 0 ? "UNAVAILABLE" : reported.length === attempts.length ? "COMPLETE" : "PARTIAL",
    value: reported.length === 0 ? null : reported.reduce((sum, entry) => sum + entry, 0),
    reportedAttempts: reported.length,
  };
}

export function aggregateUsageAttempts(attempts, options = {}) {
  const roles = options.roles ? new Set(options.roles) : null;
  const selected = Array.isArray(attempts) ? attempts.filter((entry) => !roles || roles.has(entry?.agent ?? entry?.role)) : [];
  const seen = new Set();
  const unique = [];
  let duplicatesIgnored = 0;
  for (const entry of selected) {
    if (!entry || typeof entry !== "object") continue;
    const executionId = typeof entry.executionId === "string" ? entry.executionId : typeof entry.execution_id === "string" ? entry.execution_id : null;
    if (executionId && seen.has(executionId)) {
      duplicatesIgnored += 1;
      continue;
    }
    if (executionId) seen.add(executionId);
    unique.push(entry);
  }
  const launched = unique.filter((entry) => (entry.launchStatus ?? entry.launch_status) === "launched").map((entry) => ({ ...entry, usage: asNormalizedUsage(entry.usage) }));
  const notLaunchedAttempts = unique.filter((entry) => (entry.launchStatus ?? entry.launch_status) === "not_launched").length;
  const unknownLaunchAttempts = unique.length - launched.length - notLaunchedAttempts;
  const reported = launched.filter((entry) => entry.usage.status === "REPORTED").length;
  const partial = launched.filter((entry) => entry.usage.status === "PARTIAL").length;
  const unavailable = launched.length - reported - partial;
  const totals = Object.fromEntries(ALL_FIELDS.map((field) => [field, metric(launched, field)]));
  const directTotals = launched.filter((entry) => entry.usage.totalTokensSource === "PROVIDER_REPORTED").length;
  totals.totalTokens.source = totals.totalTokens.status === "UNAVAILABLE" ? "UNAVAILABLE" : directTotals === launched.length ? "PROVIDER_REPORTED" : "INCLUDES_DERIVED_COMPONENT_TOTALS";
  return {
    version: USAGE_VERSION,
    status: launched.length === 0 || reported + partial === 0 ? "UNAVAILABLE" : reported === launched.length && unknownLaunchAttempts === 0 ? "REPORTED" : "PARTIAL",
    attemptCount: unique.length,
    launchedAttempts: launched.length,
    notLaunchedAttempts,
    unknownLaunchAttempts,
    reportedUsageAttempts: reported,
    partialUsageAttempts: partial,
    unavailableUsageAttempts: unavailable,
    duplicateExecutionIdsIgnored: duplicatesIgnored,
    totals,
    estimated: { status: "NOT_COMPUTED" },
  };
}

export function usageAttemptFromReceipt(receipt) {
  return {
    agent: receipt.role,
    role: receipt.role,
    attempt: receipt.attempt,
    status: receipt.status,
    failureCategory: receipt.failure_category,
    launchStatus: receipt.launch_status,
    modelCalls: receipt.model_calls,
    provider: receipt.provider ?? null,
    model: receipt.model,
    thinking: receipt.thinking,
    runId: receipt.response_run_id,
    nodeId: receipt.node_id,
    ownerRunId: receipt.owner_run_id,
    executionId: receipt.execution_id,
    receiptSequence: receipt.sequence,
    usage: asNormalizedUsage(receipt.usage),
  };
}
