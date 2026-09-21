# Phase 14 — metadata-first Agent Hub

## Decision

The pinned OMP Agent Hub was reviewed at commit `4267074ac91456866e95ed8de0b6353388f08502`. Its useful idea is a compact view of concurrent agent lifecycle. Ultra does not copy its transcript access or steer, message, revive, kill, and spawn controls. Those operations would create a second orchestration authority, weaken Council isolation, and enlarge the permanent tool surface.

Ultra implements `/agents` as an ephemeral read-only projection of the existing secure-workflow controller. It is not a registry of record. The durable workflow journal, controller reservation, correlated subagent-start event, and immutable terminal role receipt remain the only accepted sources. The Hub does not scan mission text or infer agents from filenames, display names, timestamps, or process lists.

## Lifecycle and accounting

The controller publishes a reservation only after the fixed spawn-budget controller accepts it. A start is admitted only when the pi-subagents event matches the exact controller request, owner run, and node identity. A terminal event is published only after `writeRoleReceipt` completes. Resume replays validated durable receipts after a valid journal checkpoint rather than reconstructing live state. Duplicate, stale, conflicting, unreserved, cross-run, over-budget, or route-conflicting events are rejected.

Live roles show usage and cost as `UNAVAILABLE`. Terminal totals use the existing normalized role-receipt aggregate; missing receipt usage remains unavailable and is never converted to zero. Completed routes must attest to the reservation. The projection validates the fixed concurrency 3, subagent depth 1, correction-round 2, and 42-attempt spawn envelope but has no path to change them.

## Privacy and authority

Every event kind has an exact field allowlist. Allowed data is limited to lifecycle identity, role, bounded counters, route identity, status, timestamps, digests, terminal error class, and normalized receipt usage. Prompt, transcript, reasoning, task text, tool arguments/results, file content, paths, secrets, credentials, and Council-member conclusions have no event field. Metadata tracing applies another explicit whitelist and records only a generic rejection code for malformed events.

The Hub registers one user command and no model-facing tool. It cannot call a provider, execute a process, steer, message, cancel, revive, spawn, mutate, change model/thinking, change a budget, or alter workflow state. Projection errors are caught by the extension and degrade only the view. This same-process metadata bus assumes installed package extensions are inside the package trust boundary; compromising arbitrary executable extension code is outside what a read-only projection can defend, but the Hub supplies no additional authority to exploit.

## Evidence

- Eleven focused/adversarial cases cover the fixed policy envelope, reservation/start correlation, durable terminal accounting, unavailable usage, negative process exit metadata, exact field rejection, Council isolation, stale/ambiguous lifecycle denial, resume replay, fail-soft behavior, schema absence, and Council-before-Judge sequencing.
- The real Pi 0.85.1 benchmark uses production journal and receipt persistence, projects three roles through `/agents`, verifies private mode-0400 terminal receipts, injects one forbidden-field event, and proves the Pi/controller continue while only the view degrades.
- A trap provider records any invocation. The benchmark completes with zero provider/model turns, network calls, external calls, paid calls, cost, runtime processes, and residue.

The projection is intentionally session-local and covers secure-workflow role attempts, not arbitrary direct subagent jobs or historical transcript search. No OMP source was copied. OMP remains source-inspected only because its Bun >=1.4 runtime is unavailable on this host.
