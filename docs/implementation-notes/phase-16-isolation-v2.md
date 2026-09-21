# Phase 16 — Subagent Isolation V2

## Decision

Ultra retains one native Git worktree for each enforced workflow. Worker correction rounds deliberately share that worktree so verified fixes accumulate, while Scout, Planner, Tester, reviewers, Council, and Judge keep their existing read-only or non-mutating role boundaries. Bubblewrap remains the execution boundary for governed commands. No per-role copy tree, mount, apply-back path, or second task controller was added.

The pinned OMP reference was inspected for snapshot, reflink, overlay, ownership, capture, apply, and teardown semantics. Its strongest transferable idea is explicit owner/lifecycle validation. Ultra already records the stronger Linux tuple of PID, boot ID, and process start ticks, so Phase 16 binds that ownership to a versioned canonical allocation contract instead of importing OMP's backend abstraction.

## Enforced V2 boundary

New allocations record `version: 2` and `isolationBackend: git-worktree-v2`. The source repository must be canonical and clean. Worktree and runtime roots must be independent, outside the repository, and free of symlink components before any allocation directory is created. Allocation records and port reservations are owner-only, single-link regular files read with `O_NOFOLLOW`.

Every list, lookup, resume, release, recovery, and cleanup path reconstructs the expected branch, worktree, allocation directory, state directory, browser profile, port reservation, database identifier, and schema identifier from the allocation UUID plus canonical repository. A mismatched or symlinked record becomes invalid evidence and cannot authorize cleanup. Live-owner recovery continues to use PID, boot ID, and start ticks, preventing PID reuse from being mistaken for ownership.

## Backend probe

The local benchmark materializes a real 256-file repository through the production allocator and cleans it completely. The native worktree completed in 24.749 ms on this host and excluded an ignored private fixture. `cp --reflink=always` was unavailable on the current filesystem, so reflink remains `UNAVAILABLE`, not inferred. It would remain unselected even when available because a repository clone copies ignored/project-local state and needs separate Git ownership, capture/apply, and teardown logic.

Overlay was not mounted: a mount-backed workspace would introduce privileged ownership and teardown failure modes while Bubblewrap already supplies the required runtime isolation. This is an explicit `NOT_RUN`, not a negative performance claim.

## Limits

The boundary protects against pre-existing symlinks, malformed or tampered allocation metadata, unsafe modes/links/ownership, stale process identity, and non-canonical cleanup targets. Node does not expose a complete descriptor-relative `openat2`/`renameat2` lifecycle, so a hostile same-UID process racing directory replacement between validation and a later path operation remains outside the package's full control. Private 0700 roots, atomic metadata replacement, Git registration checks, and post-cleanup checks reduce that window without claiming kernel-enforced immunity.

No provider, model, network, routing, retry, role, Council/Judge, concurrency, depth, correction, spawn-budget, Second Brain, or tool-schema behavior changed.
