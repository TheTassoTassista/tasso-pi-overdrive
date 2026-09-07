# Workflow

## Task sizing

- Trivial, well-bounded change: supervisor inspects, edits, and verifies directly.
- Unfamiliar or cross-cutting change: scout first, then planner.
- Risky decision or stubborn failure: oracle before more edits.
- Implementation: one worker per checkout.
- Validation: tester plus the relevant adversarial reviewer(s).

The normal substantial path is scout → planner → worker → tester → correctness review → fix → verification. Add security review only when a trust boundary, credential, parser, network surface, authorization rule, filesystem boundary, or dependency changes. Add simplicity review when the diff introduces new abstraction or configuration.

## Context lifecycle

Use FFF/LSP/AST discovery before opening whole files. Read narrow ranges and ask child agents for compact evidence. Put only durable state into `task_notebook`: decisions, constraints, verified evidence, and immediate next actions.

At 70% context, finish the current phase. At 85%, update the notebook and run `/handoff <next goal>`. The handoff uses the current model for one bounded distillation, opens a clean session, and leaves the result editable before submission.

## Delegation contract

Every child task should contain the exact goal, relevant paths, constraints, acceptance criteria, expected output shape, and whether edits are allowed. A reviewer never edits. A worker does not reinterpret an unapproved product decision. A tester reports commands and results without claiming skipped checks.

Parallel work is useful only for independent reads, independent reviews, or separate worktrees. Do not parallelize two writers into one checkout or operations that depend on each other's result.
