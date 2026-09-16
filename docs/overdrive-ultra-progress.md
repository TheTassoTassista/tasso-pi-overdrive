# Overdrive Ultra progress ledger

## Resume coordinates

- Worktree: `/home/tasso/Documents/Codex/tasso-pi-overdrive-ultra`
- Branch: `feature/overdrive-ultra`
- Base commit: `0f107b8670b69b214e478b8d854377956f7039be`
- Current phase: 10 — DAP Debug Engine
- Last completed phase commit: `fa1043e` — `feat(ultra): guard transactional writes with LSP`
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
- Implemented one clean-room content-addressed Artifact Store for large UTF-8 tool output with deterministic previews, strict manifests, bounded provenance, session/workspace scope, task digests, deduplication, quotas, and fail-soft inline degradation.
- Added `artifact://<sha256>` as an immutable ResourceFS handler with bounded numbered ranges and literal search, while preventing recursive artifact reopening and allowing large repository/memory resource results to externalize.
- Enforced owner-only directories/files, atomic durable writes, `O_NOFOLLOW`, owner/link/mode/inode checks, content-hash verification, complete private-key and credential redaction, terminal-control sanitization, and pre-redaction quota enforcement.
- Added separate bounded artifact expiry/orphan retention, `/artifacts` metadata-only inspection, metadata-only tracing, package guards, adversarial regressions, and a real-Pi success/error/deduplication benchmark.
- Repaired the interrupted benchmark so plain Node owns its deterministic generator while Pi loads the virtual-runtime fixture, and added the provider fixture to syntax validation so duplicate declarations fail the normal gate.
- Implemented one clean-room Context Governor as the final package extension, accounting for the assembled prompt, active schemas, conversation, memory, artifacts, summaries, tool output, reserved output, safety margin, and authoritative model/reported context limits.
- Added fixed-order evidence-preserving reductions, provider proof attestation, fail-closed abort semantics, a separately gated direct `/handoff` path, zero-model `/context-fit`, metadata-only traces, and the gate in every fresh subagent role.
- Added package guards, 11 adversarial regressions, a deterministic real-Pi fit/block benchmark, handoff regression coverage, and explicit documentation of the safe in-flight route-switch limitation.
- Implemented clean-room Edit Engine V2 with session-local read snapshots, exact seen-range evidence, unique/disjoint anchored replacements, mandatory preview/apply separation, bounded deterministic relocation, and fail-closed stale/ambiguous behavior.
- Added descriptor-anchored target/parent identity checks, protected/symlink/hard-link/binary/size defenses, durable adjacent staging, atomic rename, directory fsync, immutable metadata receipts, rollback after receipt failure, and rollback-conflict preservation of external work.
- Integrated the conditional `transactional_edit` schema with normal reads, exact SmartRead ranges, repository ResourceFS reads, the Tool Governor, Worker profile, safety hooks, metadata-only tracing, zero-model `/edit-engine`, and the separately governed Pi exact-edit fallback.
- Added package guards, 12 focused/adversarial tests, Tool Governor fallback regressions, and a real-Pi safe-recovery/stale-race benchmark with no external/provider/paid calls.
- Implemented a clean-room `ast-grep-v1` adapter that runs the pinned CLI only against private exact-snapshot bytes, requires an explicit bounded match count, validates UTF-8 byte ranges/replacement text, and delegates the complete result to Edit Engine V2 for atomic apply and metadata receipts.
- Added lazy first-use binary attestation for exact version, tracked Linux-x64 SHA-256, ownership/link/executable state, and stable device/inode/size/time identity; ordinary Pi startup and command discovery launch no AST subprocess.
- Integrated conditional `transactional_ast_edit` selection for semantic structural intent, retained the plugin rewrite only as a governed fallback, and kept search-only, Tester, reviewers, and Council non-mutating.
- Added strict contract separation between exact and AST transactions, metadata-only match/pattern/rewrite evidence, zero-model `/ast-edit`, package guards, real-CLI adversarial tests, and a real-Pi duplicate-match/stale-race benchmark.
- Implemented a clean-room internal LSP write guard over the existing exact and AST transaction schemas: baseline and exact candidate bytes are evaluated through the lazy pinned overlay path before mutation, with multiplicity-aware semantic regression classification and language/backend/project binding.
- Added deterministic TypeScript/JavaScript overlay verification through the existing pinned TypeScript LanguageService after a VTSLS synchronization barrier, eliminating false-green empty-diagnostic timeouts without changing the read-only server contract.
- Extended atomic apply so the real post-rename filesystem state is diagnosed before receipt publication, then revalidated at the receipt boundary; divergence or new blocking diagnostics trigger conflict-safe rollback and concurrent external work is preserved.
- Added explicit unsupported/managed-unavailable/runtime-failure policy, metadata-only validation receipts/traces, zero-model `/lsp-write`, package guards, real server crash recovery, focused adversarial tests, and a real-Pi accepted/rejected diagnostic benchmark with no new model-facing schema.

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
- Phase 5 focused Artifact Store tests: 12/12 PASS; content addressing, concurrent dedupe/provenance, session isolation, strict artifact URIs, exact ranges/search, credential/private-key/control sanitization, critical diagnostics, quotas, manifest tamper, symlink/hard-link denial, and paired/orphan retention.
- Phase 5 Artifact Store real-Pi benchmark: PASS on Pi 0.85.1; 46,070 raw tool-result characters to a 5,352-character preview (88.38% reduction), exact lines 419–421 reopened, true tool-error `isError` preserved, critical `ERROR` retained, duplicate payload deduplicated to one private object, and `/artifacts` plus `/resources` registered; four deterministic local provider turns, zero network/external-provider/paid calls, cost zero, temporary cleanup PASS.
- Phase 5 ResourceFS and Tool Governor real-Pi regressions: PASS; ResourceFS read/secret denial and conditional schema surfaces remain intact, explicit CLI remains authoritative, and the simple edit remains four tools/2,799 schema characters.
- Phase 5 full `npm run check`: 272/272 PASS plus syntax, Ultra fixture syntax, memory syntax, installed-Pi TypeScript, package and secret validation, using the verified stable managed LSP runtime. The expected unconfigured worktree run was 270/272 solely because ignored Rust/Go managed binaries are absent; no installation or source change was made.
- Phase 6 focused Context Governor tests: 11/11 PASS; complete accounting, fixed reduction order, tool-result pairing, critical diagnostics regardless of position, SmartRead/Second Brain/compaction-summary semantics, reported-usage adjustment, authoritative context bounds, non-disclosure, and fail-closed malformed/oversized inputs.
- Phase 6 Context Governor real-Pi benchmark: PASS on Pi 0.85.1; the third request reduced 3,268 to 2,183 estimated input tokens against 2,480 usable by removing one redundant artifact preview (1,085 tokens saved), preserving reopenable references and both critical diagnostics. An irreducible 39,216-token current request was BLOCKED before provider entry; three deterministic local turns, zero network/external-provider/paid calls, cost zero, `/context-fit` and cleanup PASS.
- Phase 6 direct handoff real-Pi regression: PASS; canonical notebook state survived distillation, the new session was genuinely empty, and no routing/auth/provider configuration changed.
- Phase 6 full `npm run check`: 283/283 PASS plus syntax, Ultra fixture syntax, memory syntax, installed-Pi TypeScript, package and secret validation, using the verified stable managed LSP runtime.
- Phase 7 focused/adversarial tests: 12/12 Edit Engine cases PASS; preview/apply, seen ranges, ambiguity, conservative relocation, stale content, file/parent TOCTOU, rollback, rollback conflict, protected links, JSON syntax, BOM/CRLF, expiry and malformed policy are covered. Tool Governor and compact-surface regressions PASS.
- Phase 7 real-Pi benchmark: PASS on Pi 0.85.1; safe relocation preserves an external insertion and applies the anchored replacement, preview is non-mutating, a preview/apply race returns `STALE_EDIT` without a receipt, the applied receipt is mode 0400 and metadata-only, no staged residue remains, `/edit-engine` is registered with zero provider turns; eight deterministic local turns, zero network/external-provider/paid calls, cost zero, cleanup PASS.
- Phase 7 full `npm run check`: 296/296 PASS plus syntax, Ultra fixture syntax, memory syntax, installed-Pi TypeScript, package and secret validation, using the verified stable managed LSP runtime. The nested-runner control failed only the five expected sandbox-dependent LSP/socket/Bubblewrap files; the authoritative host run passed all 296.
- Phase 8 focused/adversarial tests: real pinned ast-grep duplicate matches after a multibyte prefix, exact UTF-8 range conversion, non-mutating preview, atomic apply, expected-count mismatch, unseen ranges, stale source, overlap, malformed/failed runner output, exact/AST contract confusion, and policy bounds PASS. Edit Engine, Tool Governor, compact surface, TypeScript, and package regressions PASS.
- Phase 8 Tool Governor real-Pi rerun: PASS; simple edit 4 tools/2,128 schema characters, search-only 7/3,481 with no mutation, structural edit 8/3,996 with `transactional_ast_edit` and no plugin rewrite, explicit CLI preserved; nine deterministic local turns, zero network/external-provider/paid calls, cost zero.
- Phase 8 transactional AST real-Pi benchmark: PASS on Pi 0.85.1; two identical calls previewed and applied atomically, preview/apply race denied as `STALE_EDIT` while preserving external content, mode-0400 metadata-only `ast-grep-v1` receipt, zero staged residue, `/ast-edit` registered, sentinel proved no eager AST process; eight deterministic local turns, zero network/external-provider/paid calls, cost zero, cleanup PASS.
- Phase 8 full `npm run check`: 304/304 PASS plus syntax, Ultra fixture syntax, memory syntax, installed-Pi TypeScript, package and secret validation, using the verified stable managed LSP runtime.
- Phase 9 focused/adversarial tests: exact/AST transaction regressions plus clean, unchanged, improved, multiplicity-regressed, unsupported, disabled, missing-server, crash, post-divergence, receipt-order, metadata-privacy, real VTSLS overlay, pinned TypeScript verifier, and receipt-boundary TOCTOU cases PASS.
- Phase 9 real-Pi benchmark: PASS on Pi 0.85.1; a safe TypeScript edit was checked against exact candidate bytes, atomically installed, rechecked from the final filesystem, and issued one mode-0400 metadata-only validation receipt; TS2322 was classified `REGRESSED` and blocked before write with no receipt or residue; `/lsp-write` registered without provider turn or eager server start; seven deterministic local turns, zero network/external-provider/paid calls, cost zero, cleanup PASS.
- Phase 9 Phase 7/8 real-Pi regressions: PASS; unsupported text remains explicit fail-soft, AST candidates are guarded without changing contract or tool surface, stale races preserve external work, receipts remain private, and cleanup remains complete.
- Phase 9 full `npm run check`: 317/317 PASS plus syntax, Ultra syntax, memory syntax, installed-Pi TypeScript, package and secret validation, using the verified stable managed LSP runtime.

## Dirty files

- Only this phase-boundary ledger update is expected before its bookkeeping commit.

`docs/final-adversarial-audit.md` must not appear in this worktree's diff and the user's modified copy in the original worktree must retain SHA-256 `f556b3adc88e58f5319f208b4a74c496705ef90b24680bf8bde12e5ce5a9f3ba`.

## Known blockers and limitations

- OMP cannot yet be executed locally because Bun >=1.4 is absent. No OMP numeric result is inferred.
- A new Git worktree does not contain ignored managed LSP binaries. Baseline tests use the verified runtime in the stable installation via `PI_OVERDRIVE_LSP_RUNTIME`; the Ultra worktree has its lockfile-pinned Node LSP dependencies materialized.
- OMP comparisons are source/architecture-only until an isolated executable reference can be provided without changing either product's data.
- Tool-schema numbers use a bounded non-executing registry inside real Pi; production counts vary with installed tools, while the live selection and denial behavior is the code path under test.
- Pi 0.85.1 has no native OMP-style extended/discoverable namespace; `/tools` provides name/tier discovery without placing rare schemas in the prompt.
- Debug, eval, and Sentinel capabilities remain honestly unavailable until their respective phases land.
- ResourceFS currently supports Linux descriptor traversal and only immutable repository/memory/artifact resources; additional schemes remain deferred to their owning phases.
- SmartRead deliberately supports source/text only; archive, database, document, and image parsing remain outside its reviewed surface. Cold LSP startup adds latency even though it materially reduces context.
- Artifact Store Phase 5 supports UTF-8 text only. Binary images/browser captures remain deferred to the hardened browser phase, and critical-diagnostic preservation can intentionally make a pathological preview exceed its nominal character target rather than discard an error.
- Context estimates deliberately follow Pi's conservative four-character approximation plus a 4,096-token safety reserve; they are not provider billing tokens. Critical diagnostics can force a BLOCKED result rather than be discarded.
- Pi 0.85.1 exposes no safe in-flight API for changing the active target after final context assembly. The Context Governor therefore blocks an irreducible payload and requires explicit compaction/handoff or an already-policy-compatible target instead of silently changing routing.
- Edit Engine V2 now owns exact and bounded single-file AST transactions, JSON pre-validation, and Phase 9 pre/post managed diagnostics. Multi-file structural/rename/file-move transactions remain intentionally absent, and evidence-based model/contract selection is Phase 17; these capabilities are not claimed early.
- Phase 9 validates the edited file within its bound project and does not grant server-originated workspace mutation. Genuinely unsupported file types skip by explicit policy; a configured managed server that is absent/unpinned or a runtime failure blocks the guarded transaction. Multi-file rename/import/file-move control remains deferred until it can be atomic and rollback-safe.
- The tracked AST binary digest is intentionally Linux-x64-specific, matching the existing package platform contract. First use hashes the 52.4 MB binary, so the measured cold AST path includes that one-time integrity cost; subsequent uses revalidate filesystem identity before using the cache.
- Edit snapshots/transactions are deliberately memory-only and expire after 30 minutes. Applied receipts are bounded per session and metadata-only but do not yet have a package-owned time-retention command.

## Exact next action

Inspect the pinned OMP DAP architecture, current Pi extension/tool lifecycle, existing safe-exec/worktree/runtime isolation, Artifact Store, Task/Tool Governor debug intent, and host adapter availability. Build the smallest Phase 10 lazy single-session DAP engine with an explicit adapter allowlist, bounded metadata/artifact output, deterministic timeout/kill/cleanup, no ambient secrets/network, no routing/role changes, no eager process, and no large always-on schema.
