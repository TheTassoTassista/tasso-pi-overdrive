# Phi — Architecture Decision Log

## 2026-10-06 — D6-CLONE-RECERTIFICATION-001 (user-supplied Φ Main decision)

Decision: **IMPLEMENT / VERIFY**, exactly one full native Windows clean-room clone certification attempt on the current valid candidate. A red run requires STOP without an automatic second attempt; only a green clone permits the already-authorized downstream Pi smokes and ordinary CREATE. Historical [CI37357312199](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37357312199) test206 failure remains real with unknown cause regardless of a later pass. No timeout, retry, ownership, sandbox or provider policy change is authorized. The one-shot [CI37384516310](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37384516310) on `cccc422` ended **FAIL** at main Windows test209 (`corrupt-journal`, `PUBLISHER_READY_TIMEOUT`, native exit70) before the independent Windows clone; its cause is UNKNOWN. The authority is consumed, no clone certificate or downstream smoke is credited, and the campaign stops for Φ Work Control/Main.

## 2026-10-06 — D6-CLONE-TEST206-DIAGNOSTIC-001 (user-supplied Φ Main decision)

Decision: **EXPERIMENT**, at most two focused native Windows independent-clone reproductions of test 206 (`after-cleanup-unlinked`). Preserve the same installed packages, native Job ownership, filesystem assertions, 120-second ordinary command ceiling, security boundary and complete clone cleanup. Add only redacted-by-construction stage/result metadata; no content, paths, command lines or secrets. Run 2 only if Run 1 passes or remains inconclusive. A passing focused run does not certify D6 or authorize a blind full clone rerun. If the cause remains unknown after the bounded runs, stop as CASE E. A sufficiently evidenced in-authority A/B/C defect may be corrected and locally reviewed with ZERO_EGRESS_REVIEW, after which one full clone certification is authorized. No external model review/provider call; no Pi smokes or ordinary CREATE while clone certification is red. D6 remains PARTIAL and Windows autonomy BLOCKED.

## 2026-10-05 — D6-ZERO-EGRESS-AUTOREVIEW-001 (user-supplied Φ Main decision)

Decision: **IMPLEMENT_SMALLER**. For the D6 clone-runtime candidate, mandatory review is structured local security/correctness review plus deterministic checks, explicitly **not** an independent external model review. Repository contents must not be sent to Codex review or any new model/review egress. The prior refused review remains NOT RUN / NOT AUTHORIZED. Only `ZERO_EGRESS_REVIEW: PASS` permits native watchdog validation and one clean-room certification; Windows autonomy remains BLOCKED. The functional candidate `f6063bf` plus local review-fix commit `9a5a2c0` received zero-egress PASS after two implementation-local findings were closed: a late completion could mask an inactivity gap, and suite success could be labeled Gate A PASS before final cleanup. Scoped tests now cover both, as well as duplicate/malformed ordinals and test-owned stdout spoofing. Native Windows evidence remains a separate required gate; this review does not certify it.

## 2026-10-05 — D6-CLONE-RUNTIME-GATE-001 adopted implementation candidate

The latest user-supplied Φ Main decision is **IMPLEMENT**: independent correctness/completeness (A), observed test-progress liveness (B), and runtime/performance evidence (C), with a finite outer resource-safety ceiling. The historical 600-second aggregate limit is retired as a correctness boundary. The bounded diagnostic `D6-CLONE-RUNTIME-DIAGNOSTIC-002` is **COMPLETE, CASE A**, not a certification. The current candidate reuses the fixed serial TAP reporter and native owned Job: 150-second no-completion watchdog, 900-second exact-suite outer ceiling, 491/479/12 corpus proof and distinct failure classes. Thresholds/rationale are in `harness/TEST_BASELINE.md`. Native focused watchdog tests, auto-review and one Windows clone certification remain pending; no D6 or Windows-autonomy promotion is implied. Runtime variance cause remains UNKNOWN.

## 2026-10-05 — D6-CLONE-RUNTIME-DIAGNOSTIC-002

User-supplied Φ Main decision: **EXPERIMENT**, maximum two additional clone-only NON-CERTIFYING measurements. Preserve the same functional candidate, 491-case ordered corpus, assertions, retries, isolation, ownership and cleanup. Record phase duration, numeric test durations and observed completion gaps; do not equate buffered reporter delivery with actual test execution. Run 2 only if Run 1 lacks a sufficient explanation. Classify A/B/C/D and STOP; no permanent certification-policy change, Pi smoke, ordinary CREATE certification, separate V5/R1 or full Campaign CI. **Outcome: CASE A aggregate budget exhaustion supported** by CI37345377138 completing491 tests in654,644 ms with observed progress/cleanup intact, beyond the ordinary600s cap. Root of runtime variation UNKNOWN. D6 PARTIAL, D IN_PROGRESS, Windows autonomy BLOCKED. D6-CLONE-RUNTIME-GATE-001 remains an option for a subsequent Main-authorized step, not adopted by this experiment.

## 2026-10-05 — D6-CLONE-RUNTIME-GATE-001 (user-supplied Φ Main / Architecture decision)

Status: **IN FORCE; first non-certifying diagnosis completed with CASE C / no certification**. Decision: **IMPLEMENT_SMALLER**. Separate the independent-clone gate into full-corpus correctness/completeness, an authoritative test-progress inactivity watchdog, and versioned runtime-budget evidence, with an empirically justified outer resource-safety ceiling. The historical 600-second aggregate wall-clock cap is not itself a correctness or liveness definition. One controlled, explicitly **non-certifying** diagnostic clone run was authorized to observe beyond that cap while retaining all original 490 tests (491 after a metadata-only regression), the same isolation, native Job ownership, cleanup, zero residual processes and no automatic retry. Classify aggregate budget exhaustion versus genuine stall from its evidence before implementing the new gate; the first run completed under 600 seconds and therefore remains CASE C, not CASE A.

Certification thereafter requires every expected case/ordinal, zero failures except existing valid platform skips, healthy progress, cleanup PASS and zero owned residual processes. A progress stall or outer-ceiling abort must fail closed through the existing Job ownership; runtime regressions remain visible. Do not skip/weaken the historical unsafe-readback case (now ordinal491) or ordinal490, shard the certification suite merely for green, silently increase the old timeout, weaken sandbox/security, change provider/model behavior, credit unrun Pi smokes, or claim Windows autonomy. Stop for Φ Main if progress is unreliable, a genuine hang is found, ownership/cleanup or coverage would weaken, the inactivity threshold becomes meaningless, or a new architecture/security/authority decision is needed. D6 remains PARTIAL pending native clone certification and downstream real Pi smokes.

## 2026-10-04 — D6-WINDOWS-BOUNDED-PUBLICATION-REACHABILITY-001 (user-supplied Φ Main / Architecture decision)

Status: **IN FORCE; implementation and ordinary-path native evidence pending**. Decision: **IMPLEMENT_SMALLER / MERGE**. Separate global backend readiness from an explicit, operation-specific, natively verified Windows bounded-publication capability. Keep `sandbox.implemented:false` and `sandbox.autonomousReady:false`; keep the backend-wide `requireCodingBackend("workflow")` gate for full/unrelated capabilities. A synchronous, task-bound ordinary request may enter only a distinct bounded publication lane with a trusted control-plane envelope established before Worker delegation. An absent envelope or unverified operation fails closed. Initially only V6 single CREATE has accepted native evidence ([CI37188510264](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/37188510264)); MODIFY/DELETE/RENAME require their own ordinary-lane evidence before enablement.

The controller binds task identity, project/path scope, allowed operation and applicable policy in the envelope. Worker output is proposed data only. The controller opts into private draft retention before delegation, revokes Worker session/tool authority after response, then freshly validates the retained draft, operation/operands, ResourceFS/protected scope, native physical preconditions and exact immutable intent before consuming the existing transaction/intent/operation-bound one-shot grant. Keep V6 crash/restart classifications; no Worker self-authorization, extra mandatory model/provider call, parallel workflow/backend/publisher, global autonomy promotion or unrelated Windows capability. Stop for Main if bounded reachability cannot be separated from the global gate, if trusted task authority cannot determine the envelope, or if a security invariant/new recovery authority would be needed. Campaign 1 remains D6 PARTIAL and Windows autonomy BLOCKED until separately proved.

## 2026-10-04 — D6-SINGLE-OP-PUBLICATION-001 (user-supplied Φ Main / Architecture decision)

Status: **IN FORCE; implementation/native ordinary-workflow evidence pending**. Decision: **IMPLEMENT_SMALLER / MERGE**. Keep the historical V5 four-operation `LEGACY_COMPOSITE` contract unchanged. Support a distinct durable `SINGLE_OPERATION(op)` profile for exactly CREATE, MODIFY, DELETE and same-directory RENAME. A single-operation transaction contains exactly one physical operation, with its own validation, one-shot authority, journal boundary, postverification and crash classification. A multi-operation ordinary task may use an ordered sequence of such independent transactions; a published prefix after a crash must be explicit, never called atomic. Old/unprofiled V5 remains legacy composite; unknown profile/version or cross-operation transition fails closed. Prefer a durable discriminator in the existing journal only if legacy interpretation stays unambiguous; otherwise use the next version. No parallel journal, second publisher, arbitrary operation list/graph or fake operations.

After bounded Worker execution and revocation, the controller treats its delta/operands as untrusted data and creates trusted operation-specific intent only after validating task/control-plane authority, canonical paths, protected scope, current physical preconditions and journal eligibility. The intent binds transaction, operation, source/target, expected identity/hash/absence and replacement artifact as applicable. A one-shot grant must be immutable-intent/transaction/operation-bound and reject replay or substitution. Worker output cannot mint intent or grant, publish, or remain physically authoritative alongside the controller. Publication bookkeeping adds zero mandatory model/provider/Council/Judge calls.

Existing V2 MODIFY, V3 DELETE and V4 RENAME are operation-specific durable protocols; reuse their validated native semantics where sufficient. Any new CREATE format must be unambiguously distinguishable from fixed V5 and must use only real CREATE phases/transitions, native no-clobber publication and complete postverification. Every new durable crash cell needs an explicit automatic-safe or manual/fail-closed disposition; this decision adds **no** automatic mutation authority by itself. Preserve R1 closed, recovery narrower than publication, identity/ownership, ResourceFS, protected paths, fresh conflict checks and zero silent overwrite. Do not certify Windows autonomy or Linux recovery. Stop for Main if implementation needs ambiguous legacy reinterpretation, arbitrary graphs, multi-file atomicity, weaker security, new recovery mutation authority, Worker-authored authority, simultaneous physical publishers, a significant new subsystem/redesign or a material capability/security/cost/latency trade-off. Campaign 2 is not authorized.

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
