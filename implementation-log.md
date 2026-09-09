# Implementation log

## 2026-09-07 — audit and backup

- Detected CachyOS, Fish, official Pi 0.85.1 with dedicated Node 22.23.2, OpenAI Codex provider, available model catalog, development tools, language servers, browser state, Git context, disk space, and missing optional tools.
- Created pre-change settings backups at `/home/tasso/Documents/Codex/pi-overdrive-backups/20260907-130032` and `/home/tasso/Documents/Codex/pi-overdrive-backups/20260907-140520`, with owner-only directories and original file mode retained.
- Initial backup logic also duplicated authentication/catalog files. Their hashes were verified against the unchanged originals and the four redundant copies were then removed to honor the no-credential-copy rule. Only configuration backups remain; originals were not deleted or changed.

## Official source and package review

- Cloned official Pi tag v0.85.1 at commit `d981de1229ef899957bbe968bc8dcda02a21f477` and reviewed current package, settings, extension, skill, prompt, security, compaction, session, SDK/RPC, and custom-tool documentation/source.
- Downloaded candidate npm tarballs into the local audit workspace and inspected manifests, engines, peer ranges, lifecycle scripts, repositories, licenses, dependencies, config discovery, credential handling, output behavior, and critical execution paths.
- Installed seven exact third-party pins and the local personal package. Every selected package install reported zero npm audit vulnerabilities. Rejections are recorded in `docs/package-audit.md`.

## Configuration and custom package

- Routed the supervisor to Terra; discovery/testing to Luna; planning and correctness/security review to Sol; and rare oracle work to Astra. Enforced provider/model scope and phase-boundary switching.
- Kept native compaction, added a bounded notebook/handoff lifecycle, successful-output-only compaction, adaptive verification, context thresholds, metadata-only trace, and deterministic safety hooks.
- Added eight fresh-context agent roles, 15 skills, 12 prompt commands, project documentation/spec templates, native worktree/runtime-isolation helpers, a Bubblewrap command sandbox, benchmark definitions, operations docs, and reversible enable/disable tooling.
- Initially configured FFF, an LSP adapter, ast-grep, subagents, web tools, structured questions, browser automation, and one observability extension. The adapter was later removed after adversarial runtime failure. MCP remained inactive because the vetted adapter's peer range excludes Pi 0.85.1.

## Installation and fixes

- Installed pinned user-local language tooling and ast-grep. An early VTSLS symbol probe returned data, but this did not prove diagnostics/definitions/references and was later invalidated as completion evidence.
- Installed agent-browser 0.36.0 from the exact npm tarball after verifying its SHA-512 digest; installed isolated Chrome for Testing 152.0.7977.82.
- Foreground subagents do not inherit parent extension discovery, so every role received explicit provider extensions. Removed an unavailable FFF multi-grep tool from role allowlists; scout then launched successfully.
- Added a TypeScript API check against the installed Pi peer packages and fixed strict/exact-optional type issues. The complete local package check now passes.

## 2026-09-07 historical verification claims (superseded)

- The original check, optimizer, search, browser, handoff, catalog, and fetch probes were useful discovery data but are not current completion evidence.
- The original LSP probe tested symbols only and did not prove diagnostics, definition, or references.
- The original temporary-repository workflow used loose evidence matching and could falsely credit missing agent execution.
- Current independently rerun results are recorded only in `docs/benchmark-results.md` and `docs/final-adversarial-audit.md`.

No project, credential, shell, desktop, browser profile, or existing Pi session was removed. No cron or background maintenance job was created.

## 2026-09-08 — adversarial remediation

- Moved the authoritative Git-tracked package to `/home/tasso/Documents/Codex/tasso-pi-overdrive`, updated active Pi settings, and proved that no active source points at the dated Codex output. The old output remains only as an inactive backup.
- Replaced prompt-only orchestration with `secure_coding_workflow`: hardcoded concurrency three/depth one, fixed role/model/thinking routing, isolated runtime allocation, mandatory Tester/verification/three-reviewer rounds, and at most two correction iterations.
- Replaced the broken LSP adapter with pinned TypeScript LanguageService tools and runtime-proved TS2322 diagnostics, definition resolution, and four references on a fresh fixture.
- Replaced the shell blacklist with no free-form shell plus `safe_exec` argument vectors inside Bubblewrap. Added canonical symlink/hard-link guards and a device/inode-checked single-file deletion tool. Bubblewrap now hides repository credential paths, `.git`, host home, system `/etc`, inherited environment secrets, and network.
- Fixed Pi error propagation in `safe_exec` and `verification_gate`; exit 7 and NO_CHECKS now produce true tool errors. Critical optimizer lines are uncapped and retained in first/middle/late/last positions.
- Added unique port/state/profile/database/schema allocations, mission retention/redaction, lightweight app-evidence collection, structured findings, clean-HOME bootstrap/restore smokes, and a six-tool fresh-session surface limiter.
- Rebuilt E2E evidence as two immutable owner-only files: execution snapshot before cleanup and digest-linked final receipt after cleanup. Missing, malformed, foreign, stale/tampered evidence fails closed. The E2E includes a persistent-verification negative control.
- The former 2026-09-07 integrated-workflow/LSP PASS claims were treated as untrusted and superseded by `docs/benchmark-results.md` and `docs/final-adversarial-audit.md`.

## 2026-09-08 — power-loss recovery and final controls

- Recovered after an unexpected host power loss without crediting the interrupted workflow. Git contained the complete uncommitted remediation, active Pi settings still referenced only the permanent package, `/tmp` had been cleared, no Overdrive worktree/port/browser allocation survived, and the last durable role rows showed Scout and Planner completion but no structured workflow receipt. The run was classified `INTERRUPTED`, never PASS.
- Added fsynced, atomically replaced workflow journals with Linux boot/PID-start identity, structured checkpoints, redacted resumable state, explicit lifecycle states, stale-runtime recovery, immutable execution snapshots, and digest-linked final receipts.
- Added an actual SIGKILL control immediately after `CORRECTION_REQUIRED`. Recovery preserved completed Scout/Planner/initial Worker work, resumed correction/Tester/verification/review exactly once, and reached `COMPLETED` only after cleanup and receipt validation.
- Expanded the integrated test with fail-closed controls for persistent verification failure, missing roles/reviewers/correction, false PASS with a nonzero process exit, wrong run ID, stale task evidence, missing/malformed evidence, and interruption before finalization.
- Hardened read-only Bubblewrap bindings, executable-hook environment variables, Git external helpers, JSONL crash tails, mission retention/redaction, TypeScript workspace containment, backup/restore atomicity, and deterministic isolated Chromium testing.

## 2026-09-09 — deterministic role receipts and final authenticated proof

- Independently reconstructed the apparent pre-Planner failure. Scout had completed and Planner had actually been admitted, but both Planner attempts returned only `planner failed: failed`; the old controller discarded the package/provider error field and created no immutable per-attempt receipt, so the underlying failure was not reconstructable from durable evidence.
- Added version-4 per-role immutable receipts bound to run, task, protocol nonce, role, round, iteration, attempt, node and owner. Receipts use controller sequence numbers, UUID execution IDs, private temporary writes, file and parent-directory sync, no-replace publication, digest validation, exactly-once admission, and fail-closed stale/cross-run/cross-task/order checks.
- Added deterministic receipt/journal tests, including competing process writers and 100 repeated real-controller Scout → Planner transitions. State transitions now occur only after the controller reopens and independently admits the durable receipt.
- Receipt evidence exposed a second independent issue: `pi-subagents` intercom mode `always` detached a Worker after it mutated the worktree, while the synchronous controller treated that as retryable. Disabled the competing intercom bridge, made failed-after-mutation Worker attempts non-retryable, backed up the prior active subagent config at `/home/tasso/Documents/Codex/pi-overdrive-backups/20260909-023336-intercom-fix/subagents-config.json`, and added a static invariant preventing re-enablement.
- Fresh authenticated run `0789657a-a21f-4614-8919-ad88089050b8` completed workflow v4 with 18 immutable role receipts, three Worker/Tester/reviewer rounds, a mandatory planted blocker and correction, final verification/review PASS, cleanup PASS, evidence PASS, and no surviving worktree/runtime allocation. All negative controls failed closed.

## 2026-09-09 — model policy, council, and final integration

- Added user-owned persistent role policy for twelve roles, live registry discovery, exact provider/model/thinking validation, deterministic budget/efficient/balanced/max-quality/custom presets, read-only preset previews, and isolated runtime proofs for persistence/reload/reset without reading or changing auth values.
- Added three independent read-only council members plus a separate Judge inside the existing workflow controller. The fixed fanout/depth/correction limits remain 3/1/2; missing/malformed/early results and caller overrides fail closed. A protected `/council TASK` command now enters that controller and has tested precedence over the upstream raw prompt.
- Added route-policy binding to immutable receipts and resumable state. The first post-expansion authenticated run, `c8e1d5ac-4f17-4fd4-a4fa-336de3c0fad9`, exposed that pi-subagents reports `provider/model:thinking` while the initial validator expected a separate unsuffixed model field. Both real Scout children completed, but the controller rejected them and finalized FAIL before admission.
- Corrected the incompatibility with strict suffix canonicalization: only the separately attested thinking suffix is accepted, while provider/model/thinking mismatch becomes a durable `protocol_rejected` receipt. Every terminal attempt now receives durable evidence; a route-policy resume bug was also corrected and covered by tamper tests.
- Replaced routine paid capability/context checks with deterministic local Pi providers. The final package suite passes 77/77; real FFF/AST/LSP/web/browser/MCP/catalog/agent/model/council/bootstrap/guardrail/verification/restore smokes pass. The requested post-fix authenticated E2E was not rerun because execution approval rejected another paid run; current integrated status remains PARTIAL until explicit user authorization.
