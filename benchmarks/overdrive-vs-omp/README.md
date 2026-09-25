# Overdrive vs OMP benchmarks

This directory contains reproducible measurements, not product claims.

- Overdrive base: `0f107b8670b69b214e478b8d854377956f7039be`
- OMP source reference: `4267074ac91456866e95ed8de0b6353388f08502` (`@oh-my-pi/pi-coding-agent` 18.1.21)
- OMP license at that commit: MIT
- Model/provider calls in the Phase 0 baseline: zero

`baseline.mjs` exercises the installed official Pi 0.85.1 read, grep, and edit tools through a local deterministic provider. It records bounded output sizes, request sizes, stale-edit behavior, latency, process-tree size, and resident memory. It hashes tool output rather than persisting fixture content.

Run:

```sh
npm run benchmark:ultra:baseline
npm run benchmark:ultra:task-governor
npm run benchmark:ultra:edit-engine
npm run benchmark:ultra:edit-corpus
npm run benchmark:ultra:ast-edit
npm run benchmark:ultra:lsp-write
npm run benchmark:ultra:stream-guard
npm run benchmark:ultra:sentinel
npm run benchmark:ultra:agent-hub
npm run benchmark:ultra:director
npm run benchmark:ultra:isolation
npm run benchmark:ultra:model-harness
npm run benchmark:ultra:git-resources
npm run benchmark:ultra:commit-planner
npm run benchmark:ultra:watchdog
npm run benchmark:ultra:watchdog-pi
```

`task-governor.mjs` validates four fixed task classes and measures 10,000 deterministic Task Policy decisions. It performs no model or provider call. Its capability list is policy intent; later phases are responsible for implementing and gating optional tools.

`edit-engine.mjs` drives the real Pi read → snapshot → preview → apply lifecycle with a deterministic local provider. It records a safe-relocation success and a preview/apply race denial, receipt privacy/mode, metadata-only events, staged-file cleanup, and slash-command discovery. It performs no network, external-provider, paid-model, or billable call.

`edit-contract-corpus.mjs` executes 20 deterministic classes against the real local transactional engine, including a policy-pinned ast-grep structural case, exact-byte and sidecar oracles, expected safety denials, syntax checks where available, receipts and cleanup. It is not a model/provider comparison or an OMP execution. Unsupported `APPLY_PATCH`, non-transactional `REPLACE`, missing TypeScript/Go syntax checks in this corpus, and absent billing-token evidence are reported explicitly rather than given numeric scores.

`ast-edit.mjs` drives real Pi through read → snapshot → transactional AST preview → atomic apply and a separate stale race. The actual pinned ast-grep CLI rewrites two duplicate call expressions from private snapshot bytes; the benchmark verifies match counts, non-mutating preview, receipt contract/privacy/mode, external-content preservation, staged-file cleanup, and `/ast-edit` discovery. It performs no network, external-provider, paid-model, or billable call.

`lsp-write.mjs` drives real Pi through baseline/candidate overlays and the post-rename guard using the actual pinned TypeScript server. It proves a safe edit receives a post-validated private receipt, an introduced type error is rejected before write, no staged residue remains, and `/lsp-write` discovery starts neither a provider turn nor an LSP process. It performs no network, external-provider, paid-model, or billable call.

`stream-guard.mjs` drives real Pi through fragmented tool-argument streaming, controller reservation, the existing governing safety block, and the next normal deterministic provider turn. It proves reservation-before-delivery, one same-tool correction, no execution, metadata-only receipts, no extra provider turn, lazy command discovery, and cleanup. It performs no network, external-provider, paid-model, or billable call.

`sentinel.mjs` drives the real `/sentinel` command through status, a denied simple task, one accepted hard-debug task, and a repeated invocation. It proves exact Oracle routing, zero tools/retries, context fit, reservation-before-completion, structured untrusted advice, single-use suppression, metadata privacy, unchanged routing, and cleanup. Its one inference is an in-memory deterministic local provider call; it performs no network, external-provider, paid-model, or billable call.

`agent-hub.mjs` drives real Pi through production controller journal, reservation/start correlation, and durable role-receipt projection. It proves compact `/agents` discovery, receipt-only terminal accounting, honest unavailable live/missing usage, exact hard limits, forbidden-content exclusion, no control authority, malformed-event fail-soft behavior, private receipts, and process/state cleanup. A trap provider proves the Hub makes zero provider turns; it performs no network, external-provider, paid-model, or billable call.

`director-mode.mjs` drives real Pi through a zero-call status, denied tiny task, explicit eligible activation, dynamic Director prompt, bounded read/delegate/verify surface, and automatic exit. A later fixture intentionally re-adds `write`; the independent runtime allowlist blocks it before the sentinel file can be created. The real secure-workflow and verification registrations remain visible, the prior surface is restored, and the two required deterministic local turns perform no network, external-provider, paid-model, or billable call.

`isolation-v2.mjs` materializes and destroys a production `git-worktree-v2` allocation from a 256-file local fixture, checks the versioned canonical record and independent runtime identifiers, and proves ignored private state is absent. It probes `cp --reflink=always` without selecting it and records mount-backed overlay as `NOT_RUN`; neither alternative can silently replace the single registered Git worktree lifecycle.

`model-harness-profile.mjs` exercises the production post-route resolver and Tool/Edit Governor composition for receipt-backed and unknown model fixtures. It proves deterministic provenance, generic-safe degradation, bounded edit fallback, and the no-tool-escalation invariant over 10,000 local decisions. It makes no model, provider, network, or paid call.

`git-resources.mjs` drives real Pi against a temporary local repository through the production pinned Git runner. It verifies status, worktree/staged diffs, conflict catalog and conflict-side reads, mutation-surface denial, immutable trust metadata, command discovery, and cleanup. Six operations use twelve deterministic in-memory provider turns and zero network, external-provider, paid-model, or billable calls. GitHub is honestly `NOT_RUN` because no authenticated read-only client is available; the benchmark does not probe credentials or the network.

`commit-planner.mjs` drives real Pi through an explicit one-file inspection and a two-group hunk proposal while unrelated and protected changes coexist. It proves exact changed/excluded counts, digest binding, metadata privacy, zero staging/commit/publish authority, `/commit-plan` discovery, byte-identical HEAD/index/worktree state, deterministic cleanup, and exactly three in-memory provider turns with zero decision-model, network, external-provider, paid-model, or billable calls.

`watchdog.mjs` compares disabled/enabled Watchdog on deterministic successful, repeated-failure, unchanged-state and regression scenarios. It also drives the actual local secure-workflow state machine with fixture delegates: outcomes and delegate counts are identical, and bounded advice reaches only an already-required correction Worker. It records invocation/deduplication counts, context size, workflow result, fixture delegate calls, latency samples and zero model/tool/provider cost. `watchdog-pi.mjs` starts real Pi 0.85.1 with isolated settings and the production Watchdog extension, injects deterministic controller-observation fixtures, checks command discovery, advisory messages, fail-soft behavior, privacy and cleanup. It does not claim an authenticated full secure-workflow E2E or general token savings.

The committed result intentionally marks OMP execution `NOT_RUN`: this host did not have the reference project's required Bun >=1.4 runtime. Source inspection is never converted into fabricated numeric results. Later phase benchmarks must use identical fixtures and record failures as well as successes.
