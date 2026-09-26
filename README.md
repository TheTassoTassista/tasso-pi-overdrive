# Tasso Pi Overdrive

A reversible, pinned Pi 0.87.1 package for high-signal coding work on this Linux machine. It keeps Pi's existing OpenAI Codex authentication intact and adds a mechanically enforced coding workflow, specialized agents, one compact lazy MCP proxy, compact search and output, lazy multi-language semantic navigation, AST tools, browser automation, web fetch, verification, observability, a fail-soft Second Brain, and reusable project templates.

## What changes

- Default interactive model: `openai-codex/gpt-5.6-terra`, medium thinking.
- Persistent routing presets: `normal` (default) and `token-saver`; session quality: `auto` (default), `low`, `medium`, `high`, or `max`. `/ai-tree` shows every exact route and fallback without a model call.
- Normal direct targets use GPT-6 Luna low for Scout, GPT-6 Sol medium for Planner/Worker/correctness, Sol high for security, and GPT-6 Astra high for Oracle/Judge. OmniRoute diversity remains conditional on independently verified callability and zero-extra-cost evidence.
- Native compaction remains enabled. A session notebook stores only durable task state; `/handoff <next phase>` distills a clean-session prompt at 85% context.
- Twelve role profiles run with fresh context and enforced tool allowlists: the original eight workflow roles plus three independent council members and a judge. Workflow version 5 uses the minimum justified roles, deterministic verification before AI interpretation, and bounded escalation/correction in one canonical `git-worktree-v2` allocation. Concurrency is capped at three, nesting at one level, and scheduled runs are disabled. Journals survive process death/reboot and resume only from a validated durable checkpoint. Every terminal role attempt has a private immutable receipt that must be durably written and independently revalidated before its state transition is admitted.
- Successful oversized shell output is compacted deterministically; failures remain intact.
- Tool-call guardrails block secret reads, symlink/hard-link escapes, protected writes, all free-form shell, and caller overrides of isolation limits. Autonomous commands use an argument-vector allowlist inside Bubblewrap.
- Traces contain only timestamps, routing/model/tool metadata, input key names, durations, statuses, counts and policy digests—never prompts, argument values, outputs, URLs or credentials.
- The Second Brain conditionally routes project context to OpenViking, temporal history to Hindsight, and reusable working lessons to an ACE-style playbook. One compact untrusted Shared Memory Pack is reused across workflow roles; unavailable memory never blocks Pi.

## Install or reproduce

The setup has already been applied on the audited machine. To reproduce it against the same reviewed Pi version:

```bash
./scripts/bootstrap.sh
```

The bootstrap refuses Pi versions other than 0.87.1, backs up Pi configuration first, installs exact package versions and lockfile-backed LSP and Second Brain Python runtimes, writes owner-only config files, installs pinned user-local language tools, verifies browser and embedding-model checksums, and downloads an isolated Chromium. It never reads or logs authentication values.

Restart Pi after installation. Then check:

```text
/doctor
/subagents-models
/context-health
/memory
```

Optional ACP editor integration can be started with `npm run editor:bridge -- --cwd /absolute/project`. It binds one project/session, asks `allow_once` for each governed mutation, and keeps the existing Pi auth, routing and security hooks. See [Phase 21 editor bridge](docs/implementation-notes/phase-21-editor-bridge.md).

Shell-level status is available with `./scripts/status.sh`.

## Everyday workflow

1. Start Pi in a Git checkout, not in the home directory.
2. For a new repository run `./scripts/project-init.sh /absolute/repo/path`; existing files are never overwritten.
3. Keep `/preset normal` and `/quality auto` for the recommended default. Use `/preset token-saver` when quota matters, and inspect `/ai-tree` before important work.
4. For substantial or autonomous work call `secure_coding_workflow`; its adaptive role path, worktree, models, reviewer loop and limits cannot be changed by tool input.
5. Use `task_notebook` after a material decision or verified discovery—not after every turn.
6. Use `verification_gate` before a completion claim. Use full mode for release/build/e2e work.
7. At 85% context, finish the phase, update the notebook, and run `/handoff <next phase goal>`.

See [workflow.md](docs/workflow.md), [model-routing.md](docs/model-routing.md), [second-brain.md](docs/second-brain.md), and [verification.md](docs/verification.md) for exact policies.

## Component inventory

The core agents are `scout`, `planner`, `oracle`, `worker`, `tester`, `correctness-reviewer`, `security-reviewer`, and `simplicity-reviewer`; difficult/high-risk escalation adds `council-1`, `council-2`, `council-3`, and `council-judge`. The 15 progressively disclosed skills cover Python, C++, TypeScript/JavaScript, frontend UI, Electron, Linux, debugging, performance, security, database migrations, tests, code review, research, dependency upgrades, and Git/release work.

Prompt commands are `/bug`, `/feature`, `/refactor`, `/review`, `/security`, `/perf`, `/research`, `/migrate`, `/release`, `/docs`, `/doc-garden`, and `/code-gc`. The last two are read-only maintenance reports; nothing is scheduled in the background.

The installed packages and the reason for every acceptance/rejection are in [package-audit.md](docs/package-audit.md). System findings are in [system-audit.md](docs/system-audit.md).

## Useful commands

| Command/tool | Purpose |
|---|---|
| `/handoff <goal>` | Create an editable clean-session handoff |
| `/notebook` | Show canonical compact task state |
| `/context-health` | Show context pressure and next action |
| `/rules` | Show bounded project-rule precedence, limits, and digest-cache counters without a model call |
| `/output-stats` | Show shell-output reductions this session |
| `/stream-guard` | Show metadata-only streamed correction counters without a model call |
| `/sentinel [status\|TASK]` | Inspect Sentinel locally or request one bounded read-only second opinion for a hard debugging task |
| `/agents` | Show the current secure-workflow roster, lifecycle, route, and receipt-backed usage without agent content or a model call |
| `/director TASK` | Run one non-trivial policy-eligible task with the primary agent restricted to read/plan/delegate/verify and all repository mutation routed through the secure workflow |
| `/trace-path` | Show the current metadata-only JSONL trace |
| `/memory` / `/memory-status` | Show compact/detailed fail-soft memory state |
| `/memory-search QUERY` | Search curated/OpenViking/Hindsight/ACE context without a Pi model call |
| `/memory-recent` / `/memory-why ID` | Inspect accepted memories and provenance |
| `mcp` | Lazy proxy for the two read-only Context7 documentation tools |
| `/web-status` | Show Brave/Perplexity routing and credential presence without keys |
| `web_research` | Observable Brave-first search, Perplexity fallback, or explicit cross-check |
| `safe_web_fetch` | Fetch a known public text URL through the bounded network runner |
| `semantic_nav` | Lazy project-aware diagnostics, definition, references, hover, symbols, and read-only rename preview |
| `/lsp-status` | Show server availability, pins, process cap, and isolation policy |
| `/models` | List real available models and credential-free provider status |
| `/preset [normal\|token-saver]` | Show or persist the economic/routing strategy |
| `/quality [auto\|low\|medium\|high\|max]` | Show or set this session's quality authorization |
| `/ai-tree [--json]` | Render exact roles, efforts, fallbacks and callability with zero model calls |
| `/model-routing` | Show the active role map and policy receipt |
| `/model-role` / `/model-preset` | Compatibility controls for exact role overrides and preset preview |
| `/council <task>` | Run the existing enforced workflow with high-risk council escalation |
| `/council-status` | Show council routes, escalation policy, independence, and hard limits |
| `/subagents-models` | Confirm live role-to-model routing |
| `/obs` | Open the observability dashboard |
| `/web-tools` | Opt into a web-search provider; keys are not preconfigured |
| `verification_gate` | Run adaptive repository checks |
| `npm run smoke:recovery` | Prove SIGKILL detection, fail-closed interruption, and deterministic resume |

Prompt templates are available for bug, feature, refactor, review, security, performance, research, migration, release, and documentation work.

## Optional integrations

- `web_fetch` remains compatible and works without credentials. Prefer `safe_web_fetch` for bounded DNS-pinned retrieval and `web_research` for observable Brave-primary/Perplexity-secondary routing. Search requires the relevant provider key through the environment or `/web-tools`; `/web-status` never displays it.
- Browser work uses an isolated Chromium by default. Do not attach a personal profile unless the task explicitly needs signed-in state and you accept that visible page data becomes model-visible.
- OpenViking and Hindsight run as lazy user-level loopback services with one pinned multilingual CPU embedder. They remain fail-soft startup dependencies: no auto-capture, transcript retention, compaction takeover, remote VLM, or hidden provider call. Run `npm run setup:memory` for the vault and `scripts/setup-second-brain-services.sh --install` for the local services. See [second-brain.md](docs/second-brain.md).
- MCP uses the audited upstream adapter commit that adds Pi 0.85 compatibility. It exposes one lazy proxy and only two read-only Context7 documentation operations; direct tools, resources, script mode, sampling, elicitation, and host-config discovery are disabled. See [mcp.md](docs/mcp.md).
- Semantic navigation exposes one non-default tool instead of per-language schemas. TypeScript/JavaScript, Python, C/C++, HTML, CSS, JSON, YAML, and Bash servers are pinned or system-version-bound; every server starts lazily in a read-only, no-network Bubblewrap sandbox. Rust, Go, Java, Lua, and Ruby are detected and return `PARTIAL` until a reviewed pinned server is added. See [lsp.md](docs/lsp.md).
- `scripts/sandbox-run.sh ROOT -- COMMAND` runs a command with Bubblewrap process, mount, home, temporary-directory, credential-file, Git-metadata, system-config, and network isolation. It has no network-enabled mode. See [sandbox.md](docs/sandbox.md).
- GitHub CLI, `tree`, and `zip` could not be installed because this host requires an interactive sudo password. Their absence does not block the core setup; the exact optional command is recorded in [operations.md](docs/operations.md).

## Disable and recovery

Disable all Overdrive package sources and restore the recorded pre-install defaults without uninstalling Pi or deleting package caches:

```bash
./scripts/disable.sh
```

The script restores a setting only when it still equals the applied Overdrive value, so later user changes are not silently overwritten. Configuration backups are documented in [implementation-log.md](implementation-log.md). For manual recovery, stop Pi, copy the desired backed-up `settings.json` into `~/.pi/agent/settings.json`, preserve its mode, and restart Pi. Authentication files do not need restoration because this setup never changed them.

## Maintenance

- Review release notes and peer ranges before changing Pi or package pins.
- Run `npm run check`, `npm run benchmark`, `npm run benchmark:context`, the local smoke harness, and one explicitly approved authenticated Pi smoke after an upgrade. Context measurement is deterministic and free by default; `npm run benchmark:context -- --live` intentionally makes seven provider calls.
- Preview metadata-trace cleanup with `./scripts/cleanup-traces.sh`; deletion requires `--apply`.
- Never run `pi update --all` blindly: exact npm pins are deliberate compatibility boundaries.

The audit, accepted/rejected package rationale, and residual limitations are in [package-audit.md](docs/package-audit.md) and [security.md](docs/security.md).

## Daily-use cheat sheet

1. Start `pi` from a trusted Git checkout.
2. Use `/feature <goal>` or `/bug <symptom>` for disciplined work.
3. Use `/preset normal` plus `/quality auto` by default; `/preset token-saver` reduces model quota and `/quality` resets to auto in a new session.
4. Use `/ai-tree` to inspect exact routes, then `secure_coding_workflow` for substantial autonomous changes; it launches only the justified roles.
5. Ask `scout` or `planner` directly only for read-only exploratory work.
6. Before any delegated model call, the enforced workflow verifies the derived spawn budget (39 base + 3 bounded retry reserve = configured limit 42); `/council-status` displays all three values.
7. Run `scripts/worktree-new.sh BRANCH [BASE_REF]` only for a manual isolated experiment.
8. Use `task_notebook` after a durable decision or verified discovery.
9. Run `verification_gate` before any completion claim.
10. Run `/context-health`; at 85% use `/handoff <next goal>`.
11. Use `/obs`, `/output-stats`, and `/trace-path` for cost/latency/tool evidence.
12. Run `scripts/status.sh` after upgrades; follow [operations.md](docs/operations.md) rather than updating pins blindly.

For problems, see [troubleshooting.md](docs/troubleshooting.md). Test and benchmark evidence is in [benchmark-results.md](docs/benchmark-results.md).
