# Phase 7 — Edit Engine V2

## Scope and reference

Phase 7 adds a clean-room transactional exact-replacement contract. The design review covered official Pi 0.85.1's built-in edit implementation and pinned OMP commit `4267074ac91456866e95ed8de0b6353388f08502`, especially `packages/coding-agent/src/edit/` and `crates/pi-edit/src/modes/hashline/`. No OMP source was copied.

The useful OMP ideas are read-session snapshots, compact anchors, stale relocation, and distinct edit variants. Ultra deliberately rejects broad fuzzy/boundary recovery and apply-then-warn syntax behavior: recovery must be a unique target with exact adjacent context, a bounded uniform line shift, and a prior seen range.

## Contract

Successful `read`, exact `smart_read` range/raw, and `repo://root` ResourceFS reads create an in-memory `hash-replace-v1` snapshot. It records normalized-content and path digests, observed line ranges, expiry, and workspace/session identity. Structural summaries do not authorize mutation; the model must reopen the exact source range.

`transactional_edit` has two explicit steps:

1. `preview` accepts a snapshot ID and one or more unique, disjoint exact replacements. It verifies seen-range coverage, current file compatibility, conservative relocation, and JSON syntax when applicable. It returns `READY`, `SAFE_RECOVERY`, or a fail-closed error and never mutates the file.
2. `apply` accepts only the preview transaction ID. It reopens and revalidates the target, stages and fsyncs the complete replacement beside the target, rechecks file and parent identity, performs an atomic rename, fsyncs the directory, and commits a private immutable metadata receipt.

The built-in Pi exact editor remains installed as a separately governed fallback when the transactional extension is unavailable or deliberately selected. Structural AST mutation remains a separate capability owned by Phase 8; automatic model/contract selection remains owned by Phase 17. This avoids pretending that one protocol is already optimal for every model.

## Security and failure behavior

- Workspace, protected-path, symlink, hard-link, regular-file, size, UTF-8, owner-controlled receipt-root, parent-directory and inode checks fail closed.
- Held `O_NOFOLLOW` parent/target descriptors plus canonical parent identity checks narrow path and rename races.
- A stale file between preview and apply returns `STALE_EDIT` without a receipt or staged residue.
- A post-rename receipt failure rolls back only while the installed inode and digest still match the engine's staged bytes. A concurrent external modification returns `EDIT_ROLLBACK_CONFLICT` and is never overwritten.
- Transaction byte buffers are zeroed on terminal success/failure. Receipts contain digests/counts/ranges/status only, are mode `0400`, and never contain paths or source text.
- Traces receive only scalar metadata and digests. `/edit-engine` reports counters locally without a model call.

## Evidence

- Focused/adversarial tests cover preview/apply, observed ranges, ambiguous anchors, conservative relocation, stale content, file and parent-directory races, successful rollback, rollback conflict preservation, symlink/hard-link/protected paths, JSON rejection, BOM/CRLF preservation, expiry, and malformed policy.
- Tool Governor regressions prove `transactional_edit` is selected instead of the built-in editor when available, search-only tasks receive neither, and the built-in exact editor is restored automatically when the transactional tool is unavailable.
- `npm run benchmark:ultra:edit-engine` drives the actual Pi RPC/tool lifecycle with a deterministic local provider. Safe relocation applies atomically; a preview/apply race fails closed; receipts and traces are metadata-only; `/edit-engine` is registered with zero provider turns. The run uses zero network, external-provider, paid-model, or billable calls.

## Known limits

- Phase 7 performs an internal JSON parse check only. Managed multi-language diagnostics and rename/write-through policy land in Phase 9.
- Snapshots and transactions are intentionally session-memory state. Receipts persist for audit, but they are not replayable write authority.
- Safe same-user process isolation cannot be proven solely by Node filesystem APIs. Descriptor anchoring, identity/digest rechecks, atomic rename, and conflict-preserving rollback narrow the races; hostile same-user code still belongs in a separate OS identity/container.
