# Phi — Test Baseline

Last verified: 2026-10-04. Branch `feature/routing-presets-quality`; validated functional HEAD `b27dbb5b59a632e32180ebea076aa0e5ae69f690`.

## Latest CI: 37160704978 — SUCCESS

[Run](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37160704978), exact functional HEAD `b27dbb5b59a632e32180ebea076aa0e5ae69f690`, completed **SUCCESS** on native Windows and Ubuntu.

| Gate | Result |
| --- | --- |
| Windows focused Worker/controller publication | 6/6 PASS: registered Worker tools, verified handoff, four-operation V5 native publication, exact Git diff, stale grant and concurrent-user conflict. This is an internal bounded controller path. |
| Windows focused V5 disposition/death cases | 22/22 PASS, including 13 real publisher-death cases and explicit physical disposition labels. |
| Windows main and independent source clone | Each 479 total / 467 PASS / 0 FAIL / 12 Linux-only skips; clone `PASS_FOUNDATION_ONLY`, pinned LSP install exit0 in 29,197 ms (<120,000 ms), cleanup PASS/directory removed/owned residual 0. |
| Ubuntu main and source clone | Main 479 / 161 PASS / 0 FAIL / 318 native-Windows skips; clone `PASS_FOUNDATION_ONLY`. Native Linux V5 recovery remains unverified. |
| Three isolated Pi controls | PASS; external requests 0. |
| Local full gate | `npm run check` PASS; focused publication/mixed-journal 70 total / 21 PASS / 0 FAIL / 49 native-Windows skips. |

The ordinary Windows `secure_coding_workflow` still fails closed at its backend gate before delegation and revokes a Worker attempt after response; no top-level production-reachable mixed publication was certified. V5 recovery has only R1 metadata observation; partial/ambiguous cells are deliberately manual and V5 journals are retained. D6 PARTIAL; D IN_PROGRESS; Windows autonomy BLOCKED. No provider/model calls.

## Latest CI: 37144185054 — SUCCESS

[Run](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37144185054), exact HEAD `0a186919fff0c3a1677a1fdfc143b69538ec1efe`, completed **SUCCESS**.

| Gate | Result |
| --- | --- |
| Windows native V5 focus | 21/21 PASS. Thirteen real publisher-death cases include terminal observation, earlier/manual phases, race after physical observation, corrupt journal, quarantine return, concurrent/duplicate terminalization and append interruption. |
| Windows main and independent source clone | Each 476 total / 464 PASS / 0 FAIL / 12 Linux-only skips; clone `PASS_FOUNDATION_ONLY`, cleanup PASS, directory removed, owned residual 0. |
| Ubuntu main and source clone | Main 476 / 160 PASS / 0 FAIL / 316 native-Windows skips; clone foundation PASS. No native Linux V5 recovery is claimed. |
| Three isolated Pi controls | PASS; external requests 0. |

This certifies only R1 terminal observation after fresh native V5 proof. `cleanup: NOT_PROVEN`, `projectPublished: false`, no `PUBLISHED`, no project/quarantine mutation by recovery. External filesystem change after classification remains visible to a later native classification and blocks later startup. D6 PARTIAL; D IN_PROGRESS; Windows autonomy BLOCKED.

Prior `cd8c716` / [CI 37143402124](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37143402124) failed overall at aggregate `after-cleanup-unlinked` `PUBLISHER_READY_TIMEOUT`, before recovery assertions; dedicated V5 passed. Exact cause UNKNOWN, not reproduced in the accepted run.

## Previous CI: 37126156313 — SUCCESS

[Run](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37126156313), exact functional HEAD `ddf0a14ec4c481269b51e3ae54229c50d1306a6d`, completed **SUCCESS**.

| Gate | Result | Evidence |
| --- | --- | --- |
| Windows main native suite | PASS | 470 total / 458 PASS / 0 FAIL / 12 Linux-only skips. Dedicated V5 16/16 PASS; eight killed-publisher cases each launched ordinary `phi` twice, blocked/manual with no project/journal mutation. |
| Windows independent Git-source clone | PASS_FOUNDATION_ONLY | Same 470 / 458 PASS / 0 FAIL / 12 skips. Owned cleanup PASS, directory removed, residual owned processes 0. Full engine intentionally unavailable. |
| Ubuntu main suite | PASS | 470 total / 159 PASS / 0 FAIL / 311 native-Windows skips. |
| Ubuntu independent Git-source clone | PASS_FOUNDATION_ONLY | Clone/owned cleanup PASS; full engine intentionally unavailable. |
| Three isolated pinned-Pi foreground controls | PASS | Normal, revoked and same-draft LSP controls passed; external requests 0. |

This certifies the bounded fail-closed V5 startup fixture at this commit. It does **not** enable V5 RESUME/FINALIZE, original Worker mixed publication, D-wide E2E or Windows autonomy. The diagnostic-only commits do not explain or fix the preceding intermittent failures.

## Previous candidate: 37125550867 — FAILURE

[Run](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37125550867) at `7beff1f87b614beb960b4cd2546e8b1e1ab024a3` failed before V5 testing. Windows recovery focus passed 13/13 individual cases but sequential replay passed 12/13; test 1 `pending-directory-control` failed with assertion redacted. Cause UNKNOWN. Ubuntu passed; Windows clone/Pi were not reached. The new V5 publisher readiness marker was not exercised.

## Previous candidate: 37124518318 — FAILURE

[Run](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37124518318) at `b5a3c7ec145938fb147509203aaeac785723b14c` failed overall. Dedicated Windows mixed V5 step **16/16 PASS**, including all eight real death → ordinary `phi` startup cases. The later aggregate Windows suite was **469 total / 456 PASS / 1 FAIL / 12 skips**; `after-rename-moved` failed at broad fixture stage `PUBLISHER` before the kill/reader/startup checks. Exact reason UNKNOWN. Ubuntu main **469/158 PASS/0 FAIL/311 skips**, Ubuntu clone PASS_FOUNDATION_ONLY. Windows source clone and Pi smokes were not reached. Local direct mixed tests 1 PASS/15 native skips, startup tests 3 PASS/3 native skips; changed-file whitespace and Node syntax passed. This is not a full green acceptance gate.

## Earlier full CI: 37122496570 — SUCCESS

[Run](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37122496570), exact functional HEAD `bba78e1875346c6f18c184278d078f428c1a6311`.

| Gate | Result | Evidence |
| --- | --- | --- |
| Windows main native suite | PASS | 469 total / 457 PASS / 0 FAIL / 12 Linux-only skips. V5 five-file Git fixture PASS. |
| Windows independent Git-source clone | PASS_FOUNDATION_ONLY | Same 469 / 457 PASS / 0 FAIL / 12 skips. Owned cleanup PASS; clone directory removed; residual owned processes 0. Full engine intentionally unavailable. |
| Ubuntu suite | PASS | 469 total / 158 PASS / 0 FAIL / 311 native-Windows skips. |
| Ubuntu independent Git-source clone | PASS_FOUNDATION_ONLY | Clone/owned cleanup PASS; full engine intentionally unavailable. |
| Three isolated pinned-Pi foreground controls | PASS | Normal, revoked and same-draft LSP controls passed; external requests 0. |
| External provider/model calls | 0 recorded | Deterministic gate only. |

The prior exact `65b8096` / [CI 37108528590](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37108528590) was **FAILURE**: main Windows 468/456 PASS/0 FAIL/12 skips, independent Windows clone 468/455 PASS/1 FAIL/12 skips at child-CWD timeout test 51; outer cleanup PASS, Pi controls NOT RUN. The diagnostic-only new commit passed, but the old assertion/root cause remains UNKNOWN. It is not a proven cleanup repair.

## Local focused checks

- Direct validation-evidence tests: 14/14 PASS.
- Direct clone-cleanup tests on Linux: 7 PASS / 0 FAIL / 7 native Windows skips.
- Node syntax checks for all three changed files and targeted whitespace check: PASS.
- Managed Codex sandbox owned-validation attempt: incomplete (31 file-level results, 3 spawn failures); not a substitute for the native CI gate.

## Capability limit

D6 remains PARTIAL. V5 terminal observation via normal startup and the bounded internal Worker/controller four-operation publication path are native-Windows verified; ordinary top-level workflow integration remains blocked before delegation. Other V5 recovery actions remain deliberately manual; Windows autonomy BLOCKED. Test counts do not certify ordinary production-path behavior, full reconstruction or disaster recovery.
