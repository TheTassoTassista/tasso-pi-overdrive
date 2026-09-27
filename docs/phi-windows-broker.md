# Windows LPAC broker — bounded infrastructure

Status: VERIFIED bounded non-interactive broker infrastructure (checkpoint A). WINDOWS AUTONOMY remains BLOCKED. Functional2d8ea910290d38c4252d32c739c088489464b591, real CI36295947175 SUCCESS, both real runners and independent source clones. No whole-engine certificate.

## Actual execution surface

| Surface | Actual launch boundary | Treatment |
|---|---|---|
| Worker / safe_exec | extensions/safe-exec.ts -> shared/coding-execution.mjs -> pi.exec | Existing Windows denial retained; broker transport integration next. |
| Tester / verification / package scripts / test runners | scripts/verify-project.mjs -> shared dispatch -> spawnSync | Windows denied. Project scripts are untrusted, never bare Job-only execution. |
| Formatters / linters / compilers / interpreters | safe_exec, verification scripts, their project descendants | Require same-token/Job confinement; no host execution fallback. |
| LSP / LSP-on-write | lib/lsp-manager.mjs -> shared dispatch -> spawn | Blocked pending streaming transport and real supported server. |
| DAP | lib/dap-engine.mjs -> shared dispatch -> spawn | Blocked; targets are not read-only helpers. |
| Persistent Eval | lib/persistent-eval.mjs -> shared dispatch -> spawn | Blocked; arbitrary evaluation requires confinement. |
| Git resources | lib/git-resources.mjs -> own hardened spawn | Trusted controller path, external hooks/config/diff denied; native ResourceFS admission remains required. |
| Worktree allocation | lib/runtime-isolation.mjs -> own Git spawnSync | Trusted allocation operation, not confined workload; native identity/state/temp integration pending. |
| Browser | lib/browser-engine.mjs -> Linux bwrap spawn | Separate Linux-only backend; native browser integration absent. |
| Agent Hub | lib/agent-hub.mjs / agent-hub-control.mjs | No subprocess launch: read-only projection and cancellation of an existing attempt. |
| Editor / engine launcher | lib/editor-bridge.mjs / phi-runtime.mjs / shared/process.mjs | Trusted engine lifecycle; Windows autonomous launch denied. |
| Native build / Doctor / metadata discovery | tracked-source builder / fixed status CLI / fixed Git discovery | Trusted lightweight controller operations; not advertised as sandboxed workloads. |

## Contract and enforcement

`platform/windows/secure-broker.mjs` accepts executable path + SHA256, argv, snapshot-relative cwd, allowlisted environment, role-bound profile, explicit workspace/assets snapshots, network DENY, bounded timeout, guardian PID and session/operation/role context. `ExecutionBroker.cs` independently validates the entire schema. Direct helper invocation cannot skip validation. No shell concatenation, caller spawn override, network capability or host directory ACL grant.

Profiles READ_ONLY / EDIT / TEST: workspace read-only except EDIT; assets/runtime read-only; isolated scratch writable; exactly registryRead for OS initialization; no network; same LPAC/non-breakaway Job descendants, maximum32. Tester cannot select EDIT. Unknown LSP/BUILD/DEBUG/GIT/network profiles fail closed until justified and tested.

Node22 file startup required two compatibility fixes, without extra permissions: windowsNodeToolArguments preserves the already-scoped path for main/import resolution and disables global module search; original default-loader EPERM/lstat is reproduced as a negative control, followed by actual file/local-module execution. This changes module resolution semantics, not LPAC/ACL authority; arbitrary symlink/module-layout compatibility is not certified. Windows CreateProcess reroutes TEMP/TMP beneath supplied LOCALAPPDATA. The exact fresh scratch/Packages/Phi.Probe.ID/AC/Temp subtree is provisioned before launch. Real child equality/temporary writes/observed PID markers prove that location, not an assumed env override. No home/system grant or process-memory patch.

Runtime snapshot uses single-component NtCreateFile beneath pinned no-reparse parents, read only/no write-delete sharing/nlink1. Hash and copy use that exact handle. Fresh private root is durably journaled before grants. Source is never changed. Bounds:128MiB runtime;256 UTF-8 snapshot files/512KiB/12levels; request1MiB, tool output2MiB, lifetime120s. Grants reject traversal, ADS, device names, case duplicates and protected credential leaves.

AppContainerScope reuses ScopeRecovery/OwnedProcess: mandatory LPAC attributes, exact SID/registryRead token, real private-registry/journal/process-handle/WRITE_DAC and AAP-only canary denial before resume; atomic Job assignment and only three inherited stdio handles. Existing5s teardown, generations, lease/quarantine and zero recovery process kills retained. No competing lifecycle owner.

Host-owned anonymous pipes separate child output from control messages. Child output is serialized as base64 artifacts, NEVER parsed as metadata. Exact receipt whitelist contains no argv, paths, environment, snapshots, contents or diagnostics. A child's forged receipt cannot change actual exit/token/Job/cleanup. Interrupted proofs are UNKNOWN/null, not guessed. Cancellation/helper death closes the existing Job and reuses durable exact-scope recovery. Unknown ownership remains quarantined.

## Remaining limits

Generic non-interactive standalone tools run against disposable explicit snapshots, not a fixed built-in proof script. This is NOT yet ordinary Pi tool transport. Edits are not published into the host project. Streaming, multi-binary runtime registration, LSP URI mapping and Node-internal non-LOCAL pipes remain open. Inherited-stdio children are supported; arbitrary Node spawn/fork pipes are not certified. Permission failures never select a weaker runner.

Runtime evidence is standalone Node22/CJS and local CJS imports, not every executable/toolchain accepted by the generic request shape. Snapshot content is bounded UTF-8 text; relative names currently use a conservative ASCII grammar. Binary dependency bundles and Unicode snapshot filenames are not supported/certified yet. Unsupported workloads must fail, not silently change their source or acquire a host-directory grant.

All six C# sources are integrity-manifested; hashes are not signed/private-ACL attestation against a malicious full-trust same-user controller/cache. Bounds are not complete disk/CPU/memory quotas or hard syscall latency guarantees. Local DOS drives only, not UNC. Snapshot population precedes untrusted launch under private controller ownership; host extraction/publication needs ResourceFS integration. Existing recovery names retain compatibility labels, not an autonomy certificate. Crash-atomic writes, full native coding E2Es, Doctor/backup/reconstruction remain subsequent work.

API references: [NtCreateFile](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile), [explicit process attributes/handle list](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute), [host-owned anonymous pipes](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-createpipe). Readiness requires actual native evidence, not documentation/source inspection.

Reproduce after native build: `node --test tests/phi-windows-broker.test.mjs`, `npm run check:phi`, Git-source clean-room clone. Full Linux gate uses existing managed LSP. Zero model/provider calls.

## Actual proof and next step

[CI36295947175](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/36295947175): focused broker18/17PASS/0FAIL/1Linux-only skip; full Windows152/144PASS/0FAIL/8skips (all previous127 passes retained); Ubuntu152/69PASS/0FAIL/83skips. Both source-with-spaces clones rebuild all six C# sources and repeat corresponding counts, PASS_FOUNDATION_ONLY/cleanupPASS, no auth/ignored runtime copy. Thirteen recovery cases pass individually/sequentially; no required case disabled. Full Linux685/602PASS/0FAIL/83skips, syntax/installed-Pi TypeScript/package-secret validation PASS. Counts: phi-native-broker-evidence.json.

Native proofs: role source/temp writes, actual private/AAP/runtime/extended-path/live-network denials, independent schema/role/env/cwd rejection, hash/setup failure before target execution, runtime junction/hardlink positive controls then rejection, inherited-child alias/read-only denials, output/receipt spoof separation, actual73 propagation, overflow70, normal7/timeout124, cancellation125 and supervisor-death exact-scope recovery with observed PIDs gone. Interrupted token/start proofs remain null. Existing token/private-registry/host-handle and recovery controls remain mandatory.

Failed discovery runs retained:36295119646 (file-loader EPERM),36295475448 (classified lstat),36295599899 and36295762399 (SCRATCH/MARKER ENOENT,tempMatches=false/cwdMatches=true). Final proof resolves both causes; none counted PASS. Next exact subsystem B: actual safe_exec/verification/Worker transport with controller-owned role/program registration and handle-validated snapshot extraction/publication authority, workflow autonomy still blocked. Then real streaming LSP(C), only afterward transactions(D). Generic fixtures do not substitute for these missing integrations.

Primary compatibility references: [pinned Node loader options](https://nodejs.org/download/release/v22.23.2/docs/api/cli.html#--preserve-symlinks-main), [AppContainer environment redirection](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer). Runtime controls establish the result, not these sources alone.
