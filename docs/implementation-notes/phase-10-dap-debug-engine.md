# Phase 10 implementation note: sandboxed DAP debug engine

Phase 10 adds a clean-room, GDB-only Debug Adapter Protocol engine. The design was informed by the pinned OMP source at commit `4267074ac91456866e95ed8de0b6353388f08502`, but no OMP source was copied.

## Deliberately narrow contract

The model receives one conditional `debug_engine` schema with these actions: `launch`, `set_breakpoint`, `continue`, `step_over`, `stack_trace`, `scopes`, `variables`, `output`, `status`, and `terminate`. There is no attach, arbitrary adapter selection, raw debugger command, custom request, expression/function evaluation, or memory read/write surface. Only one session may exist at a time.

The Linux-x64 policy pins `/usr/bin/gdb` to GNU GDB 17.2 and SHA-256 `5a159b8868d53a85bee261bc35dc59437800b1d139d0389d83e4fdee5a24945d`. First use verifies the canonical path, regular-file/link state, executable mode, version, digest, and filesystem identity. GDB starts with user configuration and auto-loading disabled, and debuginfod disabled.

## Isolation and lifecycle

The adapter and debuggee run through the existing Bubblewrap launcher with a read-only `/workspace`, a private temporary home, no network namespace, and a cleared environment. Programs and source files must be relative, regular, single-link workspace files; secret paths, symlinks, hard links, `.git`, `node_modules`, oversize input, and replacement during the configuration window fail closed. The program is revalidated immediately before `configurationDone` lets it execute.

DAP framing, messages, arguments, breakpoints, stack frames, variables, values, stderr, and debuggee output have explicit limits. Reverse requests are rejected. Startup, request, idle, and shutdown timers are controller-owned; malformed protocol or a timeout destroys the session. Process-group TERM/KILL and session-shutdown cleanup cover both adapter and debuggee.

The long-running DAP `launch` request is intentionally owned by the engine rather than an individual Pi tool-turn abort signal. It is bounded when configuration completes, preventing a normal turn boundary from cancelling an otherwise valid launch while retaining a deterministic launch timeout.

## Context and evidence

Debuggee output is bounded to 128 KiB and preserves critical diagnostics. Long individual lines are chunked before the existing Artifact Store middleware, so large output cannot evade externalization by being a single JSON line. The trace event contains only action/status/error code, adapter/state, isolation booleans, program digest, counts, byte totals, and truncation state. It never contains program/source paths, prompts, source bodies, variable values, or debuggee output.

`/debug-engine` reports policy/session status without starting GDB or making a model call. The Tool Governor exposes the schema only for debugging intent. Worker may use it; Tester, reviewers, Council, and other roles retain their existing non-debug permissions.

## Evidence

- Six focused/adversarial tests cover a complete fake-DAP workflow, reverse-request denial, limits, timeout/malformed protocol cleanup, configuration-time replacement, policy rejection, and a real GDB/C fixture inside Bubblewrap.
- The real-Pi benchmark uses official Pi 0.85.1, GNU GDB 17.2, Bubblewrap, and a deterministic local provider. It completes launch, breakpoint, two stops, stack inspection, exit, output, and termination in nine local provider turns.
- The debuggee proves that an ambient secret is absent and a workspace write is denied. A 24 KiB long-line output is reduced to a 4,249-character model-facing artifact preview, with one manifest and no lost session error state.
- Cleanup proves no residual process, workspace write, or temporary directory. `/debug-engine` discovery makes zero provider calls and starts no adapter.
- All measurements use zero network, external-provider, paid-model calls, and cost.

## Current limitations

This phase supports only the pinned Linux-x64 GDB adapter and workspace executables that GDB can launch. Sessions are memory-only and do not survive Pi restart. Breakpoints are source-line breakpoints; a pre-launch breakpoint may remain pending until symbols load. Attach, core-file analysis, arbitrary evaluation, watchpoints, disassembly, memory operations, remote debugging, multi-session use, and other adapters are intentionally absent.
