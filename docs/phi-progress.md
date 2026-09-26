# Phi implementation ledger

Phase status: IN PROGRESS — portable foundation, NOT Windows-ready.

## Verified starting checkpoint

- Branch: `feature/routing-presets-quality`.
- Starting HEAD: `6dbeffb1de3d2b916571db28ad5fae4fd1078481`.
- Baseline gate rerun locally: 532 tests, 532 PASS, 0 FAIL, 0 skipped; syntax, TypeScript, package/secret validation PASS.
- Pi runtime: 0.87.1. Default: subscription-backed GPT-6 Sol, medium.
- Prior immutable authenticated workflow evidence independently found: `19a7dd06-4940-49f4-8f12-e3a851d2ae68`, 40/40 controls, PASS. No new model call in this phase.
- Protected user document SHA256: `f556b3adc88e58f5319f208b4a74c496705ef90b24680bf8bde12e5ce5a9f3ba`.
- Existing remote at the starting checkpoint: `TheTassoTassista/tasso-pi-overdrive`, PRIVATE. History retained. Later audited foundation commits were pushed to the existing feature branch only; no rename, force push, PR, tag, release, visibility or credential change.
- Starting working tree: only the pre-existing protected user document modification. Never stage it.

## Checkpoint 1 — portable identity and entry point

Implemented Phi 1.0.0 identity independent of Pi 0.87.1, bundled deterministic Unicode/ASCII mark, five themes, capability/width fallbacks, private preference persistence, centralized Linux/Windows directory adapters, runtime discovery, zero-model-call Doctor, and canonical portable Node CLI. Existing Pi configuration/auth/routing/state remain untouched. Linux launcher owns and terminates its process group; Windows engine launch explicitly fails closed.

Focused tests: 20/20 PASS on real Linux, zero model calls. Complete authoritative Linux gate: 552/552 PASS, 0 FAIL, 0 skipped; syntax, TypeScript, package/secret validation PASS. Doctor on the real host: WARN (honest optional/runtime-attestation limits), no FAIL. Protected document and auth SHA256 unchanged. Synthetic Windows path tests are unit evidence only, not native Windows evidence. Windows engine/process/sandbox support remains unimplemented.

Tracked product name is Phi; old environment/event/config identifiers remain compatibility internals until a separately validated migration. No global search-and-replace of Pi.

## Historical next action after checkpoint 1 (completed)

Checkpoint 1 is committed locally with the identity/launcher/platform foundation. Obtain its exact HEAD from Git, not a self-referential hash embedded in this file.

Next: implement tracked launcher installation/migration, bootstrap plan/test modes, local config-only backup/restore and a native CI foundation matrix. Then rerun full Linux gate, record results, and commit the coherent checkpoint. Continue with Windows AppContainer + Job Object confinement and native integration only after the foundation is green.

Do not mark the complete phase PASS before Windows-native confinement, clean-room full reconstruction and real Windows Actions evidence exist. A foundation CI job must never be presented as the complete Windows coding suite.

## Checkpoint 2 — migration, reconstruction foundation and local privacy

- First foundation commit: `97e581e`. All original routing/auth/security policies remain unchanged.
- Canonical `phi` command installed through tracked Node bootstrap; only new Phi user-local wrapper/preferences/manifest/directories created. Existing `pi` function/launcher/settings/auth remain untouched.
- Linux and Windows thin bootstrap wrappers, zero-write plan, conflict/link checks, idempotent managed launcher replacement. These install the FOUNDATION ONLY, not the complete fresh-machine runtime/toolchain.
- Phi TUI header integrated with the actual Pi 0.87.1 `setHeader` API. Scope: `PHI_LAUNCH=1`; non-UI/RPC and legacy `pi` behavior preserved. Five header/splash themes; upstream editor/footer theme is unchanged.
- Reproducible import-order regression caught by actual TUI startup and fixed: early display module no longer imports/freezes routing-controller JSON before OmniRoute initialization. Static regression plus real post-fix startup/command smoke prove the fix.
- Linux interactive launch preserves the original exec/same-PID semantics using native Node `execve` (available in the pinned Node runtime; experimental upstream API). Local verification subprocesses use bounded owned-group cleanup. Windows engine/process execution stays blocked.
- Whitelisted private Linux config backup/restore, explicit apply, no auth/secrets/memory/callability export, local RUNTIME_CALLABLE evidence required for restored defaults/overrides. Windows backup/restore blocked pending ACL guarantees. Restore rollback is ordinary-failure-safe, not yet crash-atomic/concurrent-writer-safe.
- Git-source audit covers index blobs; optional history mode covers HEAD ancestry blobs. No raw matched values printed. Invalid private-key fixture and detector-source matches are narrowly classified, not file-wide exempted. Git commit messages/private prose still need review before public publishing.
- CI foundation matrix prepared with real Ubuntu/Windows runners, immutable official Action commits, no stored Git credentials, no model/private auth calls. It is NOT full Windows coding E2E and has not yet been counted as native evidence.
- Local TUI startup: PASS for ASCII fallback and actual Unicode/truecolor Phi header; Sol medium, all extensions loaded, zero tokens. Actual command-handler smoke PASS with `modelInferenceCalls=0`.
- Legacy launcher fixture race was observed: asynchronous dashboard receipt had only one of two records at the immediate assertion. Core launcher unchanged; test now waits for the exact records, and a delayed-dashboard regression verifies the asynchronous contract. Focused launcher suite: 6/6 PASS.
- Protected document and auth hashes unchanged. No new dependency/plugin package, Pi update, route change, retry change or model inference.

Checkpoint 2 complete serial authoritative gate: **567/567 PASS, 0 FAIL, 0 skipped**, syntax/TypeScript/package validation PASS. Index audit: 553 blobs, 0 FAIL; WARN only narrowly classified invalid fixture/detector/historical paths. HEAD-ancestry scan before checkpoint 2: 1,316 blobs, 0 FAIL; historical warnings retained, not erased. No claim of exhaustive secret detection or private-prose/commit-message audit.

Checkpoint 2 code HEAD: `3a37e1457ec67597ce3c71006f56c1f55b2844f3`. Committed locally; only the protected pre-existing user modification remains outside commits.

Next closure: run the tracked Git-source-only clean-room foundation suite from its committed source. It must demonstrate no copied ignored runtimes/auth and MUST report the uninstalled full engine as blocked, not accidentally use the host configuration. CI has the same explicit scope. Native Windows sandbox, filesystem/process/journal parity and full Linux fresh-machine bootstrap remain the next substantial engineering phase; do not begin a half-finished security backend when session quota is low.

## Checkpoint 3 — Git-source reconstruction and real native CI

Functional HEAD: `0c8da9f870f19f7140246b77b1423989cd73ab25`. Branch: `feature/routing-presets-quality`. Later report-only commits are bookkeeping; obtain their exact HEAD from Git.

- Git-source-only clean-room suite implemented in `scripts/phi-clean-room.mjs`, with detached-HEAD support. No untracked LSP/DAP runtimes or auth copied. It explicitly forces the full engine unavailable, avoiding accidental host-state success.
- Existing private branch pushed after indexed source/history artifact/path/size/secret scans. No force push or remote/default-branch change. Audits have 0 FAIL; historical/synthetic paths and narrowly recognized invalid fixtures remain WARN. Heuristic scanning is not proof of absence of every secret; public publishing requires additional prose/metadata review.
- Real hosted Actions surfaced three reproducible defects, not model failures: dash default-argument expansion, multiple native Node applications in PowerShell discovery, and Linux adapter inheriting Windows host path rules. Fixed with bounded regressions; no security relaxation or added dependency.
- Complete Linux gate after the last fix: **570/570 PASS, 0 FAIL, 0 skipped**, syntax, installed-Pi TypeScript and package/secret validation PASS. Portable foundation focused suite: **37/37 PASS** on Linux.
- Fresh Git-source clone of functional HEAD: **PASS_FOUNDATION_ONLY**, 37/37 tests, bootstrap PASS, cleanup PASS, model calls 0, auth copied false, ignored runtimes copied false. Doctor intentionally FAIL and full engine `BLOCKED_NOT_INSTALLED`; this is NOT full fresh-machine product acceptance.
- Active installed `phi --version`: Phi 1.0.0 / Pi 0.87.1. Active Doctor: WARN, 0 FAIL, 0 model calls. Optional OmniRoute unavailable; preserved Second Brain health is not a retrieval proof. No optional service started.
- Protected document and auth hashes match the starting checkpoint. Only the protected pre-existing user modification remains outside task commits. Other worktrees preserved.

Native CI evidence for functional HEAD: run `36229995302`, https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/36229995302, **SUCCESS** on both real runners. Ubuntu foundation: 37 tests, 37 PASS, 0 FAIL, 0 skipped. Native Windows foundation: 37 tests, 31 PASS, 0 FAIL, 6 explicitly Linux-only skipped (process adapter 3, private backup 2, POSIX shell 1). These skips identify missing native implementations, not equivalent coverage. Both clean Git-source clones PASS_FOUNDATION_ONLY, owned-clone cleanup PASS, no auth/ignored runtime copy; full engine remains BLOCKED_NOT_INSTALLED. Source-only evidence receipt: `docs/phi-native-foundation-evidence.json`. No Windows coding/core/sandbox parity or full recovery claim.

## Exact remaining engineering work

This major phase is NOT complete. Stop at the coherent foundation checkpoint when session quota is low, as requested; do not start a half-built confinement backend.

Next implementation: design and implement the native Windows process/sandbox adapter with suspended launch, Job Object ownership and AppContainer/restricted-token confinement, then demonstrate denied home/secrets/system writes/network and role-specific read-only enforcement on a real Windows runner. A Job Object alone is not a sandbox. Keep engine execution fail-closed until these probes pass. Extend the existing shared governors/tools/receipts/worktree/browser boundaries through that adapter; do not merely unblock the launcher.

Then implement pinned complete runtime/toolchain bootstraps for fresh Linux and Windows without copying local ignored runtimes, native ACL/private-state/restore-journal guarantees, optional service/tool platform integrations and the comprehensive user-facing naming audit. Extend real CI beyond foundation to native deterministic editing/verification/Git/cleanup and full platform gates. Certify disaster recovery and the complete phase only after both fresh-machine acceptances pass. Preserve auth/routes/Council/Judge/retries/spawn limits, Second Brain and the protected document. No new authenticated run is needed merely to test these deterministic adapters.

## Continuation — native process ownership candidate

Resumed from `d8a7834b861a231f450b53beb1d8a476eb4f7eac`, exact branch and existing native CI confirmed; protected/auth hashes unchanged. No foundation redesign or authentication/routing change.

Implemented a Windows x64 system-.NET helper from tracked C# source and a shared-interface dispatch for trusted non-interactive verification only. Native Job assignment occurs atomically through `PROC_THREAD_ATTRIBUTE_JOB_LIST` at process creation, before resume; only three explicit stdio handles are inherited, never the Job handle. Job limits are code-owned (32 processes, no breakaway); lifetime <=120s. Normal exit, timeout and failure terminate the owned Job; caller death waits on a generation-checked parent handle; abrupt helper death uses kill-on-last-close. Requests use a bounded stdin pipe, not request files or command-line payloads. Node bounds output/input and preserves failed exit/abort semantics. Build identity is local integrity evidence, NOT an ACL/signed-runtime attestation or sandbox certificate.

Local pre-native gate: **580 tests, 572 PASS, 0 FAIL, 8 Windows-only skipped**, syntax/TypeScript/package validation PASS. All prior Linux coverage retained. Focused suite: 47 total, 39 PASS, 0 FAIL, 8 Windows-only skipped. Native Windows evidence still PENDING at this candidate checkpoint; compilation/API correctness is not inferred from Node syntax checks. Real Actions will compile with system Windows PowerShell/.NET and execute quoting, stdio, descendant/grandchild cleanup, parent/supervisor death, cancellation, timeout, output and failed-spawn tests. The clean Git clone builds the helper from its own source; it must not copy development binaries.

The helper is explicitly NOT a filesystem/network sandbox. `requireAutonomousBackend('win32')` and interactive Windows engine launch remain blocked. Do not route safe_exec/Worker/Tester/LSP or untrusted code through a bare Job-only runner. Next exact action is inspect real native CI for this candidate and fix reproducible native defects; then implement AppContainer/ACL/filesystem/network confinement on top of the proven process primitive before enabling any coding operation.
