# Phase 15 — bounded Director Mode

## Decision

The pinned OMP Vibe Mode was reviewed at commit `4267074ac91456866e95ed8de0b6353388f08502`. Its useful idea is reducing the top-level agent to direction and verification while isolated workers mutate. Ultra does not copy OMP's persistent fast/good worker sessions, transcript retention, asynchronous self-delivery, steer/send/wait/kill tools, or process-global worker registry. Those mechanisms would duplicate Overdrive's controller, widen authority, and bypass the already-proven receipt/correction/Council lifecycle.

Ultra implements `/director TASK` as an explicit, one-task policy gate over the existing `secure_coding_workflow`. The deterministic Task Governor must classify the exact task as mutating, non-trivial, and already deserving Planner, reviewer, or Council participation. Read-only tasks, direct small edits, and work without delegation value are rejected before provider entry. The task is submitted once as the user's normal turn; the mode automatically exits on `agent_settled`.

## Enforcement and authority

Tool Governor resolves the normal task-aware surface first. Director then intersects it with a fixed read/plan/delegate/verify allowlist and requires `read`, `secure_coding_workflow`, and `verification_gate`. A separate `tool_call` barrier enforces the same allowlist, so manual selection, explicit CLI state, or a later extension cannot resurrect direct edit/write, structural rewrite, shell, `safe_exec`, raw subagent, browser, destructive, or unknown authority. There is no fallback. The previous surface is restored only after the task settles or an idle user cancellation.

The turn-local Director instruction tells the primary agent to inspect, form a bounded plan, delegate every repository mutation through the secure workflow, and accept no prose claim without durable receipts, deterministic verification, reviewers, final evidence, and cleanup. Director Mode registers no model-facing tool, provider, process, role, worker registry, retry, model route, worktree, runtime allocation, receipt store, or state machine. The existing controller still enforces concurrency 3, depth 1, two correction rounds, the 39+3 spawn envelope, sandbox/worktree isolation, Tester non-mutation, reviewer correction, and Council-before-Judge sequencing. Agent Hub remains only the read-only projection.

## Privacy and lifecycle

Activation is session-local and bound to the SHA-256 digest of the exact submitted task plus the Task Policy digest used for the decision. The exact task is reclassified before provider entry; normal context-pressure changes may change the Task Policy digest but cannot weaken eligibility. A changed or newly ineligible task fails closed to read-only. Metadata events contain only status, reason code, session/task/policy digests, active-tool count, an optional blocked tool name, and timestamp—never the task, prompt, tool arguments/results, files, role output, or secrets.

## Evidence

- Nine focused/adversarial cases cover fixed policy, tiny/read-only denial, eligible delegation, context-pressure reclassification, allowlisted surface selection, required-tool failure, independent runtime denial, bounded instructions, metadata rejection/privacy, extension authority, existing controller ownership, and task-digest bounds.
- The real Pi 0.85.1 benchmark proves command discovery, zero-call status/tiny denial, explicit eligible activation, the actual secure-workflow and verification schemas, prompt injection, automatic exit, and exact prior-surface restoration.
- A fixture re-adds `write` after the normal clamp. The provider attempts it; the Director barrier blocks it before execution and the sentinel file remains absent. Two deterministic local turns complete with zero external/network/paid calls, cost zero, and no process/state residue.

Director Mode intentionally does not split work into independently steerable persistent workers. It uses the existing isolated Worker and bounded correction attempts because that path already has the required evidence and security semantics. No OMP source was copied; OMP remains source-inspected only because its Bun >=1.4 runtime is unavailable on this host.
