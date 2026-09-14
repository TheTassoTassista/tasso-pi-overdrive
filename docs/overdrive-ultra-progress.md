# Overdrive Ultra progress ledger

## Resume coordinates

- Worktree: `/home/tasso/Documents/Codex/tasso-pi-overdrive-ultra`
- Branch: `feature/overdrive-ultra`
- Base commit: `0f107b8670b69b214e478b8d854377956f7039be`
- Current phase: 5 — Artifact Store
- Last completed phase commit: `e4894c7` — `feat(ultra): add deterministic smart read`
- OMP reference: `4267074ac91456866e95ed8de0b6353388f08502`, package 18.1.21, MIT
- Paid/provider calls used by Ultra work: 0

## Completed work

- Verified the original repository branch/HEAD and isolated unrelated user modification.
- Created this separate worktree without stashing, resetting, or touching the user audit file.
- Performed a fresh OMP source/license/docs/tool/test/recent-issue audit.
- Captured full baseline: 216/216 tests PASS with the verified stable LSP runtime; syntax, TypeScript and package validation PASS.
- Captured context, read, grep, edit, stale-edit, process/RSS, output-optimizer, memory and deterministic task measurements.
- Added a pinned benchmark manifest and honest OMP `NOT_RUN` status because Bun >=1.4 is unavailable.
- Reconciled the local-smoke assertion with the already-current project template.
- Implemented a clean-room, versioned deterministic Task Governor by composing the existing Token Governor, Memory Router, and memory policy.
- Bound metadata-only Task Policy state to workflow checkpoints/resume, added actual Pi context-usage input, and skipped Second Brain construction for direct small edits.
- Added the zero-model-call `/task-policy` inspection command without adding an extension or tool schema.
- Implemented a clean-room Tool Governor that binds the live Pi registry to the Task Policy and reconstructs every digest-bound decision during validation.
- Added four enforced visibility tiers, FFF-first search fallback selection, semantic structural-edit gating, fail-closed unknown tools, explicit CLI precedence, and session-local `/tools` discovery/manual control.
- Made top-level Second Brain runtime construction truly lazy and skipped retrieval for Task-Policy-sufficient direct edits.
- Added metadata-only Tool Policy tracing without prompt, schema, file-content, provider-output, or secret fields.
- Implemented a clean-room ResourceFS with strict canonical URIs and only immutable `repo://root` and `memory://root` handlers.
- Bound repository traversal to held `O_NOFOLLOW` descriptors with inode revalidation; denied secrets, `.git`, `node_modules`, symlinks, hard links, binaries, oversize reads, and risky capabilities.
- Routed memory resources through the existing Second Brain controller and suppressed duplicate automatic retrieval for explicit `memory://` tasks.
- Added the conditional `resource_fs` schema, zero-model `/resources` catalog, sanitized tool errors, metadata-only tracing, package guards, and real-Pi benchmarks.
- Implemented deterministic SmartRead with `auto`, bounded `raw`, structural `smart`, and exact numbered `range` modes.
- Intercepted large built-in source reads before model context, reused descriptor-bound ResourceFS path security, enriched symbols through the pinned read-only LSP, and retained deterministic multi-language/line fallbacks.
- Added task/context-budget selection, late-symbol focus ranking, conditional Tool Governor visibility, zero-model `/smart-read` counters, metadata-only traces, package guards, regressions, and a real-Pi context-reduction benchmark.

## Current validation

- `npm run benchmark:ultra:baseline`: PASS; four real Pi tool calls, eight deterministic provider turns, zero paid/model-provider calls.
- `npm run benchmark`: PASS; critical diagnostics retained.
- `npm run benchmark:suite`: 6/6 PASS outside the nested runner sandbox.
- `npm run benchmark:memory`: PASS.
- `npm run check`: 216/216 tests PASS plus syntax/type/package validation when pointed at the already-verified stable managed binary runtime.
- `npm run smoke:local`: PASS after the expectation correction; temporary worktree/repository cleanup PASS.
- Phase 1 full `npm run check`: 227/227 PASS plus syntax, memory syntax, installed-Pi TypeScript, and package validation.
- Phase 1 focused tests: Task Governor, routing-quality, and workflow-state PASS.
- Phase 1 Pi command smoke: 10/10 PASS; `/task-policy` registered and zero inference/provider calls.
- Phase 1 benchmark: 10,000 decisions PASS; 0.067469 ms mean, 0.063512 ms mean overhead over the starting Token Governor, zero provider/model calls.
- Phase 2 focused tests: 12 Task Governor + 11 Tool Governor + 2 tool-surface tests PASS; semantic AST positive/negative controls and search-only non-mutation PASS.
- Phase 2 real-Pi benchmark: PASS on Pi 0.85.1; starting core 7 tools/4,171 schema chars, simple edit 4/2,799, search-only 6/3,012, structural edit 7/4,180, web research 4/2,104, browser 2/1,148; `/tools` registered; eight deterministic local turns, zero network/external-provider/paid calls, cost zero.
- Phase 2 full `npm run check`: 239/239 PASS plus syntax, memory syntax, installed-Pi TypeScript, package and secret validation, using the verified stable managed LSP runtime for ignored Rust/Go binaries.
- Phase 3 focused/adversarial tests: strict URI parsing, scheme/capability/authorization denial, repository bounds, symlink/hard-link/secret/binary/oversize defenses, literal search, memory routing, result caps, and metadata non-disclosure PASS.
- Phase 3 ResourceFS real-Pi benchmark: PASS on Pi 0.85.1; built-in read control PASS, ResourceFS read PASS with trust/digest metadata, `.env` denial recorded as a true tool error, `/resources` registered; six deterministic local turns, zero network/external-provider/paid calls, cost zero.
- Phase 3 Tool Governor rerun: PASS; explicit resource URI 3 tools/1,620 schema chars/~405 tokens and ResourceFS absent for ordinary prompts; nine deterministic local turns, zero network/external-provider/paid calls, cost zero.
- Phase 3 full `npm run check`: 248/248 PASS plus syntax, memory syntax, installed-Pi TypeScript, package and secret validation, using the verified stable managed LSP runtime.
- Phase 4 focused SmartRead tests: 10/10 PASS; four modes, late symbol beyond 200 declarations, LSP/fallback, exact ranges, multi-language parsing, ResourceFS denials, and metadata non-disclosure.
- Phase 4 SmartRead real-Pi benchmark: PASS on Pi 0.85.1; automatic built-in read interception, real sandboxed LSP enrichment, late symbol at lines 1203–1206 retained, exact range recovery, and `/smart-read` registration; 35,090 raw source chars to 5,701 model-facing chars (83.75% reduction), six deterministic local provider turns, zero network/external-provider/paid calls, cost zero.
- Phase 4 Tool Governor rerun: PASS; simple edit remains 4 tools/2,799 schema chars, source/search/structural/debug tasks receive conditional SmartRead, explicit CLI remains authoritative; nine deterministic local turns, zero network/external-provider/paid calls, cost zero.
- Phase 4 full `npm run check`: 260/260 PASS plus syntax, memory syntax, installed-Pi TypeScript, package and secret validation, using the verified stable managed LSP runtime.

## Dirty files

- Only this phase-boundary ledger update is expected before its bookkeeping commit.

`docs/final-adversarial-audit.md` must not appear in this worktree's diff and the user's modified copy in the original worktree must retain SHA-256 `f556b3adc88e58f5319f208b4a74c496705ef90b24680bf8bde12e5ce5a9f3ba`.

## Known blockers and limitations

- OMP cannot yet be executed locally because Bun >=1.4 is absent. No OMP numeric result is inferred.
- A new Git worktree does not contain ignored managed LSP binaries. Baseline tests use the verified runtime in the stable installation via `PI_OVERDRIVE_LSP_RUNTIME`; the Ultra worktree has its lockfile-pinned Node LSP dependencies materialized.
- OMP comparisons are source/architecture-only until an isolated executable reference can be provided without changing either product's data.
- Tool-schema numbers use a bounded non-executing registry inside real Pi; production counts vary with installed tools, while the live selection and denial behavior is the code path under test.
- Pi 0.85.1 has no native OMP-style extended/discoverable namespace; `/tools` provides name/tier discovery without placing rare schemas in the prompt.
- Debug, eval, Sentinel, and Artifact Store capabilities remain honestly unavailable until their respective phases land.
- ResourceFS currently supports Linux descriptor traversal and only immutable repository/memory resources; additional schemes remain deferred to their owning phases.
- SmartRead deliberately supports source/text only; archive, database, document, and image parsing remain outside its reviewed surface. Cold LSP startup adds latency even though it materially reduces context.

## Exact next action

Inspect current output compression, trace retention, workflow/session identity, and OMP's pinned artifact/blob stores. Define one private content-addressed, task/session-scoped `artifact://` store with deterministic previews, bounded range/search reopening, deduplication, quotas, redaction policy, and fail-soft inline fallback without conflating artifacts with metadata traces.
