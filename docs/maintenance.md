# Optional maintenance workflows

`/doc-garden [scope]` produces a read-only report for broken links, stale commands/version claims, duplicate guidance, and code/documentation drift. `/code-gc [scope]` reports evidence-backed dead code, unused dependencies, duplicates, stale TODOs, architecture violations, oversized files, and coverage gaps.

Neither command edits files or creates a schedule. Review the report, select a bounded change, use a normal worktree/worker/test/review cycle, and record recurring harness friction in `docs/reliability/HARNESS-FINDINGS.md` when a project was initialized from the template.
