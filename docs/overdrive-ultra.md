# Pi Overdrive Ultra

## Design contract

Ultra adds an OMP-class tool plane beneath the existing Overdrive control plane. It does not replace Pi, authentication, model routes, Council/Judge, workflow receipts, sandboxing, or Second Brain.

```text
task → Task Governor → task policy
                     ├─ Model Governor (existing routes/callability)
                     ├─ Context Governor (SmartRead + memory + artifacts)
                     └─ Tool Governor (small task-specific surface)
                                      ↓
                           existing secure workflow
                                      ↓
            transactional edit / AST / LSP / DAP / eval
                                      ↓
                    safe execution + Bubblewrap + receipts
```

The architecture is lazy and fail-soft. Optional parsers, debugger adapters, eval kernels, browser processes, and Sentinel sessions start only when the task policy requires them. Their absence must produce a bounded degraded result, never prevent ordinary Pi startup.

## Frozen invariants

- Official Pi 0.85.1 installation and existing authentication are not modified by development.
- Existing provider identities, role assignments, fallback order, thinking policy, Council composition, Judge sequencing, and retry categories remain authoritative.
- Council has three independent read-only members. Members receive the same initial evidence but never another member's output; Judge runs only after three valid results.
- Autonomous concurrency is 3, depth is 1, correction rounds are 2, and the derived session spawn budget is 42.
- Worker stays sandboxed in the workflow worktree; Tester stays non-mutating.
- Second Brain remains OpenViking + Hindsight + ACE + Memory Router + Shared Memory Pack + Obsidian, with local CPU embeddings.
- No feature may turn secrets, raw prompts, file bodies, or provider output into trace metadata.
- A disabled or unavailable optional feature must leave the basic `read`/`edit`/`write` path usable.

## Planned subsystems

The implementation order is deliberate: Task Governor and Tool Governor land before new large schemas. ResourceFS provides typed, policy-checked URIs. SmartRead selects bounded views. Artifact Store externalizes large outputs. Context Governor builds one provenance-bearing Task Context Pack. Edit Engine V2 and AST transactions operate through snapshots and LSP validation. DAP and eval are isolated, lazy runtimes. StreamGuard can correct an in-flight trajectory without duplicate injections. Sentinel is read-only and policy-gated. Agent Hub consumes metadata and authoritative receipts. Director Mode is an explicit state machine, never an approval bypass.

Git/GitHub resources, commit planning, imported rule formats, ACP, browser expansion, computer use, collaboration and native fast paths follow only after their security and overhead are measured. Computer use and collaboration may be intentionally deferred when the safe design is not better than omission. Native code is justified only by profiling.

## Evidence policy

Every phase has a focused test, local benchmark when relevant, local commit, and an entry in `docs/overdrive-ultra-progress.md`. Cross-product claims are scoped to the category actually measured. A missing OMP runtime or missing comparable metric is `NOT RUN`, not a win.

No OMP source has been copied as of Phase 0. Any later reuse must retain MIT attribution and be listed with its source path and commit; clean-room implementation remains preferred.
