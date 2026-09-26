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
