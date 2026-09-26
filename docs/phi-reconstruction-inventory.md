# Phi source-of-truth reconstruction inventory

Continuation inventory from `d8a7834`; NOT a completed disaster-recovery certificate. No private configuration contents or auth values are copied here. Paths describe discovery locations, not production dependence on a developer username.

| Required item / local state | Classification | Tracked source / reconstruction | Current gap |
|---|---|---|---|
| Phi implementation, branding, themes, governors, controllers, agent definitions | TRACK_IN_GIT | repository `lib`, `extensions`, `agents`, `config`, `platform`, `branding`, `themes` | Windows coding adapters not yet integrated |
| Phi user launcher/preferences/manifest | GENERATE_DURING_BOOTSTRAP | `bootstrap/core.mjs`, `bin/phi.mjs`, platform directory adapters | foundation installs only; existing Pi preserved |
| Node/npm runtime currently beside the private Pi installation | GENERATE_DURING_BOOTSTRAP | Node >=22.19 requirement, tested 22.23.2; system prerequisites documented | no complete managed clean-machine runtime installer yet |
| Official Pi 0.87.1 | GENERATE_DURING_BOOTSTRAP | exact version in `config/phi-product.json`, `config/packages.json`, legacy prerequisite installer | legacy global installer exists; isolated Phi runtime lock/reconstruction needs completion |
| Selected third-party Pi packages | GENERATE_DURING_BOOTSTRAP | exact seven package pins in `config/packages.json`; legacy `scripts/bootstrap.sh` | not yet consolidated into clean cross-platform dependency lock; native package compatibility not all proven |
| Pi package settings / subscription default / role policy | GENERATE_DURING_BOOTSTRAP | `config/settings-patch.json`, `config/model-policy.json`, routing policy and templates | existing stable settings reused; safe fresh-user initialization still needed |
| Machine model callability/provenance receipts | LOCAL_RUNTIME_DATA | `config/model-callability.json` initializes unknown, normal runtime attestations | never copy another machine's live-call attestations or invent callable evidence |
| OAuth/Codex/ChatGPT credentials | USER_AUTH_REQUIRED / SECRET_DO_NOT_COPY | official user authentication only | no credential copy, import, export or automatic probe |
| LSP npm toolchain and native Go/Rust components | GENERATE_DURING_BOOTSTRAP | locked `runtime/lsp` manifests; `config/managed-lsp.json`; tracked installer | native download policy currently Linux-specific; Windows assets/adapters pending |
| AST binary | GENERATE_DURING_BOOTSTRAP | exact ast-grep pin in package/config, legacy user-local installation | Windows digest/runtime/execution isolation not yet proven |
| MCP bridge/tool dependencies | GENERATE_DURING_BOOTSTRAP / OPTIONAL | locked `runtime/mcp` manifests and tracked allowlist | optional bridge still requires platform/runtime acceptance |
| Windows owned-process executable / build manifest | GENERATE_DURING_BOOTSTRAP | tracked `OwnedProcess.cs` + `AppContainerScope.cs`, direct `build-process.mjs` and thin PowerShell wrapper; ignored `.phi-cache` output | system x64 .NET Framework compiler/runtime prerequisite, no downloaded SDK or child PowerShell dependency; hashes not signed/private-ACL attestation |
| Linux Bubblewrap and base tools | GENERATE_DURING_BOOTSTRAP / system prerequisite | `scripts/prerequisites.sh`, tracked sandbox launcher | distro capability detection exists; fresh supported-host proof still required |
| GDB/debugpy / Persistent Eval runtimes and reviewed identities | OPTIONAL / GENERATE_DURING_BOOTSTRAP | tracked DAP/eval policies, pinned wheel/hash, helper sources | current host-specific versions/digests cannot be advertised as fresh-machine portability; fail closed when unavailable |
| Browser binaries/profiles | OPTIONAL / LOCAL_RUNTIME_DATA | tracked browser runner/config/installer | native Windows confinement pending; never copy cookies/profiles |
| Second Brain/OpenViking/Hindsight/embeddings/ACE implementation | TRACK_IN_GIT / OPTIONAL | tracked memory controllers, Python helpers and setup scripts | native Windows service/package/startup acceptance pending |
| Private memory databases, notes and session content | LOCAL_RUNTIME_DATA / SECRET_DO_NOT_COPY | excluded from Git/default config backup | user-managed encrypted private-data backup, not clone reconstruction |
| OmniRoute and SearXNG service state | OPTIONAL / LOCAL_RUNTIME_DATA | tracked setup/config/service contracts | SearXNG Linux container is not Windows-native proof; optional services must stay fail-soft |
| Worktree allocations, ports, runtime state, receipts, process identities | LOCAL_RUNTIME_DATA / GENERATE_DURING_BOOTSTRAP | tracked allocation/receipt controllers | Linux `/proc` identities, descriptor-relative edits, protected links/locks need real native equivalents |
| Configuration-only backups | LOCAL_RUNTIME_DATA | `lib/phi-backup.mjs`, whitelisted portable fields | Windows ACL/private backup and durable restore journal/locking pending |

## Production assumptions requiring adapters, not blind replacement

`ResourceFS` and Edit Engine currently use Linux descriptor-relative `/proc/self/fd` paths; process identities use `/proc` boot/start ticks. Safe execution, LSP, DAP and Persistent Eval call `scripts/sandbox-run.sh`. These are Linux security primitives, not strings to delete or replace with unchecked host paths. Git policies and optional debugger/eval profiles pin reviewed Linux executables. Preserve them on Linux and supply separately proven Windows implementations.

The complete Linux bootstrap currently installs user-local runtime packages and generates configuration through tracked sources, but its managed native downloads, browser/service prerequisites and host identities still prevent a full fresh-machine certification. Foundation clean-room PASS deliberately reports the complete engine unavailable. No hidden local implementation is accepted merely because it exists on this development machine.

## Native process scope

The new Job owner supervises trusted non-interactive Phi validation, not arbitrary agent/workspace code. Tests prove ordinary trusted descendant cleanup and kernel kill-on-close. Same-user malicious code could attempt handle duplication against a full-trust supervisor; therefore a bare Job is not the untrusted execution security boundary. Autonomous roles, safe_exec and the Windows coding launcher remain blocked pending restricted/AppContainer tokens plus filesystem/network/process-escape denial probes. Never count a process-only test as full Windows coding E2E.

Subsequent source-built fixed LPAC probes demonstrate role permissions, protected synthetic file/registry access denial, host-handle duplication denial, real network denial and ordinary cleanup. Their generated helper is rebuilt by a separate Git clone on native Windows, never copied from the developer host. This resolves the prototype build dependency, not full product reconstruction: arbitrary tool execution, crash cleanup, filesystem brokerage and Windows coding integration remain blocked. Precise scope/evidence: `docs/phi-native-confinement-evidence.json`.

Next reconstruction acceptance must start only from Git + documented base prerequisites, install pinned required runtimes, initialize safe local config without secrets, run Doctor, execute a deterministic coding fixture and prove cleanup. Authentication is separate official user login, not CI model simulation disguised as a real GPT call. Keep current machine backups; full disaster recovery remains IN PROGRESS.
