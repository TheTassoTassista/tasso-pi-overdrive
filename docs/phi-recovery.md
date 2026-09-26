# Phi migration, recovery and private data

## Existing verified Linux installation

Run `sh bootstrap/linux.sh --plan` to inspect the foundation plan without writes. `sh bootstrap/linux.sh` installs the user-local `phi` wrapper and preferences. Add the reported launcher directory to your PATH only if it is not already there. The wrapper delegates to the tracked Node entry point; shell logic does not implement product policy.

The migration leaves the existing `pi` command, Fish function, auth, providers, settings, role policies, receipts, Second Brain databases and security profiles untouched. It detects current stable sources through Pi settings and refuses engine launch if the pinned runtime or package registration is missing. The wrapper is idempotent; unrelated commands, links and unowned files are not overwritten. Move the clone only with a new explicit foundation install; it can replace a previously managed launcher after hash validation.

## Native Windows foundation

Use `powershell -NoProfile -File bootstrap/windows.ps1` or `pwsh -File bootstrap/windows.ps1`. `-Plan` performs no writes. Supported foundation environments: native Windows 10 / Server 2016 or newer, PowerShell >=5.1, Node >=22.19 and Git for Windows. No Administrator, WSL or Linux container is used. Missing Node is reported with safe installation instructions rather than an automatic system-wide installer.

The shared code installs a user-local `phi.cmd` wrapper. No persistent PATH change is made. This does **not** install the complete Phi/Pi toolchain: native AppContainer + Job Object confinement, NTFS ACL attestation, protected filesystem/process adapters and complete native coding acceptance remain pending. `phi` refuses to launch the engine there. `phi --version`, themes, splash, Doctor and bootstrap plan are the portable foundation; a FAIL for the unimplemented sandbox is expected, not hidden.

## Clean-machine disaster recovery — not yet certified

Keep the current machine/config backups until full clean-clone reconstruction passes. The intended complete flow is clone → platform bootstrap → normal user authentication → Doctor → native acceptance → `phi`. The current foundation checkout is reproducible without secrets, but the full Linux legacy installer still requires reviewed host dependencies/digests; it is not a verified fresh-machine Phi bootstrap. Windows full reconstruction is also pending.

The existing private GitHub remote is retained. This phase has not yet pushed or renamed it. Source-only local checkpoints are not a substitute for remote recovery until audited and pushed.

## Local backup / restore

On the verified Linux setup:

```sh
phi backup
phi restore /absolute/path/to/phi-UUID.json
phi restore /absolute/path/to/phi-UUID.json --apply
```

The first restore is a zero-write plan. Apply requires existing machine-local RUNTIME_CALLABLE evidence for the restored default and explicit role overrides. Callability/provenance evidence is not imported from another machine. Unknown/unreviewed models and provider routes requiring separate cost attestation are rejected. Unrelated settings and auth remain intact. Restore is per-file atomic with rollback on ordinary failure, not a power-loss-atomic multi-file transaction; do not run configuration writers concurrently. A durable cross-platform restore journal/lock remains to be implemented before stronger guarantees are claimed.

Backup contains only whitelisted theme, default provider/model/thinking and bounded subscription-backed role preferences. It excludes keys/tokens/OAuth/auth, full settings, sessions, logs, callability caches, machine paths, browser profiles and private memory databases. Mode 600 files live in a private local backup directory. Credential backup/encryption/upload is not implemented. Windows backup/restore currently fails closed pending private ACL guarantees.

Backups are local, not automatically uploaded. Private memory/user data requires a separately encrypted user-managed backup; it is not reconstructible from Git by design. No undocumented private-data copying is necessary for the intended core installation, but full portability is not yet proven.

## Validation scope

`npm run check:phi` runs the deterministic portable foundation suite without credentials or model calls. `phi verify` currently runs it through the Linux owned-process adapter; it is not the full live readiness certificate. Real Windows Actions must later prove native isolation, editing, verification and cleanup. The existing complete Linux `npm run check` gate remains mandatory and is not reduced for Windows.
