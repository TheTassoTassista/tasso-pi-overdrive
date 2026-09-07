---
description: Run adversarial correctness, security, and simplicity review
argument-hint: "[intended change]"
---
Review intent: ${@:-infer from the task and diff, marking uncertainty}.

Inspect the current diff and its callers/tests. Run independent correctness and simplicity reviewers; add security review only where the change crosses trust, authentication, data, command, network, or persistence boundaries. Findings must include severity, file/line evidence, impact, and minimal fix. Reject style-only noise. Synthesize blockers first and explicitly state verification gaps.
