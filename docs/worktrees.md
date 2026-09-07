# Worktrees and parallelism

Use managed `pi-subagents` worktrees for concurrent writers or a substantial experiment that should not disturb the main checkout. The default is off; request `worktree: true` per launch so isolation is deliberate. Native Git allocation is used because Worktrunk is not installed.

For a manual worktree:

```bash
./scripts/worktree-new.sh feature/example HEAD
```

The helper validates the branch, refuses an existing target, creates a sibling worktree, and prints a deterministic suggested port, database name, and browser-profile path. Treat those suggestions as per-worktree namespaces. Never share a writable SQLite file, development database, fixed port, build cache with unsafe concurrent writes, or browser profile between active workers.

Before integrating, inspect the child diff, run its verification in that worktree, and merge/cherry-pick from the primary checkout only after review. Use ordinary `git worktree list` and `git worktree remove /exact/path`; never delete worktree directories directly.
