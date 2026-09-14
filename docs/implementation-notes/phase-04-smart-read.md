# Phase 4 implementation note — SmartRead

## Reference inspection

This phase inspects OMP's pinned read selector, structural summary, output formatter, read path, and corresponding tests at commit `4267074ac91456866e95ed8de0b6353388f08502`. The useful ideas are deterministic structural views, explicit raw/range recovery, exact line coordinates, and omission markers. No OMP source is copied.

The clean-room implementation deliberately avoids a broad archive/database/document multiplexer, ambiguous selector syntax, native Bun/tree-sitter dependencies, and a fallback that silently returns an unbounded source dump. Those formats remain outside Phase 4 until a later resource handler can justify and secure them independently.

## Smallest coherent design

`smart_read` has four explicit modes:

- `auto` preserves small source verbatim and selects a structural view for supported large source;
- `raw` is exact up to a hard 64 KiB cap and then directs the caller to range mode;
- `smart` returns file metadata, imports/includes, major declarations, signatures, exact declaration ranges, suggested reopen ranges, and a final omitted-lines marker;
- `range` returns at most 500 exact numbered lines with before/after reopen markers.

Auto selection is deterministic. It considers the source extension, line/character size, Task Policy task classification, current context pressure, and the preset-derived SmartRead character budget. It requires no inference call. The implementation supports common C/C++, C#, Go, Java, JavaScript/TypeScript, Kotlin, PHP, Python, Ruby, Rust, and shell declarations, with a bounded line fallback for forced structural reads of other text.

Large source reads through Pi's built-in `read` are intercepted after the built-in path policy succeeds and before the result reaches the model. SmartRead then reopens the same workspace-relative file through ResourceFS's descriptor-bound verified reader. Small files and explicit built-in offset/limit reads are not changed. The explicit tool accepts only workspace-relative paths or `repo://root` URIs and inherits ResourceFS traversal, secret, symlink, hard-link, binary, and size denial.

The pinned read-only LSP supplies document symbols when available; deterministic parsing remains the fail-soft fallback. Task/focus text is used only for local symbol ranking and never copied into the result metadata or trace. FFF remains the candidate locator, `semantic_nav` remains the deeper definition/reference tool, ResourceFS owns path security, and Task Governor/Tool Governor decide budget and schema visibility. Second Brain and later Artifact/Context Governor layers remain separate evidence inputs rather than being coupled into the parser.

The first real benchmark exposed two correctness bugs before closure: a 200-declaration parse cap dropped a relevant late-file symbol, and punctuation at the end of a focus token defeated ranking. The parser now considers every declaration within the already-enforced 20,000-line source bound, while rendered output stays character-bounded; focus separators may be internal but not trailing. Dedicated regressions preserve a target at lines 1203–1206.

`/smart-read` exposes only session counters. Trace events contain modes, parser/LSP status, aggregate sizes/counts, reduction, and digests. They omit paths, URIs, symbols, focus/task text, source bodies, and provider content.

## Evidence

- 260/260 full project tests PASS, including four modes, small-file exactness, large-file bounding, LSP enrichment/fallback, late-symbol ranking, multi-language parsers, exact range recovery, ResourceFS security inheritance, and metadata non-disclosure.
- Syntax, memory syntax, installed-Pi TypeScript, package/secret validation all PASS with the verified stable managed LSP runtime.
- Official Pi 0.85.1 automatically converted a real built-in read of a 35,090-character/1,206-line TypeScript fixture into a 5,701-character model-facing structural result: 83.75% fewer characters, estimated 8,773 to 1,426 tokens using the documented four-character estimate.
- The same run reports `lspStatus=PASS`, `parser=lsp+deterministic-parser`, retains the focused declaration at lines 1203–1206, omits its implementation body, and recovers those four exact numbered lines through explicit range mode.
- The Pi run made three tool calls and six deterministic local provider turns, with zero network, external-provider, paid-model calls, or cost. `/smart-read` registration passed.
- Cold LSP enrichment made the structural read slower in this sample (1,195.316 ms versus 281.309 ms raw). Phase 4 claims context reduction and location preservation, not lower cold latency.
- The Tool Governor rerun keeps the direct string edit at four schemas and makes `smart_read` conditional for source/search/structural/debugging work. Explicit CLI selection remains authoritative.
- OMP executable comparison remains honestly `NOT_RUN` because Bun >=1.4 is unavailable.
