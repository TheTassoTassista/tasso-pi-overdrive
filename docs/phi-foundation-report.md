# Phi foundation checkpoint — not a complete portability release

Date: 2026-09-26. Functional source HEAD: `0c8da9f870f19f7140246b77b1423989cd73ab25`. The enclosing report-only commit is discoverable with `git log`; no self-referential HEAD is fabricated. Branch: `feature/routing-presets-quality`.

## Product and daily Linux use

Phi 1.0.0 is the product; Pi 0.87.1 remains the upstream engine. Canonical command: `phi`. Node >=22.19, tested pinned runtime 22.23.2. Default remains subscription-backed `openai-codex/gpt-6-sol:medium`.

Bundled deterministic Phi mark, five themes (aurora/cyber/gold/gothic/mono), full/compact/plain rendering, terminal-width checks, Unicode/ASCII and ANSI/NO_COLOR fallback are implemented. The actual Pi TUI uses the scoped, display-only Phi header; editor/footer and upstream startup/title are not completely rebranded. The exhaustive public-string migration remains unfinished. Themes do not change authority, routing or inference.

On the current verified Linux installation:

```sh
phi
phi doctor
phi theme set aurora
phi --theme cyber
phi backup
phi restore /absolute/path/to/phi-UUID.json
```

Restore is a plan unless `--apply` is supplied, and applying model preferences requires existing local callable evidence. `phi verify` currently checks the deterministic foundation, not live full readiness.

## Implementation and evidence

| Area | Concrete implementation | Demonstrated result / limit |
|---|---|---|
| Shared CLI / identity | `bin/phi.mjs`, `config/phi-product.json`, `branding/terminal.mjs`, `themes/builtin.json` | CLI/rendering tests; actual Linux TUI startup, ASCII and Unicode/truecolor, zero model calls |
| TUI integration | `extensions/phi-branding.ts`, `lib/phi-ui.mjs` | actual Pi 0.87.1 startup + command smoke PASS; no early routing-controller import |
| Platform discovery | `platform/index.mjs`, Linux/Windows adapters | actual runner dispatch, POSIX/Win32 path contracts; unsupported platforms fail closed |
| Local config I/O | `platform/shared/filesystem.mjs` | negative symlink/junction/hard-link/ADS/device/path tests; Linux private modes/UID; not a global autonomous sandbox or Windows ACL certificate |
| Linux process ownership | `platform/linux/process.mjs`, shared interface | same-PID interactive exec, argument/env/exit tests; local subprocess timeout/group termination; no extra interactive wrapper process |
| Bootstrap | `bootstrap/core.mjs`, thin `.sh` / `.ps1` | plan zero-write, managed wrapper hash, conflicts denied, idempotent; foundation ONLY, runtime not installed |
| Doctor | `lib/phi-doctor.mjs` | active Linux WARN / 0 FAIL / 0 calls; fresh clone correctly FAIL for missing engine; no auth read/probe |
| Private backup | `lib/phi-backup.mjs` | Linux whitelist/restore validation/rollback tests; no credentials or callable attestation export; Windows blocked until ACL enforcement |
| Repository preparation | `.gitattributes`, lockfile, `scripts/phi-repository-audit.mjs` | indexed artifact/size/path/secret scan 0 FAIL; history blobs 0 FAIL with classified WARN; no claim of exhaustive secret/prose audit |
| Source reconstruction | `scripts/phi-clean-room.mjs` | exact committed Git clone, npm locked source-only install, no host auth/ignored runtime copied, 37/37 Linux foundation tests, owned temporary clone removed |
| Native CI | `.github/workflows/phi-foundation.yml` | real Ubuntu/Windows runners, pinned Actions, no WSL, credentials or model calls; foundation scope only |

Complete authoritative Linux gate: `npm run check`, **570 total / 570 PASS / 0 FAIL / 0 skipped**, syntax, TypeScript against installed Pi and package validation PASS. Focused `npm run check:phi`: 37/37 PASS on Linux. Local logs are `/tmp/phi-570-check.log`, `/tmp/phi-posix-fix-tests.log`; they are local evidence, not required product inputs. Reproduce checks from source rather than relying on temporary paths.

Clean source clone status: `PASS_FOUNDATION_ONLY`; Doctor FAIL and engine `BLOCKED_NOT_INSTALLED` are expected. The test verifies the absence of host dependencies, not successful full reconstruction. Do not count it as completed disaster recovery.

Real CI run for functional HEAD: [36229995302](https://github.com/TheTassoTassista/tasso-pi-overdrive/actions/runs/36229995302), **SUCCESS**. Ubuntu foundation: 37 total / 37 PASS / 0 FAIL / 0 skipped. Native Windows foundation: 37 total / 31 PASS / 0 FAIL / 6 Linux-only skipped (three process tests, two private-backup tests, one POSIX bootstrap test). Both native source-only clone/cleanup checks PASS, no copied auth/ignored runtimes. The skipped implementations are outstanding Windows work, not proven parity. Earlier CI failures exposed dash argv, PowerShell multi-Node discovery and host-native path selection; all three received focused fixes, not added skips or weakened security. Machine-readable scoped receipt: `docs/phi-native-foundation-evidence.json`.

## Security and preserved behavior

The existing verified Linux Bubblewrap, governors, role/read-only boundaries, Council/Judge, retries, routing, spawn limits, safe tools, receipts and Second Brain remain unchanged. Concurrency 3, depth 1, correction rounds 2 and spawn budget 42 are not increased. No new model inference, API key, provider/auth change, Pi update or plugin/dependency package was introduced. Optional services are not automatically started by Phi.

Windows engine and autonomous execution remain BLOCKED. Job Objects alone cannot replace Linux filesystem/network confinement; AppContainer/restricted-token enforcement, NTFS ACLs, process-tree guarantees and real native denial tests are not implemented yet. This is a safety deferral, not Windows-native core verified. Foundation filesystem tests are not evidence of full role/tool security parity.

`docs/final-adversarial-audit.md` is preserved byte-for-byte, SHA256 `f556b3adc88e58f5319f208b4a74c496705ef90b24680bf8bde12e5ce5a9f3ba`; its pre-existing user diff is never staged. Auth hash matches the starting checkpoint. The working tree is therefore not globally clean: only this protected user change is expected after task commits. Other worktrees/services are not removed or stopped.

## GitHub and data boundaries

One existing PRIVATE repository/history remains the source: `https://github.com/TheTassoTassista/tasso-pi-overdrive.git`. Audited foundation commits are pushed to the feature branch. No force push, PR, tag, release, repository rename, visibility or default-branch change. Product naming does not require destroying or duplicating Git history.

Tracked: portable source, templates, policies, deterministic tests, themes/branding, adapters, bootstrap, dependency lock, docs and CI. Local-only: auth, sessions, runtime caches/profiles/receipts, memory databases and host configuration/attestations. Config-only backups contain bounded theme/default/role preferences; no credentials, cookies, memory, sessions, logs, auth, machine paths or callability state. No backup upload or credential backup is implemented. Local scans are heuristic; do not use them as permission for public exposure of old private prose/history.

## Recovery and remaining work

Clone the feature branch, not the unchanged old default branch:

```sh
git clone --branch feature/routing-presets-quality https://github.com/TheTassoTassista/tasso-pi-overdrive.git Phi
cd Phi
sh bootstrap/linux.sh --plan
sh bootstrap/linux.sh
```

Native Windows equivalent: `powershell -NoProfile -File bootstrap/windows.ps1 -Plan`, then without `-Plan`; requires native Windows >=10 / Server 2016, PowerShell >=5.1, Node >=22.19 and Git. No Administrator/WSL required for the current foundation. The installer reports the launcher directory; it does not edit system/user PATH or credentials. A fresh-machine full `phi` coding engine is NOT ready on either target through this bootstrap yet.

Do not wipe/repartition the current machine based on this checkpoint. Complete pinned Linux/Windows runtime and toolchain installation, native Windows enforced sandbox/process/filesystem/ACL boundaries, service/LSP/DAP/browser integrations, durable restore journal/locking, full naming migration, Windows deterministic coding E2E and complete fresh-machine recovery are outstanding. Existing host-specific Linux reviewed debugger/runtime identities must be generated/attested safely, not copied untracked or silently trusted.

Next exact work is in `docs/phi-progress.md`. This checkpoint intentionally stops before a risky half-built Windows security backend when session quota is low, as authorized by the phase's work-session-management rule. The major Phi phase is **IN PROGRESS**, not complete or release-certified.
