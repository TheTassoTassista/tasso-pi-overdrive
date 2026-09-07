# Agent operating contract

## Scope

- Work only inside this repository unless the user explicitly approves another path.
- Preserve unrelated local changes. Never read credentials, private keys, `.env*`, authentication stores, or browser profiles.
- Search before reading and read the smallest useful ranges. Prefer symbol/AST search over dumping files.

## Workflow

- Trivial change: inspect, edit, run the narrowest check, report evidence.
- Non-trivial change: scout → plan → implement → test → adversarial review → fix → verify.
- Delegate at phase boundaries, with a fresh context and a precise handoff. One writer per checkout.
- Use a managed worktree for parallel writers or risky isolation. Give every worktree unique ports, database names, and browser profiles.
- Record durable decisions, constraints, evidence, and next actions in the task notebook; do not store transcripts.

## Completion

- Run repository-specific tests, types, lint, build, and `git diff --check` as applicable.
- Report PASS, FAIL, or SKIP truthfully with commands and concise evidence.
- Do not commit, push, publish, deploy, or merge unless explicitly requested.
