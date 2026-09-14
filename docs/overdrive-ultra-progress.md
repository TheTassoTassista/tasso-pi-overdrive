# Overdrive Ultra progress ledger

## Resume coordinates

- Worktree: `/home/tasso/Documents/Codex/tasso-pi-overdrive-ultra`
- Branch: `feature/overdrive-ultra`
- Base commit: `0f107b8670b69b214e478b8d854377956f7039be`
- Current phase: 0 — baseline and OMP reference audit
- Last completed phase commit: none yet (Phase 0 changes are under validation)
- OMP reference: `4267074ac91456866e95ed8de0b6353388f08502`, package 18.1.21, MIT
- Paid/provider calls used by Ultra work: 0

## Completed work

- Verified the original repository branch/HEAD and isolated unrelated user modification.
- Created this separate worktree without stashing, resetting, or touching the user audit file.
- Performed a fresh OMP source/license/docs/tool/test/recent-issue audit.
- Captured full baseline: 216/216 tests PASS with the verified stable LSP runtime; syntax, TypeScript and package validation PASS.
- Captured context, read, grep, edit, stale-edit, process/RSS, output-optimizer, memory and deterministic task measurements.
- Added a pinned benchmark manifest and honest OMP `NOT_RUN` status because Bun >=1.4 is unavailable.
- Reconciled the local-smoke assertion with the already-current project template.

## Current validation

- `npm run benchmark:ultra:baseline`: PASS; four real Pi tool calls, eight deterministic provider turns, zero paid/model-provider calls.
- `npm run benchmark`: PASS; critical diagnostics retained.
- `npm run benchmark:suite`: 6/6 PASS outside the nested runner sandbox.
- `npm run benchmark:memory`: PASS.
- `npm run check`: 216/216 tests PASS plus syntax/type/package validation when pointed at the already-verified stable managed binary runtime.
- `npm run smoke:local`: PASS after the expectation correction; temporary worktree/repository cleanup PASS.

## Dirty files expected before the Phase 0 commit

- `package.json`
- `scripts/local-smoke.mjs`
- `benchmarks/overdrive-vs-omp/`
- `docs/omp-gap-analysis.md`
- `docs/overdrive-ultra-benchmarks.md`
- `docs/overdrive-ultra.md`
- `docs/overdrive-ultra-progress.md`

`docs/final-adversarial-audit.md` must not appear in this worktree's diff and the user's modified copy in the original worktree must retain SHA-256 `f556b3adc88e58f5319f208b4a74c496705ef90b24680bf8bde12e5ce5a9f3ba`.

## Known blockers and limitations

- OMP cannot yet be executed locally because Bun >=1.4 is absent. No OMP numeric result is inferred.
- A new Git worktree does not contain ignored managed LSP binaries. Baseline tests use the verified runtime in the stable installation via `PI_OVERDRIVE_LSP_RUNTIME`; the Ultra worktree has its lockfile-pinned Node LSP dependencies materialized.
- OMP comparisons are source/architecture-only until an isolated executable reference can be provided without changing either product's data.

## Exact next action

Verify both worktrees and the protected audit hash, then create the local Phase 0 commit. After recording its hash here, begin Phase 1 by extending the existing deterministic Token Governor into a versioned Task Policy without changing routing or workflow hard limits.
