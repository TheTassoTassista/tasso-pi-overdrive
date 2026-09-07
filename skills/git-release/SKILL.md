---
name: git-release
description: Handle Git branches, worktrees, commits, tags, and releases safely. Use for release preparation, worktree orchestration, or repository history operations.
---
# Git and Release

Inspect status, branch, remotes, repository instructions, and release workflow first. Preserve unrelated changes. Stage explicit files only and never use destructive reset/clean/stash operations without clear authorization.

Use one branch and worktree per concurrent writer. Record base ref, branch, worktree path, verification, and patch/merge ownership. Do not delete a worktree until its diff is captured and clean state is verified.

Publishing, pushing, tagging, merging, and releasing are external mutations: perform them only when explicitly requested. Report exact evidence and rollback steps.
