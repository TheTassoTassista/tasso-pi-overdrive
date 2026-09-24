# Overdrive Ultra Expansion 26–39 progress ledger

## Resume coordinates

- Worktree: `/home/tasso/Documents/Codex/tasso-pi-overdrive-ultra-expansion`
- Branch: `feature/overdrive-ultra-expansion`
- Base HEAD: `abbaa7d2e7c2841c4bc290b5ac29f5843456ade7` (validated Ultra Phase 25)
- Current HEAD: resolve with `git rev-parse HEAD` after this bookkeeping commit
- Current phase: 34 — Hashline / Edit UX Maturity, IN PROGRESS; Phase 33 is DEFERRED FOR SAFETY, Phase 32 is MEASURED/NOT ADDED, Phase 31 is COMPLETE/BOUNDED, Phase 26 is COMPLETE/BOUNDED, Phase 27 is PARTIAL/DEFERRED FOR SAFETY, Phase 28 is DEFERRED FOR SAFETY, Phase 29 is COMPLETE/BOUNDED, and Phase 30 is PREWALK COMPLETE / PERSISTENCE DEFERRED
- Last functional Expansion commit: `99d5d07` (Phase 34 bounded model-visible edit recovery guidance)
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
- `10c6b23` — controller-owned `/agent-cancel` for exact active Worker/Tester attempts, one-shot session/role/state validation, installed `pi-subagents` bridge correlation, durable terminal projection, bounded metadata trace, offline Pi/worktree/process benchmark, and regression tests. Agent Hub itself remains a read-only frontend.
- `3945eec` — Task Policy-gated deterministic local Worker prewalk on the pinned Git runner; canonical, name-only, size/binary/secret/link filtering; bounded Worker-only hints, metadata-only tracing, four focused tests, and a real offline Pi CONTROL/PREWALK benchmark. No route, retry, role, or spawn-policy change.
- `6a11f79` — read-only, digest-bound Provider Capability Registry combining Pi model declarations, receipt-backed callability and harness profiles; `/models --capabilities` scoped inspection, unknown-safe price/capability representation, and offline Pi command smoke. No adapter, provider request, route, or credential change.
- `cb9987a` — Phase 31 bounded completion: separately validated stale-aware local catalog snapshot, conflict resolution, field-level provenance, conservative Context Governor cap, bounded human/JSON inspection, regression tests, and deterministic local benchmark. No provider/routing/credential change.
- `7eb2434` — Phase 32 representative local CPU/proc profiling harness; no native binary, OMP source, build chain, route or policy change.
- `99d5d07` — Phase 34 checkpoint: fixed source-free recovery guidance for existing transactional edit failures, plus unit and real-Pi fixture assertions. No edit authority, matching, LSP, receipt or model routing change.

## Bookkeeping commits

- `a76ce40` contains the Phase 26 ledger, authority matrix, implementation note, and `benchmarks/overdrive-vs-omp/debugpy-engine-results.json`.
- The subsequent commit containing this Phase 27 disposition and `docs/implementation-notes/phase-27-computer-use-contract.md` records the contract-only, native-backend-deferred boundary. Resolve its exact hash with `git log -1` after commit.
- `797d50e` records the Phase 27 disposition. The following bookkeeping-only commit records the Phase 28 no-relay safety assessment; resolve its exact hash with `git log -1` after commit.
- The bookkeeping commit containing this Phase 29 result and Phase 30 coordinates follows functional commit `10c6b23`; resolve its exact hash with `git log -1` after commit.
- The bookkeeping commit containing the Phase 30 disposition and `docs/implementation-notes/phase-30-local-prewalk.md` follows functional commit `3945eec`; resolve its exact hash with `git log -1` after commit.
- The bookkeeping commit containing this Phase 31 partial checkpoint follows functional commit `6a11f79`; resolve its exact hash with `git log -1` after commit.
- The bookkeeping commit containing the Phase 31 completion note follows functional commit `cb9987a`; resolve its exact hash with `git log -1` after commit.
- The bookkeeping commit containing the Phase 32 measured/not-added decision follows functional commit `7eb2434`; resolve its exact hash with `git log -1` after commit.
- The bookkeeping commit containing the Phase 33 browser safety disposition follows the Phase 32 note; resolve its exact hash with `git log -1` after commit.
- The bookkeeping commit containing this Phase 34 partial checkpoint follows functional commit `99d5d07`; resolve its exact hash with `git log -1` after commit.

## Tests and benchmarks

- Pre-change Expansion baseline: 461/461 PASS, syntax PASS, TypeScript PASS, package validation PASS.
- Phase 26 focused tests: 11/11 PASS; real GDB/C and real Python/debugpy are both included. Adapter crash, debuggee nonzero exit, timeout/malformed frame, partial startup, policy/digest mismatch, path replacement, reverse request, model-supplied adapter/attach/remote/custom request denial, secret scrubbing, read-only workspace, external-network denial, bounded variables/output, and cleanup are covered.
- Phase 26 real Pi/debugpy benchmark: PASS on Pi 0.85.1; 11/11 tool results, 12 deterministic local-provider turns, real breakpoint/stack/scopes/variables/step/exit 0, 24 KiB output externalized, metadata only, no process/workspace/temporary residue, zero paid/external provider calls and €0. See `benchmarks/overdrive-vs-omp/debugpy-engine-results.json`.
- Phase 26 real Pi/GDB benchmark rerun: PASS; 8/8 tool results, nine deterministic local-provider turns, exit 0, isolation/artifact/cleanup assertions green. The original GDB result fixture was not overwritten.
- Phase 26 authoritative `PI_OVERDRIVE_LSP_RUNTIME=/home/tasso/Documents/Codex/tasso-pi-overdrive/runtime/lsp npm run check`: 466/466 PASS, syntax PASS, installed-Pi TypeScript PASS, package/secret validation PASS. `bash -n scripts/install-managed-dap.sh scripts/sandbox-run.sh` and `git diff --check` PASS.
- Phase 27 contract tests: 8/8 PASS across Linux and Windows fixture backends. Authoritative Expansion gate using the same verified LSP runtime: 474/474 PASS, syntax PASS, installed-Pi TypeScript PASS, package/secret validation PASS. A bare `npm test` without that LSP selector returned 472/474 because ignored Rust/Go managed binaries are absent in this Expansion worktree; rerunning with the documented selector returned 474/474, so this is dependency-selection evidence rather than a product regression.
- Phase 29 focused tests: exact reservation/session/role/state binding, malformed/unknown/stale/terminal/replay/completion races, Council/Judge denial, uncertainty fail-closed and installed `pi-subagents@0.66.0` exact cancellation isolation all PASS. Real Pi 0.85.1 projection benchmark PASS; new real Pi 0.85.1 offline controller benchmark PASS with actual child process and independent Git worktree, durable cancelled receipt, unaffected unrelated process, port/runtime/worktree cleanup, production command registration, zero provider calls and €0. See `benchmarks/overdrive-vs-omp/agent-hub-control-results.json`. This is a deterministic controller fixture, not an authenticated full secure-workflow E2E.
- Phase 29 authoritative `PI_OVERDRIVE_LSP_RUNTIME=/home/tasso/Documents/Codex/tasso-pi-overdrive/runtime/lsp npm run check`: 481/481 PASS, syntax PASS, installed-Pi TypeScript PASS, package/secret validation PASS. `git diff --check` PASS.
- Phase 30 focused prewalk tests: 4/4 PASS. Real Pi 0.85.1 offline deterministic Worker benchmark: PASS, correct discovery in both arms; CONTROL 3 local turns/1 search/1 read, PREWALK 2 local turns/0 search/1 read; prewalk 125 characters/12.639 ms/0 model calls, enriched prompt +127 characters. The observed −84.364 ms total delta is a single-run measurement, not a general latency claim. Cleanup PASS. See `benchmarks/overdrive-vs-omp/local-prewalk-results.json`.
- Phase 30 authoritative `PI_OVERDRIVE_LSP_RUNTIME=/home/tasso/Documents/Codex/tasso-pi-overdrive/runtime/lsp npm run check`: 485/485 PASS, syntax PASS, installed-Pi TypeScript PASS, package/secret validation PASS; `git diff --cached --check` PASS. As before, a bare gate without the documented LSP selector returned 483/485 because the ignored Rust/Go binaries are absent from this experimental worktree; no product code was changed to mask that environment selection.
- Phase 31 checkpoint: two focused registry tests PASS; real Pi offline routing-command smoke 12/12 PASS with zero model/provider calls; authoritative Expansion gate with the documented LSP selector 487/487 PASS, syntax PASS, installed-Pi TypeScript PASS, package/secret validation PASS. Registry output is metadata-only and a zero/zero default price without explicit provenance is UNKNOWN, not free.
- Phase 31 bounded completion: 13 focused registry/catalog tests PASS; real Pi offline routing-command smoke 13/13 PASS with zero inference calls; deterministic Context Governor Pi benchmark PASS; local metadata benchmark 1,000 runs/4 models, mean 0.2776 ms, zero external calls. Authoritative gate with the documented LSP selector 498/498 PASS, syntax PASS, installed-Pi TypeScript PASS, package/secret validation PASS. Bare `npm test` still has the two documented LSP runtime-selection failures in this worktree.
- Phase 32 local profile: nine deterministic benchmark suites PASS, zero paid/external calls; owned control operations range from 0.019 to 1.282 ms mean, actual optional catalog read/parse 6.078 ms mean, Pi `--version` startup median 255.15 ms. One isolated full-gate run observed 497/498 with failure identity lost to truncated output; immediately following focused test and full gate each passed 498/498. No speculative fix or native helper was added. See `docs/implementation-notes/phase-32-native-profile.md`.
- Phase 34 partial checkpoint: focused edit tests 13/13 PASS; real Pi offline edit benchmark PASS with model-visible stale guidance and cleanup, 0 paid/external calls; authoritative gate 499/499 PASS, syntax, installed-Pi TypeScript and package/secret validation PASS. See `docs/implementation-notes/phase-34-edit-ux-checkpoint.md`.
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

## Phase 28 disposition

- Pinned OMP collaboration documentation was inspected read-only at `a1b3b83a7fb8460445f2f5995a6aa56047bd44c7`. Full-control guests can influence the host; view-only guests still receive the historical session. Neither behavior maps safely to the current metadata-only Agent Hub or per-call local ACP bridge.
- No named guest, approved disclosure set, relay endpoint, or guest-copy retention/approval boundary exists for this installation. Phase 28 remains DEFERRED FOR SAFETY; no listener, link, client, transcript replication, provider call, or model schema was created. See `docs/implementation-notes/phase-28-collaboration-assessment.md`.

## Phase 29 disposition

- The only added control is `/agent-cancel <attempt-uuid>` for one currently RUNNING Worker or Tester in the same Pi session. The secure-workflow controller validates its own reservation, emits an exact upstream cancellation, waits for the normal terminal response/receipt path, and fails the workflow on dispatch uncertainty or a non-cancelled acknowledgement. The Hub merely displays eligible attempt IDs and durable lifecycle metadata. No model-facing Agent Hub mutation schema was added.
- Council/Judge and all other roles remain status-only. Pause/resume, message/steer, manual retry, revive, and spawn are deferred/not implemented because no safe controller primitive and bounded authority/receipt contract currently exists. Concurrency 3, depth 1, two correction rounds, 39+3 spawn envelope, provider routing, Council fan-out, Judge order, and retry policy are unchanged.
- Normal production cleanup retains the owned worktree for human review and releases runtime reservations; the existing explicit destroy mode removes it. The deterministic Pi benchmark verifies destruction. No authenticated cancellation E2E or paid provider call was made. See `docs/implementation-notes/phase-29-agent-hub-control.md`.

## Phase 30 disposition

- PREWALK COMPLETE: only code-discovery tasks with a validated Task Policy and no Scout receive a small relative-path hint. Exact-file tiny edits, non-code tasks, and Scout-led workflows skip it. The prewalk uses the attested, hardened Git runner on the exact isolated worktree, does no model/provider call, emits no path/content trace, and adds no tool authority. It does not duplicate Second Brain or alter Context/Tool Governor decisions. The real Pi fixture proves one fewer search and local turn for the tested discovery task, with the same relevant file found.
- PERSISTENT WORKERS DEFERRED: the current subagent API has no verified lease/resume/receipt contract for owned provider conversations, bounded retained context, per-lease tool recalculation, route and budget binding, expiry, and crash cleanup. The existing fresh Worker/correction lifecycle remains authoritative; Director and Agent Hub do not gain worker-session ownership. Council independence and 39+3 spawn accounting remain unchanged. See `docs/implementation-notes/phase-30-local-prewalk.md`.

## Phase 31 checkpoint — COMPLETE/BOUNDED

- A local Provider Capability Registry now combines the live Pi registry, current authenticated-model view, owner-only runtime-callability evidence, and already selected harness profiles. Each field carries DECLARED/VERIFIED/UNKNOWN provenance; missing tool, vision, structured-output, price, or rate-limit evidence stays UNKNOWN. A zero/zero Pi cost default is never promoted to a free-price claim, and OmniRoute prices remain UNKNOWN without catalog pricing. Exact model or provider inspection uses the existing `/models --capabilities [selector]` command; no model-facing tool, network fetch, probe, adapter, routing mutation, or provider call was added. A 50-record display bound prevents broad UI output.
- The bounded completion adds a separately validated **local** OpenRouter snapshot, stale/unknown freshness, deterministic conflict evidence, and a non-increasing Context Governor cap. The host cache is 11 days old and only one backend slice, so it is never claimed to prove current OmniRoute availability or pricing. Missing cost units and rate-limit authority remain UNKNOWN. See `docs/implementation-notes/phase-31-provider-capability-registry.md`.

## Phase 32 disposition — MEASURED/NOT ADDED

- Representative local CPU and real-Pi offline benchmarks did not isolate a material Overdrive-owned JS hot path. Pi startup, I/O, Git, ast-grep, and LSP work are separate from those local timings. Pinned OMP MIT native crates were inspected without copying or importing them. No Rust helper is justified by current evidence; existing Node/native-tool fallbacks remain authoritative. See `docs/implementation-notes/phase-32-native-profile.md`.

## Phase 33 disposition — DEFERRED FOR SAFETY

- The existing LOCAL_ISOLATED browser remains real-host-verified and networkless. PUBLIC_WEB needs controller-level egress/origin enforcement; AUTHENTICATED_SITE additionally needs explicit user authority and separate credential/profile lifecycle. Neither exists yet, and the pinned browser's domain flag was previously shown incompatible with the required profile boundary. No external browsing, downloads, auth inheritance or model-facing mode selector was enabled. See `docs/implementation-notes/phase-33-browser-boundary.md`.

## Phase 34 checkpoint — IN PROGRESS

- Pinned OMP Hashline was reviewed read-only. This checkpoint improves failed-edit recovery instructions without changing Overdrive's stronger staged transaction, seen-range, TOCTOU, LSP, atomic apply/rollback and receipt gates. Per-real-model edit-format/token comparisons and a compact grammar remain unproven and unimplemented; no paid probing was performed. See `docs/implementation-notes/phase-34-edit-ux-checkpoint.md`.
- Read-only source assessment found `/home/tasso/.config/omniroute/cache/openrouter-catalog.json` (445 OpenRouter records, `fetchedAt=2026-09-13T13:10:43.946Z`, 1,157,614 bytes, mode 0644). At the 2026-09-24 checkpoint it is eleven days old and covers OpenRouter, not all OmniRoute backends. Only shape/count/timestamp/field names were inspected; no raw descriptions, prices, credentials, or call logs were published. It is not ingested into the authoritative registry or used to infer current price, rate limits, availability, or runtime callability. No local `/v1/models` fetch or model call was made.

## Dirty files

- After the Phase 26 bookkeeping commit: expected clean; verify with `git status --short`. The managed `runtime/dap/python` and managed LSP dependencies are ignored project-local materializations, not tracked secrets.

## Known limitations

- The installed Pi configuration still points to the stable package, not this experimental Expansion worktree.
- Windows backend evidence is `NOT_RUN`; no Linux result may be promoted to Windows host support.
- Phase 23 host Computer Use and Phase 24 Collaboration remain deferred under the prior safety decisions until a new authority boundary is proved.
- Phase 26 DAP is multi-adapter only on the verified Linux host; sessions remain single-session and memory-only. The Python runtime is deliberately host-pinned, and fresh worktrees must run the project-owned hashed installer. Same-UID runtime mutation remains a local trust assumption despite per-launch attestation.
- Phase 27's `ComputerUseController` is an internal contract, not an OS sandbox or a usable desktop feature. Both native backends are unavailable; host-wide raw screenshot/input remains prohibited. Linux and Windows fixture tests do not establish host validation.
- Phase 28 collaboration needs a named opt-in guest workflow and explicit disclosure/retention choices before implementation; a strong token alone would not make transcript sharing safe.
- Phase 29 cancellation is deliberately limited to Worker/Tester and an active local session. The real Pi benchmark exercises a deterministic controller fixture sharing the production state machine/CLI adapter, while a separate installed-bridge test verifies upstream exact-attempt abort; it does not claim an authenticated full secure-workflow cancellation run. If an upstream cancellation never acknowledges, the existing delegation timeout remains the fail-closed fallback, not an immediate cleanup guarantee.
- Phase 30 prewalk is lexical and tracked-path-only; it deliberately omits untracked paths and path names outside a conservative ASCII grammar. The offline deterministic Pi benchmark establishes only its fixture discovery path, not broad model savings or full secure-workflow E2E. Persistent provider conversations remain disabled pending the documented lease/context/budget/cleanup contract.
- Phase 31 registry leaves rate limits and unqualified OpenRouter prices UNKNOWN. It does not fetch or attest a fresh/complete OmniRoute catalog. Declared Pi registry pricing is not a verified billing quote. The inspection view cannot authorize a model that routing already rejects.
- Ignored managed Rust/Go LSP binaries remain in the verified stable runtime selected for the full gate; the new worktree owns only its lockfile-pinned Node LSP modules.
- `docs/final-adversarial-audit.md` and all other protected audit state must remain untouched.

## Exact next action

Continue Phase 34 from the bounded recovery-guidance checkpoint. Any compact line/edit grammar or multi-edit batching needs a representative offline success/token benchmark and semantic parity with exact seen ranges, unique target, staged preview, LSP-on-write, atomic apply/rollback and receipts. Do not probe paid models to manufacture evidence. Preserve zero-extra-cost and all prior safety boundaries; do not push, create a PR, change tags, reset, clean or stash user work.
