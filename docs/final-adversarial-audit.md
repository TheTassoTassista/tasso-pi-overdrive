# Final adversarial audit

Audit date: 2026-09-10. Earlier completion reports were treated as untrusted. PASS requires current filesystem implementation plus repeatable static/runtime proof. The last authenticated run remains FAIL and is not credited as a pass.

## Original phases

| Phase | Status | Current evidence or gap |
|---:|---|---|
| 0 — Audit | PASS | `docs/system-audit.md`, `docs/package-audit.md`, `implementation-log.md`; `scripts/status.sh`, `npm run smoke:catalog` |
| 1 — Base Pi | PASS | Official Pi remains external and version 0.85.1; live catalog works; auth-file metadata is unchanged; two real Scout calls authenticated successfully in the fail-closed E2E |
| 2 — Core tools | PARTIAL | Git, rg, fd, jq, curl, wget, and unzip work; optional `gh`, `tree`, and `zip` remain absent. Core harness is unaffected; GitHub CLI/convenience archive flows are unavailable |
| 3 — Code search | PASS | `@ff-labs/pi-fff@0.10.6`; `npm run smoke:runtime` proves filename and content calls through Pi |
| 4 — LSP intelligence | PARTIAL | `semantic_nav`, `lib/lsp-manager.mjs`; TS/Python/C++ runtime proofs pass inside read-only no-network Bubblewrap. Rust and Go are recognized but their servers are missing; this materially limits those languages |
| 5 — AST search | PASS | `@juvio15/pi-ast-grep@0.4.2`, `@ast-grep/cli@0.45.3`; real Pi returns two structural matches |
| 6 — Context engineering | PASS | project templates, progressive skills, compact tool surface; zero-cost real-Pi context metadata plus prior exact provider counts in `npm run benchmark:context` |
| 7 — Output optimization | PASS | `lib/output-optimizer.mjs`; 97.06% fixture reduction and all critical diagnostics retained regardless of position/count |
| 8 — Handoff/notebook | PASS | `npm run smoke:handoff`: state marker survives, handoff editable, new session has zero messages |
| 9 — Subagents | PASS | `pi-subagents@0.66.0`; all twelve profiles dynamically discovered with runtime-enforced surfaces |
| 10 — Model routing | PASS | registry, authentication, and cached runtime-callability are independent prerequisites; known-rejected `gpt-5.4` deterministically falls back to Luna before fan-out and every skip is recorded |
| 11 — Benchmarking | PASS | six deterministic tasks, four preset evaluations, output benchmark, and zero-cost context inspection; missing live comparisons are labeled, not fabricated |
| 12 — Web research | PARTIAL | known-URL fetch works; Brave and Perplexity search are correctly unavailable because both keys are missing. Unknown-URL discovery is materially affected |
| 13 — Browser | PASS | real isolated Chromium profile/session opens, inspects local DOM marker, materializes, and closes |
| 14 — MCP | PASS | audited `pi-mcp-adapter@2.32.1` patch; one lazy proxy, two read-only Context7 tools, real online read, mutation/hidden-tool denial, metadata-only trace |
| 15 — Ask user | PASS | `@juicesharp/rpiv-ask-user-question@2.9.0` registered; the schema is deferred by Pi |
| 16 — Worktrees | PASS | native Git worktree/branch allocation; unit and local smoke prove independence and cleanup |
| 17 — Sandbox/safety | PASS | canonical path checks, hard-link denial, all free-form shell denied, allowlisted `safe_exec` inside Bubblewrap; 13 Pi attacks and namespace tests pass |
| 18 — Verification loop | PASS | nonzero exit/NO_CHECKS fail closed; state-machine tests force full verification after each bounded correction |
| 19 — Adversarial review | PASS | correctness/security/simplicity required; blocking review forces Worker correction and re-review; prior full v4 E2E corroborates controller tests |
| 20 — Application observability | PASS | collector returns actual sources/counts/bytes and legitimate zeros, never constants |
| 21 — Agent observability | PASS | `pi-observability@1.3.2`; `/obs` registered and available runtime metadata collected |
| 22 — Tracing | PASS | 254 files / 1,289 rows: owner-only, zero malformed/forbidden/secret-like content |
| 23 — Memory | PASS | docs/skills/notebook/session/handoff hierarchy; no ambient automatic-recall plugin |
| 24 — Skills | PASS | all 15 package skills dynamically discovered and validated |
| 25 — Prompt templates | PASS | all 12 package prompts dynamically registered |
| 26 — Issue spec | PASS | requested template fields and Planner rules validated |
| 27 — Deterministic guardrails | PASS | safety, safe-exec, verification and route-policy adversarial controls pass |
| 28 — Self-improvement | PASS | bounded/redacted findings store; no automatic config rewriting |
| 29 — Gardener/GC | PASS | optional read-only, unscheduled prompt commands are registered |
| 30 — Personal package | PASS | permanent Git package `/home/tasso/Documents/Codex/tasso-pi-overdrive`; active Pi source points only there |
| 31 — Default workflow | PARTIAL | the deterministic zero-paid full workflow including Council, Judge, planted reviewer correction and final verification passes, but the repaired integrated path has not yet had a newly authorized authenticated E2E |
| 32 — Cost/time optimization | PASS | default core set unchanged by model/council; lazy MCP/LSP; deterministic context estimator makes routine measurement cost zero |
| 33 — Complete-system test | FAIL | authorized post-fix run `179bb6f7-414c-4529-baa2-709630b9bac9` failed before Worker after all three council members failed; final verification was NOT_RUN. Cleanup and fail-closed evidence publication passed |
| 34 — Documentation | PASS | README and docs now describe current MCP/LSP/model/council/benchmark/E2E truth without stale pass claims |
| 35 — Reproducibility | PASS | clean-HOME bootstrap installs exact packages/runtimes, policy, presets, council and secret-free web slots; no auth is created |

Original-phase totals: **31 PASS, 4 PARTIAL, 1 FAIL, 0 INTENTIONALLY OMITTED**. Strict full-PASS coverage is **86.1% (31/36)**; partials are not weighted into that percentage.

## Requested 37-point runtime audit

| # | Status | Concrete proof |
|---:|---|---|
| 1 | PASS | `pi --version`; `npm run smoke:catalog` launches official Pi 0.85.1 normally |
| 2 | PASS | `npm run smoke:models` proves auth metadata unchanged; two real Scout children completed using existing `openai-codex` auth |
| 3 | PASS | `npm run smoke:runtime`; `@ff-labs/pi-fff@0.10.6` |
| 4 | PARTIAL | `npm run smoke:lsp`: real TS/Python/C++ results; Rust/Go server-missing is explicit and material for those repositories |
| 5 | PASS | `npm run smoke:runtime`; `@juvio15/pi-ast-grep@0.4.2` |
| 6 | PASS | `npm run smoke:catalog`: all 15 skills loaded from repository paths |
| 7 | PASS | `npm run smoke:catalog`: 12 prompts and 14 local extension commands registered; total Pi catalog 83 |
| 8 | PARTIAL | `npm run smoke:agents` discovers all twelve profiles and local contract tests prove Council advisory completion; a post-repair authenticated call of every Council role was intentionally not run |
| 9 | PASS | `npm run smoke:agents`, `npm run smoke:guardrails`: Tester/council mutation absent; Worker shell absent; runtime denials exercised |
| 10 | PASS | `tests/workflow-state.test.mjs`, `tests/tool-surface.test.mjs`: concurrency 3/depth 1 constants and recursive override rejection |
| 11 | PASS | routes require cached runtime-callable evidence; `gpt-5.4` is rejected before fan-out, efficient Council uses Sol/5.5/Luna plus Astra Judge, and canonical model/thinking plus forged-receipt controls pass |
| 12 | PASS | `npm run smoke:handoff`: clean session message count 0 |
| 13 | PASS | same smoke: notebook marker survived the handoff workflow |
| 14 | PASS | `tests/output-optimizer.test.mjs`: beginning/middle/end warning floods and 120 critical lines retained |
| 15 | PASS | `npm run smoke:verification`: exit 7 and NO_CHECKS cannot become PASS |
| 16 | PASS | `tests/workflow-state.test.mjs`: reviewer blocker mechanically returns work to correction and complete verification/review |
| 17 | PASS | `npm run smoke:browser`; `pi-agent-browser-native@0.6.6`, `agent-browser@0.36.0` |
| 18 | PASS | `tests/runtime-isolation.test.mjs`, `npm run smoke:local`: independent native Git worktrees/branches |
| 19 | PASS | runtime-isolation test: unique port, state directory, browser profile/session, DB and schema identifiers; DB provisioning is not claimed |
| 20 | PASS | `tests/sandbox.test.mjs`: Bubblewrap hides host secrets/config/Git, clears env/network, confines indirect writes |
| 21 | PASS | exact unsandboxed boundary documented in `docs/security.md`: trusted Pi/extensions/provider traffic, controller Git/runtime allocation, guarded host file/navigation, browser/web, read-only host diff check |
| 22 | PASS | `npm run smoke:guardrails`: secret/system/outside/destructive paths blocked |
| 23 | PASS | same smoke: shell, inline interpreters, fd exec, rg preprocessors, destructive Git denied; no side effects |
| 24 | PASS | `npm run smoke:trace`: metadata-only corpus, owner-only modes, no prompt/file/output/secret fields |
| 25 | PASS | `npm run observe`: real calculated zeros and actual Git changed-path count |
| 26 | PASS | `npm run smoke:web` and runtime smoke fetch Example Domain through real Pi |
| 27 | PARTIAL | search status accurately reports missing Brave/Perplexity keys and fails clearly; search itself is unavailable |
| 28 | PASS | `npm run smoke:restore`: byte-exact pre-Overdrive settings hash |
| 29 | PASS | `npm run smoke:bootstrap`: full clean-HOME reproduction without secrets/auth |
| 30 | PASS | `node scripts/validate-package.mjs`: no dated temporary Codex source path |
| 31 | PASS | `find -L . -type l` returns none; package validator rejects unsafe links |
| 32 | PASS | active Pi catalog source is the stable repository; no package source points to a disposable workspace |
| 33 | PASS | exact versions in `config/packages.json`, MCP/LSP lockfiles, validator, and npm audits |
| 34 | PASS | one controller/optimizer/trace/safety hook; protected `/council` deterministically shadows, rather than competes with, the upstream prompt |
| 35 | PASS | package validator, trace/mission audits and Git inspection find no secret values |
| 36 | PASS | final `npm run check`: 85/85 plus syntax/types/package validation |
| 37 | FAIL | the one authorized post-fix fresh-repository run failed before Worker; no code change, verification, reviewers, correction, or final validator PASS occurred. Cleanup did pass |

Requested-check totals: **33 PASS, 3 PARTIAL, 1 FAIL, 0 INTENTIONALLY OMITTED**. Strict full-PASS coverage is **89.2% (33/37)**.

## Model/council expansion audit

| Capability | Status | Evidence or limitation |
|---|---|---|
| Real catalog and unauthenticated-provider handling | PASS | `/models` distinguishes registry/authentication/runtime-callability; a secret-free cache is installed and `gpt-5.4` is explicitly rejected from active routes |
| Per-role override, persistence, reload, reset | PASS | isolated-home runtime command proof |
| All five preset modes | PASS | all presets assign twelve callable routes, record deterministic fallback reasons, and custom invalid routes fail `BLOCKED_BY_MODEL` without rewriting user policy |
| User-owned immutable policy boundary | PASS | mode 0600 atomic file; no model tool mutates it; nested route override rejected |
| Model/thinking receipt binding | PASS | exact/suffixed route tests, resume tamper tests, launch-contract digest, durable protocol rejection |
| Protected explicit council command | PASS | `/council` extension precedence and `/council-status` runtime proof |
| Independent member contexts | PARTIAL | profiles are runtime-discovered as fresh/read-only/non-delegating with `completionGuard: false`; local zero-edit Council passes, but authenticated post-repair completion was not rerun |
| Judge sequencing and disagreement | PASS | all three structured results required before Judge; missing/malformed/early cases fail; disagreement retained |
| Escalation policy | PASS | explicit, high-risk, reviewer disagreement and repeated-failure paths tested |
| Hard limits/no nesting | PASS | constants 3/1/2 and recursive input attacks tested |
| Bootstrap/reproducibility | PASS | clean HOME includes presets, policy and council routes without auth |
| Context overhead | PASS | real Pi metadata estimate, zero paid calls; no model/council default tool added |
| Real cross-provider execution | PARTIAL | only `openai-codex` authenticated; model-identity diversity exists, provider-family diversity does not |
| Post-fix authenticated integrated E2E | FAIL | authorized run failed at council fanout; Worker and later phases were NOT_RUN; no rerun was made |
| Heterogeneous quality benchmark | INTENTIONALLY OMITTED | precondition—two authenticated provider families—was absent; fabricating it would be invalid |
| Four-preset live review benchmark | INTENTIONALLY OMITTED | four extra paid calls were not authorized after the first E2E attempt |

Expansion totals: **11 PASS, 2 PARTIAL, 1 FAIL, 2 INTENTIONALLY OMITTED**.

## Critical gaps

- The last authenticated model-routed Council → Worker → Tester → verification → reviewer/correction run is still FAIL. All exposed deterministic causes are repaired locally, but autonomous reliance still requires a newly authorized authenticated E2E.
- Rust and Go semantic navigation are unavailable until reviewed, pinned servers are installed. This is critical only for autonomous work in those languages.

## Non-critical gaps

- Brave/Perplexity search is unavailable; known-URL fetch remains functional.
- Optional `gh`, `tree`, and `zip` are absent.
- Live preset quality/cost and cross-provider-value experiments were not run.
- Cached runtime-callability evidence does not expire automatically. Provider/account changes require an explicit evidence refresh; unknown models fail closed meanwhile.
- The bundled upstream `/council` prompt remains visible as a duplicate catalog entry; the protected extension command has tested precedence and is the actual handler.
- Nine owner-only temporary child-session directories and bounded foreground-history metadata remain after runtime cleanup. They are not active processes/worktrees, but retention is deferred rather than immediate.

## Security and architectural boundaries

- Pi, trusted extensions, provider traffic, browser/web tools, controller Git allocation/cleanup, guarded host file/navigation calls, and read-only host `git diff --check` are outside Bubblewrap. A malicious installed extension still runs with the user's authority.
- Built-in Pi host file APIs do not expose directory-FD/openat operations. Realpath, symlink-component, inode/link and post-operation checks defeat ordinary escapes but leave a narrow same-user TOCTOU race.
- Bubblewrap is a mount/user/network namespace boundary, not a VM/kernel boundary. Hostile native code or production credentials require a container/VM or separate low-privilege account.
- Secret detection relies on conventional paths/names; a secret deliberately stored under an ordinary source filename is indistinguishable from source.
- Port reservations prevent Overdrive/Overdrive collisions, but another process can race between availability checking and application bind.
- Database/schema values are isolated identifiers only; the harness does not provision a database.
- A reboot cannot reconstruct a source repository that lived only under `/tmp`; real work must start in a durable Git checkout.
- Manual `subagent` use is not the guaranteed workflow. Only `secure_coding_workflow` or protected `/council TASK` guarantees receipts, review, correction, verification and cleanup policy.
- Mission artifacts retain bounded redacted summaries for resume; ordinary non-secret paths/code prose may remain until terminal compaction/retention.

## Before autonomous reliance

All four deterministic blockers are repaired and the local corrected Council passed 100/100; the complete zero-paid workflow with a planted correction reached final PASS. Before autonomous reliance, obtain explicit authorization for exactly one authenticated E2E and require it to pass without weakening policy. Continue to use durable clean Git repositories; invoke only the enforced workflow entry points; inspect retained worktree diffs before merge; keep deploy/publish/account mutations human-approved; use a VM/container for hostile code; add Rust/Go servers only when needed; configure web-search credentials only if live discovery matters.

Do not replace the official Pi installation/auth, loosen route/receipt/verification limits, enable network in autonomous command sandboxes, stack another controller/optimizer/trace hook, or add automatic ambient memory. FFF, AST, TS/Python/C++ LSP, notebook/handoff, metadata trace, observability, browser profile isolation, safe fetch, native worktrees, verification exit propagation, package pins, bootstrap and backup/restore are working well.
