# Phi — Test Baseline

## E4 one-shot native image-only qualification FAIL (2026-10-16)

[CI38821281746](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/38821281746)/job116718186938 on `0a7b5cbce1ab38a5ea347db1fdd7256d6bb91c7c`: seed/LSP/provenance/image build PASS; isolated image self-check confirms official clangd22.1.8 path/SHA/loader and no clangd23 resolution, then FAIL at `/usr/bin/rustc --version` exit127. Rust stderr/root cause UNKNOWN. Browser and DAP not reached. Publication skipped, no qualified digest; cleanup/owned containers0 PASS. Image-only budget1/1 consumed, Preflight3 0/1, replacement E4 0/1. Existing local19/19 E4 and2/2 host C/C++ tests remain local-only. Historical CI38817537207 clangd mismatch FAIL remains distinct.

## E4 official LLVM clangd candidate local focus (2026-10-16)

Official `llvmorg-22.1.8` asset ID449438700: local download size1,938,859,476/SHA `df0e1ecf16caf3489a272a5eea4eec9b0d82878f6477fa309504f918a0006384` matches upstream metadata. Selected clangd size106,012,688/SHA `aacb4651e1886b98c5413369fc1789f4ca2d4fa5b94fdf0de4f48c98a52d4324`, version22.1.8, direct local LSP initialize/definition/shutdown PASS; ELF needs only standard libs. Focused E4/host/ledger19/19 and host C/C++ product LSP2/2 PASS. Syntax, TypeScript, package validation PASS. Native image build/self-check not run; local Docker access denied. Historical CI38817537207 FAIL unchanged, new digest UNKNOWN, all29 Preflight2 rows OPEN, Preflight3 0/1, E4 0/1. No new native browser/cmp/Rust/DAP claim.

## E4 ten-seed image-only qualification FAIL (2026-10-15)

Dedicated native image-only CI38817537207/job116705877790 on `a8ed3209e7dc32b32c268a5f323dfd97486bdcb5`: ten seed stage PASS, managed LSP check PASS, Docker build PASS, non-root isolated self-check FAIL at clangd version mismatch. Native image installed clang/llvm-libs23.1.1-1; product registry declares clangd22.1.8. No image published, cleanup/owned containers0 PASS. This does not run or qualify browser, cmp, Rust, DAP, Tier B, full Linux check, Preflight3 or E4. Local focused E4/host17/17, package/syntax/TypeScript/shellcheck and indexed audit exit0/WARN/0 FAIL remain valid local-only evidence. Historical Preflight2 1103/736 PASS/29 FAIL/338 skip unchanged; Final Preflight3 0/1 and replacement E4 0/1. Main compatibility/provenance decision required before new candidate.

## E4 two-tier local closure focus (2026-10-15)

Historical Preflight2 remains 1103 total/736 PASS/29 FAIL/338 skip and FAIL. Local **focused**: seed/image/preflight/ledger13/13, browser4/4, DAP/LSP/eval/sandbox/launcher29/29, exact Node26 outer-ceiling fixture1/1 under explicit TAP, Rust edit corpus1/1 and rust-analyzer semantic1/1 when the exact Rust1.98.1 package is supplied in disposable fixtures. `node scripts/validate-package.mjs`, TypeScript, modified JS/Bash syntax and scoped whitespace PASS. Three readback-verified new assets make a ten-seed manifest; image Dockerfile now omits floating distro Rust. This is not a full native Ubuntu check; new ten-seed image/Tier B unqualified, all 29 historical failure identities still OPEN for native confirmation. Preflight3 0/1, replacement E4 0/1. No historical PASS/FAIL count has been rewritten.
Historical Preflight2 remains 1103 total/736 PASS/29 FAIL/338 skip and FAIL. Local **focused**: E4/host17/17, browser4/4, earlier DAP/LSP/eval/sandbox/launcher29/29, exact Node26 outer-ceiling fixture1/1 under explicit TAP, Rust edit corpus1/1 and rust-analyzer semantic1/1 when the exact Rust1.98.1 package is supplied in disposable managed fixtures. A broader 10-file group produced **63 total / 59 PASS / 1 FAIL / 3 skip**; only Rust semantic navigation failed when the compiler was on outer host PATH instead of visible inside the inner sandbox. This does not supersede the prior managed-fixture PASS or prove image success. `node scripts/validate-package.mjs`, TypeScript, syntax, shellcheck and scoped whitespace PASS. Three readback-verified new assets make a ten-seed manifest; image Dockerfile now omits floating distro Rust. This is not a full native Ubuntu check; new ten-seed image/Tier B unqualified, clangd image identity unresolved, all 29 historical failure identities still OPEN for native confirmation. Preflight3 0/1, replacement E4 0/1. No historical PASS/FAIL count has been rewritten.

## Ubuntu Preflight 2 native FAIL after corrected fixture handoff (2026-10-15)

CI38754887802/job116490590028 exact harness `01ef710cbfb76acbf85a8411b1ecd2bcee4d9d34`/frozen product `c3debc10d60686e92c5601ffd59ce6c1fff62c89`/qualified image `sha256:8d45951a54903c8406c888331ee70e11cca3cdd4ef7c15ac6044761a6917e42a`: host precheck, exact fixture reset, image self-check/toolchain PASS. `npm run check` **FAIL 1103 total / 736 PASS / 29 FAIL / 338 skip** (full failed-test list in `docs/phi-progress.md`); first browser `/tmp/.local` ENOENT. Current LSP set includes rust-analyzer `language_server_missing`; DAP and other isolated-runtime failures also observed. `E4_PREFLIGHT_FAIL=FULL_CHECK`; Linux regression/failure ledger/indexed audit NOT RUN. Final cleanup PASS, owned processes0/containers0. Preflight budget2/2 exhausted and replacement E4 not started. Local harness-focused19/19, syntax/shellcheck/TypeScript/package and indexed audit exit0/WARN/0 FAIL remain **local-only** evidence; they do not override native full-check FAIL.

## Ubuntu Preflight 1 failed before image toolchain checks (2026-10-15)

CI38648775867/job116142129074 exact harness `fb055a9`/product `c3debc1`/image digest `8d45951a…6917e42a`: native host/rootfs precheck PASS; self-check FAIL on `/phi` three controlled probe files, no full Linux check; cleanup PASS, owned processes0/containers0. Scoped reset regression validates exact success/extra-file/symlink cases and current focused suite **19/19 PASS**; shellcheck/syntax/TypeScript/package PASS. Preflight1/2 consumed, replacement E4 0/1. Prior local full-check Rust/LSP failures remain unresolved, not counted green.

## E4 image self-qualification native PASS (2026-10-15)

CI38646670801/job116135107049 exact `c3debc10d60686e92c5601ffd59ce6c1fff62c89` SUCCESS. `E4_IMAGE_SELFCHECK`, `TOOL_IDENTITIES`, `NODE_ELF_CLOSURE`, `PI_SUBAGENTS_JITI`, `PHI_MOUNTPOINT`, `FOCUSED_TESTS`, `PRIVATE` all PASS; owned containers0; immutable digest `sha256:8d45951a54903c8406c888331ee70e11cca3cdd4ef7c15ac6044761a6917e42a`. This supersedes only earlier image-candidate pending status, not historical failed runs or two unrelated local Rust/LSP full-check failures. Ubuntu preflight0/2 and replacement E4 0/1 remain unrun.

Separate Ubuntu preflight/E4 Linux harness candidate: focused E4 host/image/preflight/integrated tests **18/18 PASS**, shellcheck and shell syntax PASS, TypeScript and package validation PASS. Full local `npm run check` **FAIL** at 1105 total/765 PASS/2 FAIL/338 skips, the pre-existing Rust/LSP failures; no native Ubuntu preflight or E4 credit is inferred.

## E4 minimal-context test closure candidate (2026-10-15)

CI38645683284 on `ff5f8356c53ca0f61aa25d5f3f33347ea89cf087`: UID1001 self-check and native AST identity passed, final focused test process exit1; image unpublished, cleanup/owned residual0 PASS. Exact Node26.8.2 minimal-context reproduction without `config/routing-policy.json` gives Agent Hub PASS and AST `ERR_MODULE_NOT_FOUND`; with the one file copied plus `--test-reporter=tap`, same two test files give **8/8 PASS**, `# fail 0`, stderr0. Native image qualification remains PENDING; Rust/LSP full local failures remain separate.

## E4 AST native binary path candidate (2026-10-15)

CI38644668426 on `644c7ee0cf6fa28dd3bf218e2fc6ed7c31faba38` passed non-root Node startup but self-check FAIL on `@ast-grep/cli` JS shim SHA33bb versus policy native SHA7a5; no image publication, cleanup/owned residual0 PASS. npm package tarballs match lock SRI and prove native optional package contains SHA7a5. Scoped self-check now points only to that native binary; local validation pending at this checkpoint. Full local Rust/LSP failures remain tracked separately, not relabeled.

## E4 image mode correction candidate (2026-10-15)

Changed image-only CI38643757651 on `759e093dfabedd42143db112930a6a625f4f4bca`: Node ELF/linker/startup closure PASS and complete image build; non-root self-check NOT STARTED (OCI exec126) because copied seed parent directories were `0700`; no publish, cleanup/residual0 PASS. Exact cached Node archive staging reproduces root700/usr700/usr/bin700/node755 before correction and root700/usr755/usr/bin755/node755 after. Focused seed/image7/7 PASS with mode regression. Full local check remains tracked red on Rust/LSP; no unproven image PASS.

## E4 Node runtime closure candidate local baseline (2026-10-14)

Focused seed/image/rootfs/Pi/Agent-Hub/AST **27/27 PASS**; syntax/platform, TypeScript, package and shell validation PASS. `npm run check` FAIL at test phase: first 1103/762 PASS/3 FAIL/338 skips, diagnostic rerun 1103/763 PASS/2 FAIL/338 skips; persistent Rust edit-contract syntax UNAVAILABLE and rust-analyzer navigation count0 are the prior failures, third first-run failure not reproduced. Native image-only CI38539171399 on prior exact `c4e76b6bce4cdc47e03bf98a7dafa9b857c5749b` failed before self-check because pinned Node could not load `libsimdjson.so.33`; cleanup PASS/residual0. Exact library/link staging test and fail-closed Docker/runtime checks are new local candidate; native rootfs-only linker proof remains PENDING. Host Feasibility 24/24 PASS/no Run4, preflight0/2, replacement E4 0/1.

## Historical E4 image candidate local baseline (2026-10-14)

Focused E4 image/host/integrated tests **15/15 PASS**. Workflow YAML parses; self-check JS syntax, project syntax/platform, TypeScript and package validation PASS. Full `npm run check` FAIL at test phase: **1102 total / 762 PASS / 2 FAIL / 338 skips**, with prior Rust edit-contract syntax UNAVAILABLE and rust-analyzer definition navigation failures; no new failure attributed to image candidate. Native image build/selfqualification NOT RUN; local Docker daemon access denied. Host Feasibility Run 3 remains 24/24 PASS, preflight0/2, replacement E4 0/1.

## E4 native Host Feasibility Run 3 PASS (2026-10-14)

[CI38536960296](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/38536960296) on `ac6d61a334bb193d7cd6f4fe7c4309638fadacc1`: 24/24 assertion markers PASS, extra network probe PASS, exact rootfs schema/OCI digest, ordinary-user Bubblewrap no setuid/file caps, payload CapInh/Prm/Eff/Bnd/Amb all zero, six namespace comparisons PASS, sentinel digest identical, parent-child termination PASS, `E4_PIPE_STATE=CLOSED`, owned residual0, `E4_ROOTFS_CLEANUP=PASS`, `E4_CLEANUP=PASS`, terminal feasibility PASS. The run is non-certifying; no image qualification, Ubuntu preflight or replacement E4. Local focused20/20 including sandbox/runtime tests PASS. Full local check remains FAIL on Rust syntax UNAVAILABLE and rust-analyzer empty definition; these must be resolved or shown green in the eventual real Ubuntu preflight, not hidden.

## E4 Run-3 mountpoint/schema candidate (2026-10-14)

Focused `node --test tests/e4-host-feasibility.test.mjs tests/integrated-certification-evidence.test.mjs tests/e4-seed-transport.test.mjs`: **15/15 PASS**. Shell syntax/shellcheck, `npm run syntax`, `npm run syntax:platform`, TypeScript and package validation PASS. The rootfs validator prepares an empty `/phi` and fails deterministically on removed `/phi` or `/run`; static test confirms exactly seven intended mount operations and no host-root/socket bind. Indexed audit WARN/0 FAIL, scoped staged whitespace PASS. Full `npm run check` FAIL before later phases: 1099 total/759 PASS/2 FAIL/338 skips; Rust/LSP failures remain tracked, no E4 causal attribution. Native Run 3 NOT YET RUN; no 24-assertion or image/preflight/E4 PASS claim.

## E4 Host Feasibility Run 2 terminal FAIL; no sandbox assertion (2026-10-14)

[CI38532993212](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/38532993212) on exact `ab3e4b63a466249af1bdae738b8f0a1790683b32`: AppArmor syntax/load and exact Arch OCI rootfs materialization passed; first Bubblewrap invocation reported `Can't mkdir /phi: Read-only file system`, then `PAYLOAD_PROBE` FAIL, cleanup PASS and assertion15 FAIL. No payload markers 4–14 or child-death result. Host Feasibility2/2 exhausted; image/preflight/E4 not run. Local focused14/14, syntax/platform, TypeScript, package validation and shellcheck PASS; local full check remains FAIL with two Rust-related failures and cannot be reported green.

## E4 Host Feasibility Run 1 and parser-cache correction (2026-10-14)

Native [CI38532600373](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/38532600373) on `5adb8fe40ae76f4d3ea0f5d00d4fa13b3e7124bc`: fail at `PROFILE_PARSE` because `apparmor_parser -Q` tried root-owned `/var/cache/apparmor`; `E4_CLEANUP=PASS`, `E4_ASSERT_15=FAIL`, no payload. This consumes Host Feasibility1/2 only. Local candidate adds `-K` skip-cache; updated focused suite14/14 PASS, shell syntax/shellcheck, syntax/platform, TypeScript and package validation PASS. Whitespace check of the whole working tree reports only the pre-existing protected user edit; scoped fix has no whitespace error. Full `npm run check` remains prior FAIL on two Rust-related tests, with E4 relationship unproven.

## E4 host-level feasibility local candidate (2026-10-14)

Focused `node --test tests/e4-host-feasibility.test.mjs tests/integrated-certification-evidence.test.mjs tests/e4-seed-transport.test.mjs`: **14/14 PASS**. Bash/sh syntax, package validation and installed-Pi TypeScript PASS. Local Bubblewrap 0.13.0 probe demonstrated explicit `--unshare-user` is required alongside `--disable-userns`; corrected flags yielded non-root UID, CapEff0 and nested-userns denial. Staged indexed source/security audit WARN/0 FAIL, scoped ZERO_EGRESS_REVIEW PASS. Full `npm run check` is **FAIL**, 1098 tests/758 PASS/2 FAIL/338 skips: Rust edit-contract syntax UNAVAILABLE and managed rust-analyzer definition result count0, reproduced in focused tests; no E4 relationship proved. Native Host Feasibility unrun (0/2); this is neither image qualification nor Ubuntu preflight/E4 evidence.

## E4 non-certifying container namespace diagnostics FAIL (2026-10-13)

[CI38420482485](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/38420482485) on `2b1d738405f7571e9e96f1ddbde6361eef17f24e`: pinned Arch base pull PASS, strict non-privileged rootless full `unshare` FAIL/EPERM. Changed [CI38420815845](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/38420815845) on `489b6cc50ccd7ab6827f4d6d77d8c99b90ac5507`: strict user-only, strict full, default-cap+NNP full and default-cap full each exit1/EPERM; diagnostic job intentionally FAIL. Focused local workflow/seed tests **11/11 PASS** before dispatch. These are feasibility diagnostics, **not** Ubuntu preflight, full `npm run check`, image self-qualification or replacement E4. Preflight0/2, replacement0/1; no security limit changed. Underlying Docker/host policy UNKNOWN.

## E4 seed release/readback source-identity check; no preflight (2026-10-13)

Local isolated `bsdtar -xf` of six exact cached Git/GDB/GDB-common/Python/Node/util-linux packages succeeded; extracted `usr/bin/git`, `usr/bin/gdb`, `usr/bin/python3.14`, `usr/bin/node` and `usr/bin/prlimit` equal the existing approved SHA-256 values, and `gdb-common` supplies `usr/share/gdb/python/gdb/dap/__init__.py`. Private release `411800345` assets `637362890`, `637362887`, `637362892`, `637372244`, `637372241`, `637372242` each have GitHub-reported and readback size/digest equal to local source. Manifest `config/e4-toolchain-seeds.json` records these. Local six-asset staging and focused `tests/e4-seed-transport.test.mjs` **3/3 PASS**; isolated Pi lock resolves `pi-subagents@0.66.0 → jiti@2.7.0`. This is transport/source evidence only: **no certification image, self-check, full check, Ubuntu preflight or replacement E4 has run**. No product/security gate was weakened; original E4 remains FAIL/CLOSED.

## E4 hermetic source-artifact inventory; no new gate run (2026-10-13)

Local extraction of cached CachyOS Git/GDB/Python/Node/prlimit package archives reproduces the exact approved binary SHA-256 values in the live policy. A package-lock-only resolution confirms `pi-subagents@0.66.0` declares `jiti@2.7.0`. These are **source-artifact checks**, not an image build, toolchain self-check, full check, preflight, native Windows test or E4 qualification. Ubuntu preflight0/2 and replacement E4 0/1; original E4 CI38398838331 stays FAIL/CLOSED. No tests or security gates were weakened.

## E4 recovery static attribution; no new test or CI (2026-10-13)

Original E4 CI38398838331 remains Ubuntu `npm run check` FAIL, TAP1090/702 PASS/50 FAIL/338 skips. First `jiti` failure is attributable to E4 omitting declared `pi-subagents@0.66.0` dependencies; local Pi's pre-existing hoisted `jiti@2.7.0` is not clean-runner evidence. Existing same-run logs independently record `resource_git_binary_digest_mismatch` and `DAP_ADAPTER_UNAVAILABLE`; other historical failure members are not fully classified. No code/package/CI correction or local full rerun was made. Ubuntu preflight budget0/2, replacement E4 budget0/1; Main must decide an exact host-toolchain strategy before preflight.

## Campaign 3 final-candidate qualification PASS; one-shot E4 FAIL (2026-10-13)

Candidate `9407238b22020e04a4dd19126a0262807e8bd1fa`: prior local Linux owned main 503/172 PASS/0 FAIL/331 skips and full `npm run check` PASS; exact-SHA Windows main CI38265696139 503/491 PASS/0 FAIL/12 skips, ordinals503, ledger NONE, Job empty/pipes drained/residual0 and final fixed-scope baseline PASS. One-shot E4 CI38398838331 did not repeat that green Linux result on its clean Ubuntu runner: `npm run check` TAP1090/702 PASS/50 FAIL/338 skips, first failure `tests/agent-hub-control-bridge.test.mjs` from missing `jiti` under `pi-subagents`; exit1. E4 Linux owned corpus/audit skipped; Windows job skipped, so no E4 Windows or integrated E1/E2/E3 process/cleanup evidence. Do not substitute the pre-E4 focused PASS or retry E4.

## Campaign 3 pre-E4-workflow native Windows main PASS (2026-10-12)

[CI38263762303](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/38263762303) on `b96ae39f39f9627f9aeafa7fbba8b9f6c174e88c`: complete Windows main **503 total / 491 PASS / 0 FAIL / 12 skips**, ordinals503, ledger NONE; owned Job attested/empty, pipes drained, timeout false, progress completed503/failed0, residual0. Always-on fixed-scope baseline active/stale/quarantined0, Job empty/pipes drained/residual0. Local Linux main 503/172/0/331 and full `npm run check` PASS. New dedicated E4 workflow YAML and static same-SHA/order assertions PASS, but final E4 candidate is not frozen or natively requalified; E4 not run.

## Campaign 3 current-candidate Linux full-suite classifier correction (2026-10-12)

Pre-fix local owned main emitted **503 total / 172 PASS / 0 FAIL / 331 skips**, 503 contiguous ordinals and failure ledger NONE but certifier FAIL because it demanded 500; this failed evidence is preserved. After updating only exact-corpus expectations, focused integrated/clone classifiers **12 PASS / 0 FAIL / 3 Windows-only skips**, including old-corpus rejection; local `node scripts/phi-owned-main-suite.mjs` **PASS** with 503/172/0/331, ordinals503, ledger NONE. Full `npm run check` PASS including syntax/TypeScript/package validation. Current native Windows 503-case suite and ownership baseline pending; E4 still blocked. E1/E2/E3 technical native evidence is unchanged.

## Campaign 3 E3 native technical PASS (2026-10-12)

[CI38262459923](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/38262459923) on exact `3b7e040b0b219d98c498f8c117e1cca2b46b9301`: Windows E3 job PASS. Prefix tests8/8, selected startup tests3/3, pinned isolated Pi and actual normal workflow PASS. V2 TEMP_CREATED owned-root crash → fresh normal Phi PASS_RECOVERED/ROLLBACK, projectMutations0, V2 ROLLED_BACK, accepted PREFIX_1/exact Git base, no suffix or abandoned model replay, interrupted workflow evidence, three owned broker Jobs and fresh Phi Job empty/pipes drained, residual0, fixture cleanup PASS. Final fixed-scope baseline active/stale/quarantined0, residual0. Offline provider requests0. E3 COMPLETE/native1/2. Local full `npm run check` PASS. E4 blocked pending current Linux/Windows main regressions.

## Campaign 3 E3 pre-native local baseline (2026-10-12)

Focused D-prefix and startup-recovery tests: **13 PASS / 0 FAIL / 3 Windows-only skips**. Full `npm run check`: **PASS**, including syntax, installed-Pi TypeScript and pinned package validation. Scoped diff whitespace: PASS. A fixture-confined V2 `TEMP_CREATED` marker/root-kill/ordinary-Phi-startup test path is prepared but **not executable as native Windows proof on Linux**; native C# compile, recovery, Job/pipes and cleanup are pending E3 Run 1. E1/E2 native COMPLETE/budgets exhausted. No provider/model calls were made by this local preparation. E3 PARTIAL/native0/2, E4 BLOCKED, Windows autonomy not activated.

## Campaign 3 E2 corrected native PASS (2026-10-12)

[CI38260258518](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/38260258518) on exact `bc74281d50eed7f62f52e0badf72a2bb96709c6b`: Windows E2 PASS, one native owned EDIT Job exits73 after LPAC `EPERM` denial, target sentinel unchanged, no grant/publication, workflow FAIL_CLOSED with protected receipt, Scout/Worker provider/model/thinking in structured report, graph/Job/pipes/residual0 and final fixed-scope baseline/fixture cleanup PASS, external provider requests0. Local focused graph7/7, offline E2 smoke and full `npm run check` PASS; CI graph regressions7/7 PASS. Run 1 CI38259537138 remains partial route-report evidence. E2 budget2/2 exhausted, E3 native0/2 next, E4 blocked and Windows autonomy not activated.

## Campaign 3 E2 Run 1 and route-evidence correction (2026-10-12)

[CI38259537138](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/38259537138) on `dc793c356a98ece2bfe68668a8f2923eabb524e8`: native Windows focused workflow SUCCESS, graph regressions7/7, LPAC `EPERM`/exit73, sentinel unchanged, no grant/publication, durable FAIL receipt/cleanup, one EDIT Job empty/pipes drained/owned residual0, final fixed-scope baseline PASS; external provider requests0. Required published route evidence was incomplete (Scout only), although Worker delegation completed before terminal controller rejection. Local correction reads both completed routes from protected delegation-attempt receipt; Linux E2 smoke PASS reports Scout Luna:low and Worker Sol:medium, and full `npm run check` PASS with syntax/TypeScript/package validation. E2 native budget1/2; corrected Run 2 not yet executed. E2 remains PARTIAL, E3/E4 blocked, Windows autonomy not activated.

## Campaign 3 E2 pre-native local baseline (2026-10-12)

Normal Pi offline E2 Linux smoke PASS: real Worker `safe_exec` out-of-project write attempt receives `ENOENT`/exit73; fixture sentinel identity/digest/content unchanged; workflow FAIL with protected failure receipt and cleanup PASS; external provider requests0. E2 process graph and E1/CREATE isolation regressions **7/7 PASS**: exact one denied EDIT Job required; missing/extra/wrong-exit/nonempty/undrained/unreserved/unrevoked/unexpected publisher and nonzero residual cases fail closed. `npm run check` PASS after final graph-negative additions, with syntax, installed-Pi TypeScript and package validation. Native Windows E2 remains **UNRUN / PARTIAL**, budget0/2; E3/E4 blocked and Windows autonomy not activated.

## Campaign 3 E1 native technical PASS (2026-10-11)

Corrected focused [CI38154541489](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/38154541489), exact `0c7851aaee247b3e02f62b7893b55fbb8a2c25ad`: Windows E1 PASS with real Pi autonomous source correction, V2 MODIFY protected receipt/physical postverify, exact two owned broker Jobs empty, Pi child/pipes closed, residual0 and final always-on fixed-scope baseline PASS. Inference controls PASS; external provider requests0. Earlier Run 1 CI38154077270 remains FAIL (harness graph expectation); E1 budget2/2, no additional E1. E2 native0/2 pending, E3/E4 blocked, Windows autonomy not activated.

## Campaign 3 E1 Run 1 and graph correction (2026-10-11)

CI38154077270 on `759bbfb8efa6feb1edc037e0b969019e73833c02`: native E1 terminal **FAIL**, graph UNKNOWN `CHILD_NOT_REGISTERED`; actual workflow/native V2 publication/receipt and final fixed-scope baseline PASS. Corrected E1 two-job graph exactness regressions plus inference controls **7/7 PASS**. First post-fix full `npm run check` had one unrelated browser open timeout (root cause UNKNOWN); isolated browser **4/4 PASS**, then full `npm run check` **PASS** including syntax, installed-Pi TypeScript and package validation. No timeout or product safety change. E1 budget1/2, next corrected native run pending; E2/E3/E4 unrun and Windows autonomy BLOCKED.

## Campaign 3 E1 local preparation (2026-10-11)

Offline deterministic inference controls **2/2 PASS**; normal Pi E1 source-repair smoke **PASS on Linux** with initial fixture test FAIL, source-only correction, production verification/receipt PASS and cleanup; existing normal MODIFY smoke **PASS**. Full `npm run check` **PASS** including package structure, syntax and installed-Pi TypeScript. This is local preparation only: E1 native Windows **0/2**, publication/owned graph not yet proven for the E1 scenario. ZERO_EGRESS_REVIEW PASS is recorded in `docs/phi-campaign-3-gates.md`; external provider requests 0. No D-17/D-18 rerun or Windows autonomy activation.

## Campaign 3 opening baseline (2026-10-11)

`WINDOWS-AUTONOMY-CAMPAIGN-001` authorizes E1/E2/E3 and conditional one-shot E4 but no Campaign-3 technical gate has run. Native budgets used: E1 0/2, E2 0/2, E3 0/2, E4 0/1. The accepted D-17/D-18 results below remain the foundation, not E1/E2/E3 credit. Windows autonomy BLOCKED, `windowsAutonomousReady=false`, PHI PORTABILITY COMPLETE NOT CERTIFIED. Current-candidate full regressions are required only after functional E gates and before E4, not as an intermediate freshness rerun.

## Campaign 2 Main-accepted baseline (2026-10-11)

`CAMPAIGN-2-D-CLOSURE-001` accepts D-01…D-18 and the existing frozen-functional D-17 CI38123299671/D-18 CI38124988636 evidence below: **D COMPLETE; Campaign 2 COMPLETE / MAIN CERTIFIED**. No test or native CI was rerun for this documentation-only closure. Campaign 1 stays MAIN CERTIFIED; Windows autonomy stays BLOCKED; PHI PORTABILITY COMPLETE is NOT CERTIFIED. The D-18 section's pending-Main wording is historical. E1/E2/E3 and a final Windows-autonomy gate have no credited tests or execution authority from this decision.

## D-18 one-shot integrated certification (2026-10-11)

[CI38124988636](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/38124988636), attempt1, exact functional `4d612b9dfe13eda108f32e6c5a63a10a71e4da4a`: owned Ubuntu500/169 PASS/0 FAIL/331 skips, completed ordinal500, ledger NONE; owned Windows500/488 PASS/0 FAIL/12 skips, completed ordinal500, ledger NONE, native Job empty/pipes drained/residual0. Independent Windows clone500/488/0/12, 500 reporter/native ordinals, Gate A/B PASS/C RUNTIME_RECORDED; pinned LSP20,533 ms <120,000, suite738,348 ms inside existing outer ceiling, cleanup one attempt/PASS/clone removed/residual0. Three offline Pi controls PASS/external requests0; ordinary CREATE/V6, MODIFY/V2, DELETE/V3, RENAME/V4 all PASS/protected readback/process graph/cleanup. Dependent D-wide normal CREATE→MODIFY→RENAME→DELETE PASS/PREFIX_4, same logical Git lineage, unique operation journals, zero external requests/residuals. Integrated D13 restart PASS: PREFIX_1 preserved, V2 TEMP_CREATED→ROLLED_BACK with PASS_RECOVERED/projectMutations0, suffix not started. Post-phase and final always-on fixed-scope baselines PASS with active/stale/quarantined0, owned Job empty/pipes drained/residual0. No replacement D18. D-01…D-18 technical evidence COMPLETE; Main status decision pending.

## D-17 native current-candidate qualification (2026-10-11)

[CI38123299671](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/38123299671), original attempt1, exact `4d612b9dfe13eda108f32e6c5a63a10a71e4da4a`: Ubuntu Phi corpus500/169 PASS/0 FAIL/331 skips; Windows main Phi corpus500/488 PASS/0 FAIL/12 skips, complete TAP footer/empty failure set; independent Windows clone same500/488/0/12 with 500 completed reporter/native ordinals, Gate A/B PASS/C RUNTIME_RECORDED. Clone pinned LSP10,211 ms <120,000 ms, Job empty/pipes drained/owned residual0, cleanup one attempt/PASS/directory removed. Three offline Pi smokes and ordinary CREATE/V6 PASS; external requests0, protected receipt readback PASS, final fixed-scope baseline PASS/owned residual0 and fixture removed. Indexed source audit exit0 with known historical WARN only. D-17 COMPLETE; D-18 not run; no replacement qualification.

## D-17 pre-native Linux qualification candidate (2026-10-11)

After D-14 ambiguous-after-prefix regression and final one-shot workflow wiring: local D-prefix8/8 PASS; `npm run check:phi` exact Linux corpus500/169 PASS/0 FAIL/331 Windows-only skips; `npm run check` PASS including package validation and installed-Pi TypeScript. Native Windows current-candidate D-17 remains UNRUN. The accepted D-13 run CI38122945303 is not a substitute for D-17 full regression.

## D-13 native restart focus (2026-10-11)

CI38122945303 on `f46a92c`: native Windows D-prefix7/7 PASS; normal CREATE/V6 protected receipt/PREFIX_1/owned graph PASS, interrupted MODIFY/V2 at durable TEMP_CREATED, fresh-process startup PASS_RECOVERED/ROLLBACK with projectMutations0, prefix retained, suffix unstarted, terminal V2 journal and fixture cleanup PASS. Final fixed-scope baseline active/stale/quarantined0, owned residual0. This focus is not D-17 complete current-candidate regression or D-18 final certification. New local ambiguous-after-prefix regression makes D-prefix8/8 PASS; full check on that later candidate pending.

## D-13 pre-native candidate (2026-10-11)

Functional `a8a31b5`: D-prefix/bridge/terminal-only cleanup controls7/7 PASS. Nearby reconstruction/startup/V2 portable tests16 PASS,0 FAIL,43 Windows-only skips. Full `npm run check` PASS (tests, syntax, TypeScript, package validation). Indexed security audit exit0 with historical WARN only; scoped diff whitespace PASS; ZERO_EGRESS_REVIEW PASS without external model/provider call. Native Windows focused D-13 and current-candidate D-17 gates are UNRUN; no native proof is inferred from Linux skips.

## Campaign 2 evidence reconciliation (2026-10-11)

Decision `D-LOGICAL-PROJECT-CONTINUITY-001` accepts CI38062848731 without rerun for D-09 logical-project continuity. Existing `tests/d-prefix.test.mjs` failure-after-PREFIX_1/2/3 assertions passed 6/6 focused locally at the new checkpoint and are sufficient for D-10 deterministic prefix preservation. No new native test is claimed; D-13 and full current-candidate D-17 qualification remain pending.

## Campaign 2 native dependent focus (2026-10-10)

Non-certifying CI38062848731 at `58208761c258b808fa6bbd2948ba282d328530c1`: Windows prefix tests6/6 PASS; four dependent normal Pi calls CREATE/V6, MODIFY/V2, RENAME/V4, DELETE/V3 PASS, distinct journals/receipts, physical PREFIX_0..4, Worker revoked and grant consumed, per-call process graph PASS/residual0, final owned baseline PASS active/stale/quarantined0 and residual0. Pinned LSP install23s. Local full `npm run check` PASS. This is not the full Windows regression gate or D-18 final certification, and the physical worktree-identity wording of D-09 remains unresolved. No provider/model egress; offline local fixture turns only.

## Campaign 2 local D-wide candidate (2026-10-10)

Functional `fc5bad0`: deterministic D prefix and disposable Git handoff tests 6/6 PASS. `npm run check` PASS including syntax, TypeScript and package validation; indexed source audit exit0 with historical WARN only. Native Windows dependent production-path result NOT RUN at this checkpoint. Prior Campaign-1 accepted native baselines remain on `c53e430`; they do not certify this D candidate. No provider/model call is part of the new local tests or publication protocol.

## Campaign 2 D acceptance opening baseline (2026-10-10)

`D-ACCEPTANCE-RATIFICATION-001` ratifies the current D-01..D-18 inventory in `docs/phi-d-required-gates.md`; the historical D eighteen-item inventory remains UNKNOWN. Campaign-1 CI38049409731/CI38050311443 on `c53e430` is accepted for four isolated ordinary V6/V2/V3/V4 lanes and their protected readback/cleanup, but **not** for a dependent D-wide sequence. No new D-wide local or native test is credited at this evidence-mapping checkpoint. Current Linux/Windows regression qualification, dependent happy path and native restart are pending a new Campaign-2 candidate. D IN_PROGRESS; Windows autonomy BLOCKED.

## Main-accepted Campaign-1 baseline (2026-10-10)

`CAMPAIGN-1-D6-CLOSURE-001` accepts the existing immutable `c53e430e41963887cc853fb6a4984b24e7c613ee` evidence below: D6 **COMPLETE / MAIN CERTIFIED**, Campaign 1 **COMPLETE / MAIN CERTIFIED**. CI38049409731 and CI38050311443 are not freshness rerun targets. D-level new behavior and D-wide production E2E remain unqualified; Windows autonomy stays BLOCKED. The earlier “proposed/pending” paragraphs below are historical pre-acceptance snapshots.

## Final immutable Campaign-1 candidate (2026-10-10)

`c53e430e41963887cc853fb6a4984b24e7c613ee`: local `npm run check` PASS (syntax/TypeScript/package), owned Linux500/169 PASS/0 FAIL/331 skips. Native Windows-main qualification CI38049409731: 500/488 PASS/0 FAIL/12 skips, exact ledger NONE, owned cleanup/final baseline PASS. One integrated CI38050311443: Linux500/169 PASS/0 FAIL/331 skips; Windows500/488 PASS/0 FAIL/12 skips; independent clone500/488 PASS/0 FAIL/12 skips with A/B PASS, C RUNTIME_RECORDED, LSP10,047 ms, cleanup/removal/residual0; three Pi smokes PASS; CREATE/V6, MODIFY/V2, DELETE/V3, RENAME/V4 normal workflows PASS with protected receipt readback; post-phase/final baselines PASS and owned residual0. No provider calls. No replacement run. D6 technical completion proposed for Main approval; Windows autonomy remains BLOCKED.

## Current requalification candidate (2026-10-10)

Native current Windows-main [CI38049409731](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/38049409731) on `c53e430e41963887cc853fb6a4984b24e7c613ee`: **500/488 PASS/0 FAIL/12 skips; ledger NONE; 500 completions; Job empty, pipes drained, residual0; final fixed-scope baseline PASS**. This is complete current-candidate qualification, not final Campaign-1 certification. The latter is pending one-shot integrated execution on the same SHA. B/C historical causes UNKNOWN.

At `c53e430`, local focused reporter/wrapper9/9 PASS; nearby reporter/clone21 PASS/0 FAIL/3 native skips; `npm run check` PASS with syntax, TypeScript and package validation; Linux owned main500/169 PASS/0 FAIL/331 skips and ledger NONE. Explicit Windows-main expected corpus remains500 (488 PASS/0 FAIL/12 legitimate skips for green), not inferred from output; native current-candidate gate has NOT RUN. Run 4 remains diagnostic workflow FAIL despite underlying seven native PASS; its deterministic false count is locally fixed and ZERO_EGRESS_REVIEW PASS on the candidate. B/C historical causes remain UNKNOWN. No focused Run5. D6 PARTIAL; Windows autonomy BLOCKED.

## Exhausted current-failure native budget (2026-10-10)

Run 1 CI38030554090 FAIL: A five/`CONTROLLER_READY`; B/C isolated PASS. Run 2 CI38046538359 SUCCESS: seven selected 7/7 PASS after guard fix. Run 3 CI38046868680 SUCCESS: broker file20/19 PASS/1 skip and LSP file8/7 PASS/1 skip. Run 4 CI38047141700 FAIL **wrapper only**: seven selected native tests7 PASS/0 FAIL/0 skip, ledger NONE, Job empty/pipes drained/residual0 and final fixed-scope baseline PASS; wrapper incorrectly expected91 reported cases instead of seven selected by name pattern. This is a known diagnostic harness defect; no fifth run. B/C original full-suite ASSERTION causes still UNKNOWN and no disposition; Windows-main requalification/final integrated certification NOT RUN. Local final diagnostic candidate focused ledger9/9 and `npm run check` (syntax/TypeScript/package) PASS before Run 4, but its ZERO_EGRESS correctness review is invalidated by the false count assertion. D6 PARTIAL, Windows autonomy BLOCKED.

## Current seven-ID focused gate (2026-10-10)

Run 1 [CI38030554090](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/38030554090) on `0918726`: five publication FAIL at `CONTROLLER_READY`/`EXCEPTION`, one broker deletion PASS isolated, one LSP timeout PASS isolated. Each selected native Job empty/pipes drained/residual0, final fixed-scope baseline PASS; focused gate FAIL, budget 1/4 used. The source guard correction is locally green (99 focused tests/39 PASS/0 FAIL/60 Windows skips, full `npm run check` including syntax/TypeScript/package PASS) but has not been natively tested. B/C dispositions remain OPEN. A later isolated PASS does not close an original full-suite failure.

## Reconciled D6 Windows-main baseline — current gate still red

Historical CI38009818369 is preserved as `HISTORICAL_FAILURE_SET_UNRESOLVED`, five identities/causes UNKNOWN and `HISTORICAL_ORIGINAL_FAILURES_EXPLAINED=NO`. Current CI38027895261 on `01af81d`: Windows 500/481 PASS/7 FAIL/12 skips, ledger COMPLETE7/7, native Job empty/pipes drained/residual0, final fixed-scope baseline PASS. `CURRENT_WINDOWS_MAIN_GATE=FAIL`. The new decision permits qualification by an equivalent-or-stronger fully observable current gate only after each of the seven has an evidence-backed disposition, focused validation and one green full requalification, followed by one immutable-candidate integrated PASS; none of those current gates has yet run. Bounded stage-marker regressions 7/7 PASS; full local `npm run check` PASS; focused native Run 1 pending, budget0/4. D6 PARTIAL, Windows autonomy BLOCKED.

## Windows-main failure ledger diagnostic — complete for seven observed, original-five mapping UNKNOWN

Local `npm run check` PASS, dedicated ledger regressions5/5 PASS, Linux shared wrapper500/169 PASS/0 FAIL/331 skips with ledger `NONE`, scoped whitespace and indexed audit PASS (historical WARN only), ZERO_EGRESS_REVIEW PASS. Non-certifying [CI38027895261](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/38027895261) on `01af81d`: Windows500/481 PASS/7 FAIL/12 skips, native completion500/failed7, exit1/no timeout, bounded ledger COMPLETE expected7/observed7 at ordinals276–279,292,379,463; Job empty/pipes drained/residual0 and final fixed-scope baseline PASS. Original CI38009818369 remains 500/483 PASS/5 FAIL/12 skips without identities. No proof that the two failure sets are identical; original-five closure NO. Diagnostic budget consumed, no focused fix run or re-qualification. D6 PARTIAL, Windows autonomy BLOCKED.

## One-shot integrated certification at 0941628 — FAIL, no rerun

[CI38009818369](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/38009818369): Linux exact corpus 500/169 PASS/0 FAIL/331 skips, contiguous500 and source audit PASS. Windows exact corpus500/483 PASS/**5 FAIL**/12 skips, successful TAP ordinals495, native progress completed500/failed5, exit1, no timeout/stall, Job attested empty, pipes drained, owned residual0. Exact failing test names/root cause UNKNOWN because the main-suite wrapper emitted aggregate metadata only. Pinned main-suite LSP install PASS in22s; independent clone/LSP and three Pi/four ordinary operation smokes NOT REACHED. Final `always()` baseline PASS, fixed scopes0/active0/stale0/quarantined0/owned residual0. No replacement certification authorized; D6 PARTIAL, Windows autonomy BLOCKED.

## Current Campaign-1 final-gate baseline — local preparation, native certification pending

Current `phi-check` corpus is exactly 500: Linux 169 PASS/0 FAIL/331 native skips observed locally; Windows expected 488 PASS/0 FAIL/12 skips, including the nine new operation regressions, remains to be confirmed in the final native suite. Main and clone classifiers require exact 500 ordinals/footer/progress, zero failure, and native ownership evidence; the corpus is not inferred from CI output. Focused classifier/workflow tests 9 PASS/0 FAIL/3 Windows skips, full `npm run check` PASS including syntax/TypeScript/package validation, scoped diff whitespace PASS, indexed audit exit0/0 FAIL/historical WARN, ZERO_EGRESS_REVIEW PASS. The integrated workflow now schedules CREATE/V6, MODIFY/V2, DELETE/V3, RENAME/V4 separately after the three Pi smokes, with a fixed-scope baseline after each and an `always()` final baseline. RENAME Run 1 CI37950669390 is red/known defect; Run 2 CI37951201438 on `3940227` passed 4/4 native regressions and the genuine ordinary Pi RENAME/V4 protected-receipt/cleanup path. No final Campaign-1 integrated run has been launched yet.

## DELETE/V3 focused native closure; RENAME/V4 candidate

DELETE Run 1 CI37949266012: native 2/2 and inner Pi V3 publication PASS but outer fixture FAIL on incorrect expected V6 observation; no retroactive PASS. Fixture-only fix/native discovery regression `278273b`, local focused/full check, offline Pi smoke and ZERO_EGRESS_REVIEW PASS. DELETE Run 2 [CI37949898546](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37949898546): native 2/2 and real ordinary Pi DELETE/V3 PASS, source absent, V3 CLEANED/DELETE_COMMITTED_CLEANUP_OBSERVED, protected receipt readback/ACL, Worker revocation, three broker Jobs empty/pipes drained, fixed-scope baseline residual0, fixture removed, external requests0. No DELETE runs remain.

RENAME/V4 `677320a`: focused Linux 91 total/46 PASS/0 FAIL/45 native skips, offline Pi smoke PASS, full `npm run check` PASS including syntax/TypeScript/package, repository audit exit0/0 FAIL/historical WARN, local ZERO_EGRESS_REVIEW PASS. Focused native Run 1 [CI37950669390](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37950669390) IN PROGRESS; no RENAME native PASS claim before terminal proof.

## Ordinary operation-specific D6 gate — 2026-10-09

MODIFY/V2 at `6c3b70c`: local full `npm run check` PASS including syntax, TypeScript and package validation; focused Linux tests PASS; offline Pi smoke PASS/external requests0; native Windows focused [CI37948325093](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37948325093) PASS, 2/2 regressions and real Pi ordinary MODIFY/V2 with protected receipt readback/ACL, Worker revocation, V2 CLEANED/NEW_COMPLETE_OBSERVED, target digest/identity match, three broker Jobs empty/pipes drained, fixed-scope baseline residual0 and fixture removal. No Run 2.

DELETE/V3 at `2303570`: focused Linux 87 total/46 PASS/0 FAIL/41 native skips, offline Pi DELETE smoke PASS, full `npm run check` PASS, repository audit exit0/0 FAIL with historical WARN; local ZERO_EGRESS_REVIEW PASS, external model/provider calls0. Native Windows focused Run 1 [CI37949266012](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37949266012) IN PROGRESS. No native DELETE or final Campaign PASS is credited until terminal evidence.

## Integrated native certification at a4f1a7d — PASS within CREATE/V6 scope

[CI37835713525](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37835713525) on exact `a4f1a7d9b3955bb2e70e6edd17c2c0fe08d204e2`: Ubuntu491/168 PASS/0 FAIL/323 skips; Windows main491/479 PASS/0 FAIL/12 skips, Job empty/pipes drained/owned residual0; independent Windows clone491/479 PASS/0 FAIL/12 skips, Gate A/B PASS, pinned LSP21,248ms <120,000ms, cleanup PASS/directory removed/owned residual0; three isolated deterministic Pi Worker smokes PASS with external requests0; ordinary Windows CREATE/V6 Pi smoke PASS, Worker revoked before native publication, protected receipt readback PASS, `GRAPH_COMPLETE` with exactly EDIT/LSP_READ_ONLY/TEST broker Jobs, owned residual0 and fixture cleanup PASS. Fixed-scope baselines PASS. No ordinary MODIFY/DELETE/RENAME production-path test or V5 ordinary four-operation claim follows. Historical CI37829715277 remains FAIL/CLOSED; exact historical graph predicate UNKNOWN.

## D6 CREATE process graph — focused native Windows PASS

[CI37835262432](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37835262432), exact `a4f1a7d9b3955bb2e70e6edd17c2c0fe08d204e2`: focused graph reason regressions PASS; pinned LSP and isolated Pi/subagents installed; genuine offline Pi CREATE PASS, Worker4/controller2 turns, one V6 CREATE, zero external requests. Positive protected receipt readback schema/ACL/terminal/binding PASS. `PROCESS_GRAPH=PASS/GRAPH_COMPLETE` with exactly EDIT/LSP_READ_ONLY/TEST, all three Jobs attested empty, broker helpers exit0/pipes drained, root Pi native generation exit0/not-live and pipes drained, Worker revoked, synchronous publisher returned, owned residual0. Fixed-scope baseline before fixture removal and final post-CREATE baseline both PASS with zero active/stale/quarantined and owned residual0; fixture removed. No Run 2. Full integrated certification remains pending; historical CI37829715277 FAIL/CLOSED.

## D6 CREATE process graph — deterministic local candidate, Windows Run 1 pending

Exact three broker roles derived from the offline CREATE fixture: one Worker EDIT (`edit.cjs` creates `.txt`), one Worker JSON semantic_nav LSP, one tester verification TEST (`node test.cjs`). The previous four-row expectation was source-inconsistent; CI37829715277 did not publish rows, so its exact predicate remains UNKNOWN. Graph regression retains the existing test corpus count and covers clean graph, live/missing native root identity, missing/unexpected/duplicate Job records, Job unknown/non-empty, pipe unknown/not-drained, missing/nonzero exit, Worker/publisher evidence, fixed-scope baseline mismatch and internal verifier error. Focused nearby tests 53 total/28 PASS/0 FAIL/25 Windows skips; Linux offline Pi smoke PASS/readback PASS/external requests0; full `npm run check` PASS including syntax, TypeScript and package validation. Native Windows graph/receipt readback/cleanup proof pending; no autonomy promotion.

## D6 final integrated certification — first failure at ordinary CREATE ownership assertion

[CI37829715277](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37829715277), frozen `83c593414efab7c23a3c85a10d64b2106a1ff563`: Ubuntu 491 total/168 pass/0 fail/323 skips; Windows owned main 491/479 pass/0 fail/12 skips, Job empty/pipes drained/residual0; independent Windows clone 491/479 pass/0 fail/12 skips, A/B PASS/C RUNTIME_RECORDED, pinned LSP install13,992 ms (<120 s), clone cleanup/residual0; three isolated real-Pi smokes PASS, external requests0. Ordinary Pi CREATE's inner workflow reached terminal PASS and physical disposable target matched digest/identity, but the outer smoke failed `UNKNOWN !== PASS` for complete Phi-owned process graph. Protected receipt successful readback and post-CREATE baseline were not reached. Final fixed-scope baseline PASS does not establish CREATE graph cleanup. Integrated result FAIL; no retry, no Windows autonomy promotion.

## D6 two-writer diagnosis and focused ordinary CREATE — PASS in bounded scope

Diagnostic `9f8fc665f713a5b3e1a1c514c359c0918335bb51`: isolated Windows [CI37781616197](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37781616197) **1/1 PASS**; same focused pre-CREATE Windows [CI37781875567](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37781875567) **27 total / 26 PASS / 0 FAIL / 1 skip**. Each observed two-writer child exit0, stage COMPLETE, category PASS, cleanup PASS, pipes drained, exactly two candidate receipts and fixture removal PASS. Run 2 additionally passed the protected fixture roots, permissive-root negative, native process identity/ACL and worktree resume/wrong-branch tests. Neither of those runs entered LSP/Pi/CREATE. Harness selector `1b0e36a0a4a93c8726f687f4d294ebcff0b0c684` then ran the exactly one focused ordinary Windows CREATE [CI37783558861](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37783558861), **PASS**: pinned LSP and isolated Pi 0.87.1/subagents 0.66.0 installed; workflow/evidence/cleanup PASS, native CREATE publication and matching physical target confirmed in a disposable worktree, grant consumed after Worker revocation, terminal receipt written. Pi child closed exit0, fixture removed, external requests0. The pre-CREATE block was skipped in CREATE mode, not repeated. The CREATE receipt has `ownedResidualProcesses`, `jobEmptyVerified` and `pipesDrained` null: global cleanup census remains UNKNOWN. Successful receipt writer reached; independent successful-path reader unproven in this run. Historical A2's exit1 cause remains CASE E/UNKNOWN. Local focused receipt/protected and `npm run check` PASS; indexed audit exit0/historical WARN. No full native certification was run and no additional native execution remains authorized.

## Final pre-CREATE A2 — terminal FAIL, no CREATE credit

[CI37639777800](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37639777800), functional `a75c8ba`, focused Windows block **27 total / 25 PASS / 1 FAIL / 1 skip** in 8m35s. The valid protected roots, unsafe-root negative, runtime resume and wrong-branch checks PASS. Native worktree observation: raw/canonical path strings unequal, physical `dev`+`ino` equal; normalized and case-folded forms still unequal. The one FAIL is receipt-protocol test15: concurrent child writer exits `[0,1]` rather than `[0,0]`; child stderr is not published by that assertion, so exact cause UNKNOWN. The same test passed in A1, which does not negate A2's red outcome. LSP/Pi/CREATE skipped; Phi-owned global residual/Job/pipe status UNKNOWN. Both A1/A2 are consumed. Pre-CREATE FAIL, ordinary CREATE NOT REACHED, no full Campaign certification or autonomy promotion.

## D6-WINDOWS-PRECREATE-INTEGRATION-001 — A1 native evidence and A2 boundary

[CI37637450595](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37637450595), functional `d980b76`, Windows focused block: **27 total / 24 PASS / 2 FAIL / 1 skip**, job 12m10s. Both 100-run Scout→Planner fixtures PASS; explicitly permissive root rejected; process identity and protected ACL tests PASS. The only failures are runtime resume and wrong-branch negative test because Git-reported and Node allocation roots remain textually unequal even after `realpathSync`. Native metadata shows Git `/`, Node `\`; physical dev/ino equality and exact residual spelling subtype were not logged. LSP/Pi/CREATE skipped. A2 is allowed only for the implementation-local physical-identity correction and must run the same 27-test block. If red, no CREATE. Native Job/pipe/global residual-process census was not part of A1 and is UNKNOWN, not PASS.

## Final focused Windows Run 2 — terminal pre-CREATE FAIL

[CI37634476513](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37634476513), exact functional source `a0c64e43a3e386bdf35a5d6ffa2999a9dc9ac84a`, Windows job `112836946391`: bootstrap/native build PASS; focused **25 total / 21 PASS / 3 FAIL / 1 skip**. Failed case16 and case17 at `tests/receipt-protocol.test.mjs:174,190` with protected-root rejection; case19 at `tests/runtime-isolation.test.mjs:59` with `resumed worktree is not registered by Git`. Native process identity, ACL selftest, protected evidence/tamper and runtime overlap cases PASS. LSP install, isolated Pi, three predecessor smokes and genuine ordinary CREATE SKIPPED. CI post-actions complete; Phi-owned residual census not attested. No further native run under current authority; no ordinary CREATE PASS claim. Local focused 91/30 PASS/0 FAIL/61 Windows skips and full `npm run check` PASS on this functional candidate, but native failures take precedence.

## Focused CI37633332909 and implementation-local correction

Native Windows focused regression step: **25 total / 8 PASS / 16 FAIL / 1 skip**; process generation exactness, ACL selftest and workflow protected receipt/tamper case PASS. Failure preceded LSP/Pi/ordinary CREATE. The same-run failure log proves the stale `.json` validation expectation against a `.win-v1.lock` writer and non-protected existing fixture root rejection; repository-child overlap test also did not reject. After the scoped correction, local focused **91 total / 30 PASS / 0 FAIL / 61 Windows skips** and full `npm run check` PASS. No native CREATE success claim. One final focused Run 2 pending; no full certification or provider call.

## D6 Windows process identity and protected ACL candidate — local verification

Focused `node --test tests/process-identity.test.mjs tests/protected-artifact.test.mjs tests/workflow-evidence.test.mjs tests/workflow-recovery.test.mjs tests/runtime-isolation.test.mjs tests/phi-windows-confinement.test.mjs tests/receipt-protocol.test.mjs`: **91 total / 30 PASS / 0 FAIL / 61 native Windows skips**. Full `npm run check` exited 0, including syntax, TypeScript against installed Pi and package validation. Scoped whitespace check PASS. Windows native compiler/ACL/process tests and ordinary CREATE remain pending; Linux-only results cannot certify them. Zero external provider/model calls.

## D6 Windows pre-publication portability attribution — local only, authority STOP

Deterministic local replay of the exact post-`EVIDENCE_RUN_CREATED` sequence: evidence run created, `openRoleReceiptStore()` succeeded, then an absent Windows `/proc` read produced `ENOENT` at `/proc/sys/kernel/random/boot_id` inside `initialWorkflowJournal()`/`captureProcessIdentity()`. No product/test file was modified to manufacture a passing workflow. This proves the source path can produce the observed error; the prior native CI stage lacked an individual throwing-call marker, so exact same-run syscall remains LIKELY. No native Windows CREATE run, no suite/clone rerun, no provider/model call under the new decision. Previous CI37543922909 remains FAIL with target absent/no worktree/V6 not established, receipt physically written but owner-only validation rejected, global Job/pipes/residual process count UNKNOWN. New process-identity semantics and workflow ACL trust are referred to Main before functional change.

## D6 ordinary CREATE post-fix native validation — FAIL, bounded runs consumed

[CI37543922909](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37543922909) at exact `d5c5bb4b20f5592b7d3d0dcb1f0478e371335f2f`: pinned LSP and isolated Pi install PASS; three predecessor smokes SKIPPED as specified for isolated mode; real ordinary CREATE FAIL. Stages `EVIDENCE_RUN_START` → `EVIDENCE_RUN_CREATED` → `EXECUTION_THROWN`/`ENOENT` before journal/worktree/Worker/V6, then failure execution/receipt files written and terminal FAIL emitted. Reader rejected receipt owner-only mode; accepted durable receipt status remains UNPROVEN. Snapshot `NO_WORKTREE`, original target absent, V6 `NOT_ESTABLISHED`; child closed exit0, temporary removed, provider requests0, global owned process/Job/pipes UNKNOWN. No native publication attempt. Previous local focused 26 total/19 PASS/0 FAIL/7 native skips and typecheck/package PASS do not supersede this native FAIL. Both focused Windows executions under the packet are consumed; no full certification or third sample.

## D6 ordinary CREATE diagnostic Run 1 and local portability candidate

[CI37543362273](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37543362273): focused Windows ordinary CREATE FAIL, last completed stage `EVIDENCE_RUN_START`, `EPERM` in directory synchronization, no worktree/Worker/V6/publication, original target absent; child closed and fixture removed, global owned-process/Job/pipes UNKNOWN. Focused portability candidate: `node --test tests/portable-directory-sync.test.mjs tests/workflow-evidence.test.mjs tests/phi-worker-transport.test.mjs tests/runtime-isolation.test.mjs` 26 total/19 PASS/0 FAIL/7 Windows-native skips; syntax, typecheck and package validation PASS; scoped diff check PASS. Repository audit exit0/zero FAIL with historical WARN. The protected user audit has pre-existing trailing whitespace, so whole-worktree `git diff --check` is not a candidate verdict. Native post-fix CREATE validation PENDING; no full Campaign certification authorized.

## D6-NATIVE-STABILITY-QUALIFICATION-001 — Run 1 terminal FAIL

Exact source `7458dca45a9d4cd6c8a0e59f6e9ba8b338a8f332`; [CI37510013520](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37510013520), Windows job `112428415758` FAILURE, Ubuntu job `112428416045` SUCCESS. Windows main **491 total/479 PASS/0 FAIL/12 skips**; Ubuntu **491/168 PASS/0 FAIL/323 skips**. Independent Windows clone **491/479 PASS/0 FAIL/12 skips**, Gate A/B PASS and C RUNTIME_RECORDED, suite596,932ms, longest completion gap53,158ms (<150,000ms), pinned LSP26,413ms (<120,000ms), post-test recovery PASS; Job empty, pipes drained, clone cleanup PASS/4,370ms/directory removed/residual owned0. Three isolated pinned-Pi foreground Worker smokes all PASS with local deterministic provider transport, 0 external requests and their own cleanup receipts. The ordinary Windows CREATE Pi smoke then FAILED exit1; first public error `workflow evidence finalization failed`, `toolError:true`, `workflowStatus:null`, `durableError:null`, `evidenceRuns:1`, no published delegation attempts, fixture `temporaryRemoved:true`. No final CREATE receipt or evidence for its internal Worker/publication/V6 stages; exact finalization exception and failed-workflow owned-process count UNKNOWN. GitHub job post-action cleanup completed but is not an owned-process receipt. No new local tests or provider calls in this evidence-only continuation. Run 2 NOT EXECUTED: Run 1 failure stops the PASS+PASS decision. This clone sub-gate PASS does not promote native stability qualification or Windows autonomy.

## D6-CORRUPT-JOURNAL-READY-DIAGNOSTIC-001 — two native runs, CASE E

Isolated [CI37505495334](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37505495334), commit `5b575b2456c53e8080cb4ee5d273cacbfdaebe06`: 1 PASS/0 FAIL/0 skip; test209 readiness `LINE` after465 ms, publisher PID7640 alive at readiness, any-Job membership true, fixture/Git cleanup true, stdout/stderr completed, tracked publisher residual0. The first diagnostic parser omitted a redundant Git-cleanup field; the outer native receipt proved it true. Ordered-prefix [CI37505879192](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37505879192), commit `b37fb80c64aa86b01eaf2e40c26d55776ecaa4eb`: 12 ordered Phi test files, 217 total/214 PASS/0 FAIL/3 skips; test209 `SUCCESS/LINE` in370 ms, PID6460 alive at readiness, any-Job membership true, planned kill attempted, fixture/Git cleanup true, stdout closed/stderr drained, tracked publisher residual0. Specific Job identity and total Phi-owned residual count are not attested; no claim of zero total. Both are diagnostic, not clone or full-suite certification. No failure stage observed; original CI37384516310 readiness timeout cause UNKNOWN, relation to previous publisher-ready timeouts UNKNOWN. Local focused 39/19 PASS/0 FAIL/20 Linux skips; full local `npm run check` PASS; syntax/TypeScript/package validation PASS. No product fix, timeout/retry change or provider call.

## D6-CLONE-RECERTIFICATION-001 — full workflow failed before clone

Source `cccc4224d373cd6ee97850bd4c056e7433457669`; [CI37384516310](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37384516310), Windows job `112014369544`, Ubuntu job `112014370137`. Ubuntu main Phi suite: **491 total/168 PASS/0 FAIL/323 skips**. Windows pre-main native CREATE/journal/MODIFY/DELETE/RENAME/LPAC/Worker/recovery/startup/mixed-journal steps passed; mixed-journal dedicated step **23/23 PASS**. Windows main: **491 total/478 PASS/1 FAIL/12 skips** in 591,612 ms. First failure ordinal209 `corrupt-journal`, native `PHI_MIXED_CRASH_SELFTEST_FAILED:PUBLISHER_READY_TIMEOUT:80131501`, exit70; ordinal206 passed. The independent clone never started: clone correctness/liveness/runtime gates, 120-second LSP installation, clone cleanup and zero-owned-residual receipt **NOT REACHED**. Three Pi smokes and ordinary CREATE smoke **SKIPPED**. Fixture cleanup/residual owned-process count is **NOT ATTESTED** by the failure log. Cause UNKNOWN. The one authorized certification attempt is consumed, not a passing clone certificate.

Before dispatch: incremental zero-egress diff review PASS; focused local 41 total/31 PASS/0 FAIL/10 native skips; repository audit exit0 with historical WARN only/0 FAIL; prior same-HEAD `npm run check` 1039 total/713 PASS/0 FAIL/326 skips and Phi corpus491. External model review/provider calls0. No product/runtime/timeout policy change was made.

## D6-CLONE-TEST206-DIAGNOSTIC-001 — two focused native clone runs, CASE E

Original full clone [CI37357312199](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37357312199) remains failed at ordinal206; no replacement certification. Focused Run 1 [CI37383051251](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37383051251), `3d2e377`: test206 1/1 PASS, native stage COMPLETE/exit0/2,125ms; wrapper FAIL after the test due applying full-corpus gate to focused mode, post-test recovery not reached; clone cleanup PASS/one attempt/directory removed/residual0. Focused Run 2 [CI37383507243](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37383507243), `eb25576`: diagnostic-only workflow SUCCESS, test206 1/1 PASS/stage COMPLETE/native2,137ms; LSP20,299ms (<120s), post-test recovery PASS, Job empty/pipes drained, cleanup PASS/2,443ms/one attempt/directory removed/residual0. No test206 failure stage or handle owner observed; original cause UNKNOWN. Local `npm run check` 1039 total/713 PASS/0 FAIL/326 skips, syntax/TypeScript/package PASS; fixed Phi corpus remains491. No provider/model calls. D6 clone certification not passed.

## CI37356395247 focused PASS; CI37357312199 certifying clone FAIL

Test-only `5717199` keeps the synthetic outer-ceiling fixture alive; portable fixture liveness and local focused 15 PASS/0 FAIL/10 native skips. `npm run check` PASS; `npm run check:phi` 491/168 PASS/0 FAIL/323 skips. Native focused Windows 11/11 PASS: slow valid progress171,215ms, no-progress termination150,341ms, fixture liveness1,216ms, independent outer termination4,168ms; assertions require Job empty and owned residual0. The full same-source run passed Ubuntu 491/168 and Windows main 491/479 (both 0 FAIL), but its independent clone 491/478 PASS/1 FAIL/12 skips, failed ordinal206 after651,579ms. Its process receipt: ordered491, failed1, longest native gap51,679ms, no stall/outer timeout, Job empty/pipes drained/residual0. Gate A FAIL, B UNPROVEN, C RUNTIME_RECORDED; cleanup PASS/directory removed/residual0. No Pi/CREATE smoke credit. Exact native failure stage UNKNOWN; aggregated filesystem records are not case attribution. No second clone launched.

## Zero-egress review checkpoint for clone-runtime candidate

Functional scope: `f6063bf` plus local review fix `9a5a2c0`; docs-only `f63c4a8` assessed separately. `ZERO_EGRESS_REVIEW: PASS` (structured local security/correctness review, **not** external model review). Focused `node --test tests/clone-runtime-gate.test.mjs tests/clone-runtime-reporter.test.mjs tests/phi-clone-cleanup.test.mjs`: **24 total / 14 PASS / 0 FAIL / 10 native-Windows skips**. Covers numeric reporter live delivery, test-owned stdout spoof resistance, malformed/duplicate/missing ordinals, failed exit, late completion stall, outer classification and final Gate A cleanup dependency. Full local `npm run check`: PASS, including syntax, TypeScript and package validation. `node scripts/phi-repository-audit.mjs`: WARN only for historical docs/fixtures, **zero FAIL**, model calls0. Exact functional and review-fix diffs pass whitespace checks. Native Windows slow-progress/stall/outer/cleanup controls remain pending; no certification claim. External model review NOT RUN / NOT AUTHORIZED.

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
