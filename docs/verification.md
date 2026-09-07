# Verification

`verification_gate` detects repository-native checks rather than inventing a universal command. Quick mode prefers typecheck, lint, unit tests, language-specific tests, and `git diff --check`. Full mode adds format, build, clippy, CTest, and e2e scripts when present.

Interpretation:

- PASS: the command ran and exited successfully.
- FAIL: a command ran and failed; the concise output is evidence to fix or explain.
- TIMEOUT: the command did not settle within the bound; this is not a pass.
- NO_CHECKS: the repository exposed no recognized checks; inspect project docs and run an explicit relevant command.
- SKIP: use only in the human report when a required check cannot run, with a concrete reason.

Run the narrowest test during implementation, then the full risk-appropriate set once. After any review-driven edit, rerun the affected checks. Browser QA needs state and artifact evidence, not only a successful command exit.

Local harnesses:

```bash
npm run check
npm run benchmark
npm run smoke:local
./scripts/sandbox-run.sh . -- node --test tests/*.test.mjs
```

The deterministic harness creates and removes its own temporary Git repository/worktree. It does not access credentials or call a model.

`npm run smoke:e2e` and `npm run smoke:handoff` make small authenticated model calls and therefore are never part of `npm run check`. The former plants a bug in a temporary repository, requires scout/planner/reviewer/worker/tester evidence, verifies the fix and guardrail, then deletes the repository. The latter drives the official RPC extension-UI protocol and proves `/handoff` starts an empty session with an editable distilled prompt.
