# Phi implementation ledger

Phase status: IN PROGRESS — portable foundation, NOT Windows-ready.

## Verified starting checkpoint

- Branch: `feature/routing-presets-quality`.
- Starting HEAD: `6dbeffb1de3d2b916571db28ad5fae4fd1078481`.
- Baseline gate rerun locally: 532 tests, 532 PASS, 0 FAIL, 0 skipped; syntax, TypeScript, package/secret validation PASS.
- Pi runtime: 0.87.1. Default: subscription-backed GPT-6 Sol, medium.
- Prior immutable authenticated workflow evidence independently found: `19a7dd06-4940-49f4-8f12-e3a851d2ae68`, 40/40 controls, PASS. No new model call in this phase.
- Protected user document SHA256: `f556b3adc88e58f5319f208b4a74c496705ef90b24680bf8bde12e5ce5a9f3ba`.
- Existing remote: `TheTassoTassista/tasso-pi-overdrive`, PRIVATE. Existing history retained; no rename, push, PR, tag, or credential operation.
- Starting working tree: only the pre-existing protected user document modification. Never stage it.

## Checkpoint 1 — portable identity and entry point

Implemented Phi 1.0.0 identity independent of Pi 0.87.1, bundled deterministic Unicode/ASCII mark, five themes, capability/width fallbacks, private preference persistence, centralized Linux/Windows directory adapters, runtime discovery, zero-model-call Doctor, and canonical portable Node CLI. Existing Pi configuration/auth/routing/state remain untouched. Linux launcher owns and terminates its process group; Windows engine launch explicitly fails closed.

Focused tests: 20/20 PASS on real Linux, zero model calls. Complete authoritative Linux gate: 552/552 PASS, 0 FAIL, 0 skipped; syntax, TypeScript, package/secret validation PASS. Doctor on the real host: WARN (honest optional/runtime-attestation limits), no FAIL. Protected document and auth SHA256 unchanged. Synthetic Windows path tests are unit evidence only, not native Windows evidence. Windows engine/process/sandbox support remains unimplemented.

Tracked product name is Phi; old environment/event/config identifiers remain compatibility internals until a separately validated migration. No global search-and-replace of Pi.

## Next exact action

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

Pending closure for checkpoint 2: local commit and Git-source-only clean clone, then record exact commit/test/evidence state. Native Windows sandbox, filesystem/process/journal parity and full Linux fresh-machine bootstrap remain the next substantial engineering phase; do not begin a half-finished security backend when session quota is low.
