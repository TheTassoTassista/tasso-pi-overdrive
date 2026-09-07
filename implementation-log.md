# Implementation log

## 2026-09-07 — audit and backup

- Detected CachyOS, Fish, official Pi 0.85.1 with dedicated Node 22.23.2, OpenAI Codex provider, available model catalog, development tools, language servers, browser state, Git context, disk space, and missing optional tools.
- Created pre-change settings backups at `/home/tasso/Documents/Codex/pi-overdrive-backups/20260907-130032` and `/home/tasso/Documents/Codex/pi-overdrive-backups/20260907-140520`, with owner-only directories and original file mode retained.
- Initial backup logic also duplicated authentication/catalog files. Their hashes were verified against the unchanged originals and the four redundant copies were then removed to honor the no-credential-copy rule. Only configuration backups remain; originals were not deleted or changed.

## Official source and package review

- Cloned official Pi tag v0.85.1 at commit `d981de1229ef899957bbe968bc8dcda02a21f477` and reviewed current package, settings, extension, skill, prompt, security, compaction, session, SDK/RPC, and custom-tool documentation/source.
- Downloaded candidate npm tarballs into the local audit workspace and inspected manifests, engines, peer ranges, lifecycle scripts, repositories, licenses, dependencies, config discovery, credential handling, output behavior, and critical execution paths.
- Installed eight exact third-party pins and the local personal package. Every selected package install reported zero npm audit vulnerabilities. Rejections are recorded in `docs/package-audit.md`.

## Configuration and custom package

- Routed the supervisor to Terra; discovery/testing to Luna; planning and correctness/security review to Sol; and rare oracle work to Astra. Enforced provider/model scope and phase-boundary switching.
- Kept native compaction, added a bounded notebook/handoff lifecycle, successful-output-only compaction, adaptive verification, context thresholds, metadata-only trace, and deterministic safety hooks.
- Added eight fresh-context agent roles, 15 skills, 12 prompt commands, project documentation/spec templates, native worktree/runtime-isolation helpers, a Bubblewrap command sandbox, benchmark definitions, operations docs, and reversible enable/disable tooling.
- Configured FFF, LSP, ast-grep, subagents, web tools, structured questions, browser automation, and one observability extension. MCP remained inactive because the vetted adapter's peer range excludes Pi 0.85.1.

## Installation and fixes

- Installed pinned user-local language tooling and ast-grep. Corrected VTSLS discovery from an unexpanded tilde command to a PATH-resolved system command; targeted LSP then returned 48 symbols.
- Installed agent-browser 0.36.0 from the exact npm tarball after verifying its SHA-512 digest; installed isolated Chrome for Testing 152.0.7977.82.
- Foreground subagents do not inherit parent extension discovery, so every role received explicit provider extensions. Removed an unavailable FFF multi-grep tool from role allowlists; scout then launched successfully.
- Added a TypeScript API check against the installed Pi peer packages and fixed strict/exact-optional type issues. The complete local package check now passes.

## Verification evidence

- `npm run check`: PASS (unit tests, extension TypeScript, structure/config/pin policy).
- `npm run benchmark`: PASS; 97.12% character reduction, diagnostics retained, 9.511 ms mean over 100 iterations.
- `node scripts/local-smoke.mjs`: PASS; Git, rg, fd, AST and worktree operations; temporary repository removed.
- Targeted Pi probes: FFF PASS, notebook PASS, verification gate PASS, AST PASS, LSP PASS, scout subagent PASS.
- Browser doctor: 9 PASS, 0 WARN, 0 FAIL. Public DOM/screenshot interaction and clean close passed.
- Metadata trace: owner-only and value-free. Guardrail unit tests block secret paths, protected writes, sibling-prefix escapes, destructive Git, and download-to-shell patterns.
- Final temporary-repository workflow: PASS for scout, planner, correctness reviewer, worker, tester, real failing-then-passing test, diff check, guardrail, private/value-free trace, and cleanup.
- RPC handoff smoke: PASS; the verified marker survived distillation, the new editor was prefilled, and the clean session contained zero messages.
- RPC catalog: PASS for all 15 custom skills and 12 custom prompt commands. Credential-free `web_fetch` against a public test page returned PASS.

No project, credential, shell, desktop, browser profile, or existing Pi session was removed. No cron or background maintenance job was created.
