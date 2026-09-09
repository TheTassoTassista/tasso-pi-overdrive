# Security and privacy

Pi and its extensions execute with the user's permissions. Autonomous project commands are sandboxed, but the Pi host process and trusted extension code are not a complete security boundary.

For autonomous build and test commands, `scripts/sandbox-run.sh` uses Bubblewrap. It exposes `/usr` read-only, empty `/etc` and home trees, a fresh `/tmp`, namespace-local `/proc` and `/dev`, and the selected worktree at `/workspace`. Network is always unshared. Conventional credential/key paths inside the worktree are hidden and `.git` is over-mounted read-only. Pi authentication and the normal home are never mounted.

Guardrails:

- Direct read/grep attempts against common credential, key, `.env`, SSH, GPG, keyring, and certificate paths are blocked.
- Writes to secret-like paths, `.git`, and `node_modules` are blocked.
- Free-form `bash` is blocked for all guarded calls. `safe_exec` accepts only a fixed program enum plus an argument vector, rejects destructive Git, inline Node/Python and ad-hoc package execution, and requires an Overdrive allocation for executable/mutating commands.
- Autonomous Worker/Tester runs are accepted only in an isolated worktree. Worker has no shell and may delete only a canonical, single-linked regular file through `safe_remove_file`; Tester has no edit/write/general command tool.
- Third-party search/fetch and browser tools were selected for explicit SSRF/output/redaction controls.
- Metadata tracing never stores prompt text, argument values, tool output, URLs, environment values, or authentication material.

Limitations:

- A malicious extension or trusted project extension can call Node APIs directly and bypass tool hooks.
- The Pi host, model calls, controller Git/worktree operations, guarded read/edit/write/search/semantic tools, browser, and web tools are not inside Bubblewrap. Worker mutations are host-side Pi tool operations but are confined by canonical hooks to a disposable worktree. Verification commands and Worker `safe_exec` are inside Bubblewrap; verification's read-only `git diff --check` is host-side.
- There remains a narrow same-user TOCTOU window between a guard hook approving a path and a Pi built-in opening it. Existing path components are canonicalized with symlinks denied, new parents are canonicalized, multi-linked writes are denied, and `safe_remove_file` rechecks device/inode/link count immediately before unlink, but the built-in file APIs do not expose an `openat`/directory-FD seam for complete race elimination.
- Credential hiding recognizes conventional names and key extensions. A secret stored under an arbitrary ordinary source filename is not distinguishable from source and can be read by repository code executed in the sandbox.
- Project trust authorizes code loading; it does not provide filesystem or network containment.
- Successful large outputs may omit low-signal lines. Every line classified ERROR/FATAL/failure is retained regardless of position or count; failed tool results are never compacted.

For untrusted repositories, unknown packages, destructive migrations, or production credentials, use an OS-level sandbox/container/VM and a dedicated low-privilege account. Review diffs before commit and use human confirmation for publish, deploy, merge, deletion, and account-changing browser actions.
