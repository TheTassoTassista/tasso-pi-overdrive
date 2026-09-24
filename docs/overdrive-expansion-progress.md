# Overdrive Ultra Expansion 26–39 progress ledger

## Resume coordinates

- Worktree: `/home/tasso/Documents/Codex/tasso-pi-overdrive-ultra-expansion`
- Branch: `feature/overdrive-ultra-expansion`
- Base HEAD: `abbaa7d2e7c2841c4bc290b5ac29f5843456ade7` (validated Ultra Phase 25)
- Current HEAD: resolve with `git rev-parse HEAD` after this bookkeeping commit
- Current phase: 27 — Cross-Platform Computer Use, NEXT; Phase 26 is COMPLETE/BOUNDED
- Last functional Expansion commit: `6ec6f7595ccd629b9e850f66d9c0446d81fa9ece` (Phase 26)
- Last bookkeeping Expansion commit: the commit containing this ledger update (resolve with `git log -1`)
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

- `6ec6f7595ccd629b9e850f66d9c0446d81fa9ece` — one controller-selected GDB/debugpy DAP tool, exact debugpy wheel/module/interpreter attestation, project-owned installer, module-only Bubblewrap mount, real Python and GDB regressions, and Pi benchmark path.

## Bookkeeping commits

- The commit containing this ledger, `docs/overdrive-authority-matrix.md`, `docs/implementation-notes/phase-26-multi-adapter-dap.md`, and `benchmarks/overdrive-vs-omp/debugpy-engine-results.json` closes Phase 26. Its exact hash is the branch HEAD after commit.

## Tests and benchmarks

- Pre-change Expansion baseline: 461/461 PASS, syntax PASS, TypeScript PASS, package validation PASS.
- Phase 26 focused tests: 11/11 PASS; real GDB/C and real Python/debugpy are both included. Adapter crash, debuggee nonzero exit, timeout/malformed frame, partial startup, policy/digest mismatch, path replacement, reverse request, model-supplied adapter/attach/remote/custom request denial, secret scrubbing, read-only workspace, external-network denial, bounded variables/output, and cleanup are covered.
- Phase 26 real Pi/debugpy benchmark: PASS on Pi 0.85.1; 11/11 tool results, 12 deterministic local-provider turns, real breakpoint/stack/scopes/variables/step/exit 0, 24 KiB output externalized, metadata only, no process/workspace/temporary residue, zero paid/external provider calls and €0. See `benchmarks/overdrive-vs-omp/debugpy-engine-results.json`.
- Phase 26 real Pi/GDB benchmark rerun: PASS; 8/8 tool results, nine deterministic local-provider turns, exit 0, isolation/artifact/cleanup assertions green. The original GDB result fixture was not overwritten.
- Phase 26 authoritative `PI_OVERDRIVE_LSP_RUNTIME=/home/tasso/Documents/Codex/tasso-pi-overdrive/runtime/lsp npm run check`: 466/466 PASS, syntax PASS, installed-Pi TypeScript PASS, package/secret validation PASS. `bash -n scripts/install-managed-dap.sh scripts/sandbox-run.sh` and `git diff --check` PASS.
- OMP execution: `NOT_RUN` (Bun >=1.4 not materialized in an isolated comparable runtime).

## Phase 26 adapter matrix

| Adapter | Implementation | Host evidence | Notes |
|---|---|---|---|
| GDB | IMPLEMENTED | REAL_HOST_VERIFIED | Existing Linux-x64 reviewed profile and C/Pi regressions remained green |
| debugpy | IMPLEMENTED | REAL_HOST_VERIFIED | Linux-x64 CPython 3.14.7 and managed debugpy 1.8.22 only; exact wheel, binary, and module-tree hashes |
| LLDB/CodeLLDB, Delve, js-debug | NOT_RUN | UNAVAILABLE | No runtime/policy/real host probe; not advertised as usable |
| Windows backend | NOT_RUN | NOT_RUN | No Windows execution evidence or support claim |

Both real adapters support bounded launch, source breakpoints, continue, step-over, stack, scopes, variables, output, status, and termination. Neither grants attach, arbitrary requests/commands, evaluation, remote targets, or workspace write.

## Dirty files

- After the Phase 26 bookkeeping commit: expected clean; verify with `git status --short`. The managed `runtime/dap/python` and managed LSP dependencies are ignored project-local materializations, not tracked secrets.

## Known limitations

- The installed Pi configuration still points to the stable package, not this experimental Expansion worktree.
- Windows backend evidence is `NOT_RUN`; no Linux result may be promoted to Windows host support.
- Phase 23 host Computer Use and Phase 24 Collaboration remain deferred under the prior safety decisions until a new authority boundary is proved.
- Phase 26 DAP is multi-adapter only on the verified Linux host; sessions remain single-session and memory-only. The Python runtime is deliberately host-pinned, and fresh worktrees must run the project-owned hashed installer. Same-UID runtime mutation remains a local trust assumption despite per-launch attestation.
- Ignored managed Rust/Go LSP binaries remain in the verified stable runtime selected for the full gate; the new worktree owns only its lockfile-pinned Node LSP modules.
- `docs/final-adversarial-audit.md` and all other protected audit state must remain untouched.

## Exact next action

Begin Phase 27 from this clean checkpoint: inspect the prior Phase 23 host-computer-use safety decision and current Linux/Windows native API candidates; design a platform-neutral target-bound approval contract before any host input/screenshot implementation. Preserve the Phase 23 deferred boundary until real secure host evidence exists. Do not push, create a PR, change tags, reset, clean or stash user work.
