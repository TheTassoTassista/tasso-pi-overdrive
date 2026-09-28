# D — transactional project publication (IN PROGRESS)

## Durable journal continuation (native verified subsystem, not publication)

Exact functional **d817f0962f1875d01407ba08ffebb00a7334fd84** /
[CI36448649855](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/36448649855)
SUCCESS: dedicated journal19/19PASS (18 native controls plus1 source guard),
Windows264/254PASS/0FAIL/10Linux-only skips, Ubuntu264/117PASS/0FAIL/147native
skips, retained CREATE18/18, both independent clones/cleanup and three actual-Pi
deterministic regressions PASS. Full Linux797/650PASS/0FAIL/147native skips and
syntax/TypeScript/package validation PASS. [Metadata-only proof](phi-publication-journal-evidence.json).
This accepts the precommit journal only: D remains IN_PROGRESS and Windows
autonomy BLOCKED; no actual project publication/crash recovery is claimed.

`platform/windows/native/PublicationJournal.cs` is now the trusted native journal
subsystem. Its class is not a model tool, publication endpoint or project writer.
`executePreparedWindowsPublication` remains BACKEND_UNAVAILABLE. Private registry
`HKCU/Software/Phi/PublicationJournalV1` reuses validated user/SYSTEM-only ACLs;
each new transaction binds an exclusive private named lease, creator PID **and
generation**, project root native ID, original target IDs/digests, draft ID/version,
verified/base digests and explicit CREATE/REPLACE/DELETE metadata. No project
absolute path, source contents, environment or credential payload is stored.
Metadata is deep-copied; protected paths/case aliases/duplicate IDs/extra fields
are rejected. Fixed per-transaction bounds:512 events,64KiB/event,64 operations.
The64-record admission census is checked under a per-ID lease, not a global
allocator; concurrent different-ID creators require proven serialization before
production. Do not advertise it as a hard cross-ID concurrent resource cap.

The journal is append-only `E00000000` onward: bounded binary format/version/length,
SHA256 envelope integrity plus previous-event hash and strict sequence/state graph.
Each event is synchronously flushed and read back; the first event also flushes
the parent key. A failed persistence poisons the writer; an empty/unknown/torn/
gapped/corrupt/unsafe-ACL journal is retained, not silently successful or deleted.
[RegFlushKey](https://learn.microsoft.com/en-us/windows/win32/api/winreg/nf-winreg-regflushkey)
documents persistence of the containing hive on return; it is expensive and has
no hard syscall-latency guarantee. This is not a power-loss hardware certificate.
Private same-user controller/runtime remains TCB; checksum is integrity detection,
not a signature against malicious code with the user's own authority. Removing a
valid tail can yield an older valid prefix; restart still requires recovery and
never treats even a clean prefix as publication success.

Explicit phases include PREPARED/TEMP_WRITTEN/TEMP_FLUSHED/READY_TO_COMMIT/
COMMIT_STARTED/COMMITTED/VERIFIED/CLEANED plus CONFLICT/ROLLBACK_REQUIRED/
ROLLED_BACK/RECOVERY_REQUIRED/FAILED. Skipped phases/terminal resurrection deny.
Actual COMMITTED/VERIFIED/CLEANED writes/read certificates are denied until real
native commit/cleanup observations exist. The class currently tracks precommit
metadata only; it does not implement partial multi-file progress or rollback.

`Inspect` re-opens and validates the whole bounded chain and project root/base
manifest. A busy lease or live matching generation is ACTIVE; a dead producer
with matching base is RECOVERY_REQUIRED; concurrent target content/native-ID
changes are CONFLICT. Wrong project ID, unknown schema/ACL/integrity deny. It
never changes project/temp files or journal keys, kills processes, infers a
commit from a temp file, or performs rollback. Unknown resources remain untouched.
Full unchanged-manifest preflight remains the controller's separate responsibility;
this journal check is per planned target, not a replacement for that preflight.
Startup inspection requires a separately trusted caller supplying the project
root; the journal deliberately stores no absolute project locator. Automatic
whole-project startup recovery/discovery is not implemented. Registry records
are retained in production; retention/terminal reclamation still needs the
publication adapter rather than an arbitrary key/path cleaner.

Required native fixed fixtures include persistence/phase/duplicate/live-lease,
corrupt/gap/size/unknown-schema/ACL, wrong-root, user-change/same-content-ID change,
protected path and five real writer terminations/restart inspections. The fixed
child can borrow only a validated live ScopeRecovery root (private record, lease,
generation, native ID), not an arbitrary pathname. No model calls. Deliberate
fixture corruption is removed only by that original test owner, not recovery.
TEMP_* fixture phase events simulate **journal progression only**, not physical
temp operations. These receipts always projectPublished=false, committed=[] and
cleanup=NOT_PERFORMED (journal inspection); owned test-fixture cleanup is separate.
They are NOT actual publication-crash, restart rollback or D completion proof.
Fixture draft ID/version and aggregate verified/base digests are schema-only
fixed metadata, not actual Worker verification proof. Actual per-target native
IDs/hashes and conflict/ownership checks are exercised; a future controller
adapter must bind aggregate digests to the real opaque verified draft grant.
The same-content replacement control additionally requires actual sharing32
denial while the producer pins are live, kills that producer, then recreates the
same text as a new native object and requires CONFLICT from the new inspector.
Thus a blocked live namespace operation is not mistaken for successful concurrent
replacement, nor worked around by widening production sharing or releasing pins.

Safe replacement remains unresolved. Microsoft's
[FILE_RENAME_INFORMATION](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information)
allows POSIX replacement with open target handles, but documents no expected-target
identity compare-and-swap. It must not be used as an unvalidated replacement.
[Oplock types](https://learn.microsoft.com/en-us/windows/win32/fileio/types-of-opportunistic-locks)
retain sharing violations when incompatible handles are not closed; introducing an
oplock alone is not proof that safe replacement can proceed without releasing the
protected destination. Narrow native experiments/actual identity and crash proof
must precede any production replacement adapter. No new rights/sharing/driver,
filesystem transaction dependency or silent compatibility fallback was introduced.

## Retained preflight/CREATE checkpoint (39daeba)

The preceding checkpoint implements immutable baseline/preflight/authority and a
separate native no-clobber CREATE primitive. It did **not** implement a journal;
the journal continuation above does not yet implement production project
publication, replacement, rollback or publication restart recovery. Windows autonomy remains BLOCKED. B1/B2/C are retained, not
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

Next subsystem: expected-ID safe native replacement design and proof, then bind
the now-proven precommit journal to physical temp/commit observations and recover
at each actual mutation phase including real process kill. Only after those proofs integrate controller publication into the
real disposable Git fixture pipeline, require exact verified/LSP/published digest,
host tests/intended Git diff/receipts/cleanup and all D acceptance controls. Then
E1/E2/E3 full engine certification, Doctor/backup/reconstruction. Current D is
IN_PROGRESS, not COMPLETE; autonomy and full portability remain blocked/pending.

Accepted functional39daebadb8ee3c069597591c39b3b16a91ae291d /
[CI36338087065](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/36338087065)
SUCCESS: native245/235PASS/0FAIL/10Linux-only skips, dedicated CREATE18/18 and
retained real LSP/actual Pi/both source clones green; full Linux778/649PASS/
0FAIL/129native skips plus syntax/TypeScript/package validation PASS.
[Exact metadata-only receipts](phi-publication-evidence.json) retain readiness,
conflicts, native primitive, owned clone cleanup and actual-Pi regression proof.
This confirms the no-sharing-change same-directory fix; it does not retrospectively
explain the separate prior Worker timeout, nor complete D. Additional verification
details are recorded in `phi-progress.md` and `phi-portability-report.md`.
Required native cases are mandatory on Windows and
skipped (not credited) on Linux. All controls use deterministic local programs,
with zero external model/provider calls and no Pi/auth/routing changes.
