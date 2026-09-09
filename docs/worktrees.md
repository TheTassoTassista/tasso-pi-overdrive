# Worktrees and parallelism

Use `secure_coding_workflow` for autonomous writes. Its trusted controller creates a native Git worktree and branch plus a checked free port, private state directory, isolated browser profile/session, and unique database/schema identifiers. These values are injected into Bubblewrap and browser calls; they are not prompt-only suggestions. The generic subagent default stays off because the secure controller owns the shared workflow worktree, while direct Worker/Tester launches without `worktree: true` are rejected.

For a manual worktree:

```bash
./scripts/worktree-new.sh feature/example HEAD
```

The manual helper validates the branch and refuses an existing target. Runtime isolation for autonomous work is provided by `scripts/worktree-runtime.mjs allocate`; it reserves metadata atomically, checks port availability, and prints the complete allocation. `release` frees the port while retaining reviewable code; controller cleanup removes only a matching managed allocation/worktree/branch.

Before integrating, inspect the child diff, run its verification in that worktree, and merge/cherry-pick from the primary checkout only after review. Use ordinary `git worktree list` and `git worktree remove /exact/path`; never delete worktree directories directly.
