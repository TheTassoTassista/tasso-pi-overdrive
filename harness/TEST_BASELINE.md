# Phi — Test Baseline

## D6-CLONE-RUNTIME-GATE-001 candidate (native certification pending)

Local `node --test tests/clone-runtime-gate.test.mjs tests/clone-runtime-reporter.test.mjs`: **5 PASS / 0 FAIL / 3 Windows-native skips**. The focused cleanup/timeout regressions also passed locally with native cases skipped. Full `npm run check` exited 0 (syntax, TypeScript and package validation PASS). The native Windows controls remain unrun because mandatory auto-review was denied before execution; no native certificate is claimed.

The fixed Windows independent clone corpus remains **491 total / 479 pass / 0 fail / 12 platform skips**. Its Node TAP reporter publishes numeric top-level ordinals live; local two-test streaming proof shows the first completion was delivered while the next test was still running. The trusted native Job owner observes those same numbered completions and fails closed after **150,000 ms without a new completion**. The longest healthy observed completion gap in CI37345377138 was **51,874 ms**; 150,000 ms is approximately 2.9× that gap, leaves scheduling margin, and detects a stopped runner before the outer ceiling. This is an inactivity threshold, **not** a total suite runtime target. Native slow-progress and deliberate-stall focused proofs remain pending.

The independent **outer resource-safety ceiling is 900,000 ms (15 min)** for only the fixed owned validation suite. Successful complete suites took **441,827 ms** and **654,644 ms** (spread **212,817 ms**); the ceiling leaves **245,356 ms** above the slower success, slightly more than the observed full-run spread, while remaining bounded below the 40-minute Windows CI job. It does not certify correctness. All non-suite command limits, including LSP **120,000 ms**, remain unchanged. Runtime variance cause remains **UNKNOWN**. Gate A requires exact counts/ordinals, reporter and native receipt completion, zero failures, required checks and cleanup; Gate B requires trustworthy live progress; Gate C records phase/suite/total durations. No native certificate or Pi smoke is credited yet.

## CI37345377138 — bounded diagnostic Run 2, CASE A; no certification

Exact `7ee1ce5`, Windows job `111882513652`, workflow SUCCESS. Owned independent clone: 491 total/479 PASS/0 FAIL/12 skips; suite 654,644 ms (17:03:35.098–17:14:29.753 UTC), contiguous observed ordinals1–491, diagnostic cap780,000 ms; ordinary certification cap600,000 ms unchanged. Longest observed completion gap51,874 ms after404/before405, active test UNKNOWN due reporter buffering. Top test durations: 283=24,071 ms, 285=24,013 ms, 276=22,645 ms. LSP21,233 ms (<120,000); post-test recovery PASS; native Job attested/empty/pipes drained, owned residual0. Cleanup PASS/3,054 ms/clone removed/residual0. Total clean-room684,550 ms; model/provider calls0. Prior complete same-corpus clone 441,827 ms. Run 1 CI37244676460 at `5e52be2` failed before TAP (exit7/1,704 ms) with LSP and cleanup PASS; portable reporter URL correction is instrumentation-only. D6-CLONE-RUNTIME-GATE-001 NOT ADOPTED; D6 PARTIAL/Windows autonomy BLOCKED; Pi smokes unrun.

## CI37241028198 — one non-certifying full-corpus Windows clone experiment, wrapper FAIL

Exact source `75f9831a9bdd48b359e1629a477fb126887aa738`, job `111549615743`: source dependencies 564 ms; pinned cloned LSP 9,504 ms; owned foundation suite **491 total / 479 PASS / 0 FAIL / 12 skips**, exit0 in **441,827 ms**; Job empty/pipes drained/residual0. The full clean-room attempt took 455,666 ms. A stale diagnostic-wrapper assertion expected 490/478/12 and caused overall FAIL **after** the suite but **before** post-test recovery and brand smoke. Clone cleanup PASS/one attempt/directory removed/residual0. No Pi smoke or ordinary CREATE ran. This is **CASE C**, not a complete diagnostic or certification; longest wall-clock no-progress interval and per-case timing were not emitted. Focused local correction updates the expected current corpus to491/479/12 and adds privacy regression without increasing test count. The preceding a22bcd1 clone timeout was 489/491, not 489/490. Limits/security/retry unchanged, provider calls0.

## CI37239362749 — focused Windows independent-clone diagnostic, FAIL

Diagnostic `a22bcd1`, job `111544762707`: pinned clone LSP `npm ci` exit0/**20,561 ms** under 120,000 ms; unchanged `foundation-tests` timeout exit124/**600,000 ms** with **489 of 491 completed, last ordinal489, next ordinal490 unfinished, no final TAP footer**, 0 `not ok` cases. Serial source ordering maps ordinal490 to native partial-failed-command/revocation and ordinal491 to unsafe draft readback. The previous claim that unsafe readback was case490 was wrong. Clone cleanup PASS/one attempt/directory removed/owned residual0; full gate and four Pi smokes intentionally not run. This is a diagnostic reproduction, **not** a passing foundation/CREATE certificate. Local redaction regression 16/16 and `npm run check` 1028/705 PASS/0 FAIL/323 native skips, syntax/TypeScript/package PASS at diagnostic source. Internal limits, retries and security unchanged. D6 PARTIAL; Windows autonomy BLOCKED.

## CI37214734941 — Windows clone foundation-tests timeout; bounded CREATE unverified

Exact source `2eea581e3a05b3769e383dc639fb711c3ae47663`: Windows main `check:phi` **490 total / 478 PASS / 0 FAIL / 12 skips**, duration **623,197 ms**; indexed source audit PASS. Ubuntu **490 / 167 PASS / 0 FAIL / 323 native skips**. Independent Windows clone: pinned LSP `npm ci` exit0/**19,811 ms**, owned Job empty/0 residual; subsequent `foundation-tests` exit124 at unchanged **600,000-ms** internal limit, test counts unavailable. Clone cleanup PASS, directory removed, residual Phi-owned processes0. All four Pi smokes downstream skipped, so no ordinary Windows CREATE certificate. Exact clone test at timeout UNKNOWN. Diagnostic TAP ordinal-only change locally passes focused **16/16** and full `npm run check` **1028/705 PASS/0 FAIL/323 native skips**, syntax/TypeScript/package PASS; native clone-only diagnostic pending. No limit/retry/security change.

## Bounded ordinary CREATE functional candidate — native gate pending

Functional `2eea581e3a05b3769e383dc639fb711c3ae47663`: local `npm run check` PASS, 1027 total / 704 PASS / 0 FAIL / 323 native Windows skips; syntax, installed-Pi TypeScript and package validation PASS. Targeted normal `secure_coding_workflow` real-Pi offline Linux smoke PASS: Worker/tools/verification/cleanup, zero external provider requests, no Windows publication claim. New native Windows envelope and ordinary normal-Pi V6 CREATE controls are committed and scheduled in [CI37214734941](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37214734941), still IN PROGRESS. Prior CI37188510264 certifies only the internal V6 CREATE path. Full Windows autonomy stays BLOCKED.

## Current D6 CREATE native gate — accepted

`1dad4b8bab9eb96473bc39479bbd16e7c7021808`: `npm run check` PASS, 1020 tests / 699 PASS / 0 FAIL / 321 Windows skips; syntax, installed-Pi TypeScript, package validation PASS. Task Governor focused 17/17 PASS; portable publication 21 PASS/0 FAIL/32 native skips. [CI37188510264](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37188510264) SUCCESS: Windows 486/474 PASS/0 FAIL/12 skips, native V6 cases #277 and #278 PASS; Ubuntu 486/165 PASS/0 FAIL/321 native skips. Indexed audit PASS; independent Windows source clone 474 PASS/0 FAIL, pinned LSP install exit0/no timeout, cleanup PASS/directory removed/owned residual0. Three isolated pinned-Pi smokes PASS, `externalRequests: 0` each. Prior [CI37187379390](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37187379390) failed overall with Windows aggregate 486/472 PASS/2 FAIL/12 skips at V6 fixtures before native publication (`PHI_WORKER_CAPABILITY_DENIED`, omitted “Create” mutation verb); Ubuntu PASS. Its clone and Pi smokes did not run. No model/provider calls. Do not credit the previous focused-step PASS to V6 because its test-name filter excluded those cases. This remains internal-path V6 evidence, not an ordinary Windows autonomous-workflow certificate.

## Historical local D6 candidate before native CI

At functional `bc109afe7b442726e146fbb63fe97b546ad2ce44`, `npm run check` PASS: 1019 tests total, 698 PASS, 0 FAIL, 321 Windows-native skips; syntax, installed-Pi TypeScript and package validation PASS. Focused portable `phi-publication` 21 PASS/0 FAIL/32 native skips; `phi-mixed-journal` 3 PASS/0 FAIL/20 native skips. Exact [CI37187379390](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37187379390) was launched for native Windows/Ubuntu proof and is not yet a PASS certificate. No model/provider calls. Existing accepted V5/R1 native evidence remains valid for its original commits; it does not certify V6.

Last verified: 2026-10-04. Branch `feature/routing-presets-quality`; validated functional HEAD `b27dbb5b59a632e32180ebea076aa0e5ae69f690`.

## New local-only post-revocation slice (not a native certificate)

At the current unpushed candidate, direct `node tests/phi-worker-transport.test.mjs`: 17 total / 10 PASS / 0 FAIL / 7 Windows skips. Direct `node tests/phi-publication.test.mjs`: 49 total / 19 PASS / 0 FAIL / 30 Windows skips; the new native post-Worker-revocation V5 case is skipped on Linux. Full `npm run check` succeeded outside the managed nested-spawn restriction: 1014 total / 695 PASS / 0 FAIL / 319 Windows skips, all syntax checks, installed-Pi TypeScript and pinned-package validation PASS. An initial restricted `npm run check` did not pass because unrelated fixture tests could not spawn `git` (`EPERM`); direct reproduction confirmed this environment denial. No native Windows CI or ordinary-workflow E2E has been run for this slice. Prior exact native gate CI37160704978 remains the last Windows certificate. D6 PARTIAL; Windows autonomy BLOCKED.

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
