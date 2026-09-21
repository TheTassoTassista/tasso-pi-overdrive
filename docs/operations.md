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
- Session-scoped Artifact Store: `${XDG_STATE_HOME:-~/.local/state}/pi-overdrive/artifacts/` (owner-only, content-addressed, sanitized, default retention seven days).
- Session-scoped Edit Engine receipts: `${XDG_STATE_HOME:-~/.local/state}/pi-overdrive/edit-receipts/` (owner-only scope directories; immutable mode-0400 metadata receipts; no source path or body).
- Debug adapter policy: `config/dap-engine.json` (Linux-x64 GNU GDB 17.2, exact path/version/arguments/SHA-256; adapter and debuggee run in one read-only networkless Bubblewrap sandbox).
- Persistent eval policy: `config/eval-engine.json` (exact Linux-x64 Python 3.14.7 and Node 26.8.1 paths/versions/arguments/SHA-256; private project-free networkless Bubblewrap kernels).
- Subagent mission artifacts: `~/.pi/agent/missions/` (owner-only, secret-pattern redaction, terminal retention 25; audit with `npm run missions:audit`, apply with `node scripts/mission-privacy.mjs --apply`).
- Second Brain ledger/ACE/vault: `${XDG_DATA_HOME:-~/.local/share}/pi-overdrive/second-brain/`.
- Second Brain service runtimes/state: `${XDG_DATA_HOME:-~/.local/share}/pi-overdrive/services/`; user units live under `${XDG_CONFIG_HOME:-~/.config}/systemd/user/`. Their complete Python dependency graphs are tracked in deterministic lock files, and the embedding snapshot is revision- and checksum-pinned. Embeddings/OpenViking/Hindsight bind only `127.0.0.1:1934`, `:1933`, and `:8889`.

Metadata traces, MCP metadata traces, and dated launcher logs have automatic
owner-only retention at session startup. The default is 30 days; set
`PI_OVERDRIVE_TRACE_RETENTION_DAYS` to an integer from 1 to 3650 to override
it. Invalid values disable that cleanup run. Cleanup is flat, bounded, and
never follows symlinks or accepts an arbitrary target directory. Inspect or
apply it manually with `scripts/cleanup-traces.sh --dry-run` or `--apply`.

Artifact retention is intentionally separate. Pi runs a bounded expiry/orphan pass at session startup. Preview it with `npm run artifacts:retention`; apply only after reviewing the summary with `node scripts/artifact-retention.mjs --apply`. `/artifacts` shows current-session manifest metadata and counters without a model call. Reopen a reported `artifact://<sha256>` through `resource_fs` using a bounded line range or literal search; artifact IDs never map to arbitrary paths and do not cross session/workspace scope.

The Context Governor runs automatically as the final extension before every normal provider request and inside each fresh subagent. Use `/context-fit` for a zero-model-call report of the active provider/model window, reserved output/safety budget, component estimates, and applied reductions. A BLOCKED report means the latest request was not sent; compact or hand off the session, or explicitly choose a route already allowed by policy with a large enough context window. The governor never changes routing automatically. `/handoff` performs the same fit check before its direct distillation request.

Edit Engine V2 runs automatically for exact read-bound changes. Read the exact target range, use `transactional_edit` preview, inspect `READY` or `SAFE_RECOVERY`, then apply the returned transaction. `STALE_EDIT` requires a fresh exact read; do not reuse or guess the old anchor. `/edit-engine` reports current snapshot/transaction/receipt counters without a model call. Pi's built-in exact editor remains a separately governed fallback.

For one bounded structural rewrite, read every target range first, call `transactional_ast_edit` preview with the snapshot ID and exact expected match count, inspect every hunk, then apply only its transaction ID. The pinned ast-grep binary is validated lazily and operates on a private snapshot copy; it never rewrites the live target directly. Any mismatch or source change requires a new read/preview. `/ast-edit` checks the runtime and reports local counters without a model call. The plugin `ast_grep_rewrite` is retained only as the governed fallback.

The LSP write guard runs automatically inside both transactional paths. Preview compares baseline diagnostics with an overlay of the exact candidate bytes; apply checks the real final filesystem before publishing its receipt. A new error is denied before mutation, while a post-write mismatch triggers conflict-safe rollback. Existing unchanged errors do not block unrelated work. Unsupported file types follow the explicit fail-soft policy; a configured managed server that is missing, unpinned, or crashes fails the guarded transaction closed. Use `/lsp-write` for zero-model counters. Multi-file rename and file moves remain preview-only/not implemented; the language server never receives write authority.

The Debug Engine appears only for a task with debugging intent. Call `debug_engine` with `launch` for one existing workspace-relative executable, add a source breakpoint while the session is `CONFIGURING`, then `continue` to finish configuration. Use returned frame and variable references for bounded stack/scope/variable inspection, and always call `terminate` when finished. Timeouts and protocol errors also terminate the process group. `/debug-engine` reports the lazy local policy/session status without starting GDB or making a model call. Attach, arbitrary debugger commands/requests, expression evaluation, memory operations, remote targets, other adapters, and multiple sessions are intentionally unavailable.

Persistent eval appears only for calculation, parsing, bounded experiment, data/AST transformation, or reproduction intent. Use `persistent_python` or `persistent_javascript` with `execute`; JavaScript accepts `dialect: "typescript"` for transpile-only TypeScript. State is retained only inside that Pi session and language kernel. Use `reset` to discard state and `terminate` when done; timeout, crash, five-minute idle expiry, and Pi shutdown also destroy the kernel. `/eval-engine` reports policy/session metadata without starting either runtime or making a model call.

Eval has no project workspace, user home, network, ResourceFS/tool, shell, or subprocess bridge. Read repository or artifact evidence through normal governed tools and pass only the required data into the cell. Python imports and risky builtins and JavaScript host globals/string code generation are restricted as defense in depth; Bubblewrap isolation and the absent project/user mounts are the security boundary. Output is capped at 256 KiB before Artifact Store processing, so artifacts retain the bounded full result rather than bytes beyond that cap. JavaScript is synchronous, TypeScript is transpile-only, and package installation, top-level await, timers, rich display/image output, and filesystem persistence are intentionally unavailable.

StreamGuard runs automatically and exposes no model tool. It recognizes only the reviewed controller-owned rule set while complete tool arguments are streaming, persists a metadata-only reservation, and waits for the normal governing safety decision. If safety independently blocks the same session/tool call, the concise correction is placed in that same blocked result; otherwise the reservation expires. It never retries, aborts, schedules a timer, queues a prompt, starts a runtime, or adds a model call. Use `/stream-guard` to inspect local reservation/delivery/expiry counters. A missing or failed StreamGuard leaves the safety barrier unchanged.

Sentinel is explicit and optional. Use `/sentinel status` to inspect its local one-call budget without inference. Use `/sentinel TASK` only for hard/critical debugging work; the Task Governor rejects other tasks before any provider call. A successful invocation reuses the current policy's Oracle route, runs once with no tools and no retry, and appends one visibly untrusted advisory message without starting another agent turn. The reservation consumes the session budget even if the call fails. Missing price metadata, context overflow, an unavailable route, invalid JSON, a tool call, timeout, route/thinking mismatch, or cost excess fails closed and leaves the ordinary Pi workflow unchanged. Start a genuinely new Pi session for a new Sentinel budget; do not edit session receipts.

Agent Hub is a read-only projection of the active secure workflow. Use `/agents` to inspect its compact role roster, lifecycle, route, hard limits, and receipt-backed aggregate usage without starting a provider turn. A role is shown as reserved or running only after controller-owned correlation events; terminal status and accounting appear only after the immutable role receipt has been durably written. Missing or in-flight usage is `UNAVAILABLE`, never synthetic zero. The Hub carries no prompt, transcript, tool input/output, reasoning, file content, or Council-member result, and exposes no steer, cancel, revive, spawn, model-call, or mutation operation. Invalid metadata degrades only the view; it cannot stop or alter the workflow. The projection is session-local and covers secure-workflow roles rather than arbitrary direct subagent jobs.

Director Mode is an explicit one-task entry point, not a persistent autonomy preset. Run `/director TASK` only for a non-trivial mutating task; the deterministic Task Governor rejects read-only requests, direct small edits, and work without justified Planner/reviewer/Council value before any provider call. During the task, the primary agent receives a bounded read/plan/delegate/verify surface and must route every repository mutation through `secure_coding_workflow`. A separate runtime allowlist blocks direct edit/write, shell, `safe_exec`, raw subagents, browser mutation, and unknown tools even if another extension exposes one late. The existing workflow still owns routing, worktree/runtime isolation, the 42-attempt budget, concurrency 3, depth 1, two correction rounds, role receipts, verification, reviewers, Council/Judge, evidence, and cleanup. The prior tool surface is restored on `agent_settled`; `/director status` and a policy denial make no model call. There is no direct-mutation fallback.

Workflow isolation uses one canonical `git-worktree-v2` allocation. Its worktree and runtime roots must be private, non-symlinked, mutually independent, and outside the clean source repository. The allocation record binds the exact branch, worktree, state directory, browser profile, port lock, database identifier, schema identifier, and PID/boot/start-time owner. `list`, lookup, resume, release, recovery, and cleanup reject a mismatched or symlinked record instead of acting on an untrusted path. Reflink/copy and overlay mounts are not fallback backends.

## Daily Pi startup

`scripts/install-pi-launcher.sh` installs an idempotent Fish function and a
user-local launcher. Typing `pi` serializes startup, starts OmniRoute with its
documented `--headless` flag, waits on `/api/health/ping`, starts only the
existing `pi-overdrive-searxng` container through the restricted passwordless
Docker rule, checks SearXNG on loopback, starts the hardened local Second Brain units with bounded fail-soft health, opens the web dashboard, and finally
replaces the launcher process with the real Pi executable. It never creates a
container or changes provider/authentication files. Re-run the installer after
updating the package; validate the installed copies with:

```bash
scripts/install-pi-launcher.sh --check
pi-overdrive-memory-services status
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
