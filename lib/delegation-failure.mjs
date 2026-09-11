export const FAILURE_CATEGORIES = Object.freeze([
  "TRANSIENT",
  "DETERMINISTIC",
  "POLICY",
  "RESOURCE_LIMIT",
  "AUTH",
  "UNSUPPORTED_MODEL",
  "STRUCTURED_OUTPUT_POLICY_ERROR",
  "STRUCTURED_OUTPUT_MODEL_INVALID",
]);

const FAILURE_CATEGORY = new Set(FAILURE_CATEGORIES);
const STRUCTURED_CONFIGURATION = /result\.schema|output.?schema|json schema|schema configuration|invalid schema|schema.+(?:unsupported|invalid)|structured result.+(?:configuration|request)/u;
const STRUCTURED_FAILURE = /structured.output|structured result|schema|malformed result|missing structured/u;

export function classifyDelegationFailure(value) {
  if (FAILURE_CATEGORY.has(value?.failureCategory)) return value.failureCategory;
  const status = String(value?.status ?? "").toLowerCase();
  const message = `${value?.message ?? ""} ${value?.error ?? ""}`.toLowerCase();
  if (/subagent spawn limit|spawn budget|insufficient_subagent_spawn_budget|atomic_subagent_spawn_budget_exhausted|transient_retry_reserve_exhausted/u.test(message)) return "RESOURCE_LIMIT";
  if (/unsupported.model|model.+not supported|unknown model/u.test(message)) return "UNSUPPORTED_MODEL";
  if (/\b401\b|unauthori[sz]ed|authentication|credential|api key|missing.+auth/u.test(message)) return "AUTH";
  if (status === "structured_output_failed") {
    return value?.launchStatus === "launched" && value?.routeAttested === true
      ? "STRUCTURED_OUTPUT_MODEL_INVALID"
      : "STRUCTURED_OUTPUT_POLICY_ERROR";
  }
  if ((status === "invalid_request" && STRUCTURED_FAILURE.test(message)) || STRUCTURED_CONFIGURATION.test(message)) return "STRUCTURED_OUTPUT_POLICY_ERROR";
  if (["protocol_rejected", "invalid_request", "duplicate_node", "acceptance_failed", "tool_budget_exhausted"].includes(status) || /role mismatch|policy|contract|blocked_by_model/u.test(message)) return "POLICY";
  if (["timed_out", "transport_failed"].includes(status) || /\b429\b|rate.limit|temporar|timeout|timed out|overload|service unavailable|econnreset|network/u.test(message)) return "TRANSIENT";
  return "DETERMINISTIC";
}

export function retryableDelegationFailure(value) {
  return ["TRANSIENT", "STRUCTURED_OUTPUT_MODEL_INVALID"].includes(classifyDelegationFailure(value));
}
