# Phi — Architecture Decision Log

## 2026-10-04 — D6-ORDINARY-WORKFLOW-PUBLICATION-001 (user-supplied Φ Main / Architecture decision)

Status: **IN FORCE; implementation and native ordinary-workflow evidence pending**. Decision: **IMPLEMENT_SMALLER / MERGE**. Extend the existing ordinary Windows secure workflow to reach the V5 Worker/controller publication path without certifying Windows autonomy. The authorized order is trusted task/control-plane intent → bounded Worker execution → Worker result → Worker authority revoked → independent controller validation → durable READY handoff → one-shot controller grant → V5 native publication and verification/journal. Publication must succeed after Worker revocation; keeping Worker alive for it is forbidden. No additional mandatory model pass, Council or Judge is required by the publication protocol.

Trusted publication intent is controller/control-plane-owned state, sourced from the user task or an accepted plan incorporated within existing task authority. It must bind transaction identity, operation class, operation-specific operands, authority scope and relation to the task. Planner/Worker proposals are data until incorporated by the authoritative control plane. For RENAME the authorized source **and** destination must be explicit, canonicalized and immutable across READY/publication. A semantic change of operation/source/destination/authority operands invalidates the prior handoff/grant and requires fresh authorization. Worker output cannot mint or mutate intent, grant controller authority, substitute a destination, or transform another operation into RENAME. A newly discovered rename beyond current task authority must pass existing planning/approval; no new overwrite semantics are implied.

After Worker response and revocation, the controller freshly revalidates intent, Worker result, current identities/absence/conflicts, V5 journal eligibility and native physical state; any meaningful mismatch fails closed. The one-use grant must bind transaction, operation and sufficient intent/version identity, denying replay, cross-transaction, cross-operation and changed-intent use. Reuse the existing Director, Task Governor, Worker boundary, ResourceFS, V5 journal/leases/classifier and native publication primitives. Keep exactly one physical mutation authority; recovery remains narrower than publication. Required native Windows ordinary-workflow tests cover CREATE/MODIFY/DELETE/RENAME, Worker revoked before publication, altered/absent RENAME intent, stale intent, source/destination user conflicts, grant replay/substitution, crash/restart classification and zero added provider/model calls.

This decision does **not** authorize Windows autonomy certification, a persistent Worker after response, direct Worker publication, dual publishers, publication beyond task authority, autonomous background continuation, new recovery/RENAME overwrite authority, whole-project locking or atomicity, a new agent/publisher/service, or security weakening. **Stop for Main** if implementation needs Worker lifetime extension, simultaneous authority, Worker-only trusted intent, an unbindable grant, background autonomy, weaker conflict checks, new architecture/authority/side-effect class, significant subsystem/redesign, or an unresolved authority/security contradiction. A working ordinary bounded publication path is not a Windows autonomy certificate.

## 2026-10-04 — PORTABILITY-CAMPAIGNS-001 (user-supplied Φ Main / Architecture decision)

Status: **IN FORCE** for Campaign 1, D6 Completion. A campaign organizes consecutive gates; it does not grant authority to an otherwise unauthorized gate. Work may continue through inspect → implement → test → review → native validation → checkpoint → next gate only while each gate is covered by existing architecture, authority, security invariants and documented semantics. Use small independently understandable checkpoints, not a mega-commit. Main reviews the Campaign Completion Packet before accepting any D6 status transition. Reversal/stop: halt the affected gate if it needs new authority, architecture, a security change, a wider side effect or a human choice. Campaign 2 and Windows autonomy are not authorized by this decision.

## 2026-10-04 — D6-PUBLICATION-AUTHORITY-001 (user-supplied Φ Main / Architecture decision)

Status: **AUTHORIZED, NOT YET IMPLEMENTED/VERIFIED**. Decision: **IMPLEMENT_SMALLER / MERGE**, serialized mixed Worker/controller publication. One transaction may involve both actors, but there must be exactly one physical mutation authority at a time: Worker phase → durable handoff/evidence → controller phase → durable handoff/evidence → any later authorized phase. The previous phase must terminate or lose mutation authority before the next acquires it. Controller revalidates current state independently; Worker claims cannot self-authorize it. Reuse the V5 journal, transaction ownership, leases, ResourceFS, existing Worker/controller bounds and native primitives. No general capability-token subsystem if existing mechanisms suffice.

Success requires real production-representative Worker/controller CREATE, MODIFY, DELETE and RENAME; unique ownership; deterministic non-overlapping handoff; fail-closed concurrent user changes; classifiable crashes around every meaningful durable handoff; no regression of green V5 fixtures; and native Windows evidence. Required tests cover stale/duplicate/wrong-actor handoffs, user conflict, crash before/after handoff, restart classification and zero provider/model calls. `MIXED_RECOVERY_NOT_READY` may be narrowed only for states whose contract is proved. This does **not** authorize independent/concurrent publishers, extra paths, journal/ResourceFS/protected-path bypass, whole-project atomicity, implicit recovery or Windows autonomy. Stop/reverse if the implementation needs simultaneous physical authority, ambiguous ownership, Worker self-authorization, weakened conflict detection, a journal unable to identify owner/current phase, silent overwrite or broader authority.

## 2026-10-04 — D6-V5-RECOVERY-DISPOSITIONS-001 (user-supplied Φ Main / Architecture decision)

Status: **AUTHORIZED, NOT YET IMPLEMENTED/VERIFIED**. Decision: **IMPLEMENT_SMALLER / MERGE**. Build an exhaustive matrix from real V5 operation × durable phase × freshly observed physical state. Every relevant cell must explicitly yield a proved safe automatic disposition or deliberate `FAIL_CLOSED_MANUAL`; D6 does not require automatic mutation for every crash state. Authorized classes are `OBSERVE/FINALIZE_METADATA_ONLY` for proved physical end-state, `RESUME_FORWARD` only from already-durable intent and a unique unambiguous next transition, `FINALIZE_TRANSACTION_OWNED_CLEANUP` only for identity-verified owned artifacts no longer needed by the live project, and existing formally defined operation-specific `ROLLBACK` under its original constraints. Ambiguous, conflicting and unknown states remain manual. R1 remains closed and is not broadened by this decision.

Before **any** automatic physical recovery mutation, independently prove known transaction/owner, valid unambiguous journal and pre-crash durable intent, fresh unambiguous physical classification, a unique next transition, expected identity or freshly required absence for every entry, a no-clobber primitive resilient to post-classification creation, verified staging/quarantine identity, absence of incompatible user changes, an operation-specific existing protocol transition, serialized journal append, and classifiable recovery crash. Unknown on any point means no mutation. Recovery authority stays narrower than publication; it cannot invent intent, guess, overwrite non-owned/unverified state, replay arbitrarily, use global locking, infer provenance from presence/absence, publish the project or enable Windows autonomy.

Each automatic matrix cell requires positive, negative/conflict, crash-during-recovery, restart/idempotency and native Windows tests. Each manual cell requires a blocking test. Stop/reverse a proposed cell if it needs new intent, heuristic recovery, non-owned overwrite, global filesystem locking, wider authority or weaker identity/concurrency checks. A deliberately manual cell is not itself a Main escalation unless an authoritative D6 requirement specifically requires automating it.

## 2026-10-03 — V5-RECOVERY-CLEANED-001-R1 (user-supplied Φ Main / Architecture decision)

Status: **ACCEPTED**. Verified implementation scope on Windows: only `CLEANUP_STARTED → recovery-observed CLEANED`.

Decision: **IMPLEMENT_SMALLER**. This replaces only the earlier requirement for continuous physical exclusion between classification and append. It authorizes ordinary startup to append one recovery-marked V5 `CLEANED` under the transaction journal lease after exact `CLEANUP_STARTED`, known identity/ownership, an intact journal, a fresh complete native physical classification and observed absence of the owned quarantine.

The record certifies the terminal state at observation T. It does not certify who unlinked the quarantine, continuous state until append A, future filesystem truth, `projectPublished`, or physical mutation authority. `cleanup: NOT_PROVEN` and `projectPublished: false` remain; every later physical action requires its own current proof. No global project lock, external-writer exclusion, replay, cleanup, unlink, `PUBLISHED` or model/provider call is authorized. Earlier or ambiguous states remain manual.

Implementation evidence: `0a186919fff0c3a1677a1fdfc143b69538ec1efe` / [CI 37144185054](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37144185054) SUCCESS; native Windows V5 21/21, full Windows and Ubuntu gates and source clone PASS. D6 PARTIAL, D IN_PROGRESS, Windows autonomy BLOCKED. This log records the supplied decision; it does not create broader authority. The GitHub run result, exact head SHA and platform job status were checked directly; detailed test counts and scenario receipts are recorded in the Work packet and test baseline. Original Worker mixed publication, native Linux V5 recovery and power-loss durability remain unproved. Historical CI 37143402124 failed in the aggregate `after-cleanup-unlinked` case at `PUBLISHER_READY_TIMEOUT` before recovery assertions; its cause is UNKNOWN.

## Decision Template

### YYYY-MM-DD — Title

Proposal:

Problem:

Existing Phi behavior:

Research:

Alternatives:

1. No change
2. Minimal solution
3. Moderate solution
4. Full solution

Benefits:

Costs:

Security impact:

Token impact:

Latency impact:

Portability impact:

Decision:

IMPLEMENT / IMPLEMENT_SMALLER / MERGE / EXPERIMENT / DEFER / REJECT

Reason:

Evidence:

Revisit if:
