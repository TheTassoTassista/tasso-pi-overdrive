# Phase 8 — Transactional AST Edit

## Scope and reference

Phase 8 adds a clean-room structural rewrite adapter on top of the Phase 7 transaction engine. The design review covered pinned OMP commit `4267074ac91456866e95ed8de0b6353388f08502`, especially `packages/coding-agent/src/tools/ast-edit.ts` and the Rust AST rewrite path, plus the already-installed `@juvio15/pi-ast-grep@0.4.2` package and owner-local `ast-grep 0.45.3` CLI. No OMP source was copied.

OMP and the existing Pi plugin both preview and then rerun a rewrite against the live target. A source change between those operations can invalidate the preview or leave a partial mutation before stale-count detection. Ultra instead runs ast-grep only against private snapshot bytes and hands exact ranges/replacements to Edit Engine V2. The live file is changed only by the existing atomic transaction path.

## Contract

`transactional_ast_edit` is a bounded two-step `ast-grep-v1` contract:

1. `preview` requires a current exact-read snapshot, one pattern/rewrite pair, and an explicit expected match count. The adapter writes only the snapshot bytes to a private temporary file, executes the pinned CLI, validates compact JSON byte ranges against the UTF-8 snapshot, rejects malformed/changed/excessive/overlapping/unseen matches, then creates an Edit Engine transaction. The live target is not mutated.
2. `apply` accepts only that AST transaction ID. Edit Engine revalidates the live target and applies the complete resulting bytes through its descriptor-anchored stage/fsync/atomic-rename/receipt path. Contract confusion between exact and AST transaction IDs fails closed.

The binary is resolved to a canonical absolute owner-controlled regular executable with one link. Its tracked Linux-x64 SHA-256, exact version, device/inode, size, modification time, and change time are checked lazily on first AST use and cached only while identity remains unchanged. Ordinary session startup does not launch ast-grep. The plugin `ast_grep_rewrite` remains a separately governed fallback when the transactional tool is unavailable; the Tool Governor hides it when the stronger contract is present.

## Security and failure behavior

- Match count is mandatory and capped at 32; pattern/rewrite length, CLI output, and runtime are hard-bounded by tracked policy.
- The CLI sees a private snapshot copy, never a live workspace path. Only fixed reviewed flags are constructed; no config, follow, path, or shell input is exposed by the public schema.
- UTF-8 byte offsets are decoded strictly and checked against the exact returned match text before transaction creation.
- Any post-read source change returns `STALE_EDIT`; Phase 8 deliberately permits no structural relocation.
- The Phase 7 target/link/owner/inode/parent checks, atomic install, conflict-preserving rollback, and mode-0400 metadata receipts remain authoritative.
- Traces contain only status, counts, syntax state, and SHA-256 digests of path/content/pattern/rewrite/receipt. Patterns, rewrites, source, paths, prompts, and provider output are absent.
- Worker receives the transactional AST tool and fallback; Tester, reviewers, Council, and search-only tasks receive no new mutation capability.

## Evidence

- Focused/adversarial tests use the real pinned CLI and cover duplicate matches after a multibyte prefix, exact range conversion, preview non-mutation, atomic apply, expected-count mismatch, unseen ranges, stale source, overlap, malformed/failed runner output, contract confusion, and invalid policy.
- Tool Governor regressions prove semantic structural intent selects `transactional_ast_edit`, hides the plugin rewrite, restores it when the transactional tool is absent, and gives search-only work neither mutation path.
- `npm run benchmark:ultra:ast-edit` drives official Pi 0.85.1 through read → snapshot → AST preview → apply. Two identical calls are replaced atomically; a separate preview/apply race fails closed while preserving external content; receipts/traces are metadata-only. `/ast-edit` registers with zero provider turns, and a sentinel executable proves command discovery/session startup does not launch the AST runtime. The run uses zero network, external-provider, paid-model, or billable calls.

## Known limits

- Phase 8 is deliberately single-file and supports one pattern/rewrite pair per transaction. Multi-file rewrites require independent previews/receipts instead of hidden partial application.
- The configured output byte cap is validated after Pi returns the subprocess result; timeout and match limits bound normal use, but same-user hostile processes still require OS isolation.
- JSON receives the Phase 7 syntax check. Managed multi-language diagnostics and post-write verification land in Phase 9 and are not claimed here.
- Model-specific edit-contract selection remains Phase 17. This phase changes no provider route, retry, Council/Judge, workflow, authentication, or Second Brain policy.
