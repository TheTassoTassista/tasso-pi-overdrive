# Native Windows trusted-process backend

This adapter is process ownership, NOT the autonomous execution sandbox. Windows coding launch and safe_exec remain blocked. No WSL, downloaded SDK, new Node package, API key or model call is needed to exercise it.

## Implemented control plane

- `platform/windows/native/OwnedProcess.cs`: Windows x64 Job supervisor, explicit inherited stdio, bounded request parsing, normal/failure/timeout cleanup.
- `platform/windows/process.mjs`: shared-interface dispatch, bounded input/output/lifetime, cancellation, source/build-hash checks.
- `platform/windows/build-process.mjs`: direct system .NET Framework compiler, explicit system references, no shell command string or ambient compiler response file; generated cache is ignored, never copied from the development machine.
- `scripts/build-windows-process.mjs` plus thin PowerShell wrapper: source-only reconstruction and idempotence for matching hashes, refusal to overwrite conflicting builds.

Required native target: Windows >=10 / Server 2016, x64, Node >=22.19, system .NET Framework v4 compiler/runtime. Local hashes are integrity checks, not signature/private ACL or machine-security attestations. A changed/stale build requires a fresh source checkout; no automatic destructive cache deletion.

Job assignment uses `PROC_THREAD_ATTRIBUTE_JOB_LIST` **during CreateProcess**, before the suspended thread resumes. The older create-suspended/assign sequence has an orphan window if the supervisor dies before assignment, as [Microsoft explains](https://devblogs.microsoft.com/oldnewthing/20230209-00/?p=107812/). [The attribute API](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute) also restricts inherited handles to stdin/stdout/stderr; the anonymous Job handle is never inherited. Limits are code-owned: 32 native processes, <=120 seconds lifetime, 1 MiB request/input and 2 MiB Node output. These are tool-process limits, not permission to increase existing agent concurrency/depth/correction/spawn budgets.

The native owner waits on the root process and a generation-checked guardian handle. Guardian PID reuse after helper creation is rejected. No arbitrary stored PID is killed. On normal parent exit or timeout, the complete Job is terminated and active-process count must reach zero before a successful return. Abrupt helper death closes its Job handle. This proves lifecycle for the tested trusted descendants, not resistance to malicious same-user handle duplication; an AppContainer/restricted token is still needed for untrusted processes.

Requests stay in stdin pipes, never command-line JSON, temporary request files or traces. Child argv is CRT-encoded, never shell-expanded. Child environment is preserved for **trusted package verification only**; never reuse this full environment for autonomous tools. Role-specific sanitized environments, filesystem, network and protected-state boundaries must be implemented with the sandbox adapter.

## Native evidence and reconstruction defect

Native lifecycle tests exercise actual stdout/stderr/stdin, Unicode/spaces/metacharacter argv, cwd/environment, detached child/grandchild cleanup, timeout, forced helper and Node-caller death, cancellation of an observed running tree, output-limit cleanup, failed spawn and malformed requests. Non-Windows runs explicitly skip native tests, never fake the platform.

The first native compilation/lifecycle tests passed, but the second clean clone failed invoking Desktop PowerShell from Node. Read-only shell identity invocation failed there too; the exact underlying Windows PowerShell startup cause remains unproven. No execution-policy/GPO/registry change was attempted. The unreliable child-shell dependency was replaced with direct `csc.exe` argv; hosted Windows source clone and native tests then passed. Metadata-only diagnostics retain fixed stages/codes/numeric counts, normalize pipe encoding and reject arbitrary lookalike diagnostic identifiers. No raw failed output, test names, command arguments, environment or private paths are included in those receipts.

The native CI/clone receipt and exact final counts are in `docs/phi-progress.md`. This is still NOT Windows coding E2E, full AppContainer/ACL security parity or complete disaster recovery. Interactive Windows Pi launch remains blocked. Next layer must verify filesystem read/write grants, protected secrets, network denial, process/handle escape resistance and read-only Tester/reviewer roles before integrating autonomous tools.
