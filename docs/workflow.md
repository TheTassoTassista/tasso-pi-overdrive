# Workflow

## Task sizing and adaptive path

The persistent preset and session quality overlay resolve to an internal Token Governor decision before runtime allocation. The default `normal + auto` path classifies bounded work as simple, normal, hard or critical. The controller—not model/tool input—selects role booleans, context limits, Council authorization and a model-call ceiling.

- Simple: Worker → deterministic sandboxed verification → stop.
- Normal: optional compact Scout/Planner evidence → Worker → deterministic verification → stop when solved.
- Hard: Scout/Planner → Worker → deterministic verification → AI Tester or an appropriate reviewer only when useful.
- Critical/security-sensitive/disputed: strong planning and specialized review; Council only when justified.

`token-saver` bypasses planning, Tester AI and reviewers on a successful simple/default path. It escalates after concrete failure rather than repeating a cheap model. A blocking review or failed verification still mechanically schedules a correction Worker, then complete deterministic re-verification and the necessary Tester/reviewer evidence. The correction maximum remains two; exhaustion returns FAIL. See [model-routing.md](model-routing.md) for exact routes and quality semantics.

## Council escalation

Council is not part of trivial or ordinary successful work. The controller invokes it for an explicit `/council` request, critical risk at an authorized quality, an authorized material split between reviewer verdicts, or the second correction after repeated failure (with Oracle root-cause evidence). `/council-status` and `/ai-tree` are read-only views of routes and limits.

Exactly three profiles run concurrently: `council-1` checks behavioral correctness, `council-2` checks security/failure containment, and `council-3` checks simplicity/operations. Each receives the same bounded evidence packet in a fresh context, has no mutation/delegation/web tool, and cannot see a peer's first answer. Their profiles explicitly use advisory completion semantics (`completionGuard: false`), so a correct zero-edit analysis succeeds without weakening the read-only boundary. Pi-subagents' native per-invocation structured schema requires conclusion, recommendation, evidence, confidence, risks, and blocking concerns; prose-only, partial, malformed, wrong-identity, or duplicated results fail closed before synthesis.

Only then does `council-judge` receive the three reports in its own fresh read-only context. Its structured result must state the decision basis, agreements, disagreements, required actions, and confidence. Disagreement is retained rather than reduced to a majority vote. The decision is supplied to the next Worker plan/correction, but never bypasses Tester, verification, reviewers, receipts, or cleanup.

Council uses the same compile-time limits as the workflow: concurrency three, subagent depth one, and two correction rounds. These fields are absent from its caller-facing path; recursive model/tool attempts to set model, provider, thinking, workflow scripts, nesting, or larger fan-out are blocked before pi-subagents executes them. Council profiles do not contain the `subagent` tool, so a nested council is impossible through their runtime surface.

## Spawn budget

`lib/workflow-spawn-budget.mjs` is the single source of truth for the delegation budget. Under the current 3/1/2 workflow policy, the worst valid no-retry path is 39 spawns:

- core Scout + Planner + initial Worker: `3`
- optional high-risk Oracle + Council members + Judge: `5`
- three Tester/reviewer rounds: `3 × (1 + 3) = 12`
- two correction Workers: `2`
- worst-case reviewer-disagreement Council + Judge in all three rounds: `3 × 4 = 12`
- second-correction repeated-failure Oracle + Council + Judge: `5`

The supported retry policy is one retry per delegation, bounded globally to three retries per workflow. Eligible failures are transport/timeout/rate-limit `TRANSIENT` failures and `STRUCTURED_OUTPUT_MODEL_INVALID` after a real child launch with an attested route. The shared reserve is therefore `min(39 × 1, 3) = 3`; required total is `39 + 3 = 42`. The static pi-subagents session limit is 42. Package validation and clean-HOME bootstrap both fail if the configured limit drops below the derived total or a future policy change outgrows it.

`secure_coding_workflow` reads the active regular, non-symlinked subagent config and performs this preflight before runtime allocation, Scout, or any model call. Insufficient configuration fails with `INSUFFICIENT_SUBAGENT_SPAWN_BUDGET` and non-sensitive configured/required/policy metadata, consuming zero delegations and zero model calls. Council member-plus-Judge blocks and reviewer fanouts reserve their remaining base slots atomically; a block that cannot fit is rejected before its first child. Retry claims cannot consume an active atomic reservation. Durable resume restores both used-spawn and retry counters and rejects missing or inconsistent pre-fix accounting.

The controller's guard accounts for the current enforced workflow. Pi-subagents owns the authoritative session-wide counter. Its installed API does not expose that live counter to another extension, so unrelated manual subagent calls already made in the same Pi session cannot be subtracted during the initial controller preflight; the upstream limit still rejects such a collision before provider launch, and the corrected diagnostic remains `RESOURCE_LIMIT` / `SUBAGENT_SPAWN_BUDGET_EXHAUSTED` with `modelCalls=0`. Start a fresh Pi session before a maximum-path autonomous run if the same session has already used manual subagents.

The configured Council target is OpenAI Sol high + DeepSeek V4 Pro High through OmniRoute + Qwen 3.8 through OmniRoute, followed by direct OpenAI Astra high as Judge. DeepSeek and Qwen are different model families behind one shared gateway, so this is not infrastructure independence. Newly catalogued OmniRoute IDs remain `RUNTIME_UNKNOWN` until genuine callability evidence exists; live resolution then uses the declared direct fallbacks rather than treating metadata presence as inference proof.

The adaptive controller is workflow version 5. Before the first role starts it writes an owner-only, atomically replaced journal under `${XDG_STATE_HOME:-~/.local/state}/pi-overdrive/workflow-evidence/<run-id>/state.json`. Every phase boundary is fsynced. The journal records the task/repository identity, frozen preset/quality/difficulty/governor decision, per-workflow protocol nonce, controller-owned monotonic checkpoint sequence, process boot identity, current phase and round, completed roles, review and verification outcomes, blocker counts, correction status, cleanup/evidence state, and timestamps. Role prose retained for resumption is secret-redacted; terminal journals retain bounded metadata.

Every terminal role attempt first writes an owner-only immutable receipt under the run's `role-receipts/` directory. A receipt binds a UUID execution ID and deterministic sequence number to exactly one run, task, nonce, role, round, iteration, attempt, node, owner, terminal status, exit code, provider/model, thinking level, provider-reported usage, and result/error digest. Creation uses a private temporary file, file sync, atomic no-replace publication, and parent-directory sync; identical duplicate bytes are idempotent and conflicts fail closed. The controller reopens and validates that durable receipt, including the active policy's model and thinking route, before admitting the role transition. Missing, malformed, truncated, stale, cross-run, cross-task, wrong-role/round/model/thinking, duplicate-conflicting, or out-of-order receipts cannot advance the state machine.

Usage accounting copies only bounded numeric terminal fields exposed by `pi-subagents`: input/output/cache-read/cache-write tokens, cost, turns, tool calls, and duration. Provider-reported total or reasoning tokens are retained when present; otherwise the total is explicitly labelled as derived from the four reported token components and reasoning remains unavailable. Missing usage is `UNAVAILABLE`, never zero. Failed attempts and retries remain separate immutable entries, execution IDs are deduplicated during aggregation, Council has its own aggregate, and estimates are kept separate as `NOT_COMPUTED`. No inference call is made for accounting.

Delegation failures are classified as `TRANSIENT`, `DETERMINISTIC`, `POLICY`, `RESOURCE_LIMIT`, `AUTH`, `UNSUPPORTED_MODEL`, `STRUCTURED_OUTPUT_POLICY_ERROR`, or `STRUCTURED_OUTPUT_MODEL_INVALID` in new audit evidence. Invalid or unavailable local schemas, schema compilation/configuration failures, and all structured failures without both launch proof and route attestation are deterministic `STRUCTURED_OUTPUT_POLICY_ERROR` and never retry. Only an attested `structured_output_failed` response produced after launch is `STRUCTURED_OUTPUT_MODEL_INVALID`; it may use one retry on the exact same role/model/thinking route. A second invalid result fails closed. Together with transport transients, these retries share the existing three-spawn workflow reserve; no second retry budget exists. Auth, policy, unsupported model, resource/spawn limits, role/contract/run/task/route mismatch, read-only mutation, sequencing, and malformed state remain no-retry.

Each structured failure receipt records a closed, validated metadata object: failure stage, native schema version, validation keyword/path when safely extractable, missing/unexpected field names, parse-error class, provider/model/thinking, attempt, output length when available, and a raw-output digest when available. It never stores the prompt, raw model output, file contents, or arbitrary provider error text. The installed pi-subagents bridge uses native `outputSchema` mode but intentionally projects no invalid raw output after failure, so output length/digest are normally null while the error digest remains available. Controller-side markdown/JSON normalization was deliberately not added: the bridge exposes either already validated structured data or no raw candidate, and guessing from prose would weaken schema enforcement.

On every invocation the controller scans for stale `RUNNING` journals. A dead process, changed Linux boot ID, or reused PID changes the state to `INTERRUPTED`; it is never inferred to be successful. A call with the same canonical repository and task digest resumes the earliest safe structured checkpoint. An explicit prior run ID may also be supplied. Missing, truncated, malformed, stale-task, wrong-run, or digest-mismatched evidence fails closed. A crash after the immutable execution snapshot or cleanup can be finalized without rerunning completed work, but only after independently revalidating the snapshot, resource absence, receipt digest, and final journal.

Runtime allocation metadata is also written before a port or worktree is created. Recovery releases stale port locks and either resumes the retained Git worktree with a newly allocated port/state/browser session or removes an incomplete allocation. It never removes an unrelated worktree or browser profile.

## Context lifecycle

Use FFF, TypeScript semantic navigation, and AST discovery before opening whole files. Read narrow ranges and ask child agents for compact evidence. Put only durable state into `task_notebook`: decisions, constraints, verified evidence, and immediate next actions.

At 70% context, finish the current phase. At 85%, update the notebook and run `/handoff <next goal>`. The handoff uses the current model for one bounded distillation, opens a clean session, and leaves the result editable before submission.

## Delegation contract

Every child task receives the exact goal, assigned worktree, unique runtime identifiers, constraints, and expected output shape. Reviewers never receive mutation tools. Worker has guarded edits plus Bubblewrap-backed commands and a narrowly scoped single-file delete. Tester has no edit, write, shell, or general execution tool and invokes only the sandboxed verification gate.

Parallel work is useful only for independent reads, independent reviews, or separate worktrees. Do not parallelize two writers into one checkout or operations that depend on each other's result.

The controller fixes reviewer fan-out at three and subagent depth at one. Neither value appears in the workflow tool schema; generic `subagent` attempts to override them or launch Worker/Tester without worktree isolation are rejected by the safety hook.
