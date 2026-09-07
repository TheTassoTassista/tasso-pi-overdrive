---
description: Measure and improve performance without trading away correctness
argument-hint: "<slow operation or target>"
---
Performance target: ${@:-describe the problem}.

Define workload and success metric. Measure a reproducible baseline before optimizing. Identify the dominant cost with profiling or instrumentation, change the smallest relevant path, and rerun the same benchmark enough times to distinguish signal from noise. Verify correctness and resource regressions. Report environment, commands, samples, before/after results, and uncertainty.
