# Phi — Architecture Decision Log

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
