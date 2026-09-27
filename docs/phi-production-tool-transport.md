# Production Windows tool transport — B1 bounded proof verified

State: B1 COMPLETE on569e23d/CI36313233404 SUCCESS, both native runners/clones.
Windows178/169PASS/0FAIL/9skips, separate primary/cleanupPASS. Historical f006
pre-receipt failure did not reproduce, cause UNKNOWN; fixed-code diagnostics
now preserve future controller failures. Prior fbb proof remains exact-run only.
Separate primary/cleanup proof and exact budget contract: phi-clean-clone-cleanup.md.
A remains COMPLETE. B2 controller/Worker candidate IN_PROGRESS, native unverified;
see phi-worker-tool-transport.md. C LSP/D publication NOT_STARTED; autonomy BLOCKED.

Historical report-only tested HEAD51460dbb11f5c6503c680fd5811dec79d5f4afc5:
[CI36302582518](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/36302582518)
FAILURE. Direct Windows tests retain154PASS/0FAIL/9skips, Ubuntu suite/clone PASS,
but independent Windows clone cleanup throws EBUSY in phi-clean-room.mjs finally.
No clone receipt is emitted; underlying report/timeout/lock owner are UNKNOWN,
cleanup FAIL and no no-orphans certification. No retry or product change follows.
The prior successful native proof below is historical, not a final gate waiver.
Next diagnose/preserve primary failure metadata and reproduce ownership/timeout
before a targeted fix; require green clone cleanup before B1 closure/B2.

Functional9be8ac0f6e41e831bdec0302ae0fef606063792e, real
[CI36301697234](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/36301697234)
SUCCESS, both native OSes and independent source-with-spaces clones.
Windows163/154PASS/0FAIL/9Linux-only skips; focused B1 11/10PASS/0FAIL/1Linux-only skip.
Ubuntu focused163/74PASS/0FAIL/89Windows-only skips; complete Linux696/607PASS/0FAIL/89skips.
Syntax/installed-Pi TypeScript/package validation PASS. Every previous144 native
passing case retained; extra skip is the new explicitly Linux-only host-rejection
test, not a required Windows test disabled. Exact receipt: phi-native-tool-transport-evidence.json.

## Actual call graph / spawn classification

| Production surface | Windows route | Classification |
|---|---|---|
| registered safe_exec | extensions/safe-exec.ts -> shared/safe-exec-handler.mjs -> shared executeCodingTool -> windows/coding-tools.mjs -> runWindowsSecureBroker -> native ExecutionBroker -> OwnedProcess | BROKERED verified bounded subset; registered Node file commands only |
| verification_gate | extension -> shared verifyCodingProject -> verifyWindowsProject -> native anchored snapshot -> registered checks -> executeWindowsCodingTool -> same LPAC broker | BROKERED verified bounded subset; no pi.exec on Windows |
| verification CLI | scripts/verify-project.mjs Windows branch -> same shared verifier | BROKERED verified bounded subset; exits before Linux discovery/spawn |
| workflow / Worker delegation | secure-workflow -> requireCodingBackend(workflow) | BLOCKED, B2 integration/role identity pending |
| safe_remove / EditEngine | requireCodingBackend -> native filesystem integration missing | BLOCKED |
| LSP / DAP / Persistent Eval | shared sandboxInvocation/admission | BLOCKED, no Job-only fallback |
| Linux safe_exec / verification | existing sandboxInvocation / Bubblewrap; existing discovery and Git check | LINUX_ONLY, unchanged execution |
| native helper build/status / snapshot extraction / scope recovery | tracked helper, fixed endpoint, direct argument vector | INTERNAL_TRUSTED controller; target commands never run here |
| Git resources / worktree allocator | own bounded/hardened Git sites, no new coding activation | INTERNAL_TRUSTED, native allocation/identity integration pending |
| browser | existing Linux sandbox backend | LINUX_ONLY |
| Agent Hub | projection/cancellation, no new launch authority | INTERNAL_TRUSTED |

No Windows target path uses pi.exec, spawnSync(target), shell concatenation,
the bare Job runner or caller-selected platform/runner. The old full-workflow
gate remains false. Source-wiring regressions accompany actual native runtime
tests; source matching is not native enforcement evidence.

## Authority and supported subset

Tool inputs remain program/argv/cwd/timeout only. Windows accepts Node file
commands, or exactly node --check FILE. Entry must be a snapshot-relative
ASCII js/cjs/mjs file. No inline code, interpreter flags, shell, arbitrary
executable, env, role/profile, grants or runtime override.

Syntax inspection uses READ_ONLY; file/test execution uses TEST. Both have
read-only workspace and isolated writable scratch. B1 grants NO EDIT, including
interactive callers. Receipt role scout/tester denotes the code-owned execution
profile principal, NOT a proven delegated subagent identity. Actual Worker
authority/session binding is the B2 task; do not claim Worker completion.

The registered tool executor is directly reusable in source-only tests without
substituting Pi's virtual typebox schema runtime. This proves the actual
registered execution branch plus shared dispatch, not a fresh installed Pi
Windows session, model delegation or a whole-workflow E2E.

Verification reads package.json from the native anchored snapshot and accepts
selected scripts only when exactly one registered Node file command. Shell
scripts, npm, compound commands, arbitrary Node switches and other toolchains
fail closed. Unsupported selected checks cannot be silently omitted to PASS.
No selected checks means NO_CHECKS/exit2. Nonzero stops the sequence/exit1.
Listing is explicitly non-executing, never a verification PASS.

Node's node:test API can run in an ordinary file; CLI --test child-pipe modes
are deliberately unregistered pending compatible confined transport. There is
no change to Node/Pi or dependency installation.

## Snapshot and publication lifecycle

Native --project-snapshot is read-only INTERNAL_TRUSTED extraction:
single-component no-reparse NtCreateFile, actual root/file identities,
handle enumeration, single-linked regular files, strict UTF-8, no write/delete
sharing, source handles pinned until extraction completes. Protected entries
(.git, dependencies, auth/credentials/key directories/files) are excluded by
name without reading them. Other junction/hardlink/invalid/binary/overflow
entries fail closed, not followed or silently replaced. Bounds remain
256 files/512KiB/12 levels/2,048 enumerated entries/5s controller scan.

Base root/file identities and contents produce snapshotDigest. Payload is
internal transient source data, not a receipt/trace. Receipt contains only
snapshot digest, backend/security facts/session/result/cleanup/state.

Actual B1 lifecycle: SNAPSHOT_CREATED -> command -> VERIFIED, or failed
command plus completed owned cleanup -> ROLLED_BACK. Cleanup failure -> FAILED,
existing journal/recovery rules apply. projectPublished is ALWAYS false.
VERIFIED means that command completed on that extracted snapshot, not that all
project acceptance criteria or a proposed diff passed.

No EDIT_APPLIED/READY_TO_PUBLISH/PUBLISHED transition is reachable in B1.
No naive recursive copy, host ACL grant, in-place host edit or concurrent-user
overwrite is introduced. Native broker scope cleanup destroys the disposable
execution copy; base data currently lasts only for the controller verification
sequence, not a durable Worker draft.

Later B2/D design: controller-owned Worker/session/task authority -> explicit
edit draft -> verified diff and base identities/hashes -> native transaction
prepare/flush/validate -> destination compare -> atomic replacement ->
post-apply validation -> PUBLISHED receipt. Stale destination fails/rebases via
existing EditEngine conflict policy. Cancellation/crash must retain owned
journal identity, never guess ownership or overwrite user changes.

## Evidence / limits

Local regression/gate counts are recorded in phi-progress.md. Mandatory actual
Windows tests now prove the registered production safe_exec handler (not a
substitute fixture executor), actual shared-dispatch verification and its CLI:
real Git fixture/source/local CJS imports/node:test unit execution, syntax,
READ_ONLY/TEST token/Job/start/session/backend attestation, scratch writes,
actual protected/workspace write denial with unchanged source, source extraction
hardlink/junction positive controls followed by rejection, nonzero73/FATAL,
timeout124, actual abort, unavailable-helper no-fallback and cleanup.
In the preceding successful run, both source clones rebuild all six sources and repeat their corresponding
counts/cleanupPASS without auth or ignored runtime copy. Native read-only recovery
Doctor row PASS; whole clone Doctor still FAIL/full engine BLOCKED_NOT_INSTALLED.
This is not full product acceptance. Runtime payload evidence is CJS; js/mjs
entry grammar is accepted but not independently certified by these B1 cases.
Candidate push for CI was explicitly authorized after Linux gate green.
The later report-only recheck failed Windows clone cleanup as recorded above;
do not carry that prior PASS across runs.

Remaining: actual Worker binding/edit drafts (B2), real Pi Windows startup,
additional runtimes/dependencies, directory cwd, Unicode/binary snapshots,
streaming LSP(C), crash-atomic publication(D), native coding/security/crash E2Es,
full Doctor/backup/reconstruction. Native helper hash integrity is not signed
or private-ACL build trust; quotas/syscall bounds remain incomplete as in A.
No new model/provider calls, credentials/Pi/routing changes or autonomy switch.
