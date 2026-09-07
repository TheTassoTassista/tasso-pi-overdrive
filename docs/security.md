# Security and privacy

Pi extensions execute with the user's permissions. This package reduces common mistakes but is not a sandbox.

For untrusted build or test commands, `scripts/sandbox-run.sh` uses the already installed Bubblewrap runtime. It exposes only `/usr`, `/etc`, `/proc`, `/dev`, an empty home, a fresh `/tmp`, and the selected repository mounted writable at `/workspace`; network is unshared by default. Pi itself remains outside that sandbox so provider authentication is never mounted inside it.

Guardrails:

- Direct read/grep attempts against common credential, key, `.env`, SSH, GPG, keyring, and certificate paths are blocked.
- Writes to secret-like paths, `.git`, and `node_modules` are blocked.
- Writes outside the active workspace and dangerous shell commands require interactive confirmation; they fail closed in headless mode.
- Recursive removal, destructive Git cleanup, disk writes, shutdown, download-to-shell, sudo, package removal, recursive permission changes, and forced pushes are gated.
- Third-party search/fetch and browser tools were selected for explicit SSRF/output/redaction controls.
- Metadata tracing never stores prompt text, argument values, tool output, URLs, environment values, or authentication material.

Limitations:

- Shell parsing is heuristic; aliases, interpreters, generated scripts, and novel command forms can bypass string rules.
- A malicious extension or trusted project extension can call Node APIs directly and bypass tool hooks.
- The Bubblewrap wrapper applies only to commands explicitly launched through it; it does not transparently contain every Pi tool call.
- Project trust authorizes code loading; it does not provide filesystem or network containment.
- Successful large outputs may have omitted lines. Errors are preserved, and a narrower rerun is required when omitted detail matters.

For untrusted repositories, unknown packages, destructive migrations, or production credentials, use an OS-level sandbox/container/VM and a dedicated low-privilege account. Review diffs before commit and use human confirmation for publish, deploy, merge, deletion, and account-changing browser actions.
