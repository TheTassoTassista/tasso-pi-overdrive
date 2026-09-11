import { classifyDelegationFailure, retryableDelegationFailure } from "./delegation-failure.mjs";
import { MAX_TRANSIENT_RETRIES_PER_DELEGATION } from "./workflow-spawn-budget.mjs";

const MAX_ATTEMPTS = MAX_TRANSIENT_RETRIES_PER_DELEGATION + 1;

/**
 * The attempt bound is deliberately not a caller parameter. Each attempt must
 * claim its controller/upstream spawn slot inside executeAttempt before launch.
 */
export async function executeDelegationWithRetry(executeAttempt, options = {}) {
  if (typeof executeAttempt !== "function") throw new TypeError("executeAttempt must be a function");
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await executeAttempt(attempt);
    } catch (error) {
      lastError = error;
      const failureCategory = error?.failureCategory ?? classifyDelegationFailure(error);
      if (typeof options.onFailure === "function") await options.onFailure(error, { attempt, failureCategory });
      if (attempt >= MAX_ATTEMPTS || !retryableDelegationFailure({ failureCategory })) throw error;
    }
  }
  throw lastError ?? new Error("delegation failed without an error");
}
