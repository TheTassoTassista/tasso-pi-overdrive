# Phi — Session Continuation

Last verified: 2026-10-03

## Branch / heads / working tree

- BRANCH: `feature/routing-presets-quality`
- R1_IMPLEMENTATION_HEAD_BEFORE_DOC_CHECKPOINT: `0a186919fff0c3a1677a1fdfc143b69538ec1efe`
- REMOTE_HEAD_BEFORE_DOC_CHECKPOINT: `0a186919fff0c3a1677a1fdfc143b69538ec1efe` (live `git ls-remote`)
- STAGED_STATE_BEFORE_DOC_CHECKPOINT: empty.
- WORKING_TREE_BEFORE_DOC_CHECKPOINT: modified protected `docs/final-adversarial-audit.md`, `docs/phi-progress.md`, `docs/phi-portability-report.md`; untracked `AGENTS.md`, `docs/phi-mixed-native-evidence.json`, `harness/`. This is a historical snapshot before the documentation commit.
- Protected audit SHA-256: `f556b3adc88e58f5319f208b4a74c496705ef90b24680bf8bde12e5ce5a9f3ba`; unchanged, unstaged. Never modify or stage it without explicit user instruction.

## Current phase / security status

D6 PARTIAL; D IN_PROGRESS; WINDOWS AUTONOMY BLOCKED; portability IN PROGRESS. The V5 controller publication grant remains fail-closed; only recovery terminal observation from exact `CLEANUP_STARTED` is enabled. Preserve no-clobber, native isolation, ResourceFS, verified draft continuity, transaction ownership, bounded recovery and protected state. Recovery must not mint PUBLISHED or replay committed operations.

## Last verified checkpoint / tests / CI

- Functional `0a186919fff0c3a1677a1fdfc143b69538ec1efe` / [CI 37144185054](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37144185054) **SUCCESS**. Native Windows V5 21/21; Windows main and independent clone each 476/464 PASS/0 FAIL/12 skips; Ubuntu 476/160 PASS/0 FAIL/316 native-Windows skips, Ubuntu clone foundation PASS. 13 real-death startup cases cover terminal observation, no-action earlier states, race after classification, corrupt journal, quarantine return, journal contention and interrupted append; no recovered publication. Windows clone cleanup PASS/residual owned 0; three Pi controls PASS/external requests 0.
- Prior `cd8c716` / [CI 37143402124](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37143402124) was FAILURE overall: dedicated V5 PASS, aggregate `after-cleanup-unlinked` stopped at `PUBLISHER_READY_TIMEOUT` before recovery assertions. Cause UNKNOWN; not reproduced at the final HEAD.
- Functional `ddf0a14ec4c481269b51e3ae54229c50d1306a6d` / [CI 37126156313](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37126156313) **SUCCESS**. Windows main and independent source clone each 470/458 PASS/0 FAIL/12 skips; Ubuntu main 470/159 PASS/0 FAIL/311 skips and foundation clone PASS. Dedicated V5 16/16 PASS; all eight real-death cases launched ordinary `phi` twice, blocked/manual with no project/journal mutation and cleanup PASS. Windows clone cleanup PASS/directory removed/residual owned 0; three isolated pinned-Pi deterministic controls PASS with 0 external requests. Local validation-evidence 15/15 PASS and confinement portable 7 PASS/58 native skips. No product recovery behavior or timeout changed.
- Prior `7beff1f87b614beb960b4cd2546e8b1e1ab024a3` / [CI 37125550867](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37125550867) **FAILURE** before V5: Windows recovery focus individual 13/13 PASS; sequential 12/13 PASS, test 1 `pending-directory-control` failed with assertion redacted. Cause UNKNOWN. Ubuntu passed; Windows clone/Pi not reached. The V5 publisher marker received no new evidence.
- Prior `b5a3c7ec145938fb147509203aaeac785723b14c` / [CI 37124518318](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37124518318) **FAILURE**. Dedicated native V5 step 16/16 PASS, with all eight ordinary `phi` startup death cases. Aggregate Windows 469/456 PASS/1 FAIL/12 skips: `after-rename-moved` failed at broad fixture stage `PUBLISHER` before kill/reader/startup; exact cause UNKNOWN. Ubuntu main 469/158 PASS/0 FAIL/311 skips and foundation clone PASS. Windows source clone and Pi smokes not reached. The new markers do not change product behavior or timeout.
- Functional `bba78e1875346c6f18c184278d078f428c1a6311` / [CI 37122496570](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37122496570) **SUCCESS** on native Windows and Ubuntu. Windows main and independent source clone each 469/457 PASS/0 FAIL/12 skips; Ubuntu main 469/158 PASS/0 FAIL/311 native skips, Ubuntu clone PASS_FOUNDATION_ONLY. Windows clone owned cleanup PASS/directory removed/residual owned processes 0. Three isolated pinned-Pi deterministic foreground controls PASS, each zero external requests. No new model/provider calls.
- V5 exact five-file Git-diff fixture PASS in the main Windows checkout and repeated by the independent clone. It is physical no-crash execution/read-only reconstruction, not original Worker publication or V5 recovery.
- Prior `65b8096` / CI 37108528590 remains **FAILURE**: Windows clone test 51 failed while main suite passed. Diagnostic-only `bba78e1875346c6f18c184278d078f428c1a6311` did not reproduce it; root cause UNKNOWN. Do not claim a native cleanup fix.
- Local focused: direct validation-evidence 14/14 PASS; clone-cleanup portable 7/7 PASS with seven Windows-only skips; three changed files pass Node syntax and targeted whitespace checks. A separate managed-sandbox owned-validation attempt failed three file-level spawns and is not native evidence.

## Completed / do not redo

- Bounded V5 physical four-operation success, eight real death/fresh-read-only-reader boundaries, exact Git diff and native clone gate now have green evidence. Do not rebuild those primitives or weaken the V5 fail-closed publication gate.
- All eight V5 real-death boundaries now have two ordinary `phi` startups each, blocked/manual with no observed project/journal mutation and native full/clone gate green at `ddf0a14`. Do not repeat this no-action proof as a substitute for actual safe recovery.
- Fixed phase-only CI diagnostics for intermittent clone test 51 are committed/pushed; do not label them a root-cause fix.

## Current unfinished unit / exact next action

1. Keep the R1 terminal observation contract narrow. `CLEANED` from recovery marks an observation, not publisher unlink provenance, continuous filesystem truth or project publication. Every later physical operation reclassifies natively.
2. Investigate other V5 dispositions only with separate architecture authority and native proof; partial and ambiguous states stay manual. The original Worker/controller mixed grant, D-wide E2Es and Windows autonomy remain blocked.
3. If the earlier fixture readiness timeout recurs, inspect its fixed stage evidence. Do not infer a root cause or increase the deadline to hide it.

## Known limitations / blocker

- V5 RESUME/replay and original Worker mixed publication remain unimplemented/unproven. Only one metadata-only terminal observation is verified; other real-death states stay manual. D-wide E2Es remain open.
- Intermittent prior clone test-51, V5 publisher-readiness and sequential recovery failures have UNKNOWN causes. The new green run does not explain them; diagnostic-only markers are not fixes.
- Clean source clone is foundation only, not full runtime reconstruction. Doctor full, backup/restore and disaster recovery remain incomplete.
