# Phase 30 — bounded local Worker prewalk; persistence deferred

## Implemented boundary

The secure-workflow controller may supply a small, name-only Git path hint to a Worker before its first attempt and corrections. It is **not** a Scout, model turn, search index, tool, or source-content pack. A validated Task Policy must permit repository search and classify the task as code work; an active Scout, direct small edit, single explicitly named file without discovery/debug need, and non-code tasks skip it. Only Worker receives the hint. Planner, Oracle, Tester, reviewers, Council members, and Judge do not. The Worker still opens paths using its normal governed tools and isolated worktree. An invalid or unavailable index yields no hint; it does not grant a fallback filesystem authority.

The prewalk verifies the exact canonical worktree root through the existing attested Git ResourceFS runner and lists tracked index paths with a bounded `git ls-files -z --cached`. It rejects protected/secret names, traversal, controls, symlinks, multiply linked files, binary samples, and files over 256 KiB. Each selected path is a relative, reopenable hint, rechecked with no-follow file descriptors and inode identity. It emits at most eight paths and 960 characters, validates the rendered grammar, and fits inside the routing handoff budget. The Task Policy and model route are not modified. A fresh TOCTOU-safe read remains the responsibility of the Worker's existing tool boundary; prewalk hints are untrusted data, not authorization.

Only status, selected/scanned counts, characters, elapsed milliseconds, zero model-call count, and a SHA-256 digest enter trace metadata. No task text, path list, source bytes, prompt, or credentials enter traces. No large discovery output is produced, so Artifact Store externalization is unnecessary for this bounded variant. Shared Memory Pack remains separate project-history evidence; the prewalk is current repository location evidence. The normal Context Fit Gate on provider requests remains authoritative, and the prewalk is capped below the existing workflow handoff limit.

## Measured result and limitations

`benchmarks/overdrive-vs-omp/local-prewalk.mjs` launches real Pi 0.85.1 twice with the same offline deterministic local Worker fixture and task in a fresh temporary Git repository. In the saved run, CONTROL used three local provider turns, one search and one read; PREWALK used two turns, zero searches and one read. Both identified `parseInput` in `src/parser.ts`. The controller prewalk itself made zero model/provider calls, used 125 characters and 12.639 ms, and the benchmark cleaned its temporary repository. The enriched prompt grew by 127 characters (about 32 tokens using a four-char estimate). One run's elapsed-time delta, including prewalk, was −84.364 ms; this is startup noise, **not** a general latency claim. The benchmark proves this specific deterministic discovery path, not broad model quality, full secure-workflow E2E, or guaranteed savings on other tasks. The prewalk skips tasks where that overhead is unlikely to help. Untracked paths and names outside the conservative ASCII grammar are deliberately absent; matching is lexical, not semantic.

Four focused prewalk tests cover policy/Scout skips, exact-file and non-code skips, deterministic discovery, canonical worktree rejection, secret/symlink/hardlink/binary/oversize/hostile-path denial, eight-path bound, deduplication, unchanged Task Policy, Worker-only delivery including correction, and no extra delegated role. Existing workflow, spawn-budget, Tool Governor, Context Governor, Director, Agent Hub, Council, isolation, and receipt regressions are included in the authoritative gate.

## Persistent Worker decision

Persistent provider conversations remain **DEFERRED**. A safe implementation would require all of the following to be specified, persisted, attested, and tested before enabling reuse:

| Required contract | Minimum rule |
|---|---|
| Owner and task scope | One controller session, Director/task chain, and exact owner run; unrelated tasks cannot inherit authority |
| Lease | Explicit finite states, expiry, idle timeout, max lifetime, one-shot resume identity |
| Workspace | Exact worktree/allocation UUID, repository/branch, state directory, and stale-worktree rejection |
| Context | Bounded transcript/summary, Context Fit proof before every provider call; durable memory/artifacts instead of unbounded history |
| Budget | Model, token, wall-time, tool, retry, and global 39+3 spawn accounting cannot reset on reuse |
| Tools and route | Recalculate Task/Tool Governor surface for every lease; policy-bound model/thinking; no authority accumulation |
| Cleanup and receipt | Crash/SIGKILL/cancel/recovery handling, no orphan process/port/profile/state, durable terminal/reuse receipts |

The current installed subagent path exposes fresh delegated attempts and exact cancellation, but no verified provider-session lease/resume primitive satisfying that contract. The measured prewalk saves one deterministic search/turn without introducing a persistent process. Therefore an unbounded or weaker persistence layer would add security and cleanup complexity without established benefit. Director continues to own the existing one-task secure workflow; Agent Hub displays existing attempt metadata only. Council remains fresh, independent, read-only, and non-delegating. Concurrency 3, depth 1, correction rounds 2, 39+3 spawn envelope, routing, retries, receipts, and isolation are unchanged.
