# Phase 3 implementation note — ResourceFS

## Reference inspection

This phase inspects OMP's pinned internal URL parser/router, caller-context types, filesystem resource builder, memory handler, artifact handler, and registry helpers at commit `4267074ac91456866e95ed8de0b6353388f08502`. Useful ideas are typed immutable resource envelopes, per-scheme handlers, caller-scoped resolution, and path-only/bounded access. No OMP source is copied.

The clean-room design deliberately avoids OMP's broad process-global registry, opaque arbitrary-scheme MCP fallback, numeric cross-session artifact lookup, and exposure of backing paths in agent-facing diagnostics. OMP's own caller-binding comments and issue reference show why resource identity must never depend on whichever session was registered first.

## Smallest coherent design

Phase 3 implements only schemes with current, testable value:

- `repo://root/<relative-path>`: bounded workspace read and literal search through the existing canonical path policy plus descriptor/inode revalidation;
- `memory://root/<encoded-query>`: read/search through the existing Second Brain controller and Memory Router, never direct memory-store filesystem access.

Every scheme declares `READ`, `SEARCH`, `WRITE`, `MUTATE`, and `EXECUTE` capabilities as a subset plus a trust level and immutability. URI parsing rejects queries/fragments, credentials, ports, control characters, backslashes, encoded separators, empty/dot/parent segments, invalid percent encoding, unknown authorities, and unknown schemes before dispatch. Resolved bodies are explicitly untrusted data and are bounded independently of handler behavior.

Repository opens first apply the existing canonical workspace/secret policy, then walk each component through held `/proc/self/fd` directory descriptors with `O_NOFOLLOW`. Final descriptor identity is compared with both the prior canonical inspection and the current pathname. This closes parent-component symlink swaps where practical on the supported Linux host; multiply-linked files are denied, and searches skip them safely.

No current ResourceFS handler is writable, mutating, or executable. The registry refuses any future risky handler unless it supplies a controller-owned authorization callback; ResourceFS itself therefore cannot become an adapter around safe-exec, workspace policy, provider authentication, or another boundary.

One conditional `resource_fs` schema provides describe/read/search; it appears only when Task Policy detects a supported URI. `/resources` lists name/capability/trust metadata with no model call. Access traces contain scheme, operation, size/status and an URI digest, never the URI, query, content, path, prompt, or backend payload.

Explicit `memory://` tasks suppress automatic top-level memory injection, preventing duplicate retrieval; the resource handler remains the only path for that request. Pi 0.85.1 does not preserve an extension-returned `isError: true`, so ResourceFS throws a sanitized error code after emitting metadata for every denied operation. A real Pi negative-control run proves the resulting tool message carries `isError=true`.

## Deferred schemes

`artifact://`, Git/GitHub, agents, receipts, traces and conflicts are not faked here. They will register against this core only when their owning phases provide scoped identity, retention, and authorization semantics. `file://` is intentionally omitted because `repo://root/` expresses the security root without absolute-path ambiguity.

## Evidence

- 248/248 full project tests PASS, including strict URI ambiguity/traversal cases, capability and authorization denial, bounded directory/file reads, secret/symlink/hard-link/binary/oversize rejection, literal bounded search, Memory Router injection, result caps, and metadata non-disclosure.
- Syntax, memory syntax, installed-Pi TypeScript, package/secret validation all PASS with the verified stable managed LSP runtime.
- The actual Pi 0.85.1 ResourceFS benchmark passes repository read, true `.env` tool-error denial, trust/digest metadata, and `/resources` registration. It uses six deterministic local provider turns, zero network/external-provider/paid calls, and cost zero.
- The real-Pi Tool Governor rerun proves an explicit resource URI exposes exactly `read`, `resource_fs`, and `task_notebook` in its fixture (3 tools, 1,620 schema characters, approximately 405 schema tokens), while ordinary prompts do not expose ResourceFS.
- OMP executable comparison remains honestly `NOT_RUN` because Bun >=1.4 is unavailable. No OMP source was copied.
