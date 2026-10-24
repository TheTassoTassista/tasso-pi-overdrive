# OmniRoute 3.8.50 — protected host operation approval packet

Status: **QUARANTINE_RECOVERY_DEFERRED / SPECIFIC_BLOCKER** under `PHI-OMNIROUTE-QUARANTINE-RECOVERY-001`. The previously approved block ran once and stopped with `directory children mismatch: .` before publication. The exact quarantine `/opt/phi/omniroute/.incoming-3.8.50-bc71bbfe146958f9b9848a21` remains root-owned and untouched; the versioned target and sidecar are absent. A subsequent unprivileged full-tree verification found no missing, added or changed entries, but privileged process-use absence is UNKNOWN from this unprivileged session. Thus `QUARANTINE_RECOVERABLE=NO` pending separately approved read-only host attestation. The old approval and script hash below are historical: **DO NOT RUN THE BLOCK AGAIN**. A diagnostic-only script revision has SHA-256 `b3d0ab7b16aeddee0add681e546bcc215da86d59c6c38e0e96359416fe9b8106`; it neither resolves the unexplained mismatch nor has host-execution approval. No second install, root cleanup, service activation or core removal is authorized by this packet.

## Exact inputs and intended output

- Source staging (user-owned, mutable, **not trusted by root**): `/home/tasso/.local/share/phi/omni-derived-stage-bsuvLtRA/squashfs-root`.
- Source manifest: `/home/tasso/.local/share/phi/omni-derived-stage-bsuvLtRA/derived-integrity-manifest.json`, SHA-256 `cefef41509e534c51f1ef173c9fd25753fa1c86975b148829a6232ca4b9fcb9b`.
- Original root-owned asset: `/opt/omniroute-bin/OmniRoute.AppImage`, size `341498993`, SHA-256 `96099e33c899940ce5fd606064415c79c32d4fd75f7b58a23c640ea769347b71`.
- Only authorized derivation: omission of `resources/app/node_modules/global-agent/node_modules/.bin/semver`, originally pointing to the broken absolute CI-workspace path recorded in the manifest. No other entry may differ.
- Protected target: `/opt/phi/omniroute/3.8.50`; protected manifest sidecar: `/opt/phi/omniroute/.manifest-3.8.50.json`.
- Host installer source: `/home/tasso/Documents/Codex/tasso-pi-overdrive-optional-services/scripts/omniroute-protected-host-install.py`, SHA-256 `f005d4a255fd301eb9d0a8274df4d64d1f23b35884805205619964e65a95171f`.

## Scope, privileges and risk

The operator needs one bounded root execution to create `/opt/phi/omniroute`, a random `.incoming-3.8.50-*` quarantine there, the root-owned 0600 manifest sidecar, and the root-owned versioned payload. There is **no** service installation, sudoers change, launcher/registry change, credential operation, model call, core cleanup or stable switch. The derived payload is not upstream byte-identical; the original release digest is provenance for its source, not a signature of the derived tree.

The main risks are a mutable user source, symlink/path substitution, partial root quarantine on failure, accidental replacement of a published target, and OmniRoute's background egress. The installer pins the manifest and AppImage digests; opens every source ancestor/entry without following symlinks; copies only listed entries through directory file descriptors into a root-only same-filesystem quarantine; hashes bytes during copying; independently rescans the protected copy; enforces root ownership and 0755 directories, 0755 executable files, 0644 other files, two fixed internal symlinks and no setuid/setgid/hardlinks/special files; then uses Linux `renameat2(RENAME_NOREPLACE)` for atomic publication. An existing target or sidecar is an error, never overwritten. The root executable script must itself be copied to a protected location and hash-checked **after** copying, before execution. Any failure is fail-closed; a quarantine/sidecar may remain for exact operator review, never cleaned by a broad glob.

## Historical exact commands — EXECUTED ONCE; DO NOT REUSE

The user-level check succeeded and the operator ran the `sudo` block once against the old pinned script. It failed closed before publication. These commands are retained only to explain that attempt; the source script has since changed for diagnostics, so its old digest check must now fail. Do not bypass or update that check without a new concrete host approval and a disposition of the unexplained failure.

```bash
set -euo pipefail
python3 -I /home/tasso/Documents/Codex/tasso-pi-overdrive-optional-services/scripts/omniroute-protected-host-install.py check

script_source=/home/tasso/Documents/Codex/tasso-pi-overdrive-optional-services/scripts/omniroute-protected-host-install.py
script_expected=f005d4a255fd301eb9d0a8274df4d64d1f23b35884805205619964e65a95171f
operator_dir=$(sudo /usr/bin/mktemp -d /run/phi-omniroute-install.XXXXXXXX)
case "$operator_dir" in /run/phi-omniroute-install.*) ;; *) echo 'REFUSE: unexpected operator directory' >&2; exit 1 ;; esac
sudo /usr/bin/install -o root -g root -m 0500 -- "$script_source" "$operator_dir/install.py"
script_actual=$(sudo /usr/bin/sha256sum "$operator_dir/install.py" | /usr/bin/cut -d ' ' -f 1)
test "$script_actual" = "$script_expected" || { echo 'REFUSE: installer digest changed' >&2; exit 1; }
sudo /usr/bin/python3 -I "$operator_dir/install.py" install
sudo /usr/bin/python3 -I "$operator_dir/install.py" verify-installed
```

Before entering the root block, inspect `git status`, script content/digest and exact source paths. If the script digest is not the pinned value, **stop**; do not use a mutable user-home script directly with root. The installer repeats the asset/manifest/full-tree verification at execution time. Root quarantine and target share `/opt`'s filesystem. The `verify-installed` mode is read-only and rechecks the root-owned sidecar and every target entry. No script content or credential file is copied into the payload.

## Post-install validation before any activation

1. `verify-installed` must PASS; verify `/opt/phi/omniroute/3.8.50` and its ancestors are root-owned, non-user-writable, without permissive ACLs. A non-root attempt to open a representative file for write **without** truncation must be denied. No service/launcher change is implied.
2. In a fresh, bounded, credential-free runtime isolation with an **effective** no-external-route network namespace, launch only this exact protected `AppRun --headless`. Compare `/proc/<pid>/exe` device/inode to the protected `omniroute-desktop`, bind PID to `/proc/<pid>/stat` start time and UID, prove the child/server ancestry and cgroup/namespace relationship, then map the actual loopback listener's socket inode via `/proc/<pid>/fd`. A health HTTP200 without that chain is insufficient.
3. Probe a foreign listener and a stale/reused PID/start-time fixture; each must fail identity attestation. Confirm no duplicate second launch, bounded readiness timeout/failure handling, graceful shutdown, zero owned child/orphan processes and closed test listener. Do not infer these results from the earlier user-owned staging trial.
4. Probe non-loopback network reachability **inside the exact execution environment**; it must fail. Do not rely on systemd properties alone: an earlier unprivileged user-systemd IP filter was ineffective. OmniRoute attempted background leaderboard/provider-stat fetches in the prior namespace. These must not reach the network during bootstrap. Future explicitly authorized provider traffic is a separate policy decision, not a reason to loosen bootstrap isolation. No inference probe is authorized here.

Until every applicable native production-path and network predicate is demonstrated, `OMNIROUTE_PROTECTED_LOCAL_PROVEN=NO` and OmniRoute autostart remains disabled/fail-closed. The current Phi launcher still attests the old AppImage path; this install does not silently redirect it to the new target.

## Exact rollback disposition

No stable Phi switch or service is part of installation, so a failed install leaves daily Phi unchanged. If failure happens **before** the no-replace rename, do not publish the quarantine; record its exact printed `ROOT_QUARANTINE` path and root-owned inode, then arrange an individual operator cleanup only after inspecting that exact path. If publication succeeds but later gates fail, stop and verify all trial-owned processes are gone; verify the exact target's owner, inode and manifest again; atomically rename only `/opt/phi/omniroute/3.8.50` to a new root-owned `.rollback-3.8.50-<random>` sibling with `RENAME_NOREPLACE` and retain it for inspection. Do **not** use `rm -rf`, globbing, overwrite, a current-version pointer or any launcher/registry mutation. The root-only sidecar stays as evidence until a separately reviewed exact cleanup. If any identity/process/writer predicate is uncertain, leave the target in place but disabled and report the blocker; do not improvise removal.

## Separate historical core-dump request — NOT PART OF INSTALL

Do not read or copy content. The two root-owned regular files currently have parent `/var/lib/systemd/coredump` (device36/inode139740), owner root:root, mode0640, link count1:

- `core.omniroute-deskt.1000.31000c7a25924daba228c79d9da261dc.44596.1792770470000000.zst`: device36/inode859833, 7932505 bytes.
- `core.omniroute\x20(v16\x2e.1000.31000c7a25924daba228c79d9da261dc.44663.1792770470000000.zst`: device36/inode859834, 59964156 bytes. The backslashes are literal filename characters.

Any later core cleanup needs its **own** exact host approval. Immediately before each individual unlink, the operator must open the canonical parent without following links, `lstat` the exact literal filename, recheck device/inode/type/owner/mode/link count/size, and establish no writer or holder (including privileged processes). A mismatch or uncertain holder means no unlink. No glob, directory cleanup, permanent privilege or shared-service interruption is authorized by this packet.
