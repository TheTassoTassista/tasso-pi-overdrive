# Benchmark and smoke results

Recorded through 2026-09-09 on official Pi 0.85.1. Results below are from the post-remediation filesystem/runtime; the 2026-09-07 integrated-workflow and LSP claims are superseded.

| Check | Result | Runtime evidence |
|---|---|---|
| Package unit/static validation | PASS | 59/59 Node tests, extension TypeScript check, JSON/frontmatter/pin/path validation |
| Receipt/journal determinism | PASS | Receipt invariants and controller admission tests pass; the real receipt-enabled Scout → Planner controller transition repeated 100/100 with identical adjacency |
| Output optimizer | PASS | 5,000 lines / 164,450 chars → 4,836 chars (97.06%); all critical diagnostics retained; 14.888 ms mean over 100 runs |
| Fresh tool-schema overhead | PASS | no-tools 433 input tokens; default seven-tool surface 4,547; delta 4,114. MCP accounts for the 588-token increase from the pre-MCP 3,959/3,526 result; the web phase added zero because its tools remain inactive until explicitly selected. Pre-limiter measurement was 15,965 total / 15,532 delta |
| Dual-provider web policy | PASS / credentials pending | `/web-status`, compatibility `web_fetch`, DNS-pinned `safe_web_fetch`, provider-specific failure, precedence, fallback, cross-check, SSRF/redirect/timeout/body/content limits, sanitized errors, and no autonomous-role network tools passed; live Brave/Perplexity calls await their keys |
| Deterministic evaluator | PASS | 6/6 tasks; real before-exit 1 → after-exit 0 for bug fixture; zero paid model calls |
| Pi runtime capabilities | PASS | FFF filename/content, ast-grep two matches, TS2322 diagnostic, exact definition, four references, public `web_fetch` |
| Agent model routing | PASS | E2E receipt recorded every role with exact provider/model/thinking route and unique run/node ownership |
| Structured workflow | PASS | Fresh run `0789657a-a21f-4614-8919-ad88089050b8`: Worker/Tester/verification/reviewer rounds, mandatory correction, final verification/review PASS; no prose scraping |
| Evidence/cleanup | PASS | 18 unique immutable role receipts plus immutable owner-only execution snapshot before cleanup and digest-linked final receipt; worktree/runtime/port removed; evidence survived with top-level and final verdict cleanup/evidence PASS |
| Negative controls | PASS | missing Scout receipt, cross-run Planner receipt, persistent verification failure, missing role/reviewer/correction, nonzero-process PASS mutation, wrong run, stale task, missing/malformed evidence/journal, and pre-final SIGKILL all failed closed |
| Power-loss recovery | PASS | child process SIGKILLed immediately after `CORRECTION_REQUIRED`; stale journal became `INTERRUPTED`; completed roles were not rerun; correction, Tester, verification, and all reviewers resumed exactly once; final receipt/journal validated |
| Browser | PASS | assigned unique `--session` + `--profile`, Chromium profile materialized, local DOM marker inspected, session closed |
| Handoff/notebook | PASS | marker persisted through distillation, editable prompt transferred, new session message count zero |
| Catalog discovery | PASS | Pi RPC exposed all 15 skills, 12 prompt commands, and 7 local extension commands from the stable package; adapter commands were also present |
| Guardrails/Bubblewrap | PASS | direct `.env`/symlink/outside/FFF/AST/shell attacks denied; sandbox hid host paths, env, repository secrets, `/etc`, network, and protected `.git` |
| Verification gate | PASS | exit 7 surfaced as Pi tool error/FAIL; empty repository surfaced as tool error/NO_CHECKS |
| Bootstrap | PASS | isolated temporary HOME/config/state roots installed exact package pins, pinned MCP/TypeScript/Pyright/ast-grep runtimes, and secret-free reversible web policy without creating auth |
| Restore | PASS | original settings restored byte-for-byte in an isolated target; SHA-256 `08288b6b68fad66fa8797adbf8855d8029042b2970edf326d5415bcf22c194cb` |
| Trace privacy | PASS | 95 files / 574 rows audited after the final E2E: zero value-bearing fields, insecure files, forbidden fields, secret-like values, truncated tails, or malformed rows |
| Mission privacy | PASS | 18 terminal artifacts, all owner-only, no detected secret-like values; terminal retention cap 25 |
| Application observability | PASS | collector returned real current values: 0 sources, 0 critical, 0 warnings, 0 bytes—not placeholders |

`benchmarks/tasks.json` defines the six reusable categories. `benchmarks/evaluator.mjs` executes deterministic controls without paid model use. `benchmarks/context-overhead.mjs` makes seven intentionally small Luna calls and reports API-exposed token/cache/cost values. The full authenticated E2E is intentionally separate from `npm run check` because it is slower and consumes model traffic.
