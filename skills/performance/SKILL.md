---
name: performance
description: Measure and improve latency, throughput, memory, CPU, I/O, or build performance. Use only when a performance objective or regression is in scope.
---
# Performance

Define workload, metric, environment, noise controls, and acceptable tradeoffs. Record a baseline before editing.

Profile to find the dominant cost. Prefer algorithmic and I/O reductions over micro-optimizations. Check warm/cold behavior, cache effects, allocation, concurrency, and worst cases relevant to users.

Compare repeated before/after samples using the same harness. Verify correctness and resource regressions. Keep benchmark data and interpretation separate.
