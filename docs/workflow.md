# Workflow

## Task sizing

- Trivial, well-bounded change: supervisor inspects, edits, and verifies directly.
- Unfamiliar or cross-cutting change: scout first, then planner.
- Risky decision or stubborn failure: oracle before more edits.
- Implementation: one worker per checkout.
- Validation: tester plus the relevant adversarial reviewer(s).

The normal substantial path is the `secure_coding_workflow` state machine: Scout → Planner → optional Oracle → Worker → Tester → sandboxed verification → correctness/security/simplicity reviews. A blocking review or failed verification mechanically schedules a correction Worker, then Tester, verification, and every reviewer again. The correction maximum is two; exhaustion returns FAIL.

## Council escalation

Council is not part of trivial or ordinary successful work. The controller invokes it for an explicitly high-risk run (`includeOracle: true`), a material split between mandatory reviewer verdicts, or the second correction after repeated failure (with Oracle root-cause evidence). `/council TASK` is an Overdrive extension command that enters this same enforced controller path; it has tested precedence over the raw pi-subagents prompt with the same name. `/council-status` is the authoritative read-only view of routes and limits.

Exactly three profiles run concurrently: `council-1` checks behavioral correctness, `council-2` checks security/failure containment, and `council-3` checks simplicity/operations. Each receives the same bounded evidence packet in a fresh context, has no mutation/delegation/web tool, and cannot see a peer's first answer. Their profiles explicitly use advisory completion semantics (`completionGuard: false`), so a correct zero-edit analysis succeeds without weakening the read-only boundary. Pi-subagents' native per-invocation structured schema requires conclusion, recommendation, evidence, confidence, risks, and blocking concerns; prose-only, partial, malformed, wrong-identity, or duplicated results fail closed before synthesis.

Only then does `council-judge` receive the three reports in its own fresh read-only context. Its structured result must state the decision basis, agreements, disagreements, required actions, and confidence. Disagreement is retained rather than reduced to a majority vote. The decision is supplied to the next Worker plan/correction, but never bypasses Tester, verification, reviewers, receipts, or cleanup.

Council uses the same compile-time limits as the workflow: concurrency three, subagent depth one, and two correction rounds. These fields are absent from its caller-facing path; recursive model/tool attempts to set model, provider, thinking, workflow scripts, nesting, or larger fan-out are blocked before pi-subagents executes them. Council profiles do not contain the `subagent` tool, so a nested council is impossible through their runtime surface.

The current catalog has one authenticated provider (`openai-codex`) and four runtime-callable council identities under the efficient preset: Sol, 5.5, Luna, and Astra as judge. The rejected `gpt-5.4` route is skipped before fan-out with an explicit reason. This is model-identity diversity, not cross-provider diversity.

The controller is workflow version 4. Before the first role starts it writes an owner-only, atomically replaced journal under `${XDG_STATE_HOME:-~/.local/state}/pi-overdrive/workflow-evidence/<run-id>/state.json`. Every phase boundary is fsynced. The journal records the task/repository identity, a per-workflow protocol nonce, a controller-owned monotonic checkpoint sequence, process boot identity, current phase and round, completed roles, review and verification outcomes, blocker counts, correction status, cleanup/evidence state, and timestamps. Role prose retained for resumption is secret-redacted; terminal journals retain bounded metadata.

Every terminal role attempt first writes an owner-only immutable receipt under the run's `role-receipts/` directory. A receipt binds a UUID execution ID and deterministic sequence number to exactly one run, task, nonce, role, round, iteration, attempt, node, owner, terminal status, exit code, provider/model, thinking level, and result/error digest. Creation uses a private temporary file, file sync, atomic no-replace publication, and parent-directory sync; identical duplicate bytes are idempotent and conflicts fail closed. The controller reopens and validates that durable receipt, including the active policy's model and thinking route, before admitting the role transition. Missing, malformed, truncated, stale, cross-run, cross-task, wrong-role/round/model/thinking, duplicate-conflicting, or out-of-order receipts cannot advance the state machine.

Delegation failures are classified as `TRANSIENT`, `DETERMINISTIC`, `POLICY`, `AUTH`, `UNSUPPORTED_MODEL`, or `STRUCTURED_OUTPUT` in audit evidence. Only plausibly transient transport/timeout/rate-limit failures may use the single bounded retry; all other categories terminate that role immediately.

On every invocation the controller scans for stale `RUNNING` journals. A dead process, changed Linux boot ID, or reused PID changes the state to `INTERRUPTED`; it is never inferred to be successful. A call with the same canonical repository and task digest resumes the earliest safe structured checkpoint. An explicit prior run ID may also be supplied. Missing, truncated, malformed, stale-task, wrong-run, or digest-mismatched evidence fails closed. A crash after the immutable execution snapshot or cleanup can be finalized without rerunning completed work, but only after independently revalidating the snapshot, resource absence, receipt digest, and final journal.

Runtime allocation metadata is also written before a port or worktree is created. Recovery releases stale port locks and either resumes the retained Git worktree with a newly allocated port/state/browser session or removes an incomplete allocation. It never removes an unrelated worktree or browser profile.

## Context lifecycle

Use FFF, TypeScript semantic navigation, and AST discovery before opening whole files. Read narrow ranges and ask child agents for compact evidence. Put only durable state into `task_notebook`: decisions, constraints, verified evidence, and immediate next actions.

At 70% context, finish the current phase. At 85%, update the notebook and run `/handoff <next goal>`. The handoff uses the current model for one bounded distillation, opens a clean session, and leaves the result editable before submission.

## Delegation contract

Every child task receives the exact goal, assigned worktree, unique runtime identifiers, constraints, and expected output shape. Reviewers never receive mutation tools. Worker has guarded edits plus Bubblewrap-backed commands and a narrowly scoped single-file delete. Tester has no edit, write, shell, or general execution tool and invokes only the sandboxed verification gate.

Parallel work is useful only for independent reads, independent reviews, or separate worktrees. Do not parallelize two writers into one checkout or operations that depend on each other's result.

The controller fixes reviewer fan-out at three and subagent depth at one. Neither value appears in the workflow tool schema; generic `subagent` attempts to override them or launch Worker/Tester without worktree isolation are rejected by the safety hook.
