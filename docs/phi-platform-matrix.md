# Phi platform boundary inventory

This is a migration matrix, not a parity certificate. The current complete engine is still verified only on Linux x86_64. Inventory of `lib`, `scripts`, and `extensions` found Linux/path/process assumptions in 48 files before integration. Existing Linux implementations are preserved, not silently relaxed.

| Capability | Shared interface/core | Linux implementation | Native Windows implementation | Evidence/status |
|---|---|---|---|---|
| Identity / themes | branding + portable CLI | ANSI / UTF-8 / ASCII | same renderer, conservative legacy console fallback | Linux unit PASS; native Windows pending |
| Config discovery | platform directory adapter | XDG + existing private Pi state | LocalAppData + existing Pi state | path units PASS; NTFS ACL attestation pending |
| Protected config I/O | canonical/no-link/identity checks | owner UID, mode, inode, no-follow | junction checks; ACL enforcement still needed | Linux negative tests PASS; not autonomous confinement |
| Launcher process ownership | launchEngine / runOwnedEngine | interactive exec/same PID; local-check owned groups + exit/timeout cleanup | Job Object backend required | Linux PID/arguments/exit and descendant termination tests PASS; Windows BLOCKED |
| Command sandbox | SandboxBackend readiness contract | existing argument-vector + Bubblewrap | AppContainer/restricted-token backend required | Linux existing baseline PASS; Windows BLOCKED |
| Worktree / runtime | existing Git + allocation policy | existing secure native worktrees, ports/state/profile | Git for Windows + ACL/reparse validation required | Windows pending |
| Governors / role routing | current shared policy/controller | unchanged verified implementation | enforcement requires adapter integration | no route/policy changes |
| Receipts / recovery / locks | current journal contracts | immutable private links/permissions + boot/start identity | atomic NTFS/ACL and process-creation identity required | Windows pending |
| Tools / editor / mutations | existing safety/edit controllers | unchanged no-follow/digest/Bubblewrap | canonical drive/UNC/ADS/case checks required throughout | Windows pending; engine blocked |
| LSP | common semantic protocol | pinned managed toolchain, Linux sandbox | native binaries + AppContainer runner needed | Windows pending |
| DAP / persistent eval | common protocol, limits | reviewed Linux GDB/debugpy/node digests | native adapter pins/confinement required | host-bound identities remain a portability gap |
| Browser | common tool contract | current networkless Chromium namespace | native browser confinement/network controls required | Windows BLOCKED |
| Local embeddings / memory | shared memory routing/curation | existing lazy Python loopback services | packaging/runtime checks required | fail-soft; no Windows parity claim |
| OmniRoute | existing provider boundary | current optional loopback service | investigate native service launcher | optional, no unknown-cost inference |
| SearXNG | read-only search boundary | existing Linux container | Docker Desktop optional, NOT native service parity | unavailable without backend |
| Bootstrap / recovery | tracked sources + manifests | legacy full installer pending clean-room repair | new portable foundation only initially | not yet recoverable full product |

## Windows security design constraints

[Microsoft AppContainer isolation](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation) covers credential, file, network and process boundaries. It is a candidate, not an automatic Bubblewrap equivalence claim. Required probes must demonstrate denied host secrets/home/system mutation, denied network, allowed worktree-only mutation, read-only Tester/Council, resource bounds and cleanup.

[Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) provides process-tree lifecycle/resource controls, including kill-on-close. It does not on its own supply filesystem/network isolation; process security must be established separately. Child creation must be suspended until job assignment and restricted token/AppContainer setup succeed. Neither ACL-only confinement nor `taskkill` alone is an acceptable sandbox substitute.

Windows engine launch is refused until those properties and native tests are implemented. Do not advertise WSL or Docker/Linux containers as Windows support.

## Naming disposition

- Phi: canonical product, executable, new README, splash, themes, Doctor and new portable docs.
- Pi: upstream runtime, authentication location, package API, runtime CLI args. Retained deliberately.
- `pi-overdrive` / `tasso-pi-overdrive`: on-disk compatibility state, event/custom-type IDs, existing manifests, historical docs, legacy recovery/install scripts, remote history. Retained deliberately to avoid state loss, pending explicit compatibility migration.
- Historical audit/benchmark/roadmap documents: historical labels retained; new public onboarding does not link them as the current installation promise.
- Machine-specific Linux binary/version/digest policies: not brand references; require attested generated machine configuration before clean-room parity is possible.
