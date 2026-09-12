# Operations

## Paths

- Package: this directory.
- Pi settings: `~/.pi/agent/settings.json`.
- Semantic runtime: `runtime/lsp/` inside the stable Git repository; installed strictly from its lockfile.
- ast-grep CLI runtime: `~/.local/share/pi-overdrive/lsp-node/` (owner-local compatibility path).
- Subagent config: `~/.pi/agent/extensions/subagent/config.json`.
- Browser config: `~/.pi/config/pi-agent-browser-native/config.json`.
- User-local tools: `~/.local/share/pi-overdrive/` with selected links in `~/.local/bin/`.
- Metadata traces: `${XDG_STATE_HOME:-~/.local/state}/pi-overdrive/traces/`.
- Workflow journals and immutable receipts: `${XDG_STATE_HOME:-~/.local/state}/pi-overdrive/workflow-evidence/`.
- Integrated E2E evidence: `${XDG_STATE_HOME:-~/.local/state}/pi-overdrive/e2e-evidence/`.
- Runtime allocations: `${XDG_STATE_HOME:-~/.local/state}/pi-overdrive/runtime/`.
- Subagent mission artifacts: `~/.pi/agent/missions/` (owner-only, secret-pattern redaction, terminal retention 25; audit with `npm run missions:audit`, apply with `node scripts/mission-privacy.mjs --apply`).

Metadata traces, MCP metadata traces, and dated launcher logs have automatic
owner-only retention at session startup. The default is 30 days; set
`PI_OVERDRIVE_TRACE_RETENTION_DAYS` to an integer from 1 to 3650 to override
it. Invalid values disable that cleanup run. Cleanup is flat, bounded, and
never follows symlinks or accepts an arbitrary target directory. Inspect or
apply it manually with `scripts/cleanup-traces.sh --dry-run` or `--apply`.

## Daily Pi startup

`scripts/install-pi-launcher.sh` installs an idempotent Fish function and a
user-local launcher. Typing `pi` serializes startup, starts OmniRoute with its
documented `--headless` flag, waits on `/api/health/ping`, starts only the
existing `pi-overdrive-searxng` container through the restricted passwordless
Docker rule, checks SearXNG on loopback, opens the web dashboard, and finally
replaces the launcher process with the real Pi executable. It never creates a
container or changes provider/authentication files. Re-run the installer after
updating the package; validate the installed copies with:

```bash
scripts/install-pi-launcher.sh --check
```

## Recovery after interruption or power loss

Run `npm run smoke:recovery` to exercise the deterministic SIGKILL/resume control. A normal `secure_coding_workflow` invocation performs recovery automatically: live process identity is checked using Linux boot ID and `/proc` start ticks, stale `RUNNING` work is marked `INTERRUPTED`, and matching work resumes from the last durable structured checkpoint. It cannot become PASS without a valid immutable execution snapshot, successful cleanup verification, a digest-linked receipt, and a terminal `COMPLETED` journal.

Inspect without deleting anything:

```bash
node scripts/worktree-runtime.mjs audit
node scripts/trace-audit.mjs
node scripts/mission-privacy.mjs
```

Temporary test repositories are disposable by design. If a real reboot removes a `/tmp` source repository, the durable journal remains `INTERRUPTED`; the controller fails closed because the source/worktree cannot be reconstructed. Production workflows should start from a durable Git checkout.

## Upgrade protocol

1. Back up Pi config without displaying file contents.
2. Read current official Pi package/settings/security docs and release notes.
3. Query exact package manifests, dates, engines, peer ranges, repository, license, dependencies, and lifecycle scripts.
4. Download tarballs and inspect manifest plus critical execution/config/security code.
5. Update one pin, run package checks and npm audit, launch Pi offline, run a low-cost smoke, then verify browser/multi-language semantics/subagents.
6. Record evidence and limitations. Keep the old backup until several real tasks succeed.

## Optional system packages

The host package manager requires an interactive sudo password, so no privileged install was attempted beyond the failed non-interactive check. If desired, the user can install the missing conveniences in a terminal:

```bash
sudo pacman -S --needed github-cli tree zip
```

`git`, `rg`, `fd`, `jq`, `curl`, `wget`, `unzip`, compilers, Python, Rust, Node, npm, and pnpm were already available. The core Pi setup does not depend on `gh`, `tree`, or `zip`.

## Disable

`scripts/disable.sh` removes the selected package sources and local package reference from active Pi settings and restores unchanged Overdrive-owned defaults. It retains Pi, authentication, caches, browser binaries, language tools, logs, and backups. Remove retained data only after reviewing exact paths and deciding that recovery is no longer needed.
