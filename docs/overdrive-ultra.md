# Pi Overdrive Ultra

## Design contract

Ultra adds an OMP-class tool plane beneath the existing Overdrive control plane. It does not replace Pi, authentication, model routes, Council/Judge, workflow receipts, sandboxing, or Second Brain.

```text
task → Task Governor → task policy
                     ├─ Model Governor (existing routes/callability)
                     ├─ Context Governor (SmartRead + memory + artifacts)
                     └─ Tool Governor (small task-specific surface)
                                      ↓
                           existing secure workflow
                                      ↓
            transactional edit / AST / LSP / DAP / eval
                                      ↓
                    safe execution + Bubblewrap + receipts
```

The architecture is lazy and fail-soft. Optional parsers, debugger adapters, eval kernels, browser processes, and Sentinel sessions start only when the task policy requires them. Their absence must produce a bounded degraded result, never prevent ordinary Pi startup.

## Frozen invariants

- Official Pi 0.85.1 installation and existing authentication are not modified by development.
- Existing provider identities, role assignments, fallback order, thinking policy, Council composition, Judge sequencing, and retry categories remain authoritative.
- Council has three independent read-only members. Members receive the same initial evidence but never another member's output; Judge runs only after three valid results.
- Autonomous concurrency is 3, depth is 1, correction rounds are 2, and the derived session spawn budget is 42.
- Worker stays sandboxed in the workflow worktree; Tester stays non-mutating.
- Second Brain remains OpenViking + Hindsight + ACE + Memory Router + Shared Memory Pack + Obsidian, with local CPU embeddings.
- No feature may turn secrets, raw prompts, file bodies, or provider output into trace metadata.
- A disabled or unavailable optional feature must leave the basic `read`/`edit`/`write` path usable.

## Implemented control plane

Phase 1 adds the versioned deterministic Task Governor. It composes the existing Token Governor, Memory Router, and preset/quality policies into one digest-bound Task Policy. A small direct string change resolves to one Worker, four capability intents (`read`, `edit`, `lsp`, `verify`), no Planner, memory, debugger, browser, reviewer, or Council. A race under load resolves to a focused debugging policy with Planner, project memory, SmartRead/LSP intent, debug/eval/Sentinel intent, Worker, deterministic verification, and correctness review.

The Task Policy contains metadata and limits, never the raw task. The secure workflow persists it and validates its digest on resume. `/task-policy [--json] TASK` previews the decision locally without a model call.

Phase 2 adds the versioned deterministic Tool Governor. Immediately before each model turn it resolves the Task Policy against Pi's live tool registry and installs only the required schemas. `read` is always essential; FFF/AST search, edit/write, LSP, memory, verification, and the enforced workflow are conditional; web/browser require matching explicit task intent; `safe_exec` and MCP are hidden/on-demand; raw shell, raw subagent, and file removal are controller-only. Unknown tools fail closed. Explicit Pi CLI tool flags remain authoritative, and `/tools` exposes a schema-free inventory plus deliberate session-local enable/disable/auto controls.

AST mutation uses a separate semantic `structural-edit` capability. A tool name or simple string replacement cannot activate it; a structural transformation over syntactic nodes can. Search-only work prefers FFF over redundant built-ins and cannot receive mutation tools. Tool Policy validation reconstructs the deterministic decision from the bound Task Policy and recorded live registry, so a recomputed digest cannot bless a semantically forged surface. The same Task Policy makes top-level Second Brain construction truly lazy for small direct edits.

Phase 3 adds a clean-room ResourceFS core with two deliberately narrow, immutable schemes: `repo://root/<relative-path>` for bounded workspace read/literal search and `memory://root/<encoded-query>` for access through the existing Memory Router and Shared Memory Pack controller. Each scheme declares capabilities, trust, and immutability. The strict hierarchical parser rejects traversal, separator encoding, credentials, ports, query/fragment ambiguity, controls, and unknown schemes. Repository access reuses workspace/secret policy and walks path components through held `O_NOFOLLOW` directory descriptors, then revalidates inode identity; symlinks, hard links, `.git`, `node_modules`, binary reads, and oversized reads fail closed.

ResourceFS currently exposes no `WRITE`, `MUTATE`, or `EXECUTE` operation. A future risky handler cannot register without a controller-owned authorization callback. One conditional `resource_fs` schema appears only for explicit supported URIs, while `/resources` reports the catalog without a model call. Explicit `memory://` access suppresses duplicate automatic memory injection. Tool output marks resource bodies as untrusted data, and traces contain only scheme/operation/status/size/trust plus a URI digest—never the URI, query, path, or body.

Phase 4 adds deterministic SmartRead. A large supported source read through Pi's ordinary `read` tool is replaced before model context with file structure, imports/includes, declarations, signatures, exact ranges, reopen suggestions, and an omission marker. Small files remain verbatim. Explicit `auto`, `raw`, `smart`, and `range` modes are available through the conditional `smart_read` tool; raw and range modes are hard-bounded.

SmartRead uses the Task Policy's preset/context budget and task text only for local ranking. ResourceFS owns canonical path enforcement, the pinned read-only LSP enriches document symbols when available, and deterministic multi-language parsing/line fallback keeps the feature fail-soft without a model call. Metadata traces contain only bounded counts, sizes, status, and digests. FFF remains the locator and `semantic_nav` remains the deeper definition/reference path; SmartRead does not duplicate either system.

Phase 5 adds one content-addressed Artifact Store for large UTF-8 tool results. Output above the configured threshold becomes a deterministic untrusted preview plus manifest metadata and `artifact://<sha256>`. Sanitized content is private, immutable, session/workspace scoped, task-attributed, quota-bound, deduplicated, and reopenable only through bounded ResourceFS line ranges or literal search. The middleware preserves non-text blocks, prior details, usage, and Pi error state; storage failure degrades to a bounded redacted inline preview.

The store has no model-callable schema of its own. Explicit artifact URIs activate the existing conditional `resource_fs` tool, and `/artifacts` reports metadata without inference. Secrets, complete private keys, terminal controls, malformed manifests, cross-session IDs, symlinks, hard links, permissive files, and digest mismatches fail closed. Artifact retention uses its own seven-day manifest lifecycle and stale-orphan cleanup; it shares neither files nor deletion rules with metadata traces. Binary/browser artifacts remain deferred to the browser phase.

Phase 6 adds one fail-closed Context Fit Gate immediately before every normal provider request. It accounts for the system prompt, active tool schemas, conversation, Shared Memory Pack/Second Brain context, artifact previews, agent summaries, tool output, reserved output, the target model window, Pi's reported usage/window when available, and a fixed safety reserve. If needed it applies only evidence-preserving reductions in the mandated order: redundant artifacts, generic tool output, historical raw reads through a SmartRead envelope, older Second Brain packs, then conversation prefix already represented by a genuine Pi compaction summary.

Every fresh subagent role loads the gate. A matching PASS proof is attested again in `before_provider_request`; an error, stale proof, or remaining overflow calls `ctx.abort()` rather than relying on a swallowed hook exception. The direct `/handoff` completion path has an equivalent pre-call check, while `/context-fit` inspects the current target locally. The latest user request and current evidence are never silently truncated. Pi 0.85.1 has no safe in-flight route-switch API at this boundary, so an irreducible payload is blocked for explicit compaction/handoff or a policy-compatible target; routing and callability remain unchanged.

## Planned subsystems

The implementation order is deliberate: Task Governor and Tool Governor landed before new large schemas. ResourceFS provides typed, policy-checked repository, memory, and artifact URIs; SmartRead selects bounded source views; Artifact Store externalizes large text outputs; Context Governor now proves the assembled payload fits before provider entry. Edit Engine V2 and AST transactions operate through snapshots and LSP validation. DAP and eval are isolated, lazy runtimes. StreamGuard can correct an in-flight trajectory without duplicate injections. Sentinel is read-only and policy-gated. Agent Hub consumes metadata and authoritative receipts. Director Mode is an explicit state machine, never an approval bypass.

Git/GitHub resources, commit planning, imported rule formats, ACP, browser expansion, computer use, collaboration and native fast paths follow only after their security and overhead are measured. Computer use and collaboration may be intentionally deferred when the safe design is not better than omission. Native code is justified only by profiling.

## Evidence policy

Every phase has a focused test, local benchmark when relevant, local commit, and an entry in `docs/overdrive-ultra-progress.md`. Cross-product claims are scoped to the category actually measured. A missing OMP runtime or missing comparable metric is `NOT RUN`, not a win.

No OMP source has been copied through Phase 6. Any later reuse must retain MIT attribution and be listed with its source path and commit; clean-room implementation remains preferred.
