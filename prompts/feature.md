---
description: Deliver a feature through scope, implementation, verification, and review
argument-hint: "<feature goal>"
---
Feature goal: ${@:-describe the feature}.

Clarify only decisions that materially affect the result. Use scout for repository evidence and planner for a concise spec with scope, exclusions, acceptance criteria, and verification. For substantial work, run the worker in a managed Git worktree; keep one writer per checkout. Have tester verify real behavior, then run fresh correctness and simplicity reviews plus security review when a trust boundary changes. Fix blockers, rerun verification, inspect the final diff, and summarize evidence and remaining limitations.
