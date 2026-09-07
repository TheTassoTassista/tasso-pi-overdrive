# Benchmark and smoke results

Recorded 2026-09-07 on Pi 0.85.1.

| Check | Result | Evidence |
|---|---|---|
| Package unit/static validation | PASS | Node tests, TypeScript check against installed Pi types, JSON/frontmatter/pin validation |
| Output optimizer | PASS | 5,000 lines / 164,450 chars reduced to 4,743 chars (97.12%); diagnostics retained; 9.511 ms mean over 100 runs |
| Local repository harness | PASS | 14 checks: Git, rg, fd, AST, worktree create/list/remove, non-overwriting project template; temporary repository removed |
| Integrated multi-agent harness | PASS | Scout, planner, pre-fix reviewer, worker, tester and guardrail all returned PASS; planted test failed before, passed after, diff clean; repository removed |
| RPC handoff | PASS | Verified marker distilled, editable prompt transferred, command completed, new session had zero messages |
| LSP targeted smoke | PASS | VTSLS returned 48 document symbols from a TypeScript source tree |
| AST targeted smoke | PASS | Three function declarations found structurally |
| FFF targeted smoke | PASS | Relevant package file discovery succeeded with bounded output |
| Scout child launch | PASS | Fresh-context scout returned the package identity through explicit tool providers |
| Browser doctor | PASS | 9 pass, 0 warning, 0 failure; headless Chromium launch succeeded |
| Browser interaction | PASS | Public page opened, DOM snapshot exposed its heading/link, screenshot was created, session closed |
| Skill/prompt catalog | PASS | RPC catalog exposed all 15 custom skills and all 12 custom prompt commands |
| Credential-free web fetch | PASS | `web_fetch` extracted the Example Domain page and returned `WEB_FETCH_PASS` |
| Credential preservation | PASS | Current authentication/model-store hashes matched the pre-change originals before credential backup copies were removed |
| Metadata tracing | PASS | Owner-only JSONL contained event/model/tool/input-key/duration/status/context metadata and no prompt, value, URL, or output fields |

One combined multi-tool model probe produced transient AST/LSP failures while immediate isolated probes passed. This is recorded as orchestration contention, not hidden as a pass; the final harness therefore treats independent targeted checks as authoritative and keeps retries bounded.

`benchmarks/tasks.json` defines six reusable model tasks: navigation, bug fix, refactor, difficult reasoning, test diagnosis, and adversarial review. They are not bulk-run automatically because that would consume paid model traffic without approval. `benchmarks/results.json` stores the deterministic results and fields for API-exposed token, cache, cost, latency, and retry data.
