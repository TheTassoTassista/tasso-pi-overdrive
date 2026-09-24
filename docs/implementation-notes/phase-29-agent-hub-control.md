# Phase 29 — bounded Agent Hub control plane

## Authority decision

`/agents` remains a metadata-only, read-only projection. It displays a full, immutable attempt UUID only for Worker and Tester. The separate user command `/agent-cancel <attempt-uuid>` is registered by the secure-workflow controller, not by the projection and not as a model tool. It does not accept a PID, role name, shell command, prompt, model, or route.

The controller resolves the UUID to its own reservation and requires the current Pi session ID, workflow run/task identity, role, receipt sequence, attempt number, and `RUNNING` version 1 state to match. Only Worker and Tester are cancellable. The controller then emits the installed `pi-subagents` exact `{requestId, ownerRunId, nodeId}` cancel event. The command reports `CANCEL_REQUESTED`, not a terminal success. The normal response path must persist a role receipt before the Hub shows `CANCELLED`; cancellation failure makes the workflow fail closed. The current 42-attempt envelope, three-way Council, Judge order, model routing, Tool/Task Governors, and transient retry policy are unchanged.

Duplicate request IDs are rejected. A second request against an already requested or terminal attempt is stale. Unknown/malformed IDs, a different session, mismatched run/role/sequence/attempt, Council/Judge roles, and a closed controller are rejected. A dispatch exception or a non-cancelled terminal response after an accepted cancel makes the overall workflow FAIL, rather than reporting cancellation success. The controller holds no generic process-kill or spawn primitive. Audit metadata includes only operation/result/state and request/attempt digests; no prompt, transcript, Council output, tool payload, or secret is emitted.

| Operation | Phase 29 classification | Reason |
|---|---|---|
| CANCEL Worker/Tester | SUPPORTED, user command only | Exact controller-owned bridge cancellation and receipt path exist |
| CANCEL Council/Judge/other roles | UNSAFE / DEFERRED | Preserve Council independence and protected quorum/sequencing |
| PAUSE, RESUME | NOT_IMPLEMENTED | No owned bounded paused-context primitive |
| MESSAGE, STEER | UNSAFE / DEFERRED | No approved next-turn boundary or untrusted-message receipt contract |
| RETRY | NOT_IMPLEMENTED as a Hub control | Existing controller-only transient retry remains policy-bound |
| REVIVE, SPAWN | UNSAFE / DEFERRED | No separate governed identity/spawn-budget authority |

## Evidence and limits

- `tests/agent-hub-control.test.mjs` exercises exact identity, authorization, replay, stale/terminal/completion races and Council/Judge denial.
- `tests/agent-hub-control-bridge.test.mjs` drives the installed `pi-subagents@0.66.0` bridge: an exact cancel aborts one owned delegation, not an unrelated concurrent delegation, and produces a durable cancelled receipt projected by the Hub.
- `benchmarks/overdrive-vs-omp/agent-hub-control.mjs` runs real Pi 0.85.1 offline with a deterministic controller fixture sharing the production attempt controller and CLI adapter. It starts a real bounded child in an actual isolated Git worktree, observes `/agents` RUNNING, sends `/agent-cancel` with the shown UUID, observes `CANCELLED` from a durable receipt, verifies worktree/port/runtime cleanup and that an unrelated same-user child survives. A separate Pi startup confirms the production secure-workflow extension registers `/agent-cancel`. This benchmark uses zero model/provider calls; it is **not** an authenticated full secure-workflow E2E.
- `benchmarks/overdrive-vs-omp/agent-hub.mjs` still verifies the projection, redaction, accounting and fail-soft behavior in real Pi.
- Production workflow cleanup retains its owned worktree for human review by default while releasing runtime reservations; `PI_OVERDRIVE_CLEANUP_WORKFLOW=1` selects destruction. This pre-existing policy was not changed by cancellation. The deterministic benchmark explicitly uses destruction and verifies it.
- If the upstream bridge never returns a terminal response, the controller must not claim a cancelled receipt. The existing delegation timeout remains the fail-closed fallback; there is no guarantee of immediate cleanup from an unresponsive upstream bridge.

No external provider, paid call, global installation, credential, routing preset, retry bound, Council policy, or stable worktree changed.
