# Benchmark and smoke results

Recorded on 2026-09-09 with official Pi 0.85.1. A PASS below is backed by the current filesystem plus a runtime command; failed authenticated post-expansion E2E runs are explicitly not counted as passes.

## Current regression evidence

| Check | Result | Runtime evidence |
|---|---|---|
| Unit/static package | PASS | `npm run check`: 77/77 Node tests, syntax, extension TypeScript, manifest/frontmatter/pin/path validation |
| Deterministic evaluator | PASS | `npm run benchmark:suite`: 6/6 task categories, zero paid calls |
| Model preset evaluator | PASS | `npm run benchmark:models`: four presets, all twelve routes present and in the live authenticated catalog, zero paid calls |
| Real Pi capability path | PASS | `npm run smoke:runtime`: FFF filename/content, two AST matches, TS diagnostics/definition/four references, and real public `web_fetch`, driven sequentially by a local deterministic provider |
| Real model commands | PASS | `npm run smoke:models`: live catalog, authentication metadata unchanged, override/persistence/reload/reset, invalid-ID rejection, all concrete presets, custom preservation |
| Council surface/policy | PASS | `npm run smoke:council`: protected `/council` command wins over the upstream prompt, `/council-status` is key-free, all four roles are fresh/read-only/non-delegating |
| MCP | PASS | `npm run smoke:mcp -- --online`: lazy Context7 connection and real read, mutation approval denial, allowlist, no side effect, metadata-only MCP trace |
| General LSP | PASS/PARTIAL | `npm run smoke:lsp`: real TS and Python definition/references/diagnostics and C++ diagnostic pass in read-only no-network Bubblewrap; missing Rust and Go servers report `PARTIAL` |
| Web | PASS/PARTIAL | `npm run smoke:web`: `web_fetch` and DNS-pinned `safe_web_fetch` work; unsafe schemes/private targets fail; Brave and Perplexity search fail explicitly because both credentials are absent |
| Browser | PASS | `npm run smoke:browser`: three actual Chromium calls with assigned profile/session, DOM marker inspection, profile materialization, and close |
| Agent boundaries | PASS | `npm run smoke:agents`: all twelve profiles discovered; Tester/council are read-only, Worker has no shell, autonomous roles have no web tools |
| Guardrails | PASS | `npm run smoke:guardrails`: all 13 direct/symlink/outside/shell/indirection attacks denied with no leak or side effect |
| Verification | PASS | `npm run smoke:verification`: exit 7 and `NO_CHECKS` surface as tool errors and cannot become PASS |
| Notebook/handoff | PASS | `npm run smoke:handoff`: durable marker preserved, editable handoff produced, new session message count zero |
| Bootstrap | PASS | `npm run smoke:bootstrap`: clean temporary HOME, exact packages/runtimes, all presets/council routes, private policy/backup, no auth created |
| Restore | PASS | `npm run smoke:restore`: original settings restored byte-for-byte; SHA-256 `08288b6b68fad66fa8797adbf8855d8029042b2970edf326d5415bcf22c194cb` |
| Output optimizer | PASS | `npm run benchmark`: 164,450 to 4,836 characters (97.06%); critical diagnostics retained; 16.074 ms mean over 100 runs |
| Trace privacy | PASS | `npm run smoke:trace`: 228 files / 1,179 rows; zero malformed rows, truncated tails, insecure files, forbidden fields, or secret-like values |
| Mission privacy | PASS | `npm run missions:audit`: 18 terminal artifacts, all owner-only, zero detected secret-like values; terminal retention cap 25 |
| Observability | PASS | `npm run observe`: actual current values—0 sources, 0 critical, 0 warnings, 0 bytes; Git changed-path count was 12 at measurement time |

The first deterministic evaluator attempt inside Codex's own nested sandbox could not spawn `rg`; the host-context rerun passed 6/6. Likewise, nested-sandbox LSP/Bubblewrap failures are not product failures; the required host-context suite passed 77/77.

## Preset comparison

`npm run benchmark:models` queried the real Pi registry. Only `openai-codex` was authenticated, with eight available models. The route-rate columns sum the registry's published input-plus-output USD-per-million rates for the roles shown; they are not task-cost estimates.

| Preset | Deterministic status | Normal path rate | Added high-risk/council rate | Models | Providers | Live review |
|---|---|---:|---:|---:|---:|---|
| Budget | PASS | 9.8 | 7.0 | 1 | 1 | NOT RUN |
| Efficient | PASS | 123.2 | 207.5 | 6 | 1 | NOT RUN |
| Balanced | PASS | 105.7 | 207.5 | 6 | 1 | NOT RUN |
| Max quality | PASS | 210.5 | 207.5 | 5 | 1 | NOT RUN |

Efficient remains the default: Luna handles cheap reconnaissance/testing, Terra implementation, Sol planning/review, and Astra only Oracle/Judge. This is a routing/cost rationale, not evidence that heterogeneous councils improve quality. The `--live` four-review benchmark was not run because it would add paid calls after an authenticated E2E had already been attempted. A cross-provider quality comparison was impossible with one authenticated provider.

## Context and tool-schema overhead

The last exact provider-reported pre-model/council measurement was:

- no tools: 433 input tokens
- default surface: 4,547 input tokens
- exact default delta: 4,114 tokens
- MCP increment over the pre-MCP measurement: 588 tokens
- WEB increment: 0 default tool schemas
- LSP increment: 0 default tool schemas; `semantic_nav` stays opt-in/lazy

The current zero-cost measurement, `npm run benchmark:context`, runs Pi seven times with a local metadata-only provider and the same tool selections. Pi's actual contexts were inspected without storing their contents:

- no tools: estimated 459 tokens
- default: estimated 5,379 tokens
- estimated delta: 4,920 tokens
- actual default call exposed eight schemas: the configured seven core tools plus Pi's deferred `ask_user_question`
- `secure_coding_workflow` alone: 548 schema characters / estimated 137 schema tokens
- model routing: 0 new default tool schemas (slash commands only)
- council: 0 new default tool schemas (internal to the existing workflow tool)

The estimate uses Pi's documented four-characters-per-token estimator, so it must not be compared numerically as if it were a new provider-billed measurement. The exact seven-call live measurement was not rerun because it would consume additional paid calls. The important structural result is exact: the model/council expansion did not add tools to the default surface.

## Authenticated E2E status

The last fully passing pre-expansion workflow evidence is run `0789657a-a21f-4614-8919-ad88089050b8`; it proves the v4 Worker → Tester → verification → reviewers → correction machinery but not the new model/council receipt integration.

The post-expansion run `c8e1d5ac-4f17-4fd4-a4fa-336de3c0fad9` correctly ended FAIL before Scout admission. Both real Scout child executions completed on `openai-codex/gpt-5.6-luna:low`, but the controller expected `openai-codex/gpt-5.6-luna` plus a separate `low` field and rejected both responses. The run wrote FAIL evidence and cleaned its runtime; it did not become a false positive.

The controller now accepts the canonical model form or the exact `:thinking` suffix Pi-subagents emits, canonicalizes it, stores a launch-contract digest, and records every terminal attempt durably. Targeted route/receipt/state tests and the full 77-test suite pass.

The explicitly authorized single post-fix run `179bb6f7-414c-4529-baa2-709630b9bac9` nevertheless ended **FAIL**. Scout, Planner, and Oracle completed on the configured `openai-codex/gpt-5.6-luna:low`, `openai-codex/gpt-5.6-sol:high`, and `openai-codex/gpt-6-astra:high` routes. The high-risk council then failed closed before Worker: `gpt-5.4` was rejected by Codex as unsupported with a ChatGPT account; council-1 and the first council-2 attempt were rejected by the child runtime for making no edits even though these are deliberately read-only advisory roles; the second council-2 attempt omitted its required structured-output call. Each council member had two controller-level delegation attempts. Worker, Tester, verification, reviewers, correction, and Judge were therefore not run.

The durable child sessions record 21 provider calls, 47,081 input tokens, 14,080 output tokens, 37,248 cache-read tokens, 10,030 reasoning tokens, 98,409 total reported tokens, and USD 0.7057564. The outer Luna coordinator made two additional calls; its token and cost data were not persisted by the no-session RPC harness. Total model-call count is therefore 23, while the reported token/cost total covers 21 of those calls only. Runtime/worktree/port/process cleanup passed and the temporary repository was removed.

The E2E evidence validator also has a separate false-negative: it compares canonical stored model IDs to hardcoded IDs containing `:thinking`, so it incorrectly labels the three successfully routed roles as unintended. This does not explain the controller stop—the council failures do—but it makes the final validator unreliable until corrected. No rerun was performed.
