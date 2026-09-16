# Phase 9 — LSP write guard

## Scope

Phase 9 adds a clean-room diagnostic guard inside the existing Phase 7/8 transaction boundary. The design review covered pinned OMP commit `4267074ac91456866e95ed8de0b6353388f08502`, especially its LSP write-through and edit integration. No OMP source was copied, no provider/model route changed, and no model-facing tool schema was added.

## Transaction contract

An exact or AST preview already owns the complete bytes intended for disk. The guard sends the current transaction bytes to the pinned LSP mux twice: current bytes establish the baseline, and the exact candidate bytes establish the pre-write result through `textDocument/didChange`. The project stays read-only inside Bubblewrap and no repository file is changed for preflight. TypeScript/JavaScript also passes the same overlay bytes through the already-pinned in-process TypeScript LanguageService after an LSP synchronization barrier, avoiding a false clean result when VTSLS legitimately omits an empty `publishDiagnostics` notification.

Diagnostics are normalized and bounded. New blocking diagnostics are compared as a multiplicity-aware semantic multiset over relative file, severity, source, code, and message; ranges remain in the full digest but are excluded from the stable blocking identity so an unrelated line shift does not invent an error. Language, backend, and project-root identities are digest-bound between baseline, candidate, and post-write checks. The explicit policy blocks new errors, permits unchanged existing errors, permits improvements, skips genuinely unsupported languages, and fails closed when a configured managed server is missing, unpinned, crashes, or returns unverifiable data. Disabling the policy is an explicit local operator choice and retains the underlying atomic editor checks.

After preflight passes, Edit Engine stages, fsyncs, and atomically renames the exact candidate. The guard then forces fresh diagnostics against bytes read from the real final filesystem. A new blocking diagnostic, backend/project change, runtime failure, or full diagnostic-digest mismatch raises before receipt publication. Edit Engine restores the verified prior bytes only while the installed candidate inode and digest remain engine-owned; a concurrent external change becomes a rollback conflict and is never overwritten. The mode-0400 success receipt is published only after validation and contains counts/digests plus language/backend/project identities, never paths, messages, source text, prompts, or secrets.

## Surface and lifecycle

- `transactional_edit` and `transactional_ast_edit` keep their existing schemas and permissions.
- `semantic_nav` and every language server remain read-only; `workspace/applyEdit` is still denied.
- `/lsp-write` reports local guard counters with zero inference calls.
- Server startup remains lazy, pinned, project-scoped, capped at three, read-only, and network-isolated.
- Guard initialization failure leaves ordinary Pi startup/read state available but fails the guarded transactional mutation path closed. The separately governed built-in editor remains the explicit fallback surface.

## Evidence

- Focused tests cover clean apply, unchanged and improved baselines, multiplicity-aware regression detection, pre-write block, post-write rollback, receipt ordering/privacy, unsupported/disabled fail-soft cases, configured-server and runtime fail-closed cases, contract confusion, and injected crashes.
- Real VTSLS tests prove candidate bytes produce diagnostics without changing disk, a bad TypeScript candidate is blocked, a safe candidate is written and rechecked, and a failed language-server launch is recoverable on the next request.
- Edit Engine and AST regressions remain green.
- `npm run benchmark:ultra:lsp-write` drives official Pi 0.85.1 through a real managed LSP success and error path: seven deterministic local provider turns, zero network/external-provider/paid calls, one validated private receipt, no receipt for the rejected edit, no staged residue, and zero-provider `/lsp-write` discovery.
- The authoritative Phase 9 gate is 317/317 tests PASS plus syntax, Ultra syntax, memory syntax, installed-Pi TypeScript, and package validation.

## Deliberate limits

Phase 9 validates the edited file through the current managed server and exact project. It does not grant arbitrary server workspace edits, apply rename/file-move operations, or claim a multi-file atomic transaction. Rename preview remains read-only; multi-file rename/import/file-move control stays deferred until it can preserve the same transaction, rollback, and receipt guarantees.
