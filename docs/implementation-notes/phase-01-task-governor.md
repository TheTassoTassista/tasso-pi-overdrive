# Phase 1 implementation note — Task Governor

## Reference inspection

This phase rechecked OMP's task spawn policy, structured-subagent, read-only policy, goal loop, and current task-related issue evidence at pinned commit `4267074ac91456866e95ed8de0b6353388f08502`. The useful architectural lesson is to make task selection controller-owned and inspectable while keeping execution-time attestation authoritative. No OMP source was copied.

## Smallest coherent design

`lib/task-governor.mjs` composes the existing Token Governor, Memory Router, and memory budget policy. One deterministic pass emits a versioned, digest-bound Task Policy containing:

- difficulty, risk categories, expected scope, and available-context pressure;
- model roles and existing call/retry/correction limits;
- memory need and bounded pack budget;
- capability intent for the later Tool Governor;
- Planner, Second Brain, SmartRead, LSP, debugger, eval, Sentinel, reviewer, Council, browser, web, and verification decisions;
- applied and blocked explicit choices.

The policy never stores the task text and records `decisionModelCalls: 0`. Explicit choices are accepted by the library; a requested disable is rejected only for Planner, reviewer, or Council when that would remove a mandatory high-risk control.

The secure workflow now persists the policy, validates it on resume, publishes a metadata-only decision event, and avoids constructing a Second Brain pack for a small direct edit. Existing workflows without a stored Task Policy remain resumable and are upgraded at the next checkpoint.

`/task-policy [--json] TASK` gives a local, zero-model-call preview. It does not change the session or persistent routing.

## Compatibility boundary

With no explicit Task Policy choices, the resolved Token Governor routing is unchanged except that a short direct string/label edit suppresses an otherwise unnecessary Scout. Model identities, provider fallback order, quality overlay, Council membership/Judge sequencing, retry categories, concurrency 3, depth 1, correction rounds 2, and spawn budget 42 are unchanged.

This phase declares capability intent only. Actual schema visibility is deliberately left to Phase 2; debugger, eval, Sentinel, and browser intent cannot make those tools appear by itself.

## Evidence

- 11 Task Governor tests cover the two required examples, deterministic digest, safe overrides, security elevation, context pressure, token-saver budgets, metadata privacy, and workflow resume binding.
- The real Pi command smoke proves `/task-policy` is registered and completes with no inference/provider event.
- The four-case benchmark performs 10,000 policy decisions, records zero model/provider calls, and keeps OMP numeric status `NOT_RUN` while Bun is unavailable.
