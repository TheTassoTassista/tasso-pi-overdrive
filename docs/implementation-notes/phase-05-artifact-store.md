# Phase 5 implementation note — Artifact Store

## Reference inspection

This phase inspects OMP's pinned session artifact store, blob store, artifact protocol, streaming-output integration, and related tests at commit `4267074ac91456866e95ed8de0b6353388f08502`. The useful ideas are automatic large-output spill, stable internal URIs, bounded reopening, atomic persistence, and lifecycle cleanup. No OMP source is copied.

The clean-room design deliberately uses one store instead of separate artifact/blob registries. A 64-character SHA-256 is both the content identity and the `artifact://<id>` authority, while the filesystem lookup remains bound to a session/workspace scope. This avoids numeric cross-session IDs, registry ambiguity, arbitrary path resolution, and competing retention rules.

## Smallest coherent design

Tool results above 12,000 bytes are intercepted before model context. Text blocks are normalized, terminal controls removed, credential-like values and complete private-key blocks redacted, then hashed and written as owner-only content plus a strict JSON manifest. The model receives a deterministic untrusted preview, metadata, and the URI. Non-text blocks, existing tool details, usage, and Pi's `isError` state remain intact. If policy or persistence is unavailable, the extension returns a bounded redacted inline preview and a stable error code instead of breaking Pi.

Each manifest records SHA-256, stored and source sizes, character/line counts, MIME type, producer tools, canonical timestamps, retention, session/workspace scope digest, task digests, trust, redaction state, and immutability. Duplicate sanitized bytes share one data object and merge bounded provenance. Quotas apply to both the pre-redaction input and stored representation, preventing a giant secret-like input from shrinking past the item limit.

Artifact access is only through the existing ResourceFS parser. `READ` provides bounded numbered line ranges and `SEARCH` provides bounded literal matches; there is no path parameter, mutation, execution, or cross-session lookup. Repository and memory ResourceFS results may themselves spill when large, but an `artifact://` reopen is never recursively externalized.

Storage directories are mode `0700`; files are created atomically at `0600` with `O_NOFOLLOW`, owner/type/link/mode checks, inode revalidation, `fsync`, and post-rename verification. Manifest fields, dates, retention math, bounded provenance, and content hash are validated before bytes are returned. Symlink and hard-link substitutions fail closed.

Artifact retention is separate from trace retention. Session startup performs a bounded manifest-expiry pass; the standalone command defaults to dry-run. It removes only verified expired pairs or stale private orphan/temp files, skips foreign/unsafe entries, and never follows hostile scope or object symlinks. `/artifacts` exposes only current-session counters and manifest metadata. Trace events contain only sizes, counts, statuses, sanitized tool names, and digests—not prompts, output bodies, paths, URIs, or secrets.

Phase 5 stores UTF-8 text (`text/plain`, Markdown, or JSON). Binary browser captures remain deferred to the hardened browser phase, where image-specific preview and reopening semantics can be reviewed rather than smuggled into a text API.

## Benchmark correctness repair

The first unfinished benchmark draft imported a Pi fixture into plain Node even though the fixture imports Pi's virtual `typebox` runtime. The final benchmark owns its deterministic payload generator directly, while Pi itself loads the TypeScript fixture and provider. The provider fixture is now also part of `syntax:ultra`, so a duplicated declaration cannot evade the project gate merely because a benchmark was not run.

The real-Pi sequence covers a successful large result, a bounded `artifact://` range reopen, and the same large payload returned as an actual tool error. The final assertion requires the error result to retain `isError=true`, keep its critical diagnostic, and deduplicate to the first content object.

## Evidence

- 272/272 full project tests PASS with the verified stable managed LSP runtime; syntax, memory syntax, installed-Pi TypeScript, package, and secret validation PASS.
- Artifact-focused tests cover content addressing, concurrent deduplication, session isolation, range/search, strict URI parsing, secret/private-key/control sanitization, critical diagnostics, pre/post-redaction quotas, tampered manifests, symlink/hard-link substitution, and paired/orphan retention.
- Official Pi 0.85.1 externalized a 46,070-character/700-line tool result into a 5,352-character preview: 88.38% fewer model-facing characters, or an estimated 11,518 to 1,338 tokens using the documented four-character approximation.
- The same real-Pi run reopened exact lines 419–421, including the critical line at 420; preserved the critical diagnostic in both previews; retained `isError=true` on the failing tool result; and stored one private object because the duplicate payload deduplicated.
- `/artifacts` and `/resources` registration passed. The run made three tool calls and four deterministic local provider turns, with zero network, external-provider, paid-model calls, or cost; temporary state cleanup passed.
- ResourceFS and Tool Governor real-Pi regressions remain PASS. OMP executable comparison remains honestly `NOT_RUN` because Bun >=1.4 is unavailable.
