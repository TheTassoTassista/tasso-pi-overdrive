---
name: code-review
description: Review diffs adversarially for correctness, maintainability, tests, and scope. Use for PRs, working-tree reviews, or final implementation checks.
---
# Code Review

Read the task, repository rules, diff, affected callers, and tests. Reconstruct behavior rather than reviewing lines in isolation.

Try to disprove correctness: inspect error paths, boundaries, state transitions, concurrency, compatibility, and untested behavior. Check security only where a trust boundary is involved and simplicity where added structure may be unnecessary.

Report actionable findings first with severity, exact file/line evidence, impact, and minimal fix. Avoid vague preferences and praise. State verification gaps explicitly.
