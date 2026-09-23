# Overdrive Ultra Expansion 26–39 progress ledger

## Resume coordinates

- Worktree: `/home/tasso/Documents/Codex/tasso-pi-overdrive-ultra-expansion`
- Branch: `feature/overdrive-ultra-expansion`
- Base HEAD: `abbaa7d2e7c2841c4bc290b5ac29f5843456ade7` (validated Ultra Phase 25)
- Current HEAD: resolve with `git rev-parse HEAD`; no Expansion commit yet at ledger creation
- Current phase: 26 — Multi-Adapter DAP, IN PROGRESS
- Last functional Expansion commit: none
- Last bookkeeping Expansion commit: none
- OMP reference: `a1b3b83a7fb8460445f2f5995a6aa56047bd44c7` (main on 2026-09-23, coding-agent 18.2.11)
- OMP license: repository root and coding-agent package declare MIT; no source copied into Expansion
- Extra monetary cost/external model-provider calls: €0 / 0

## Baseline and reference checks

- The completed Ultra branch was clean at the expected base commit. The original, hardening, Second Brain and Ultra worktrees were left unchanged; a fifth isolated worktree was created from the validated Ultra HEAD.
- New worktree first gate: 454/461 because ignored TypeScript/LSP Node dependencies were absent from a fresh Git worktree. The seven failures were all in TypeScript/LSP/eval integration. `npm ci --ignore-scripts --no-audit --no-fund` materialized exactly the existing `runtime/lsp/package-lock.json` in this worktree only. Authoritative `PI_OVERDRIVE_LSP_RUNTIME=/home/tasso/Documents/Codex/tasso-pi-overdrive/runtime/lsp npm run check` then passed 461/461, syntax, TypeScript and package validation before any Expansion code edit.
- OMP public `main` was read by `git ls-remote` and fetched into the existing reference clone without changing its checkout. Root LICENSE and package metadata at the pinned commit state MIT; current DAP defaults, debug documentation and tests were inspected. OMP advertises GDB, LLDB, CodeLLDB, debugpy, Delve, js-debug and other adapters, but its model tool also exposes attach, evaluate, custom requests and memory writes that are outside Overdrive's default authority. OMP itself has not been executed; numeric comparison remains `NOT_RUN`.
- On this Linux host, `/usr/bin/gdb` 17.2 and `/usr/bin/python3` 3.14.7 exist. `lldb-dap`, `codelldb`, `dlv`, and `debugpy` are not installed at baseline. A second adapter must be obtained in a project-local, pinned runtime and demonstrated by a real smoke before it is advertised as available.

## Phase 26 design guard

Retain one controller-owned DAP session, exact adapter identity, networkless Bubblewrap, read-only workspace, scrubbed environment, reverse-request denial, bounded DAP framing/output, process-group cleanup, and the existing GDB C smoke. Adapter names and launch payloads must come from reviewed profiles, never model-supplied command/argv. Attaching to ambient processes, raw commands, memory write and general evaluation remain unavailable. New adapter capability is separately attested and only enabled after a real smoke.

## Functional commits

- None yet.

## Bookkeeping commits

- None yet.

## Tests and benchmarks

- Pre-change Expansion baseline: 461/461 PASS, syntax PASS, TypeScript PASS, package validation PASS.
- Phase 26 focused tests: pending.
- Phase 26 real adapter benchmark: pending.
- OMP execution: `NOT_RUN` (Bun >=1.4 not materialized in an isolated comparable runtime).

## Dirty files

- At initial ledger creation: this ledger and `docs/overdrive-authority-matrix.md` only; recheck `git status --short` after every checkpoint.

## Known limitations

- The installed Pi configuration still points to the stable package, not this experimental Expansion worktree.
- Windows backend evidence is `NOT_RUN`; no Linux result may be promoted to Windows host support.
- Phase 23 host Computer Use and Phase 24 Collaboration remain deferred under the prior safety decisions until a new authority boundary is proved.
- The existing DAP is a real, pinned Linux/GDB implementation, not yet a multi-adapter implementation.
- Ignored managed Rust/Go LSP binaries remain in the verified stable runtime selected for the full gate; the new worktree owns only its lockfile-pinned Node LSP modules.
- `docs/final-adversarial-audit.md` and all other protected audit state must remain untouched.

## Exact next action

Implement Phase 26 adapter-profile selection and strict availability/attestation without widening DAP input authority. Add a project-local pinned second adapter only if its runtime can be isolated and real-smoked; otherwise record it as unavailable. Run focused/adversarial tests, real Pi/adapter benchmark, full gate, commit locally, update this ledger, then continue to Phase 27. Do not push, create a PR, change tags, reset, clean or stash user work.
