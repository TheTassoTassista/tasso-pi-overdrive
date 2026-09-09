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

The unit/static harness and evaluator create and remove their own temporary repositories and do not call a model. `npm run smoke:e2e` does call the configured routed models.

`npm run smoke:e2e` is deliberately outside `npm run check`: it plants a failing percentage bug plus a machine-readable security blocker, requires the full routed state machine, forces correction/re-verification, writes immutable execution evidence, destroys the worktree/runtime, then writes and validates the cleanup-aware receipt. It also runs a controller negative control whose verification always fails and must end FAIL. `npm run smoke:handoff` uses a deterministic local provider, drives the official RPC extension-UI protocol, and proves `/handoff` starts an empty session with an editable distilled prompt.
