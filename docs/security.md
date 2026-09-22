# Security and privacy

Pi and its extensions execute with the user's permissions. Autonomous project commands are sandboxed, but the Pi host process and trusted extension code are not a complete security boundary.

For autonomous build and test commands, `scripts/sandbox-run.sh` uses Bubblewrap. It exposes `/usr` read-only, empty `/etc` and home trees, a fresh `/tmp`, namespace-local `/proc` and `/dev`, and the selected worktree at `/workspace`. Network is always unshared. Conventional credential/key paths inside the worktree are hidden and `.git` is over-mounted read-only. Pi authentication and the normal home are never mounted.

Guardrails:

- Direct read/grep attempts against common credential, key, `.env`, SSH, GPG, keyring, and certificate paths are blocked.
- Writes to secret-like paths, `.git`, and `node_modules` are blocked.
- Free-form `bash` is blocked for all guarded calls. `safe_exec` accepts only a fixed program enum plus an argument vector, rejects destructive Git, inline Node/Python and ad-hoc package execution, and requires an Overdrive allocation for executable/mutating commands.
- ast-grep cannot enable symlink following; its target, config, and rule-file paths are constrained to canonical non-secret workspace files before the subprocess runs.
- Autonomous Worker/Tester runs are accepted only in an isolated worktree. Worker has no shell and may delete only a canonical, single-linked regular file through `safe_remove_file`; Tester has no edit/write/general command tool.
- Runtime allocations use the single `git-worktree-v2` backend. Private canonical roots deny symlink components and repository overlap; owner-only single-link records are opened with `O_NOFOLLOW`, and every lifecycle operation reconstructs the exact branch/worktree/runtime identity before it can resume, release, recover, or clean anything.
- Third-party search/fetch and browser tools were selected for explicit SSRF/output/redaction controls.
- Metadata tracing never stores prompt text, argument values, tool output, URLs, environment values, or authentication material.
- Imported project rules are fixed-location, bounded, scope-matched, digest-cached, and sanitized before entering the model context. They are explicitly lower authority than controller/current-task policy and cannot change tools, routing, Council/Judge, cost, spawn, sandbox, approval, verification, receipt, or Git/publish policy. `rule://project` is digest-bound and read-only.

Limitations:

- A malicious extension or trusted project extension can call Node APIs directly and bypass tool hooks.
- The Pi host, model calls, controller Git/worktree operations, guarded read/edit/write/search/semantic tools, browser, and web tools are not inside Bubblewrap. Worker mutations are host-side Pi tool operations but are confined by canonical hooks to a disposable worktree. Verification commands and Worker `safe_exec` are inside Bubblewrap; verification's read-only `git diff --check` is host-side.
- There remains a narrow same-user TOCTOU window between a guard hook approving a path and a Pi built-in opening it. Existing path components are canonicalized with symlinks denied, new parents are canonicalized, and multi-linked writes are denied. `safe_remove_file` now holds an `O_NOFOLLOW` descriptor across final device/inode/link validation and unlink, then admits success only if that exact inode reaches link count zero. Trace retention similarly anchors known directories through held descriptors and verifies the opened inode after unlink. The built-in Pi file APIs still do not expose an `openat`/directory-FD seam for complete race elimination.
- Credential hiding recognizes conventional names and key extensions. A secret stored under an arbitrary ordinary source filename is not distinguishable from source and can be read by repository code executed in the sandbox.
- Project trust authorizes code loading; it does not provide filesystem or network containment.
- Prompt-injection filtering is a defense-in-depth classifier, not a proof that arbitrary prose is semantically harmless. The hard guarantee is that project rules have no direct execution/configuration API and all requested actions still pass the existing deterministic governors and enforcement boundaries. Pi core still loads root `AGENTS.md`; Ultra does not duplicate or replace that native loader.
- Successful large outputs may omit low-signal lines. Every line classified ERROR/FATAL/failure is retained regardless of position or count; failed tool results are never compacted.

Exact execution boundary:

- Worker `safe_exec` and every verification command run inside Bubblewrap with
  no network. Worker host-side edits are limited to its disposable canonical
  worktree; raw shell and autonomous network tools are absent.
- Tester has no mutation or general command tool. Its verification runs in a
  read-only Bubblewrap workspace; its allocated browser profile is a separate
  host process because Chromium cannot run inside this command sandbox.
- Scout, Planner, Council, Judge, Correctness, and Simplicity are host-side
  read-only roles. Oracle and Security add explicitly bounded web tools, so
  their public network reads are trusted-host operations.
- The workflow controller performs Git worktree allocation/cleanup, receipt
  I/O, provider calls, MCP, LSP orchestration, and final host-side diff checks.
  Those operations are trusted extension code, not model-selectable shell.
- The top-level interactive Pi process retains guarded read/edit/write access
  to the selected workspace. Installed extensions execute with the user's
  authority. Neither can honestly be described as a complete sandbox.

For untrusted repositories, unknown packages, destructive migrations, or production credentials, use an OS-level sandbox/container/VM and a dedicated low-privilege account. Review diffs before commit and use human confirmation for publish, deploy, merge, deletion, and account-changing browser actions.
