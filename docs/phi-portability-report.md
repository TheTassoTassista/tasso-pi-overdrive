# Phi portability / disaster-recovery checkpoint

**PHI PORTABILITY: IN PROGRESS**

This is a safe partial checkpoint, not permission to wipe the current machine. Goal A (complete native Windows coding) and Goal B (full Git-only disaster recovery) are not yet complete. Existing Linux Pi/Overdrive remains intact.

## Source and actual evidence

- Audited functional source: `2b743cd7274470ba8b8c621a2c2a04ea9caacc12`.
- Branch: `feature/routing-presets-quality`. Later commits update documentation only; read exact delivery HEAD with `git rev-parse HEAD`.
- Existing repository/remote: `https://github.com/TheTassoTassista/tasso-pi-overdrive.git`, name `tasso-pi-overdrive`, visibility **PRIVATE**, verified through GitHub. No new repository, force push, tag, PR, release or default-branch change.
- Native CI [36246587895](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/36246587895): **SUCCESS** on real Windows and Ubuntu. [Machine-readable scope receipt](phi-native-confinement-evidence.json).
- Local authoritative Linux: **591 total / 579 PASS / 0 FAIL / 12 native-Windows tests explicitly skipped**. All original 570 Linux tests retained. Syntax, TypeScript against installed Pi and package/pinned-policy validation including its secret scan PASS.
- Actual Windows focused suite: **58 total / 51 PASS / 0 FAIL / 7 Linux-only skipped**. Ubuntu: **58 / 46 PASS / 0 FAIL / 12 Windows-only skipped**. These are expanded foundation/process/confinement suites, NOT full Windows coding regression coverage.
- Both separate Git clones in a path containing spaces rebuild/test from committed source: **PASS_FOUNDATION_ONLY**, all corresponding OS tests repeated, cleanup PASS, no auth or ignored runtime copied. Both report full engine `BLOCKED_NOT_INSTALLED` and Doctor FAIL for the deliberately absent Pi/full backend. These results must not be relabelled full disaster recovery.

Reproduce focused checks with `npm run check:phi`. The authoritative Linux gate is `PI_OVERDRIVE_LSP_RUNTIME="$PWD/runtime/lsp" npm run check` after documented managed LSP installation. Actual native API evidence requires the real Windows CI; Linux skips do not simulate Windows.

## Windows security / execution status

- Process backend: source-built native x64 .NET Framework helper, atomic CreateProcess Job assignment before resume, explicit stdio handle list, guardian-generation handle, fixed lifetime/process/output bounds, normal/error/timeout/caller/helper death cleanup tests PASS.
- Confinement primitive: LPAC with exactly `registryRead`, fresh profile SID and actual token/capability checks before resume, mandatory ALL_APPLICATION_PACKAGES opt-out behavioral control, role-specific ACLs and low-integrity writable scratch/workspace.
- Actual probes PASS: synthetic private file/registry denial, host process-handle duplication denial, protected/runtime WRITE_DAC denial, runtime write/rename denial, ADS/extended-path denial, existing junction/private-hardlink/read-only-hardlink access controls and live listening network denial. Worker writes fixture workspace; Tester/reviewer cannot. Original bytes checked unchanged. Ordinary profile/files/registry and Job cleanup PASS for every role and both clones.
- ADS fixture setup and junction cleanup failures were reproducible native defects, fixed without reducing assertions or granting broader authority. The controller proves real aliases/streams exist before denial tests. Native junction removal does not traverse the target; its target survives until owned-tree deletion.
- **Windows sandbox adapter remains not implemented/autonomousReady=false. Coding launcher and arbitrary safe_exec/Worker/Tester/tools remain BLOCKED.** The fixed probe is not registered as a model tool and the bare trusted Job runner is not reused as an untrusted sandbox.
- Native coding E2E: **NOT RUN — unsafe engine intentionally blocked**. No WSL or Linux container evidence substituted.

## Recovery / configuration / privacy

- Active Phi 1.0.0, official Pi **0.87.1** unchanged. Actual host `phi doctor`: **WARN, 0 FAIL**, no model calls; optional services and live sandbox/runtime attestations are not silently counted PASS.
- Top-level `openai-codex/gpt-6-sol:medium`, routing, Council/Judge, retry policy, concurrency 3, depth 1, correction limit 2, spawn envelope 42 and Second Brain preserved. No auth/provider/API-key change or new Pi inference.
- Linux configuration-only backup/restore tests PASS. Auth/secrets/live callability/browser profiles/private memory excluded; official login is separate. Windows backup/restore remains BLOCKED pending native ACL/private-state/journal guarantees. Linux restore crash/concurrent-writer atomicity is not yet guaranteed.
- Indexed Git blobs and HEAD-ancestry blobs audited for private/generated artifacts, credential-like values and machine paths: **0 FAIL**. Status WARN for narrowly classified invalid fixture/detector/historical/synthetic paths. Heuristic scans are not exhaustive secret-absence proof and do not audit all Git metadata/private prose.
- No newly introduced production dependency on developer home/temporary Codex paths. Existing Linux descriptor-relative `/proc` operations and host-specific reviewed identities are documented adapter/reconstruction gaps, not blindly replaced with unchecked paths. [Inventory](phi-reconstruction-inventory.md).
- Protected user document SHA256 before/after: `f556b3adc88e58f5319f208b4a74c496705ef90b24680bf8bde12e5ce5a9f3ba`. Auth-file SHA256 unchanged; values never copied/printed. The pre-existing protected document modification remains uncommitted and unstaged; no claim of a globally clean user worktree.
- Repository rename preparation: retain the same private repository/history/settings; defer the coordinated name/remote/link change to `Phi` until the safe integration checkpoint. No disconnected second repository or public visibility is needed.

## Exact next implementation

At low session quota, stop only after this tested source plus report are committed/pushed. Do not begin by unblocking Windows.

1. Implement durable per-user AppContainer scope ownership/crash-recovery journal, anchored controller path authority and actual hostile replacement/kill/recovery tests. Review capability/system-metadata scope and dynamic/native child execution before accepting arbitrary programs.
2. Build the real native SandboxBackend/FilesystemBackend and connect existing ResourceFS/Edit Engine/worktrees/process identities/locks/governors/tools/LSP through it; preserve all Linux paths and fail closed for unimplemented operations. Prove full credential-free native coding workflow/cleanup on Windows.
3. Complete pinned Linux/Windows runtime/package/tool bootstrap from Git only, safe local initialization and optional-service separation, native backup/restore protections and full fresh-machine coding acceptance on both OSes. Authentication remains official user login, never copied to CI.
4. Then expand full platform gates, coordinate the existing private-repository rename and update final recovery/portability certification. Do not declare COMPLETE until both closure goals are demonstrated.
