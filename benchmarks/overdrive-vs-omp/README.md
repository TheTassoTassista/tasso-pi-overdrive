# Overdrive vs OMP benchmarks

This directory contains reproducible measurements, not product claims.

- Overdrive base: `0f107b8670b69b214e478b8d854377956f7039be`
- OMP source reference: `4267074ac91456866e95ed8de0b6353388f08502` (`@oh-my-pi/pi-coding-agent` 18.1.21)
- OMP license at that commit: MIT
- Model/provider calls in the Phase 0 baseline: zero

`baseline.mjs` exercises the installed official Pi 0.85.1 read, grep, and edit tools through a local deterministic provider. It records bounded output sizes, request sizes, stale-edit behavior, latency, process-tree size, and resident memory. It hashes tool output rather than persisting fixture content.

Run:

```sh
npm run benchmark:ultra:baseline
npm run benchmark:ultra:task-governor
npm run benchmark:ultra:edit-engine
```

`task-governor.mjs` validates four fixed task classes and measures 10,000 deterministic Task Policy decisions. It performs no model or provider call. Its capability list is policy intent; later phases are responsible for implementing and gating optional tools.

`edit-engine.mjs` drives the real Pi read → snapshot → preview → apply lifecycle with a deterministic local provider. It records a safe-relocation success and a preview/apply race denial, receipt privacy/mode, metadata-only events, staged-file cleanup, and slash-command discovery. It performs no network, external-provider, paid-model, or billable call.

The committed result intentionally marks OMP execution `NOT_RUN`: this host did not have the reference project's required Bun >=1.4 runtime. Source inspection is never converted into fabricated numeric results. Later phase benchmarks must use identical fixtures and record failures as well as successes.
