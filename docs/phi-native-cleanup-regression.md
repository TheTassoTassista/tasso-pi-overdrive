# Native cleanup regression — bounded kernel-object lifetime handling

Scope: fixed, positively journaled native Phi fixtures only. **Windows autonomy remains BLOCKED.** This is not a generic LPAC broker, transactional EditEngine or Windows coding E2E.

Functional source: `94c6b4d3e36c3ac2ad4ba800e42d359f82815acb`. Real final [run 36279000733](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/36279000733) **SUCCESS**, both runners and independent source clones. Windows **134 / 127 PASS / 0 FAIL / 7 Linux-only skips**; Ubuntu **134 / 64 PASS / 0 FAIL / 70 native-Windows skips**. All 13 individual affected cases and the combined 13-case sequence pass. Full post-native Linux gate **667 / 597 PASS / 0 FAIL / 70 skips**, syntax/installed-Pi TypeScript/package-secret validation PASS. Do not infer whole-engine certification from these bounded results.

## Proven operations, not an undifferentiated “access denied”

| State | Actual failing API / authority | Native evidence |
| --- | --- | --- |
| File held without delete sharing | `NtCreateFile`, single leaf relative to a pinned directory, access `00110080` (DELETE, READ_ATTRIBUTES, SYNCHRONIZE), share READ `1`, options `00200060` | `STATUS_SHARING_VIOLATION` `c0000043`, Win32 **32**; the controlled handle is owned by the fixture controller. |
| Root already delete-pending, still referenced | `NtCreateFile`, relative root open, access `00110081` (also LIST_DIRECTORY), share READ `1`, options `00200021` | `STATUS_DELETE_PENDING` `c0000056`, `RtlNtStatusToDosError` gives Win32 **5**, not a DACL denial. The controlled root handle's actual file ID matches its journal. |
| Child directory delete-pending, still referenced | `SetFileInformationByHandle`, FileDispositionInfo class **4**, DELETE authority on the same verified ordinary directory handle | Win32 **145**, DIRECTORY_NOT_EMPTY; reproducible with an empty child whose verified handle remains open. Also observed in real Worker-role clone cleanup and Reviewer-supervisor recovery. |

The defect was incomplete lifecycle handling: deletion-disposition retry began only **after** successful acquisition, and excluded the parent-directory 145 condition. Job active-process count zero does not establish that every filesystem reference has closed. No evidence identifies a particular antivirus/indexer as the holder on an expired historical runner; no such attribution is made.

These controls independently exercise the documented [NtCreateFile rights/sharing](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile), [delete-pending NTSTATUS](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-erref/596a1078-e883-4972-9bbc-49e60bebca55), and [directory lifetime until last handle close](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-removedirectoryw). The proof is the actual native controls, not documentation or Linux static tests alone.

Original run [36267318046](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/36267318046) recorded Win32 5 in final recovery but **did not record its NTSTATUS/API**. That historical missing information cannot be reconstructed retroactively. The precise 5-producing operation above is independently reproduced on real Windows, not guessed from that report. Ordinary STATUS_ACCESS_DENIED `c0000022` is not included in acquisition retry.

## Primary / cascade distinction and investigation history

- Original six failures: timeout-case final recovery failed, then `clean`, `pid-reuse`, `corrupt`, `unknown-field`, `oversized` failed in `Begin()`'s global startup recovery **before creating their own fixtures**. These are a primary cleanup failure plus quarantine cascades, not evidence of five independent ownership defects.
- Later run [36267546143](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/36267546143) passed its first native suite but failed the independent clone. A green first suite was not accepted as resolution.
- Metadata-only diagnostic source `347df3e` passed both suites/clones in run [36277156748](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/36277156748), demonstrating intermittency, not a fix.
- Native runs `36277511249` and `36277668019` disproved guessed pending-leaf/descendant-retains-parent controls. Pending leaves are omitted by enumeration; a descendant handle alone did not reliably retain the root. The corrected control directly holds the captured root object. Negative investigation outcomes are retained, not credited as PASS.
- Run [36277832871](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/36277832871) proves both exact NtCreateFile states individually and sequentially; its independent clone still failed. Source `8acd32e` fixes acquisition but run [36278240554](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/36278240554) exposes real Worker-role clone failure at **DISPOSITION / 145** (one failed test, no five-case cascade).
- Run [36278694724](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/36278694724) independently reproduces 145 with a single controlled child directory and also fails real Reviewer-supervisor recovery at the same API. This is why 145 handling was added, rather than broadly retrying unknown errors.

## Product fix and preserved boundaries

`platform/windows/native/RecoveryFilesystem.cs` retries acquisition only for the two proven NTSTATUS values. It repeats the single-component **handle-relative lookup before the first successful child open** while its parent remains pinned; it does not reopen a previously acquired child or traverse a DOS path. A successful root still must match the journal's actual file ID before any deletion. Final reparses are never followed. A leaf which actually disappears becomes idempotent absence, not authority over another path.

Disposition still acts through the same acquired handle. Additional 145 retry is restricted to an ordinary directory (`attributes & 0x410 == 0x10`), not a file or reparse target. It neither rescans new data nor clears readonly/ACLs. If the directory stays nonempty, the command still fails and preserves its journal.

All retries share the original **5-second monotonic cleanup budget**, including root acquisition; no per-entry reset or larger product timeout. Polling is 10 ms, conditional on the proven native failure, not a fixed large sleep. Existing depth 16 / 2,048 entries, 64 scopes / 10-second recovery pass, Job/token/rights/share limits remain unchanged. Deadlines are cooperative between native calls, not a promise to cancel a hung kernel syscall.

Unknown/mismatched roots and corrupt journals remain quarantined. No broad process kill, permission takeover, attribute clearing, unsandboxed fallback or readiness switch. Native recovery kills **zero** processes; tests deliberately terminate only their observed fixture processes.

## Regression and forensic evidence

`ScopeRecovery.cs` / `tests/phi-windows-confinement.test.mjs` prove:

- sharing and pending-root handles held past the budget: actual failure, owned data/journal preserved;
- sharing/root/child-directory release **after observing a real retry**, rather than an arbitrary sleep: complete cleanup;
- a permanently referenced child directory: actual 145 after the budget, actual root identity retained;
- failed recovery retains its receipt and blocks a new scope; closing only the fixture's known handle permits subsequent idempotent recovery; the unrelated live PID generation is never killed;
- original timeout, supervisor/parent/guardian/Worker/Tester/tool-death, ownership/unknown-resource, readonly, mapping, depth, anchored-filesystem and platform-dispatch coverage retained.

`scripts/phi-windows-recovery-focus.mjs` runs affected cases individually, then sequentially and requires the exact matched PASS count; zero matching tests cannot pass. `npm run check:phi` still runs every supported case in suite order and the independent source-with-spaces clone repeats it.

Diagnostics contain only fixed API names, rights/flags/errors, actual object IDs and SHA-256 leaf digests. No raw leaf/DOS path, ACL text, exception, prompt, environment or contents. Nested receipts preserve the exact whitelisted record across clone redaction. Scope/PID correlation is separately schema-validated. A primary safe receipt is emitted before final recovery can overwrite the reported assertion with a secondary error; neither failure is suppressed.

The clone foundation-test budget is 180 seconds to include explicit held-open negative controls and cascade passes. Other clone stages remain 120 seconds. This does **not** extend any production cleanup/recovery/lifetime limit.

## Reproduction and remaining scope

On native Windows with the checked system-compiler helper: `node scripts/phi-windows-recovery-focus.mjs`, then `npm run check:phi`, then `node scripts/phi-clean-room.mjs`. On the existing Linux host: `PI_OVERDRIVE_LSP_RUNTIME="$PWD/runtime/lsp" npm run check`. No new Pi/model/provider execution is involved.

The recovery prerequisite is now green; the next engineering step is the trusted generic LPAC launch/stdio broker, then real LSP confinement and crash-atomic writes in that order. Historical holder identity remains unavailable; no retrospective kernel-handle-owner certificate is implied. Whole-engine confinement/transactions/coding E2Es, full Doctor, Windows backup/restore and full disaster recovery remain unfinished independently of this bounded fix.
