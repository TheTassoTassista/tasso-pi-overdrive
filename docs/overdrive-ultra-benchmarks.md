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

## Known baseline finding

The local smoke initially failed only because its expected documentation-directory list had drifted behind the already-committed project template. The fixture showed every actual template file was created and user `AGENTS.md` was preserved. Phase 0 updates the smoke expectation to the current template and reruns it; this is a test repair, not a feature claim.
