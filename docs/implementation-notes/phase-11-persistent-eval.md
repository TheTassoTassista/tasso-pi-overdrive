# Phase 11 implementation note: sandboxed persistent eval

Phase 11 adds clean-room, session-local Python and JavaScript/TypeScript eval kernels. The design was informed by the pinned OMP source at commit `4267074ac91456866e95ed8de0b6353388f08502` and its closed teardown-race report #11707, but no OMP source was copied.

## Deliberately narrow contract

The model receives two conditional schemas: `persistent_python` and `persistent_javascript`. Both support `execute`, `reset`, `status`, and `terminate`; JavaScript additionally selects `javascript` or transpile-only `typescript`. There is one sequential kernel per language per Pi session. Code, frame, output, stderr, value, startup, execution, idle, and shutdown limits are fixed by `config/eval-engine.json` and cannot be widened by tool input beyond the configured execution-time ceiling.

The Linux-x64 policy pins `/usr/bin/python3.14` at Python 3.14.7 and `/usr/bin/node` at v26.8.1, including exact arguments and SHA-256 digests. It also pins TypeScript 6.0.3's single compiler file and the exact `/usr/bin/prlimit` helper. First use verifies canonical paths, regular single-link files, safe ownership-relevant modes, complete binary/file digests, and stable runtime identity. The package-owned runner and, for JavaScript, the compiler file are copied into a new owner-only root.

## Isolation and lifecycle

Each kernel runs through the existing `scripts/sandbox-run.sh` in a new minimal-runtime mode, with only its private runner root mounted read-only as `/workspace`, a private temporary home/filesystem, a cleared environment, the read-only system runtime, and a new network namespace. The user's project workspace, home, owner-local tool runtime, and Pi runtime are not mounted. No ResourceFS, Pi tool, shell, subprocess, or package-install bridge is exposed. The pinned process limiter permits the fixed Node startup thread set but saturates that budget; an attempted child process returns `EAGAIN`. Python independently sets its process limit to zero after startup.

The Python runner restricts imports and dangerous builtins; the JavaScript VM removes process, require, module, Buffer, fetch, WebAssembly, SharedArrayBuffer, and string/wasm code generation. These language controls are defense in depth, not the primary boundary. The OS sandbox removes project/user files and network, while Python's process resource limit denies process creation even if advanced object introspection reaches a low-level module.

Strict newline-delimited JSON framing rejects malformed or oversized protocol. Every request is single-flight. Timeout, abort, malformed protocol, pipe failure, unexpected exit, reset, five-minute idle expiry, explicit termination, and Pi shutdown terminate the entire process group, wait through TERM/KILL, remove the private root, and leave the next execution to start clean. Shutdown sends are idempotent and do not propagate kernel failure into Pi.

## Context and evidence

Each execution returns bounded stdout, stderr, and final value. Long lines are split into 512-character chunks before existing Artifact Store middleware so a single JSON line cannot evade externalization. The local kernel caps output at 256 KiB, so an artifact contains the bounded complete result rather than bytes beyond that cap.

Trace events contain only language/dialect, action/status/error code, lifecycle counters, duration/output counts, truncation state, and isolation booleans. They never contain cell code, stdout, stderr, values, prompts, project paths, file content, or secrets. `/eval-engine` inspects policy/session counters with zero provider calls and starts no process.

Task Policy and Tool Policy expose eval only for explicit bounded computation or debugging intent. Worker receives the two tools; Tester, reviewers, Council, and every other role retain their previous authority. Eval cannot read repository evidence itself: the model must obtain evidence through the normal governed read path and pass only the necessary data.

## Evidence

- Seven focused/adversarial test groups cover policy widening, minimal-mount/process-limit enforcement, retained Python and JavaScript/TypeScript state, direct and introspective Python escape attempts, JavaScript host-global denial, cross-session isolation, output bounds, timeout cleanup, unexpected exit, and restart with clean state.
- A low-level Python `BuiltinImporter`/`posix` probe cannot read the host package fixture because it is absent from the mount namespace; `posix.system` cannot fork because the kernel process limit is zero.
- The real-Pi benchmark uses official Pi 0.85.1, the exact pinned runtimes, Bubblewrap, Artifact Store, and a deterministic local provider. It proves Python 40→42, JavaScript/TypeScript 40→42, isolation denials, 24 KiB output externalization, lazy command discovery, and complete cleanup in nine local provider turns.
- The focused Persistent Eval plus Task/Tool Governor selection is 38/38 PASS. The real-Pi Tool Governor rerun leaves a simple edit at four tools/2,128 schema characters and gives debugging intent 14 tools/6,852 characters including DAP plus both eval schemas.
- All measurements use zero network, external-provider, paid-model calls, and cost.

## Current limitations

The exact runtime digests are Linux-x64 host specific and require a reviewed policy update after a host runtime upgrade. Kernels and state are memory-only and do not survive timeout, crash, reset, idle expiry, or Pi restart. JavaScript execution is synchronous: there is no top-level await, timer, async host API, dynamic import, or package loading. TypeScript is transpiled without typechecking. There is one kernel per language, no rich display/image protocol, no tool/resource bridge, no project or user filesystem, and no persisted eval filesystem.
