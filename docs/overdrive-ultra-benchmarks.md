# Overdrive Ultra benchmark record

## Phase 0 baseline

Recorded 2026-09-14 from base commit `0f107b8670b69b214e478b8d854377956f7039be` with official Pi 0.85.1. All measurements used deterministic local fixtures and zero paid/provider calls.

| Metric | Result | Evidence |
|---|---:|---|
| Full package tests | 216/216 PASS | `PI_OVERDRIVE_LSP_RUNTIME=<verified stable runtime> npm run check` |
| Syntax/type/package validation | PASS | Same command; syntax, memory syntax, installed-Pi TypeScript, package validation |
| Base tree size | 1,347,724 bytes | Filesystem measurement excluding `.git` and materialized LSP `node_modules` |
| Deterministic context cold process | 8,533 ms | `npm run benchmark:context`, first no-tools process |
| Deterministic context warm process range | 1,115–1,236 ms | Six subsequent fresh Pi RPC processes |
| Default active schemas | 8 | Seven configured core tools plus Pi's `ask_user_question` |
| Estimated default-vs-no-tools context delta | 4,916 tokens | Pi context fixture; estimate at four characters/token, not billing tokens |
| Read 200-line output | 7,855 chars, 1,058.137 ms | Real Pi read through deterministic provider |
| Grep capped at 50 | 2,748 chars, 1,093.092 ms | Real Pi grep through deterministic provider |
| Exact edit | 68 request chars, 45 output chars, 1,108.417 ms, PASS | Real Pi exact-string edit |
| Stale edit | 70 request chars, 113 output chars, rejected, file unchanged | Real Pi exact-string edit negative control |
| Warm Pi RSS observed | 185,328–187,144 KiB | `/proc` process-tree samples during four isolated tool calls |
| Peak process tree for those calls | 1 | Pi plus no persistent helper for read/grep/edit fixtures |
| Output optimization | 164,450 → 4,836 chars (97.06%), 15.404 ms mean | 100 iterations; critical diagnostics retained |
| Deterministic task suite | 6/6 PASS | Navigation, bug, refactor, diagnosis, planning rubric, review; zero model calls |
| Repeated-memory fixture reduction | 97.75–98.87% estimated | Exact character counts, four-character token estimate |

The cold 8.5-second result includes initial Pi/package loading on this host; later independent processes stabilize around 1.1–1.2 seconds. It is recorded rather than discarded as an outlier.

The Phase 0 tool benchmark made four tool calls and eight deterministic provider turns. Output bodies are represented in the result by SHA-256 digests, not persisted raw fixture data.

## OMP comparability status

OMP source was pinned to `4267074ac91456866e95ed8de0b6353388f08502`, package 18.1.21, MIT. It was not executed because Bun >=1.4 was absent. Therefore Phase 0 makes no numerical claim about OMP latency, RAM, task success, edit success, or token usage.

The benchmark tree is `benchmarks/overdrive-vs-omp/`. Later results must use the same starting fixtures, record both successes and failures, and distinguish estimated tokens from provider-reported tokens.

## Phase 1 Task Governor

`npm run benchmark:ultra:task-governor` runs 10,000 deterministic decisions over four fixed task classes and validates the resulting policies. The recorded Ultra run completed in 674.690 ms total, or 0.067469 ms mean per decision, with zero model/provider calls. The starting Token Governor took 39.568 ms total, or 0.003957 ms mean; the unified policy therefore adds 0.063512 ms mean local overhead in this run.

| Task fixture | Policy result | Active capability intents | Active model roles |
|---|---|---:|---:|
| Change one string | PASS; no Planner/memory/debugger/Council | 4 | 1 |
| Bounded parser change | PASS; no debugger/Council | 5 | 2 |
| Intermittent race under load | PASS; Planner/memory/debug/eval/Sentinel/reviewer | 9 | 5 |
| Critical production migration | PASS; Planner/reviewer/Council | 3 | 11 |

Timing is a local microbenchmark and not a cross-product superiority claim. OMP remains `NOT_RUN` because its required Bun runtime is unavailable. Capability intents for future tools are policy decisions, not claims that DAP, eval, or Sentinel already exist.

## Known baseline finding

The local smoke initially failed only because its expected documentation-directory list had drifted behind the already-committed project template. The fixture showed every actual template file was created and user `AGENTS.md` was preserved. Phase 0 updates the smoke expectation to the current template and reruns it; this is a test repair, not a feature claim.

## Phase 2 Tool Governor

`npm run benchmark:ultra:tool-governor` launches fresh official Pi 0.85.1 RPC processes with a deterministic local context provider and a bounded non-executing tool registry. The provider reports the exact active tool names and serialized schema characters received for each prompt. The Phase 8 rerun made nine deterministic local turns, zero network or external-provider calls, zero paid calls, and cost zero.

| Task surface | Tools | Schema characters | Estimated schema tokens | Required assertion |
|---|---:|---:|---:|---|
| Starting Overdrive core | 7 | 3,500 | 875 | Control |
| Ultra simple string edit | 4 | 2,128 | 532 | read/transactional edit/LSP/verification; no write/AST/web/browser/controller |
| Ultra search-only | 7 | 3,481 | 871 | FFF + AST search + SmartRead; no mutation |
| Ultra structural edit | 8 | 3,996 | 999 | semantic `structural-edit` activates transactional AST; plugin rewrite hidden; SmartRead inspects source |
| Ultra explicit resource URI | 3 | 1,620 | 405 | read + ResourceFS + memory notebook; ResourceFS absent otherwise |
| Ultra debugging | 11 | 5,385 | 1,347 | focused search/edit/SmartRead/LSP/memory/verify/workflow |
| Ultra web research | 4 | 2,104 | 526 | memory + safe web; no browser |
| Ultra browser inspection | 2 | 1,148 | 287 | read + isolated browser only |
| Explicit CLI control | 2 | 1,136 | 284 | exact `read,safe_exec` preserved |

The simple-edit fixture reduces serialized schema size by 39.2% relative to the seven-tool control. This is an isolated schema-selection benchmark, not a provider billing-token claim and not a claim that every production task will have fewer than seven tools. Hard debugging correctly expands above the control. `/tools` registration and every visibility/security assertion passed. OMP stays `NOT_RUN` because Bun >=1.4 is unavailable, so no cross-product winner is declared.

## Phase 3 ResourceFS

`npm run benchmark:ultra:resource-fs` launches official Pi 0.85.1 with the actual ResourceFS extension and a deterministic local single-tool provider. It waits for Pi's `agent_settled` lifecycle event, so asynchronous built-in and extension tools are measured on the same protocol boundary. Three tool calls use six deterministic provider turns, zero network/external-provider/paid calls, and cost zero.

| Real Pi operation | Result | Elapsed | Output | Evidence |
|---|---:|---:|---:|---|
| Built-in `read`, 200 lines | PASS | 392.073 ms | 5,346 chars | Control path |
| ResourceFS `repo://root/fixture.txt`, 200 lines | PASS | 267.249 ms | 5,534 chars | Explicit workspace-untrusted/immutable metadata and URI digest |
| ResourceFS `.env` read | PASS (denied) | 275.481 ms | 61 chars | Pi records `isError=true`; sanitized `resource_repo_path_protected` |
| `/resources` command registration | PASS | — | — | Source is the actual extension |

The timings are one local run and not a performance superiority claim. ResourceFS deliberately adds 188 output characters in this fixture for a trust boundary, truncation state, and digest. Its purpose is policy and provenance, not replacing the built-in read tool for ordinary paths. OMP remains `NOT_RUN`; Bun is absent and no synthetic comparison is reported.

## Phase 4 SmartRead

`npm run benchmark:ultra:smart-read` launches official Pi 0.85.1 with the actual SmartRead extension and deterministic local single-tool provider. The fixture is a 35,090-character, 1,206-line TypeScript source whose task-relevant declaration is deliberately last, at lines 1203–1206. Three tool calls use six deterministic local provider turns, zero network/external-provider/paid calls, and cost zero.

| Real Pi operation | Result | Elapsed | Model-facing output | Evidence |
|---|---:|---:|---:|---|
| Built-in raw `read` control | PASS | 281.309 ms | 35,090 chars | Exact complete source control |
| Built-in `read` with automatic SmartRead | PASS | 1,195.316 ms | 5,701 chars | LSP + deterministic parser; focused late symbol retained; implementation body omitted |
| Explicit SmartRead exact range | PASS | 425.292 ms | 259 chars | Exact numbered lines 1203–1206 plus omission markers |
| `/smart-read` command registration | PASS | — | — | Source is the actual extension |

The automatic result saves 29,389 characters (83.75%). Using the declared four-character approximation, the comparison is 8,773 versus 1,426 tokens. The cold structural read is slower because it starts a sandboxed LSP; this benchmark demonstrates context reduction and exact code-location recovery, not a latency win. OMP remains `NOT_RUN` because its required Bun runtime is unavailable.

## Phase 5 Artifact Store

`npm run benchmark:ultra:artifacts` launches official Pi 0.85.1 with the actual Artifact Store and ResourceFS extensions. The deterministic payload generator lives directly in the Node benchmark, while Pi loads the TypeScript fixture/provider inside its own runtime. The fixture provider is also syntax-checked by the full project gate. Three tool calls use four deterministic local provider turns, zero network/external-provider/paid calls, and cost zero.

| Real Pi operation | Result | Model-facing output | Evidence |
|---|---:|---:|---|
| Large 46,070-character tool result | PASS | 5,352 chars | 88.38% reduction; deterministic preview, URI and manifest metadata |
| ResourceFS artifact range, lines 419–421 | PASS | 482 chars | Exact numbered lines recovered; critical `ERROR` at line 420 retained |
| Same payload from a failing tool | PASS | 5,352 chars | `isError=true`, critical diagnostic retained, content object deduplicated |
| Stored object integrity/privacy | PASS | 1 object | SHA-256 matches; scope/session digests; owner-only mode; one link; no temporary path in manifest |
| `/artifacts` and `/resources` registration | PASS | — | Sources are the actual extensions |
| Temporary state cleanup | PASS | — | Benchmark root removed in both PASS and FAIL paths |

The recorded run completed the tool sequence in 383.318 ms. Using the declared four-character approximation, the main comparison is 11,518 versus 1,338 tokens; these are estimates, not provider billing values. The failure control prevents a context-reduction PASS from masking lost Pi error semantics. OMP stays `NOT_RUN` because Bun >=1.4 is unavailable, so no cross-product latency or reduction winner is declared.

## Phase 6 Context Governor

`npm run benchmark:ultra:context-governor` launches official Pi 0.85.1 with the actual Artifact Store and Context Governor plus a deterministic local provider. Two scenarios and one command-discovery process use zero network/external-provider/paid calls and cost zero.

| Real Pi operation | Result | Context evidence |
|---|---:|---|
| First two fit requests | PASS | 544 and 1,906 estimated input tokens; no unnecessary reduction |
| Third request with duplicate artifact | PASS | 3,268 → 2,183 tokens against 2,480 usable; redundant-artifact stage changed exactly one message and saved 1,085 tokens |
| Evidence preservation | PASS | two tool results, five reopenable artifact references, one explicit omission marker, both critical diagnostics retained |
| Provider attestation | PASS | all three successful context proofs matched provider/model immediately before request payload dispatch |
| Irreducible current user request | PASS (blocked) | 39,216 tokens against 1,880 usable; all safe stages exhausted; zero provider stream entries |
| `/context-fit` registration | PASS | extension command discovered with zero provider calls |
| Temporary cleanup | PASS | benchmark root removed in both PASS and FAIL paths |

These are conservative local estimates aligned with Pi's four-character approximation, not provider billing tokens. The benchmark proves pre-provider behavior and preservation properties; it does not claim an automatic model switch or cross-product superiority. OMP remains `NOT_RUN` because Bun >=1.4 is unavailable.

## Phase 7 Edit Engine V2

`npm run benchmark:ultra:edit-engine` launches official Pi 0.85.1 with the actual read tool and Edit Engine V2. Two independent scenarios use eight deterministic local provider turns, zero network/external-provider/paid calls, and cost zero.

| Real Pi operation | Result | Evidence |
|---|---:|---|
| Read-bound safe relocation | PASS | Snapshot footer observed; one-line external insertion preserved; preview reports `SAFE_RECOVERY`; apply produces the intended anchored replacement |
| Preview isolation | PASS | Fixture still contains `anchor old` after preview and before apply |
| Atomic apply and receipt | PASS | Final content digest matches; one mode-0400 metadata-only receipt; no path/source text; no staged residue |
| Preview/apply race | PASS (blocked) | External replacement made after preview remains intact; apply returns `STALE_EDIT`; no receipt or staged residue |
| Metadata trace contract | PASS | Snapshot/preview/apply records contain only status, counts and digests; no fixture path or source text |
| `/edit-engine` registration | PASS | Extension command discovered with zero provider turns |
| Temporary cleanup | PASS | Benchmark root removed in PASS and FAIL paths |

The current Phase 8 regression rerun recorded recovery and stale scenarios at 283.244 ms and 290.223 ms respectively. These are single-host lifecycle measurements, not a latency comparison. OMP remains `NOT_RUN` because Bun >=1.4 is unavailable; no cross-product success or performance claim is inferred.

## Phase 8 Transactional AST Edit

`npm run benchmark:ultra:ast-edit` launches official Pi 0.85.1 with the actual read tool, Edit Engine V2, and lazy pinned ast-grep adapter. Two independent scenarios use eight deterministic local provider turns, zero network/external-provider/paid calls, and cost zero.

| Real Pi operation | Result | Evidence |
|---|---:|---|
| Duplicate structural matches | PASS | Exact snapshot plus expected count 2; both `legacy(value)` call expressions previewed and replaced by `modern(value)` |
| Preview isolation | PASS | Live fixture remained unchanged through structural query and transaction creation |
| Atomic AST apply and receipt | PASS | Final digest matched; one mode-0400 `ast-grep-v1` metadata-only receipt; no staged residue |
| Preview/apply race | PASS (blocked) | External post-preview content remained intact; apply returned `STALE_EDIT`; no receipt or staged residue |
| Metadata trace contract | PASS | Only status/counts/digests recorded; no fixture path, pattern/rewrite text, or source body |
| `/ast-edit` registration | PASS | Zero provider turns; sentinel executable proves session startup/discovery does not launch the lazy runtime |
| Temporary cleanup | PASS | Benchmark root and private snapshot directories removed in PASS and FAIL paths |

The recorded success and stale scenarios completed in 474.905 ms and 344.731 ms respectively. These are single-host lifecycle measurements, not a latency comparison. The exact pinned CLI and first-use SHA-256 attestation are part of the measurement; OMP remains `NOT_RUN` because Bun >=1.4 is unavailable, so no cross-product success or performance claim is inferred.

## Phase 9 LSP write guard

`npm run benchmark:ultra:lsp-write` launches official Pi 0.85.1 with the actual read/transactional-edit path and pinned TypeScript LSP. The success and rejection scenarios use seven deterministic local provider turns, zero network/external-provider/paid calls, and cost zero.

| Real Pi operation | Result | Evidence |
|---|---:|---|
| Candidate overlay isolation | PASS | Exact candidate bytes were checked through LSP while the live fixture retained its baseline bytes |
| Pre-write type regression | PASS (blocked) | New TS2322 caused `LSP_NEW_BLOCKING_DIAGNOSTIC`; original file unchanged; no receipt |
| Post-write validation | PASS | Safe candidate was atomically installed, reread from the real filesystem, and matched the accepted diagnostic digest |
| Immutable validation receipt | PASS | One mode-0400 receipt contains bounded language/backend/project/count/digest evidence and no path, diagnostic message, or source body |
| Metadata trace contract | PASS | Baseline/candidate/post status, counts, and digests only; no fixture path or source text |
| Residue and lazy lifecycle | PASS | No staged files; `/lsp-write` discovery used zero provider turns and a sentinel proved no eager LSP start |
| Temporary cleanup | PASS | Benchmark root removed in PASS and FAIL paths |

The recorded safe and rejected scenarios completed in 2,078.088 ms and 1,970.364 ms. These are single-host lifecycle observations, not an OMP latency comparison. OMP remains `NOT_RUN` because Bun >=1.4 is unavailable.
