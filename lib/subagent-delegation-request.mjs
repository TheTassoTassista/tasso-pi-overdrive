// Keep the emitted payload limited to pi-subagents' structured delegation API.
// Internal routing metadata is published separately and must never be forwarded.
export function subagentDelegationRequest({ requestId, ownerRunId, nodeId, agent, task, context, cwd, model, thinking, timeoutMs, toolBudget, artifacts, result }) {
  return { requestId, ownerRunId, nodeId, agent, task, context, cwd, model, thinking, timeoutMs, toolBudget, artifacts, result };
}
