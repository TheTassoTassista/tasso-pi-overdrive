# D — transactional project publication (IN PROGRESS)

This checkpoint implements immutable baseline/preflight/authority and a separate
native no-clobber CREATE primitive. It does **not** implement production project
publication, a durable project transaction journal, replacement, rollback or
restart recovery. Windows autonomy remains BLOCKED. B1/B2/C are retained, not
re-certified as a complete Windows engine.

## Actual lifecycle and receipt meaning

The controller in `extensions/secure-workflow.ts` reserves a governed Worker via
`lib/phi-worker-authority.mjs` before delegation. On Windows that reservation
uses `readWindowsProjectSnapshot` in `platform/windows/coding-tools.mjs` and
native `RecoveryFilesystem.ReadProjectSnapshot`: bounded anchored UTF8 files,
root and per-file native IDs, no-follow/single-link source validation. Existing
foreground Pi session binding owns one `WorkerDraft` in controller memory.
Every native EDIT/TEST/LSP execution materializes a disposable LPAC copy; its
native IDs change, but logical draft ID/revision/content digest remain bound.
An unsuccessful EDIT never commits partial readback. Revocation clears payload.

Before D, only the original root ID survived separately from the current draft.
D now retains immutable original per-file IDs/SHA256/byte lengths in
`lib/phi-publication-plan.mjs`, not a second raw-content copy. Changed operations
are computed against that original manifest, not against fresh execution-copy
IDs. Existing `draftContentDigest` encoding is unchanged and shared by preflight
and WorkerDraft.

Production `safe_exec` settles successful EDIT as EDITED. Registered TEST batch
in `verifyWorkerDraft` accepts only unchanged draft content and complete real
command success, then marks VERIFIED. Failed/rejected re-verification invalidates
prior publication approval while preserving the current payload. Actual
`semantic_nav` records its native JSON diagnostics against the exact ID/version/
digest. Analysis PASS containing Error is **not** semantic approval. Missing,
unknown-severity or failed diagnostics deny approval; changed revisions erase
all semantic proofs. A later analysis, including a pre-launch runtime failure,
invalidates a previously minted READY grant. Changed/new JSON files require
their own clean proof; case variants cannot avoid this check. Unsupported JSON
case variants cannot currently obtain proof from the bounded C endpoint.

Only the original controller reservation closure exposes `preparePublication`.
It requires explicit own-field `approveProjectMutation: true`, existing immutable
Task/Tool edit+verify capabilities and active transactional_edit. Neither Worker
tokens nor model tools expose it. This is a separate host-project approval, not
an inferred consequence of draft EDIT. It reads a new anchored native project
snapshot and checks the whole original manifest, conservatively including
unchanged files. User creation/removal, root replacement, content change or
same-content file identity replacement returns CONFLICT without clearing draft
or changing host files. Root/alias extraction failures deny instead of guessing.

Only after VERIFIED and applicable clean LSP and unchanged base does the
controller receive READY_TO_PUBLISH plus a separate opaque WeakMap grant. Grants
are bound to record/lifetime/exact draft/transaction ID; copies, Worker tokens,
stale preparations, revocation and in-flight tools cannot use them.
`executePreparedWindowsPublication` always denies with BACKEND_UNAVAILABLE for
an otherwise valid grant. No runner injection, recursive copy or host write
fallback exists. The full workflow platform gate remains closed and does not
invoke preflight yet; this is an implemented subsystem, not a publication E2E.

All lifecycle names are explicit: DRAFT_CREATED, EDITED, VERIFIED,
READY_TO_PUBLISH, PUBLISHING, PUBLISHED, CONFLICT, ROLLED_BACK, FAILED. In this
partial implementation PUBLISHING/PUBLISHED/ROLLED_BACK are **unreachable**;
terminal mutation transitions require the missing native transaction adapter.
Revoked publication preflight is FAILED (Worker metadata separately REVOKED).
Receipts report draft ID/version/source digest, verified/base digests, operations,
semantic proof metadata, conflicts and projectPublished=false. Attempted/committed
file lists are empty; transaction recovery/cleanup are NOT_STARTED, not PASS.
Existing execution receipts are not project publication certificates.
`publishHub` in secure-workflow publishes metadata/evidence, **not project files**.

## Native CREATE primitive and API choice

`AnchoredFile.Write` remains an exclusive, expected-ID/hash in-place mutation
primitive. It is **not** crash-atomic and is not used to publish Worker changes.
The separate `CreateNoReplace` primitive pins root and every parent, checks the
original root ID and protected segments, creates an exclusive random temp via
handle-relative NtCreateFile/FILE_CREATE on that same filesystem, writes complete
bytes, flushes, validates native ID/single-link/content hash, then performs
NtSetInformationFile/FileRenameInformation with RootDirectory=NULL and one leaf:
the documented same-directory rename relative to the exclusively held source
file object. Only a handle created by that exact parent instance, with matching
native ID, may be renamed. Parents remain pinned and ReplaceIfExists=false. It post-verifies the same held
file before closing. Kernel no-clobber is the destination concurrency check:
existing/case-alias/newly-created user targets are never overwritten. No delete
of a target or path reopen for a write is permitted. New files inherit parent
ACLs; no existing ACL/stream/attribute preservation is claimed.

The entrypoint accepts only fixed synthetic selftest case names, uses owned
ScopeRecovery fixtures and is **not** exposed as a model-facing publication
endpoint. Exception-injection tests cover before-temp/temp/write/flush/validation/
precommit/rename/postverify and check absent-or-complete-new target, unchanged user
target, unchanged unrelated sentinel, explicit injected phase and fixture cleanup.
Additional controls reject a foreign source handle and prove the parent cannot
be renamed while the valid same-directory CREATE proceeds.
Unexpected native/IO failures cannot masquerade as successful injection. These
are exception/namespace primitive controls, not process-termination recovery or
power-loss durability proof. A pre-commit failure may leave an owned temp until
the test scope cleanup; there is no arbitrary real-project temp recovery yet.

API rationale uses primary Microsoft documentation:

- [FILE_RENAME_INFORMATION](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information): same-volume rename, relative parent handle/leaf, DELETE source right and no-clobber semantics. POSIX replacement flags are not proof of expected-destination-ID compare-and-swap.
- [ReplaceFileW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew): path-based opens, preservation rules and documented nontrivial failure states; WRITE_THROUGH is unsupported. This is not sufficient evidence of safe anchored expected-ID replacement or crash recovery.

**Unresolved replacement constraint:** releasing an exclusive expected target
handle before a pathname replace reintroduces the race; keeping no-delete-sharing
is not evidence that replacement can commit. Neither a repeated path check nor
an unconditional POSIX rename closes that gap. A replacement design must prove
anchoring, destination identity at commit and old-complete/new-complete under
actual native process death. No unsafe substitute is enabled to make D green.

Initial native candidate7bc020b/CI36337120221 proved preflight/CONFLICT and all
pre-rename injection/alias-denial controls, but six rename-dependent CREATE
controls failed with RENAME_NEW/c0000043/32. That version explicitly supplied the
same pinned parent as RootDirectory. Microsoft's API defines NULL/one leaf for
same-directory rename; explicitly supplying RootDirectory involves a new target
directory open. The next candidate uses that documented NULL/leaf operation and
binds its source handle to the exact exclusive-create parent/ID. No directory or
file sharing/access rights are increased, no pin is released, no collision is
accepted as success and no assertion is relaxed. Native confirmation is required.
The same failed aggregate also cancelled one existing Worker least-privilege
control at its unchanged30000ms test budget; underlying phase/cause UNKNOWN.
Its dedicated step passed. No timeout extension or retrospective fix claim.

## Operation policy and remaining D work

| Operation | This checkpoint | Required before production |
| --- | --- | --- |
| CREATE | Metadata plan; separate fixed no-clobber native primitive | Durable ownership journal, adapter, recovery/crash proof |
| REPLACE | Metadata plan only; backend denied | Expected-ID atomic native replacement, ACL/stream policy, recovery |
| DELETE | Metadata plan only; backend denied | Recoverable staged deletion; no irreversible early removal |
| RENAME | Explicit DELETE+CREATE plan, never guessed | Destination conflict + recoverable paired operation semantics |

No multi-file atomicity is claimed. Intended future contract is per-file old/new
atomic publication plus a durable metadata journal recording pending/committed
operations; partial multi-file publication must be detectable and recovered only
when ownership/base/current IDs match. Unknown identity or concurrent user changes
must retain evidence/FAIL safe, never repair arbitrary files.

Next subsystem: durable minimal project transaction ownership/phase journal and
safe native replacement design, then recovery at each phase including real
process kill. Only after those proofs integrate controller publication into the
real disposable Git fixture pipeline, require exact verified/LSP/published digest,
host tests/intended Git diff/receipts/cleanup and all D acceptance controls. Then
E1/E2/E3 full engine certification, Doctor/backup/reconstruction. Current D is
IN_PROGRESS, not COMPLETE; autonomy and full portability remain blocked/pending.

Candidate verification is recorded in `phi-progress.md` and
`phi-portability-report.md`. Required native cases are mandatory on Windows and
skipped (not credited) on Linux. All controls use deterministic local programs,
with zero external model/provider calls and no Pi/auth/routing changes.
