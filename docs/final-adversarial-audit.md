# Final adversarial audit

Audit date: 2026-09-09. The 2026-09-07 completion claims were treated as untrusted. A PASS below requires current filesystem implementation plus a repeatable runtime/static command; package names are included where a third-party Pi package implements the capability. The final authenticated evidence run is `0789657a-a21f-4614-8919-ad88089050b8` (workflow v4, task `1f82853a4b114a7d4430359012d42434bc41845a63e8fccb544ae48ecb94aae8`).

## Original phases

| Phase | Status | Evidence or gap |
|---:|---|---|
| 0 — Audit | PASS | `docs/system-audit.md`, `docs/package-audit.md`, and `implementation-log.md`; verify with `scripts/status.sh` and `node scripts/catalog-audit.mjs`. The audit records distro, shell, Pi, providers/models, tools, identity presence, environment names, disk, and missing tools without secret values. |
| 1 — Base Pi | PASS | Official Pi remains outside this repository; `pi --version` returns 0.85.1 and `node scripts/catalog-audit.mjs` launches its RPC mode. The authenticated fresh E2E proves the existing `openai-codex` authorization still works. |
| 2 — Core tools | PARTIAL | `docs/system-audit.md`; `git`, `rg`, `fd`, `jq`, `curl`, `wget`, and `unzip` work, but `gh`, `tree`, and `zip` are absent because privileged package installation requires the user's sudo password. This does not materially affect the harness; GitHub-specific CLI work and convenience listings/archives remain unavailable. |
| 3 — Code search | PASS | `@ff-labs/pi-fff@0.10.6`, host `rg`/`fd`; `node scripts/runtime-capabilities.mjs` proves real Pi FFF filename/content search on a fresh tree. |
| 4 — LSP intelligence | PARTIAL | `extensions/typescript-navigation.ts`, `lib/typescript-navigation.mjs`, pinned `typescript@6.0.3`; `node scripts/runtime-capabilities.mjs` proves TS2322 diagnostics, exact cross-file definition, and four references. Symbols, hover, workspace symbols, and Pi-integrated Python/C++/JSON/HTML/CSS/shell LSP are absent. This materially limits semantic navigation outside TypeScript/JavaScript; text/AST search and installed host language servers remain available. |
| 5 — AST search | PASS | `@juvio15/pi-ast-grep@0.4.2` plus pinned `@ast-grep/cli@0.45.3`; `node scripts/runtime-capabilities.mjs` proves two structural matches through real Pi. |
| 6 — Context engineering | PASS | `templates/project/AGENTS.md`, `templates/project/docs/`, all skill frontmatter, `extensions/tool-surface.ts`; `node scripts/validate-package.mjs` and `node benchmarks/context-overhead.mjs`. |
| 7 — Output optimization | PASS | `extensions/output-optimizer.ts`, `lib/output-optimizer.mjs`; `npm run benchmark` and `node --test tests/output-optimizer.test.mjs` prove 97.06% fixture reduction while retaining all ERROR/FATAL/failure lines at every tested position and count. |
| 8 — Handoff/notebook | PASS | `extensions/notebook.ts`, `extensions/handoff.ts`; `node scripts/handoff-smoke.mjs` proves notebook survival, editable distilled prompt, and a new session with zero messages. |
| 9 — Subagents | PASS | `pi-subagents@0.66.0`, `agents/*.md`, `config/subagents.json`, `extensions/secure-workflow.ts`; `node scripts/agent-policy-smoke.mjs` and fresh E2E prove all eight roles execute in isolated child contexts with enforced surfaces. |
| 10 — Model routing | PASS | `agents/*.md`, `config/subagents.json`, fixed routes in `extensions/secure-workflow.ts`; `node scripts/e2e-smoke.mjs` validates provider/model/thinking for every runtime role receipt. |
| 11 — Benchmarking | PASS | `benchmarks/tasks.json`, `benchmarks/evaluator.mjs`, `benchmarks/context-overhead.mjs`, `benchmarks/output-optimizer.mjs`; `npm run benchmark:suite`, `npm run benchmark:context`, and `npm run benchmark`. Six deterministic categories run without paid model calls; token/cache/cost fields are recorded where Pi exposes them. |
| 12 — Web research | PARTIAL | `@juicesharp/rpiv-web-tools@2.9.0`; `node scripts/runtime-capabilities.mjs` proves public `web_fetch` and extracted source text. `web_search` is intentionally unconfigured because no search-provider credential was supplied; it fails clearly and is documented in `docs/browser-and-web.md`. This materially prevents direct search but not fetching a known URL. |
| 13 — Browser | PASS | `pi-agent-browser-native@0.6.6`, pinned `agent-browser@0.36.0`, isolated Chrome for Testing; `node scripts/browser-smoke.mjs` launches the exact assigned session/profile, inspects `OVERDRIVE_BROWSER_OK`, materializes the profile, and closes the session. |
| 14 — MCP | INTENTIONALLY OMITTED | `docs/mcp.md` and `config/mcp.example.json`. The vetted `pi-mcp-adapter@2.32.1` peer range excludes Pi 0.85.1, so installing it would violate the compatibility requirement. This affects only MCP services; local search, Git, web fetch, and browser capabilities remain available with a smaller schema. |
| 15 — Ask user | PASS | `@juicesharp/rpiv-ask-user-question@2.9.0`, Planner prompt in `agents/planner.md`; `node scripts/catalog-audit.mjs` proves the structured tool/command package is loaded by Pi. |
| 16 — Worktrees | PASS | `lib/runtime-isolation.mjs`, `scripts/worktree-runtime.mjs`; `node --test tests/runtime-isolation.test.mjs` and fresh E2E prove a distinct Git branch/worktree is created and later absent after verified cleanup. |
| 17 — Sandbox/safety | PASS | `scripts/sandbox-run.sh`, `extensions/safety.ts`, `extensions/safe-exec.ts`; `node --test tests/sandbox.test.mjs tests/safety.test.mjs` and `node scripts/guardrail-smoke.mjs` prove namespace isolation and 13 denied attacks. Residual host operations are explicitly listed below. |
| 18 — Verification loop | PASS | `extensions/verification-gate.ts`, `scripts/verify-project.mjs`, state machine in `lib/workflow-state.mjs`; `node scripts/verification-smoke.mjs` proves exit 7 and NO_CHECKS cannot become PASS. Fresh E2E proves correction and final re-verification. |
| 19 — Adversarial review | PASS | three reviewer prompts, `lib/review-policy.mjs`, `extensions/secure-workflow.ts`; fresh E2E plants correctness/security blockers, requires all reviewers, and reruns correction until zero blocking findings. |
| 20 — Application observability | PASS | `config/observability-adapters.json`, `lib/observability.mjs`, `scripts/collect-observability.mjs`; `npm run observe` returns actual discovered-source/count/byte values rather than constants. |
| 21 — Agent observability | PASS | `pi-observability@1.3.2`; `node scripts/catalog-audit.mjs` proves `/obs` is registered, and `npm run observe` records model/tool/timing/git values exposed by the available APIs. |
| 22 — Tracing | PASS | `extensions/metadata-trace.ts`, `lib/jsonl-audit.mjs`, `scripts/trace-audit.mjs`; `npm run smoke:trace` parses every complete row and permits only an unterminated final crash tail, with no prompt/content/secret fields or insecure modes. |
| 23 — Memory | PASS | Durable docs/skills/notebook/session/handoff hierarchy is documented in `README.md` and `docs/workflow.md`; no automatic recall plugin is loaded. `node scripts/validate-package.mjs` proves the selected package surface. |
| 24 — Skills | PASS | 15 directories under `skills/`; `node scripts/catalog-audit.mjs` proves all 15 are dynamically discovered by Pi, and `node scripts/validate-package.mjs` validates their Agent Skills frontmatter. |
| 25 — Prompt templates | PASS | 12 templates under `prompts/`; `node scripts/catalog-audit.mjs` proves every `/bug`, `/feature`, `/refactor`, `/review`, `/security`, `/perf`, `/research`, `/migrate`, `/release`, `/docs`, `/doc-garden`, and `/code-gc` command is registered. |
| 26 — Issue spec | PASS | `templates/issue-spec.md` contains every requested field; Planner generation rules are in `agents/planner.md`; `node scripts/validate-package.mjs`. |
| 27 — Deterministic guardrails | PASS | `extensions/safety.ts`, `extensions/safe-exec.ts`, `extensions/verification-gate.ts`; `node scripts/guardrail-smoke.mjs` and `node scripts/verification-smoke.mjs`. |
| 28 — Self-improvement | PASS | `lib/findings-store.mjs`, `scripts/record-finding.mjs`, `docs/self-improvement.md`; `node --test tests/observability-findings.test.mjs` proves bounded categories/redaction and no automatic config rewriting. |
| 29 — Gardener/GC | PASS | `prompts/doc-garden.md` and `prompts/code-gc.md`; `node scripts/catalog-audit.mjs` proves registration. They are read-only, optional, and unscheduled. |
| 30 — Personal package | PASS | Permanent Git package `/home/tasso/Documents/Codex/tasso-pi-overdrive`, actual `package.json` Pi manifest; `node scripts/validate-package.mjs` proves no active code/config path points into a dated Codex workspace. |
| 31 — Default workflow | PASS | Version-4 controller in `extensions/secure-workflow.ts`, `lib/workflow-state.mjs`, `lib/workflow-evidence.mjs`, and `lib/workflow-receipts.mjs`; every role transition requires an immutable admitted receipt. Fresh positive, negative, repeated receipt, and SIGKILL/resume controls prove the sequence and fail-closed loop. |
| 32 — Cost/time optimization | PASS | `extensions/tool-surface.ts`, progressive skills, FFF/AST/TS tools, optimizer, handoff, and fixed phase routing; `node benchmarks/context-overhead.mjs` measures default schema delta 3,526 versus 15,532 before remediation (77.3% lower). |
| 33 — Complete-system test | PASS | `scripts/e2e-smoke.mjs`; fresh authenticated run `0789657a-a21f-4614-8919-ad88089050b8` used a new temporary Git repository, 18 immutable role receipts and three full implementation/review rounds, then validated negative controls, final evidence, and cleanup. |
| 34 — Documentation | PASS | `README.md` and `docs/*.md` cover architecture, inventory, locations, roles, commands, routing, worktrees/runtime, browser/web, MCP status, sandbox, verification, benchmarks, tracing, observability, backup/restore, disable, troubleshooting, and daily use. `node scripts/validate-package.mjs`. |
| 35 — Reproducibility | PASS | `scripts/bootstrap.sh`, `scripts/prerequisites.sh`, `config/packages.json`; `node scripts/bootstrap-smoke.mjs` rebuilds in a clean temporary HOME with exact pins and creates no auth. |

Phase totals: **32 PASS, 3 PARTIAL, 0 FAIL, 1 INTENTIONALLY OMITTED**. Strict full-phase coverage is **88.9% (32/36)**. The original completion checklist has **24 PASS, 1 PARTIAL (broad LSP), 0 FAIL, 1 INTENTIONALLY OMITTED (MCP)**, for **92.3% strict coverage (24/26)**.

## Requested adversarial checks

| # | Status | Concrete result |
|---:|---|---|
| 1 | PASS | Official Pi 0.85.1 launches in RPC/catalog and authenticated E2E modes: `pi --version`; `node scripts/catalog-audit.mjs`; `npm run smoke:e2e`. |
| 2 | PASS | Existing `openai-codex` auth completes all routed E2E calls; bootstrap/disable never reads or writes auth: `npm run smoke:e2e`; `node scripts/bootstrap-smoke.mjs`. |
| 3 | PASS | FFF is called through Pi and returns filename/content matches: `node scripts/runtime-capabilities.mjs`; package `@ff-labs/pi-fff@0.10.6`. |
| 4 | PARTIAL | `node scripts/runtime-capabilities.mjs` proves TS diagnostics/definition/references via `extensions/typescript-navigation.ts`; broader multi-language LSP, hover and symbols are absent and materially affect non-TS work. |
| 5 | PASS | Pi AST tool returns two structural matches: `node scripts/runtime-capabilities.mjs`; package `@juvio15/pi-ast-grep@0.4.2`. |
| 6 | PASS | Pi dynamically lists all 15 package skills: `node scripts/catalog-audit.mjs`; `skills/*/SKILL.md`. |
| 7 | PASS | Pi lists all 12 prompt commands plus six custom extension commands: `node scripts/catalog-audit.mjs`; `prompts/*.md`, package manifest. |
| 8 | PASS | All eight requested agents exist, load, and are exercised by policy/E2E tests: `node scripts/agent-policy-smoke.mjs`; `npm run smoke:e2e`; `agents/*.md`. |
| 9 | PASS | Runtime tool calls outside role allowlists and Tester mutation are rejected: `node scripts/agent-policy-smoke.mjs`; enforcement is in `extensions/safety.ts`, `extensions/tool-surface.ts`, and fixed workflow calls. |
| 10 | PASS | `MAX_CONCURRENCY=3` and `MAX_DEPTH=1` are controller constants and absent from model input schema; override attempts are rejected: `node --test tests/workflow-state.test.mjs tests/tool-surface.test.mjs`. |
| 11 | PASS | Every role receipt has the exact provider/model/thinking route and owner/run/node tuple: `npm run smoke:e2e`; fixed policy in `lib/workflow-state.mjs`. |
| 12 | PASS | New handoff session contains zero messages while preserving distilled editable state: `node scripts/handoff-smoke.mjs`; `extensions/handoff.ts`. |
| 13 | PASS | Notebook marker survives the intended handoff flow: `node scripts/handoff-smoke.mjs`; `extensions/notebook.ts`. |
| 14 | PASS | Beginning/middle/100+-warning/final-line/120-critical controls all retain critical diagnostics: `node --test tests/output-optimizer.test.mjs`; `lib/output-optimizer.mjs`. |
| 15 | PASS | Nonzero exit and NO_CHECKS surface as tool errors and cannot report PASS: `node scripts/verification-smoke.mjs`; `extensions/verification-gate.ts`. |
| 16 | PASS | Run `0789657a-a21f-4614-8919-ad88089050b8` recorded planted reviewer blockers, refused early completion, and forced correction, Tester, verification and all reviewers again: `npm run smoke:e2e`; `lib/workflow-state.mjs`. |
| 17 | PASS | Actual isolated Chromium profile/session launches, inspects a local marker, materializes, and closes: `node scripts/browser-smoke.mjs`; package `pi-agent-browser-native@0.6.6`. |
| 18 | PASS | Independent Git worktree/branch is created and cleanup proves both absent: `node --test tests/runtime-isolation.test.mjs`; `npm run smoke:e2e`; `lib/runtime-isolation.mjs`. |
| 19 | PASS | Unique port, state directory, browser profile/session, database and schema identifiers are allocated: `node --test tests/runtime-isolation.test.mjs`; `lib/runtime-isolation.mjs`. Database provisioning itself is not claimed. |
| 20 | PASS | Bubblewrap hides host home/auth, `/etc`, env, secrets, network and `.git`; read-only mode cannot mutate: `node --test tests/sandbox.test.mjs`; `scripts/sandbox-run.sh`. |
| 21 | PASS | The exact non-sandboxed set is documented in `docs/security.md`: Pi/controller/model traffic, Git allocation/cleanup, guarded host read/edit/write/search/TS tools, browser/web, and read-only host `git diff --check`. Verification and Worker `safe_exec` are sandboxed. Audit with `node scripts/agent-policy-smoke.mjs`. |
| 22 | PASS | `.env`, credential/key, system, outside-workspace and destructive access are denied in 13 real Pi calls: `node scripts/guardrail-smoke.mjs`; `extensions/safety.ts`. |
| 23 | PASS | Shell indirection is unavailable; fd exec, rg preprocessors, Git external diff/textconv, inline Node/Python, npm exec/dlx and destructive Git are denied: `node scripts/guardrail-smoke.mjs`; `extensions/safe-exec.ts`. |
| 24 | PASS | Complete trace corpus has owner-only modes and metadata keys only: `npm run smoke:trace`; `extensions/metadata-trace.ts`, `lib/jsonl-audit.mjs`. |
| 25 | PASS | Collector calculates real values from actual artifacts/config and reports legitimate zeros when none exist: `npm run observe`; `lib/observability.mjs`. |
| 26 | PASS | Public page fetch through real Pi returns Example Domain text/source: `node scripts/runtime-capabilities.mjs`; package `@juicesharp/rpiv-web-tools@2.9.0`. |
| 27 | PARTIAL | `web_search` is correctly documented and fails clearly without a provider key in `docs/browser-and-web.md`; it was not given a credential and is not operational. This affects discovery of unknown URLs. |
| 28 | PASS | Isolated restore returns the exact original settings bytes and SHA-256: `node scripts/backup-restore-smoke.mjs`; `scripts/restore-backup.mjs`. |
| 29 | PASS | Clean-HOME bootstrap installs/checks all exact Pi/tool pins and creates no auth: `node scripts/bootstrap-smoke.mjs`; `scripts/bootstrap.sh`. |
| 30 | PASS | Active source/config path scan rejects dated Codex paths: `node scripts/validate-package.mjs`; stable path in `~/.pi/agent/settings.json`. Runtime state roots derive from HOME/XDG, not a temporary Codex path. |
| 31 | PASS | Repository scan finds no broken symlinks: `find -L . -type l`; bootstrap/package validation rejects unsafe config links. |
| 32 | PASS | No package source points into a temporary workspace: `node scripts/validate-package.mjs`; `config/settings-patch.json`, active Pi settings. |
| 33 | PASS | All third-party Pi and user-local tool versions are exact in `config/packages.json`; `node scripts/validate-package.mjs`. |
| 34 | PASS | Package manifest has one workflow controller, one optimizer, one trace hook, one safety hook plus non-overlapping safe-exec/semantic/surface helpers; `node scripts/validate-package.mjs` and `npm run typecheck`. Removed `extensions/orchestrator.ts` and broken `config/lsp.json`. |
| 35 | PASS | Static entropy/name scan, trace audit, mission audit, and Git diff inspection find no stored secret values: `node scripts/validate-package.mjs`; `npm run smoke:trace`; `npm run missions:audit`. |
| 36 | PASS | `npm run check` reruns Node tests, syntax, TypeScript and static/package checks. |
| 37 | PASS | Authenticated run `0789657a-a21f-4614-8919-ad88089050b8` completed from a fresh temporary repository with 18 admitted role receipts, independently validated final receipt, cleanup/evidence PASS, and absent worktree/runtime resources. |

Adversarial-check totals: **35 PASS, 2 PARTIAL, 0 FAIL, 0 INTENTIONALLY OMITTED**.

## Architectural weaknesses and residual boundaries

- Pi, trusted extensions, provider calls, browser/web tools, controller Git operations, and guarded host-side file/navigation tools do not run inside Bubblewrap. A malicious extension executes with the user's authority.
- Built-in Pi host file APIs do not expose directory-FD/openat operations. Canonicalization, symlink denial and inode/link checks make trivial escapes fail, but a same-user attacker racing a host read/edit call leaves a narrow TOCTOU boundary.
- Bubblewrap is namespace/mount isolation, not a VM or kernel boundary. `/usr` host executables are visible read-only. Hostile native code, privileged code, production credentials, and untrusted package install scripts require a container/VM or separate low-privilege account.
- Secret hiding recognizes conventional paths/names. An arbitrary secret placed in an ordinary source filename cannot be distinguished from source.
- The Overdrive port registry prevents collisions between its own live allocations, but there is a small external race between checking a free port and the application binding it.
- Database/schema names and state directories are isolated identifiers; the harness does not provision or destroy an actual database.
- A reboot that erases a source repository intentionally created under `/tmp` leaves durable evidence as `INTERRUPTED` but cannot reconstruct the missing repository. Real work must begin in a durable Git checkout.
- Normal successful workflow cleanup releases runtime locks but retains the disposable worktree for human diff review unless explicit destruction is requested. The E2E uses destruction and proves it.
- Running `pi-subagents` manually is not equivalent to the guaranteed controller path. Safety hooks require Worker/Tester isolation, but only `secure_coding_workflow` guarantees the complete review/correction/verification state machine.
- A deterministic test provider is used for browser protocol sequencing; actual Chromium launch, DOM inspection, isolated profile creation and closure are real. The authenticated coding E2E uses routed live models and can legitimately fail within bounded retries; such failure cannot become PASS.
- Running journals retain bounded, redacted role summaries needed for resume. They do not store raw prompts/tool output, but ordinary non-secret code/path prose may remain until terminal compaction/retention.

## Recommendations before autonomous reliance

Use `secure_coding_workflow` rather than manually chaining subagents; start only from clean durable Git repositories; review retained worktree diffs before merging; keep publish/deploy/account mutations human-approved; run hostile code in a container/VM or separate account; configure web search only if needed; and add language-specific semantic adapters only when a real repository justifies their schema/toolchain cost.

Do not replace the official Pi installation or authentication, stack another optimizer/orchestrator/trace extension, loosen the fixed workflow limits, enable network inside autonomous command sandboxes, add automatic long-term recall, or install the currently incompatible MCP adapter. The existing FFF/AST/TypeScript navigation, notebook/handoff, metadata trace, isolated browser, native worktree core, verification exit propagation, exact package pins, backup/restore, and compact tool surface are working well.
