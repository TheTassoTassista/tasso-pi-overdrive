# Tasso Pi Overdrive

A reversible, pinned Pi 0.85.1 package for high-signal coding work on this Linux machine. It keeps Pi's existing OpenAI Codex authentication intact and adds a mechanically enforced coding workflow, specialized agents, compact search and output, TypeScript semantic navigation, AST tools, browser automation, web fetch, verification, observability, and reusable project templates.

## What changes

- Default interactive model: `openai-codex/gpt-5.6-terra`, medium thinking.
- Role routing: Luna for reconnaissance/testing, Terra for implementation, Sol for planning/review, Astra only for the hardest advisory pass.
- Native compaction remains enabled. A session notebook stores only durable task state; `/handoff <next phase>` distills a clean-session prompt at 85% context.
- Eight agents run with fresh context and enforced tool allowlists. `secure_coding_workflow` owns the isolated worktree and enforces Scout → Planner → Worker → Tester → verification → three reviewers → bounded correction. Concurrency is capped at three, nesting at one level, and scheduled runs are disabled. Version-4 workflow journals survive process death/reboot and resume only from a validated durable checkpoint. Every terminal role attempt has a private immutable receipt that must be durably written and independently revalidated before its state transition is admitted.
- Successful oversized shell output is compacted deterministically; failures remain intact.
- Tool-call guardrails block secret reads, symlink/hard-link escapes, protected writes, all free-form shell, and caller overrides of isolation limits. Autonomous commands use an argument-vector allowlist inside Bubblewrap.
- Traces contain only timestamps, model/tool names, input key names, durations, statuses, and context counts—never prompts, argument values, outputs, URLs, or credentials.

## Install or reproduce

The setup has already been applied on the audited machine. To reproduce it against the same reviewed Pi version:

```bash
./scripts/bootstrap.sh
```

The bootstrap refuses Pi versions other than 0.85.1, backs up Pi configuration first, installs exact package versions, writes owner-only config files, installs pinned user-local language tools, verifies the browser CLI tarball checksum, and downloads an isolated Chromium. It never reads or logs authentication values.

Restart Pi after installation. Then check:

```text
/doctor
/subagents-models
/context-health
```

Shell-level status is available with `./scripts/status.sh`.

## Everyday workflow

1. Start Pi in a Git checkout, not in the home directory.
2. For a new repository run `./scripts/project-init.sh /absolute/repo/path`; existing files are never overwritten.
3. Use the task directly for trivial work. For substantial or autonomous work call `secure_coding_workflow`; its stage order, worktree, models, reviewer loop, and limits cannot be changed by tool input.
4. Use `task_notebook` after a material decision or verified discovery—not after every turn.
5. Use `verification_gate` before a completion claim. Use full mode for release/build/e2e work.
6. At 85% context, finish the phase, update the notebook, and run `/handoff <next phase goal>`.

See [workflow.md](docs/workflow.md), [model-routing.md](docs/model-routing.md), and [verification.md](docs/verification.md) for exact policies.

## Component inventory

The eight agents are `scout`, `planner`, `oracle`, `worker`, `tester`, `correctness-reviewer`, `security-reviewer`, and `simplicity-reviewer`. The 15 progressively disclosed skills cover Python, C++, TypeScript/JavaScript, frontend UI, Electron, Linux, debugging, performance, security, database migrations, tests, code review, research, dependency upgrades, and Git/release work.

Prompt commands are `/bug`, `/feature`, `/refactor`, `/review`, `/security`, `/perf`, `/research`, `/migrate`, `/release`, `/docs`, `/doc-garden`, and `/code-gc`. The last two are read-only maintenance reports; nothing is scheduled in the background.

The installed packages and the reason for every acceptance/rejection are in [package-audit.md](docs/package-audit.md). System findings are in [system-audit.md](docs/system-audit.md).

## Useful commands

| Command/tool | Purpose |
|---|---|
| `/handoff <goal>` | Create an editable clean-session handoff |
| `/notebook` | Show canonical compact task state |
| `/context-health` | Show context pressure and next action |
| `/output-stats` | Show shell-output reductions this session |
| `/trace-path` | Show the current metadata-only JSONL trace |
| `ts_diagnostics`, `ts_definition`, `ts_references` | Pinned TypeScript 6.0.3 semantic navigation |
| `/subagents-models` | Confirm live role-to-model routing |
| `/obs` | Open the observability dashboard |
| `/web-tools` | Opt into a web-search provider; keys are not preconfigured |
| `verification_gate` | Run adaptive repository checks |
| `npm run smoke:recovery` | Prove SIGKILL detection, fail-closed interruption, and deterministic resume |

Prompt templates are available for bug, feature, refactor, review, security, performance, research, migration, release, and documentation work.

## Optional integrations

- `web_fetch` works without credentials. `web_search` fails clearly until you export a provider variable such as `BRAVE_SEARCH_API_KEY` or configure `/web-tools`.
- Browser work uses an isolated Chromium by default. Do not attach a personal profile unless the task explicitly needs signed-in state and you accept that visible page data becomes model-visible.
- MCP is intentionally not active: the current adapter's declared Pi peer range excludes 0.85.1. A hardened empty reference config is in `config/mcp.example.json`; revisit only after a compatible release is vetted.
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
- Run `npm run check`, `npm run benchmark`, the local smoke harness, and one low-cost Pi smoke after an upgrade.
- Preview metadata-trace cleanup with `./scripts/cleanup-traces.sh`; deletion requires `--apply`.
- Never run `pi update --all` blindly: exact npm pins are deliberate compatibility boundaries.

The audit, accepted/rejected package rationale, and residual limitations are in [package-audit.md](docs/package-audit.md) and [security.md](docs/security.md).

## Daily-use cheat sheet

1. Start `pi` from a trusted Git checkout.
2. Use `/feature <goal>` or `/bug <symptom>` for disciplined work.
3. Use `secure_coding_workflow` for substantial autonomous changes; it launches the appropriate roles itself.
4. Ask `scout` or `planner` directly only for read-only exploratory work.
5. Run `scripts/worktree-new.sh BRANCH [BASE_REF]` only for a manual isolated experiment.
6. Use `task_notebook` after a durable decision or verified discovery.
7. Run `verification_gate` before any completion claim.
8. Run `/context-health`; at 85% use `/handoff <next goal>`.
9. Use `/obs`, `/output-stats`, and `/trace-path` for cost/latency/tool evidence.
10. Run `scripts/status.sh` after upgrades; follow [operations.md](docs/operations.md) rather than updating pins blindly.

For problems, see [troubleshooting.md](docs/troubleshooting.md). Test and benchmark evidence is in [benchmark-results.md](docs/benchmark-results.md).
