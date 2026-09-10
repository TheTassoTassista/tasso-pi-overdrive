const ADVISORY = new Set(["scout", "planner", "oracle", "tester", "correctness-reviewer", "security-reviewer", "simplicity-reviewer", "council-1", "council-2", "council-3", "council-judge"]);

export function validateRoleCompletion({ role, status, mutationAttempted = false, mutationObserved = false, implementationRequired = false }) {
  if (status !== "completed") throw new Error(`role_completion_failed:${role}:${status ?? "missing"}`);
  if (ADVISORY.has(role) && (mutationAttempted || mutationObserved)) throw new Error(`read_only_role_mutation:${role}`);
  if (role === "worker" && implementationRequired && !mutationObserved) throw new Error("worker_required_mutation_missing");
  return true;
}

export function isAdvisoryRole(role) { return ADVISORY.has(role); }
