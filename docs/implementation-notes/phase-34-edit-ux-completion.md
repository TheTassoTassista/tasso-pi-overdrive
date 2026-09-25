# Phase 34 — bounded edit UX completion

## Actual contract surface

- `HASH_ANCHORED`: registered `transactional_edit`; snapshot/seen-range, preview, LSP preflight/post-check, staged atomic apply/rollback, and private receipt remain in the existing Pi path.
- `AST_STRUCTURAL`: registered `transactional_ast_edit`; pinned ast-grep generates exact ranges, then uses the same transactional and LSP gates.
- `APPLY_PATCH`: a possible Model Harness Profile mapping, **not** a registered autonomous production tool here. It was not benchmarked as an implementation.
- `REPLACE`: Pi's built-in `edit` fallback, **not** equivalent to the transactional path. No claim of transactional receipt/LSP parity is made.

No fifth protocol, tool authority, model route, retry loop, fallback count, Council/Judge setting, or spawn budget was added. The existing profile still offers at most one configured fallback, and Tool Governor still subtracts inactive/denied tools. Ordinary edits do not select AST; structural edits continue to prefer AST when active.

## Deterministic evidence

`npm run benchmark:ultra:edit-corpus` executes 20 controlled classes through the real local `EditEngine` and, for the structural case, the policy-pinned ast-grep binary. Its result is in `benchmarks/overdrive-vs-omp/edit-contract-corpus-results.json`: **20/20 oracle cases PASS**, comprising 16 exact edits and four expected fail-closed denials. The benchmark checks exact final bytes, a preserved sidecar, private metadata-only receipts, no staged residue, and cleanup. It records failure class, first attempt, bounded recovery, retry count, engine operations, protocol character counts, latency, and rollback observation per case. The two Go/TypeScript syntax checks are explicitly `NOT_RUN` in this corpus; the separate real-Pi LSP benchmark and authoritative gate cover TypeScript LSP. Language syntax is checked for JavaScript, Python, C, Rust, and JSON. `piToolCalls` and billing tokens are `null`, not inferred from engine calls or characters.

The pre-existing real-Pi `edit-engine`, `ast-edit`, and `lsp-write` benchmarks exercise actual extension registration, read-bound snapshots, LSP preflight/post-check, stale races, and receipt cleanup. This corpus is a deterministic engine benchmark, not a model-format, provider-cost, or authenticated workflow benchmark. OMP execution remains `NOT_RUN`; pinned OMP Hashline source review is recorded in the checkpoint note, not converted into numeric comparison.

## Recovery and profile evidence

Fixed source-free hints now cover blocking LSP diagnostics, unavailable candidate validation, and AST match-count mismatch in addition to the earlier stale/ambiguity/unseen-range hints. They do not echo candidate source or attempt to manufacture diagnostic codes/line numbers unavailable from the error object. There is no automatic retry cascade.

`config/edit-benchmark-evidence.json` intentionally has zero model-family records. The Model Harness Profile resolver can consume a reviewed, tracked comparative record only when it has two configured contracts, at least 20 fixtures and attempts per contract, actual model-call/token counts, a verified zero-extra-cost or subscription-backed basis, zero unsafe outcomes, freshness under 30 days, and a clear success advantage without worse format/retry counts. Malformed, stale, one-sample, unsafe, or inconclusive records are `UNKNOWN` and cannot reorder contracts; even qualified evidence cannot add a tool or override task-specific AST selection. Tests exercise that boundary with synthetic records. The digest is provenance metadata for a trusted reviewed file, not cryptographic proof of provider billing or model behavior.

No real-model comparative benchmark was run: no route was established as zero-extra-cost specifically for this phase, and unknown-price OmniRoute routes were not probed. Consequently, **no family preference was promoted**. OpenAI/Codex, Qwen, Kimi, DeepSeek and others are all `NOT_RUN` for comparative edit format success/token cost, not tied or assumed equivalent. Local decision logic is in place for later reviewed evidence, but model-specific superiority remains unknown.

## Deliberate boundaries

The existing preview is already bounded by `maxPreviewChars`, and multi-edit batching is single-file/atomic within the existing limit. Streaming a new diff protocol or claiming multi-file atomic rename would add surface without evidence, so neither was added. The 20-case corpus does not prove real-model format reliability, cross-platform compilers, or every language's LSP; the full gate and separate real-Pi benchmarks remain authoritative for their own narrower claims. Extra paid/external model calls: **0**, extra monetary cost: **€0**.
