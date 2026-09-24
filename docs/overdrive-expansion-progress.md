# Overdrive Ultra Expansion 26–39 progress ledger

## Resume coordinates

- Worktree: `/home/tasso/Documents/Codex/tasso-pi-overdrive-ultra-expansion`
- Branch: `feature/overdrive-ultra-expansion`
- Base HEAD: `abbaa7d2e7c2841c4bc290b5ac29f5843456ade7` (validated Ultra Phase 25)
- Current HEAD: resolve with `git rev-parse HEAD` after this bookkeeping commit
- Current phase: 28 — Secure Collaboration, NEXT; Phase 26 is COMPLETE/BOUNDED and Phase 27 is PARTIAL/DEFERRED FOR SAFETY after its contract checkpoint
- Last functional Expansion commit: `ea7aad044da9ad30af6280d6f1f3fbbda7b84b3b` (Phase 27 contract)
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
- `ea7aad044da9ad30af6280d6f1f3fbbda7b84b3b` — platform-neutral, fail-closed Computer Use action/approval/target/frame contract and Linux/Windows fixture tests. No native backend or model tool was registered.

## Bookkeeping commits

- `a76ce40` contains the Phase 26 ledger, authority matrix, implementation note, and `benchmarks/overdrive-vs-omp/debugpy-engine-results.json`.
- The subsequent commit containing this Phase 27 disposition and `docs/implementation-notes/phase-27-computer-use-contract.md` records the contract-only, native-backend-deferred boundary. Resolve its exact hash with `git log -1` after commit.

## Tests and benchmarks

- Pre-change Expansion baseline: 461/461 PASS, syntax PASS, TypeScript PASS, package validation PASS.
- Phase 26 focused tests: 11/11 PASS; real GDB/C and real Python/debugpy are both included. Adapter crash, debuggee nonzero exit, timeout/malformed frame, partial startup, policy/digest mismatch, path replacement, reverse request, model-supplied adapter/attach/remote/custom request denial, secret scrubbing, read-only workspace, external-network denial, bounded variables/output, and cleanup are covered.
- Phase 26 real Pi/debugpy benchmark: PASS on Pi 0.85.1; 11/11 tool results, 12 deterministic local-provider turns, real breakpoint/stack/scopes/variables/step/exit 0, 24 KiB output externalized, metadata only, no process/workspace/temporary residue, zero paid/external provider calls and €0. See `benchmarks/overdrive-vs-omp/debugpy-engine-results.json`.
- Phase 26 real Pi/GDB benchmark rerun: PASS; 8/8 tool results, nine deterministic local-provider turns, exit 0, isolation/artifact/cleanup assertions green. The original GDB result fixture was not overwritten.
- Phase 26 authoritative `PI_OVERDRIVE_LSP_RUNTIME=/home/tasso/Documents/Codex/tasso-pi-overdrive/runtime/lsp npm run check`: 466/466 PASS, syntax PASS, installed-Pi TypeScript PASS, package/secret validation PASS. `bash -n scripts/install-managed-dap.sh scripts/sandbox-run.sh` and `git diff --check` PASS.
- Phase 27 contract tests: 8/8 PASS across Linux and Windows fixture backends. Authoritative Expansion gate using the same verified LSP runtime: 474/474 PASS, syntax PASS, installed-Pi TypeScript PASS, package/secret validation PASS. A bare `npm test` without that LSP selector returned 472/474 because ignored Rust/Go managed binaries are absent in this Expansion worktree; rerunning with the documented selector returned 474/474, so this is dependency-selection evidence rather than a product regression.
- OMP execution: `NOT_RUN` (Bun >=1.4 not materialized in an isolated comparable runtime).

## Phase 26 adapter matrix

| Adapter | Implementation | Host evidence | Notes |
|---|---|---|---|
| GDB | IMPLEMENTED | REAL_HOST_VERIFIED | Existing Linux-x64 reviewed profile and C/Pi regressions remained green |
| debugpy | IMPLEMENTED | REAL_HOST_VERIFIED | Linux-x64 CPython 3.14.7 and managed debugpy 1.8.22 only; exact wheel, binary, and module-tree hashes |
| LLDB/CodeLLDB, Delve, js-debug | NOT_RUN | UNAVAILABLE | No runtime/policy/real host probe; not advertised as usable |
| Windows backend | NOT_RUN | NOT_RUN | No Windows execution evidence or support claim |

Both real adapters support bounded launch, source breakpoints, continue, step-over, stack, scopes, variables, output, status, and termination. Neither grants attach, arbitrary requests/commands, evaluation, remote targets, or workspace write.

## Phase 27 disposition

- Internal API: IMPLEMENTED/UNIT_VERIFIED for Linux and Windows fixture backends; seven actions share the same target/element/frame/approval/revocation rules.
- Native Linux capability: UNAVAILABLE. Read-only portal introspection found Screenshot v2 `AvailableTargets=0`, no RemoteDesktop, and InputCapture `SupportedCapabilities=0`; raw `grim`/compositor control cannot meet target/redaction guarantees. No host screenshot/input was performed.
- Native Windows capability: NOT_RUN. OS APIs were reviewed, but no Windows runtime/backend/CI evidence exists.
- Pi model-facing capability: UNREGISTERED by policy validation. No host action, external provider, or paid call was added. See `docs/implementation-notes/phase-27-computer-use-contract.md`.
- Status: PARTIAL/DEFERRED FOR SAFETY rather than a false cross-platform PASS. A trusted approval UI, native target-bound capture/inspection/input broker, pre-publication redaction, and host tests remain prerequisites.

## Dirty files

- After the Phase 26 bookkeeping commit: expected clean; verify with `git status --short`. The managed `runtime/dap/python` and managed LSP dependencies are ignored project-local materializations, not tracked secrets.

## Known limitations

- The installed Pi configuration still points to the stable package, not this experimental Expansion worktree.
- Windows backend evidence is `NOT_RUN`; no Linux result may be promoted to Windows host support.
- Phase 23 host Computer Use and Phase 24 Collaboration remain deferred under the prior safety decisions until a new authority boundary is proved.
- Phase 26 DAP is multi-adapter only on the verified Linux host; sessions remain single-session and memory-only. The Python runtime is deliberately host-pinned, and fresh worktrees must run the project-owned hashed installer. Same-UID runtime mutation remains a local trust assumption despite per-launch attestation.
- Phase 27's `ComputerUseController` is an internal contract, not an OS sandbox or a usable desktop feature. Both native backends are unavailable; host-wide raw screenshot/input remains prohibited. Linux and Windows fixture tests do not establish host validation.
- Ignored managed Rust/Go LSP binaries remain in the verified stable runtime selected for the full gate; the new worktree owns only its lockfile-pinned Node LSP modules.
- `docs/final-adversarial-audit.md` and all other protected audit state must remain untouched.

## Exact next action

Begin Phase 28 from this clean checkpoint: inspect the Phase 24 collaboration safety assessment and the pinned OMP reference, then require a concrete authenticated, opt-in guest-rights/retention/approval boundary before any listener or shared transcript. Keep Phase 27's native Computer Use deferred until a reviewed OS broker and host evidence exist; do not use Phase 28 to bypass it. Do not push, create a PR, change tags, reset, clean or stash user work.
