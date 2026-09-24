# Phase 26: evidence-backed multi-adapter DAP

Overdrive retains one conditional `debug_engine` model tool and one controller-owned session. The controller selects GDB for an existing workspace executable or debugpy for an existing `.py` source; the model cannot supply an adapter name, DAP request, host, port, attach target, expression, or raw debugger command. The public action set remains launch, source breakpoint, continue, step-over, stack, scopes, bounded variables/output, status, and terminate. A capability matrix in `lib/dap-engine.mjs` explicitly marks attach, evaluation, custom requests, and remote targets unavailable for both adapters. Phase 10's GDB backend was not replaced.

## Runtime and security evidence

| Adapter | Host status | Exact runtime | Authority |
|---|---|---|---|
| GDB | REAL_HOST_VERIFIED | `/usr/bin/gdb` 17.2, SHA-256 `5a159b8868d53a85bee261bc35dc59437800b1d139d0389d83e4fdee5a24945d` | Existing reviewed argv, networkless Bubblewrap, read-only workspace |
| debugpy | REAL_HOST_VERIFIED on this Linux host after managed install | `/usr/bin/python3.14` 3.14.7, SHA-256 `dd65a07e8f535525443d63e2bd6dd10efbf22bf22e0b6d65e634266acc7ac976`; debugpy 1.8.22 wheel SHA-256 `0c1104233340196e5cbf5514e7dfdbb98968e730cfd7fdd6f3d72a082be838a9`; module-tree SHA-256 `28fd1a1c1eaaa19efc055c51ee576ec9326726fa81ca1c95727383ae42756636` | Project-owned ignored runtime; only attested `debugpy` module is mounted read-only; same namespace/workspace/secret/cleanup policy as GDB |
| LLDB/CodeLLDB, Delve, js-debug | UNAVAILABLE/NOT_RUN | Not installed or not attested on this host | No registered profile or claimed execution |
| Windows debugger backend | NOT_RUN | No Windows host evidence | No Windows DAP support claimed |

`scripts/install-managed-dap.sh` reproduces the debugpy runtime with an exact hashed wheel in `runtime/dap/python`, without global Python or system-site mutation. Installation refuses an existing target and checks the installed module tree before promotion. The launch path independently hashes the exact Python binary and every module file, rejects symlinks/writable directories and replacement during read, and rechecks the debuggee source immediately before `configurationDone`. Package validation fixes all reviewed identities. Missing or mismatched runtime fails closed before spawning an adapter. The managed runtime is intentionally ignored by Git; each fresh worktree must install it using the pinned installer before Python debugging is available.

The adapter and debuggee run in one private Bubblewrap namespace with a cleared environment, private `/tmp`/home, read-only `/workspace`, protected credential paths masked, and no external network. debugpy's internal loopback transport is confined to that network namespace; no host/public listener is exposed. Pi controls the process group and termination. Session output and variable values are bounded; large output passes through Artifact Store, while trace events contain metadata only.

## Tests and benchmark

- Focused DAP suite: 11/11 PASS. It covers fake-protocol reverse-request denial, malformed frames, timeout, crash/partial startup, configuration-time replacement, policy denial, module-digest rejection before spawn, controller-selected Python profile, real GDB/C, real debugpy/Python breakpoint/step/stack/scopes/variables, secret removal, read-only workspace, external-network denial, nonzero debuggee exit, and cleanup.
- Real Pi 0.85.1/debugpy benchmark: PASS, 11 tool results over 12 deterministic local-provider turns. It launched the pinned adapter, hit the source breakpoint, inspected stack/scopes/variables, stepped and exited 0. Artifact Store externalized 24 KiB output to a 5,073-character model-facing preview. Metadata contained no source/output/secret values. `/debug-engine` discovery made zero provider calls and started no adapter. No process, workspace-write, or temporary-directory residue remained.
- Real Pi/GDB benchmark rerun: PASS, eight tool results over nine deterministic local-provider turns, exit 0, isolated output/cleanup preserved.
- Authoritative Expansion gate: 466/466 tests, syntax, installed-Pi TypeScript, package and secret validation PASS using the already verified stable managed LSP runtime. Both benchmarks and tests made zero paid/external provider calls; extra monetary cost €0.

## Deliberate limits

This is a Linux-x64, host-pinned implementation. The static Python interpreter path/version/hash means another host must have a newly reviewed policy; no Windows/Linux portability claim is implied. debugpy needs private loopback internally, but cannot reach an external network through the namespace. The engine does not expose pause, step-in/out, threads, exception info, source retrieval, breakpoint removal, arbitrary evaluation, attach, remote targets, or raw adapter commands; these are not implicitly available just because an adapter could support them. Sessions remain memory-only and single-session. Same-UID mutation of the package/runtime remains a host trust assumption; launch-time attestation narrows but cannot eliminate all TOCTOU races against a malicious local owner.

## Phase 27 handoff

Cross-platform Computer Use must start with one neutral capability/approval contract and separate Linux/Windows native brokers. The existing host-wide input/screenshot path is still deferred for safety; do not promote it from design to `REAL_HOST_VERIFIED` without an approved target-bound action and actual host evidence.
