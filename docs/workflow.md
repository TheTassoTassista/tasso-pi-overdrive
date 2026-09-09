# Workflow

## Task sizing

- Trivial, well-bounded change: supervisor inspects, edits, and verifies directly.
- Unfamiliar or cross-cutting change: scout first, then planner.
- Risky decision or stubborn failure: oracle before more edits.
- Implementation: one worker per checkout.
- Validation: tester plus the relevant adversarial reviewer(s).

The normal substantial path is the `secure_coding_workflow` state machine: Scout → Planner → optional Oracle → Worker → Tester → sandboxed verification → correctness/security/simplicity reviews. A blocking review or failed verification mechanically schedules a correction Worker, then Tester, verification, and every reviewer again. The correction maximum is two; exhaustion returns FAIL.

The controller is workflow version 4. Before the first role starts it writes an owner-only, atomically replaced journal under `${XDG_STATE_HOME:-~/.local/state}/pi-overdrive/workflow-evidence/<run-id>/state.json`. Every phase boundary is fsynced. The journal records the task/repository identity, a per-workflow protocol nonce, a controller-owned monotonic checkpoint sequence, process boot identity, current phase and round, completed roles, review and verification outcomes, blocker counts, correction status, cleanup/evidence state, and timestamps. Role prose retained for resumption is secret-redacted; terminal journals retain bounded metadata.

Every terminal role attempt first writes an owner-only immutable receipt under the run's `role-receipts/` directory. A receipt binds a UUID execution ID and deterministic sequence number to exactly one run, task, nonce, role, round, iteration, attempt, node, owner, terminal status, exit code, route, and result/error digest. Creation uses a private temporary file, file sync, atomic no-replace publication, and parent-directory sync; identical duplicate bytes are idempotent and conflicts fail closed. The controller reopens and validates that durable receipt before admitting the role transition. Missing, malformed, truncated, stale, cross-run, cross-task, wrong-role/round, duplicate-conflicting, or out-of-order receipts cannot advance the state machine.

On every invocation the controller scans for stale `RUNNING` journals. A dead process, changed Linux boot ID, or reused PID changes the state to `INTERRUPTED`; it is never inferred to be successful. A call with the same canonical repository and task digest resumes the earliest safe structured checkpoint. An explicit prior run ID may also be supplied. Missing, truncated, malformed, stale-task, wrong-run, or digest-mismatched evidence fails closed. A crash after the immutable execution snapshot or cleanup can be finalized without rerunning completed work, but only after independently revalidating the snapshot, resource absence, receipt digest, and final journal.

Runtime allocation metadata is also written before a port or worktree is created. Recovery releases stale port locks and either resumes the retained Git worktree with a newly allocated port/state/browser session or removes an incomplete allocation. It never removes an unrelated worktree or browser profile.

## Context lifecycle

Use FFF, TypeScript semantic navigation, and AST discovery before opening whole files. Read narrow ranges and ask child agents for compact evidence. Put only durable state into `task_notebook`: decisions, constraints, verified evidence, and immediate next actions.

At 70% context, finish the current phase. At 85%, update the notebook and run `/handoff <next goal>`. The handoff uses the current model for one bounded distillation, opens a clean session, and leaves the result editable before submission.

## Delegation contract

Every child task receives the exact goal, assigned worktree, unique runtime identifiers, constraints, and expected output shape. Reviewers never receive mutation tools. Worker has guarded edits plus Bubblewrap-backed commands and a narrowly scoped single-file delete. Tester has no edit, write, shell, or general execution tool and invokes only the sandboxed verification gate.

Parallel work is useful only for independent reads, independent reviews, or separate worktrees. Do not parallelize two writers into one checkout or operations that depend on each other's result.

The controller fixes reviewer fan-out at three and subagent depth at one. Neither value appears in the workflow tool schema; generic `subagent` attempts to override them or launch Worker/Tester without worktree isolation are rejected by the safety hook.
