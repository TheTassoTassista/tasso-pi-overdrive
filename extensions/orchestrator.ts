import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GUIDANCE = `
Pi Overdrive workflow:
- Keep context small: search first, then read only relevant ranges. Prefer FFF, LSP, and AST tools when they fit.
- For trivial work, act directly. For non-trivial work, use isolated specialists at phase boundaries: scout, planner, worker, tester, then adversarial reviewers.
- Use managed Git worktrees for concurrent writers or substantial isolated implementation; never let two writers share a checkout.
- Ask the user only for a decision that materially changes the result. Never inspect secret files or reveal credentials.
- Before claiming completion, run the verification gate and report real PASS/FAIL/SKIP evidence. Fix blocking review findings and verify again.
`;

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => ({ systemPrompt: `${event.systemPrompt}\n${GUIDANCE}` }));
}
