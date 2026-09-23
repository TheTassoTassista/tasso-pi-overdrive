# Phase 25: native fast paths — profiling decision

Measured the current implementation after Phase 24 at commit `68b25b9`, using existing deterministic local fixtures and benchmark scripts **without** `--write-results`. No dependency, runtime, provider route, model, preset, auth, or package code was changed. External/paid provider calls and monetary cost were zero. The OMP reference was not run because Bun >=1.4 is unavailable; these are local measurements, not cross-product claims.

| Existing path | Local result | Scope |
|---|---:|---|
| Task Governor | 10,000 validated decisions; 0.080982 ms mean | Warm deterministic JS policy fixture |
| Model Harness Profile plus governor constraint | 10,000 compositions; 0.061269 ms mean | Warm deterministic JS post-route fixture |
| Output optimizer | 164,450 input characters to 4,836, 97.06% reduction; 15.364 ms mean over 100 iterations; diagnostic retained | Large synthetic text fixture; not a normal single-tool latency claim |
| Real Pi exact edit | 404.197 ms safe recovery, 256.371 ms stale rejection | Separate Pi 0.85.1 processes, four local provider turns each; fixture cleanup PASS |
| Real Pi AST edit | 1,787.070 ms success, 1,614.501 ms stale rejection | Separate Pi processes, four local provider turns each; pinned native ast-grep and LSP validation are included; fixture cleanup PASS |
| Real Pi built-in read/grep/edit/stale | 1,021.783 / 1,027.463 / 1,003.727 / 997.623 ms | Fresh Pi process per tool, two local provider turns each; active installed package control, not isolated Ultra tool CPU timing |

Commands: `node benchmarks/overdrive-vs-omp/task-governor.mjs`, `node benchmarks/overdrive-vs-omp/model-harness-profile.mjs`, `node benchmarks/output-optimizer.mjs`, `node benchmarks/overdrive-vs-omp/edit-engine.mjs`, `node benchmarks/overdrive-vs-omp/ast-edit.mjs`, and `node benchmarks/overdrive-vs-omp/baseline.mjs`. The two edit benchmarks used the already-verified stable managed LSP runtime. All returned PASS and removed temporary fixture state. The baseline's fresh-process timings must not be compared as if they were isolated function timings; the AST timing likewise cannot be assigned to JavaScript rather than Pi startup, binary attestation, ast-grep, or LSP from this evidence.

Decision: **do not add package-owned native code**. The directly measured JS policy paths are sub-millisecond, the large-output path is already bounded and evidence-preserving, and the measured semantic edit path already invokes native ast-grep. These results do not demonstrate a reproducible, material JS CPU bottleneck that justifies another binary, platform pin, sandbox surface, build chain, or fallback. This is a value/safety decision, not a claim that native code can never improve a workload. Reopen with a representative real task whose latency is material, repeated measurements, CPU attribution to an owned JS function, an explicit improvement target, and a portable JS/system fallback; do not infer a win from OMP source alone.
