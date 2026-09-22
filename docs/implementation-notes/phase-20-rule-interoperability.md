# Phase 20 — Config / Rule Interoperability

## Decision

Ultra adds one clean-room, project-only rule registry inside the existing Context Governor and ResourceFS extensions. It does not add an extension hook, model-facing tool schema, controller, provider call, command runner, or execution path. Pi's native `AGENTS.md` context remains native and is never duplicated; nested task-scoped `AGENTS.md`, `.agent/rules`, `.agents/rules`, Cursor, Windsurf, Cline, and GitHub instruction files are normalized into one bounded representation.

The pinned OMP reference at `4267074ac91456866e95ed8de0b6353388f08502` informed the supported file locations and format vocabulary. No OMP source was copied. Ultra deliberately does not import user-home rules, environment-selected directories, MCP/settings, TTSR conditions, AST conditions, agent selectors, interrupt modes, or executable configuration. OMP's documented name-only first-win deduplication, advisory glob matching, unsorted intra-provider order, permissive malformed-frontmatter fallback, and full always-apply prompt injection were not retained.

## Deterministic pipeline

1. Extract at most 16 safe project-relative file references from the current task.
2. Inspect only fixed project locations. GitHub instruction recursion is capped by depth, directory count, entry count, candidate count, source bytes, and safe filename rules.
3. Deny symlink components, hard-linked files, secrets, `.git`, `node_modules`, traversal, binaries, oversized files, unsupported frontmatter, and authority-bearing metadata.
4. Parse only `description`, `globs`, `alwaysApply`, and GitHub `applyTo`. Scope globs are actually matched against task files.
5. Sanitize terminal/bidirectional controls, delimiter spoofing, and paragraphs that attempt to override controller/security policy, access secrets, grant tools/network/browser, alter routing/Council/cost/spawn policy, or authorize automatic publication.
6. Order applicable rules by explicit source priority and scope specificity. Exact duplicates are removed; different same-name rules remain visible as deterministic conflict evidence rather than being silently merged.
7. Build a maximum 12-rule, 12,000-character Rule Pack with 2,400-character per-rule excerpts. The fixed authority boundary states that the pack is untrusted project guidance and cannot grant authority.
8. The final Context Governor accounts for the resulting system prompt and must still produce its normal provider proof.

Precedence inside imported project guidance is `AGENTS > .agent/.agents rules > Cursor > Windsurf > Cline > GitHub`. System/controller security and the explicit current user task remain higher authority. Lower-priority rules never change Task/Tool Governor output, model routing, retry policy, Council/Judge, cost, spawn limits, approval policy, sandboxing, verification, receipts, or Git authority.

## Cache, resources, and privacy

Parsing cache keys bind parser version, format, project-relative source path, and raw content digest. Every discovery rereads sources through descriptor-checked ResourceFS primitives before deciding whether the cache is valid. Changed content therefore misses the cache; a stale `rule://project/<path-digest>/<source-digest>` URI fails closed.

`rule://project` provides `READ` only. It returns sanitized content, never raw rejected paragraphs, and has no search, write, mutate, execute, network, or publish capability. Metadata traces contain counts, sizes, status, and digests only—never source paths, rule text, prompt text, filenames, or credentials. `/rules` reports policy bounds, precedence, and cache counters locally with zero provider calls.

## Evidence and limitations

- Focused and adversarial tests cover source formats, actual scope matching, unrelated exclusion, deduplication, deterministic precedence/conflicts, prompt-injection rejection, tool/network/browser/push non-authority, traversal/symlink denial, strict malformed parsing, breadth limits, digest invalidation, bounded packs, read-only/stale-safe ResourceFS, and metadata privacy.
- The real Pi 0.85.1 benchmark sees the root native instruction plus only the applicable sanitized imported rules, preserves explicit conflict evidence, excludes the unrelated 45 KiB rule and malicious paragraph, passes Context Governor, exposes no tools, and cleans its fixture. It uses one deterministic local provider turn and zero decision, external-provider, network, paid, or billable calls.
- Scope matching depends on file paths present in the current task. A scoped rule with no discoverable task path is conservatively omitted; it is not guessed from natural-language intent.
- Root `AGENTS.md` remains loaded by Pi core. Ultra adds the authority boundary and does not duplicate its bytes, but cannot replace Pi's native loader with descriptor-relative reads from this package.
- The simple frontmatter parser intentionally rejects multiline YAML, brace/extglob syntax, executable conditions, and unknown keys. Compatibility is narrower than permissive ecosystem parsers by design.
