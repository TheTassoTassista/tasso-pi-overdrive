export const FAILURE_CATEGORIES = Object.freeze(["TRANSIENT", "DETERMINISTIC", "POLICY", "AUTH", "UNSUPPORTED_MODEL", "STRUCTURED_OUTPUT"]);

export function classifyDelegationFailure(value) {
  const status = String(value?.status ?? "").toLowerCase();
  const message = `${value?.message ?? ""} ${value?.error ?? ""}`.toLowerCase();
  if (status === "structured_output_failed" || /structured.output|schema|malformed result|missing structured/u.test(message)) return "STRUCTURED_OUTPUT";
  if (/unsupported.model|model.+not supported|unknown model/u.test(message)) return "UNSUPPORTED_MODEL";
  if (/\b401\b|unauthori[sz]ed|authentication|credential|api key|missing.+auth/u.test(message)) return "AUTH";
  if (["protocol_rejected", "invalid_request", "duplicate_node", "acceptance_failed", "tool_budget_exhausted"].includes(status) || /role mismatch|policy|contract|blocked_by_model/u.test(message)) return "POLICY";
  if (["timed_out", "transport_failed"].includes(status) || /\b429\b|rate.limit|temporar|timeout|timed out|overload|service unavailable|econnreset|network/u.test(message)) return "TRANSIENT";
  return "DETERMINISTIC";
}

export function retryableDelegationFailure(value) {
  return classifyDelegationFailure(value) === "TRANSIENT";
}
