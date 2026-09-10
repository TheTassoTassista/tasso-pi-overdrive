import { classifyDelegationFailure } from "./delegation-failure.mjs";
import { canonicalExecutedRoute } from "./model-policy.mjs";

const SPAWN_BUDGET_ERROR = /subagent spawn limit|spawn budget|INSUFFICIENT_SUBAGENT_SPAWN_BUDGET|ATOMIC_SUBAGENT_SPAWN_BUDGET_EXHAUSTED/iu;

export function delegationWasLaunched(response) {
  if (response?.status === "completed") return true;
  return [response?.runId, response?.model, response?.thinking, response?.launchContractDigest]
    .some((value) => typeof value === "string" && value.length > 0);
}

export function delegationFailureReason(response) {
  const message = `${response?.error ?? ""} ${response?.message ?? ""}`;
  if (SPAWN_BUDGET_ERROR.test(message)) return "SUBAGENT_SPAWN_BUDGET_EXHAUSTED";
  return undefined;
}

export function canonicalizeDelegationResponse(route, response) {
  const launched = delegationWasLaunched(response);
  let canonicalResponse;
  if (launched) {
    try {
      canonicalResponse = canonicalExecutedRoute(route, response);
    } catch (error) {
      canonicalResponse = {
        ...response,
        status: "protocol_rejected",
        error: `model route attestation rejected: ${error instanceof Error ? error.message : "unknown error"}`,
      };
    }
  } else {
    canonicalResponse = {
      ...response,
      launchStatus: "not_launched",
      modelCalls: 0,
    };
  }
  if (canonicalResponse.status !== "completed") {
    canonicalResponse.failureCategory = classifyDelegationFailure(canonicalResponse);
    canonicalResponse.failureReason = delegationFailureReason(canonicalResponse);
  }
  return canonicalResponse;
}
