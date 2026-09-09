# Model routing

| Role | Model | Thinking | Why |
|---|---|---:|---|
| Main supervisor | gpt-5.6-terra | medium | Balanced default for interactive coding |
| Scout | gpt-5.6-luna | low | Cheap, fast repository reconnaissance |
| Tester | gpt-5.6-luna | medium | Fast evidence gathering and failure triage |
| Simplicity reviewer | gpt-5.6-luna | medium | Focused reduction pass |
| Worker | gpt-5.6-terra | high | Reliable implementation on a scoped plan |
| Planner | gpt-5.6-sol | high | Strong reasoning before expensive edits |
| Correctness/security reviewers | gpt-5.6-sol | high | Adversarial, high-stakes analysis |
| Oracle | gpt-6-astra | high | Rare, hardest second opinion only |

Do not escalate merely because a task is long. Escalate when uncertainty, architectural coupling, security impact, or repeated contradictory evidence makes stronger reasoning valuable. The enforced model scope rejects models outside the configured OpenAI Codex families and prevents accidental cross-provider routing.

Keep the model tool surface stable within a session. Search and MCP capabilities use proxy-style compact tools; specialists expose only their allowlisted tools. This reduces schema cost and preserves cache reuse.

The E2E validator compares the complete runtime route, including thinking suffix: Luna `:low` for Scout, Luna `:medium` for Tester/Simplicity, Terra `:high` for Worker, Sol `:high` for Planner/Correctness/Security, and Astra `:high` for Oracle. A missing or different suffix fails validation.
