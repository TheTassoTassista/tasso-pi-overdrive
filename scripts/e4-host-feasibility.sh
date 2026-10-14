#!/usr/bin/env bash
set -euo pipefail

# Non-certifying host-level isolation proof. Docker only materializes a pinned
# userspace rootfs; the payload runs under ordinary-user host Bubblewrap.
repo_root=$(realpath -e -- "$(dirname -- "${BASH_SOURCE[0]}")/..")
profile_source="$repo_root/certification/apparmor/phi-e4-bwrap.profile"
probe_source="$repo_root/certification/e4-host-probe.sh"
expected_bwrap=$(awk '$1 == "profile" && $2 == "phi-e4-bwrap" {print $3}' "$profile_source")
[[ "$expected_bwrap" =~ ^/[A-Za-z0-9_./-]+$ && "$expected_bwrap" != *'..'* ]] || { echo 'E4_HOST_FAIL=PROFILE_TARGET_INVALID' >&2; exit 1; }
expected_temp=$(dirname -- "$(dirname -- "$(dirname -- "$(dirname -- "$expected_bwrap")")")")
expected_version=0.9.0-1ubuntu0.3
expected_image='docker.io/library/archlinux:base@sha256:3c64b538588416593f69a1aebd2f2ec0f2541b29159f32556fa7def2167147a0'

fail() { printf 'E4_HOST_FAIL=%s\n' "$1" >&2; exit 1; }
[[ ${RUNNER_OS:-} == Linux && ${RUNNER_TEMP:-} == "$expected_temp" ]] || fail RUNNER_IDENTITY
[[ -n ${ImageVersion:-} ]] || fail RUNNER_IMAGE_REVISION_UNKNOWN
[[ $# == 1 && "$1" == "$expected_image" ]] || fail IMAGE_NOT_PINNED
[[ $(id -u) -ne 0 ]] || fail ROOT_RUNNER
for command in docker dpkg-deb apt-get apparmor_parser sha256sum getcap timeout tar; do
  command -v "$command" >/dev/null 2>&1 || fail "TOOL_MISSING_$command"
done
[[ -f "$profile_source" && -f "$probe_source" ]] || fail PROFILE_OR_PROBE_MISSING
[[ $(grep -c '^[[:space:]]*userns,[[:space:]]*$' "$profile_source") == 1 ]] || fail PROFILE_USERNS_RULE
[[ $(grep -c 'flags=(unconfined)' "$profile_source") == 1 ]] || fail PROFILE_MODE
grep -Fq "$expected_bwrap" "$profile_source" || fail PROFILE_TARGET
[[ ! -e "$expected_temp/phi-e4-tools" ]] || fail TOOL_STAGE_EXISTS

stage=$(mktemp -d "$expected_temp/phi-e4-host.XXXXXXXX")
container_id=
profile_loaded=0
sandbox_pid=
owned_pids=()
owned_starts=()
cleanup_ok=1
proof_passed=0
proc_start() { awk '{print $22}' "/proc/$1/stat" 2>/dev/null || true; }
owned_alive() {
  local i
  for i in "${!owned_pids[@]}"; do
    [[ -n ${owned_starts[$i]} && $(proc_start "${owned_pids[$i]}") == "${owned_starts[$i]}" ]] && return 0
  done
  return 1
}
cleanup() {
  local original=$? i
  trap - EXIT
  if [[ -n "$sandbox_pid" ]] && kill -0 "$sandbox_pid" 2>/dev/null; then kill -KILL "$sandbox_pid" 2>/dev/null || true; fi
  for i in "${!owned_pids[@]}"; do
    if [[ -n ${owned_starts[$i]} && $(proc_start "${owned_pids[$i]}") == "${owned_starts[$i]}" ]]; then
      kill -KILL "${owned_pids[$i]}" 2>/dev/null || true
    fi
  done
  if [[ "$profile_loaded" == 1 ]]; then
    sudo -n apparmor_parser -R "$profile_source" || cleanup_ok=0
  fi
  if [[ -n "$container_id" ]]; then docker rm -f "$container_id" >/dev/null 2>&1 || cleanup_ok=0; fi
  rm -rf -- "$stage" "$expected_temp/phi-e4-tools" || cleanup_ok=0
  if owned_alive; then cleanup_ok=0; fi
  printf 'E4_CLEANUP=%s\n' "$([[ $cleanup_ok == 1 ]] && echo PASS || echo FAIL)"
  if [[ "$original" != 0 || "$cleanup_ok" != 1 || "$proof_passed" != 1 ]]; then
    printf 'E4_ASSERT_15=FAIL\nE4_HOST_FEASIBILITY=FAIL\n'
    exit 1
  fi
  printf 'E4_ASSERT_15=PASS\nE4_HOST_FEASIBILITY=PASS\n'
}
trap cleanup EXIT
trap 'exit 1' INT TERM

# Download through the runner's signed Ubuntu apt index, but do not install or
# mutate the host package database. The profile names this one fixed path.
mkdir -m 700 "$expected_temp/phi-e4-tools"
(cd "$stage" && apt-get download "bubblewrap=$expected_version") || fail BWRAP_PACKAGE_UNAVAILABLE
deb="$stage/bubblewrap_${expected_version}_amd64.deb"
[[ -f "$deb" ]] || fail BWRAP_PACKAGE_MISSING
[[ $(dpkg-deb -f "$deb" Package) == bubblewrap && $(dpkg-deb -f "$deb" Version) == "$expected_version" && $(dpkg-deb -f "$deb" Architecture) == amd64 ]] || fail BWRAP_PACKAGE_IDENTITY
dpkg-deb -x "$deb" "$expected_temp/phi-e4-tools" || fail BWRAP_EXTRACTION
[[ -f "$expected_bwrap" && ! -L "$expected_bwrap" && -x "$expected_bwrap" ]] || fail BWRAP_BINARY
mode=$(stat -c %a "$expected_bwrap")
[[ "$mode" == 755 ]] || fail BWRAP_MODE
[[ -z $(getcap "$expected_bwrap") ]] || fail BWRAP_FILE_CAPABILITIES
[[ $("$expected_bwrap" --version) == 'bubblewrap 0.9.0' ]] || fail BWRAP_VERSION
bwrap_sha=$(sha256sum "$expected_bwrap" | awk '{print $1}')
profile_sha=$(sha256sum "$profile_source" | awk '{print $1}')
printf 'E4_BWRAP_PATH=%s\nE4_BWRAP_VERSION=%s\nE4_BWRAP_SHA256=%s\nE4_PROFILE_SHA256=%s\n' "$expected_bwrap" "$expected_version" "$bwrap_sha" "$profile_sha"
printf 'E4_RUNNER_IMAGE=%s\nE4_KERNEL=%s\n' "${ImageVersion:-UNKNOWN}" "$(uname -r)"
printf 'E4_APPARMOR_VERSION=%s\n' "$(apparmor_parser --version | head -1)"
printf 'E4_APPARMOR_STATE=%s\n' "$(cat /sys/module/apparmor/parameters/enabled 2>/dev/null || echo UNKNOWN)"
printf 'E4_USERNS_RESTRICTION=%s\n' "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo UNKNOWN)"
printf 'E4_HOST_CAPEFF=%s\n' "$(awk '/^CapEff:/ {print $2}' /proc/self/status)"
[[ $(awk '/^CapEff:/ {print $2}' /proc/self/status) == 0000000000000000 && $(awk '/^CapPrm:/ {print $2}' /proc/self/status) == 0000000000000000 ]] || fail HOST_CAPABILITIES
[[ $(cat /sys/module/apparmor/parameters/enabled 2>/dev/null) == Y ]] || fail APPARMOR_UNAVAILABLE
[[ $(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null) == 1 ]] || fail USERNS_RESTRICTION_CHANGED
apparmor_parser -Q "$profile_source" || fail PROFILE_PARSE
sudo -n apparmor_parser -r "$profile_source" || fail PROFILE_LOAD
profile_loaded=1

# Docker is outside the payload and only exports the exact pinned image.
image=$1
docker pull "$image" >/dev/null || fail IMAGE_PULL
image_digest=${image##*@}
docker image inspect "$image" --format '{{json .RepoDigests}}' | grep -Fq "$image_digest" || fail OCI_DIGEST_MISMATCH
container_id=$(docker create "$image" /usr/bin/true) || fail IMAGE_CREATE
docker export "$container_id" -o "$stage/rootfs.tar" || fail ROOTFS_EXPORT
mkdir -m 700 "$stage/rootfs" "$stage/fixture" "$stage/evidence"
tar -tf "$stage/rootfs.tar" | awk '/^\// || /(^|\/)\.\.($|\/)/ {bad=1} END {exit bad}' || fail ROOTFS_ARCHIVE_PATH
tar --no-same-owner -xf "$stage/rootfs.tar" -C "$stage/rootfs" || fail ROOTFS_EXTRACTION
[[ -x "$stage/rootfs/usr/bin/sh" && -f "$stage/rootfs/etc/os-release" ]] || fail ROOTFS_INVALID
grep -q '^ID=arch$' "$stage/rootfs/etc/os-release" || fail ROOTFS_IDENTITY
printf 'E4_OCI_DIGEST=%s\n' "$image_digest"

sentinel="$stage/host-sentinel"
printf 'phi-e4-host-sentinel\n' > "$sentinel"
chmod 600 "$sentinel"
sentinel_before=$(sha256sum "$sentinel" | awk '{print $1}')
host_pidns=$(readlink /proc/self/ns/pid)
host_netns=$(readlink /proc/self/ns/net)

bwrap_args=(
  --unshare-all --unshare-user --disable-userns --clearenv --die-with-parent --new-session
  --ro-bind "$stage/rootfs" /
  --proc /proc --dev /dev --tmpfs /tmp --tmpfs /run
  --dir /phi --bind "$stage/fixture" /phi/fixture --bind "$stage/evidence" /phi/evidence
  --ro-bind "$probe_source" /phi/probe.sh
  --setenv PATH /usr/bin:/bin --setenv HOME /tmp
  --setenv E4_HOST_NETNS "$host_netns" --setenv E4_HOST_PIDNS "$host_pidns"
  --setenv E4_HOST_PID "$$" --setenv E4_HOST_SENTINEL "$sentinel"
)
verify_bwrap_now() {
  [[ -f "$expected_bwrap" && ! -L "$expected_bwrap" && $(stat -c %a "$expected_bwrap") == 755 && -z $(getcap "$expected_bwrap") ]] || fail BWRAP_IDENTITY_CHANGED
  [[ $(sha256sum "$expected_bwrap" | awk '{print $1}') == "$bwrap_sha" ]] || fail BWRAP_DIGEST_CHANGED
  [[ $(sha256sum "$profile_source" | awk '{print $1}') == "$profile_sha" ]] || fail PROFILE_DIGEST_CHANGED
}
printf 'E4_BWRAP_POLICY=unshare-all,unshare-user,disable-userns,clearenv,die-with-parent,new-session,ro-rootfs,proc,dev,tmpfs-tmp,tmpfs-run,fixture-bind,evidence-bind,probe-ro-bind\n'
verify_bwrap_now
timeout --signal=TERM --kill-after=5s 60s "$expected_bwrap" "${bwrap_args[@]}" -- /usr/bin/sh /phi/probe.sh | tee "$stage/probe.out" || fail PAYLOAD_PROBE
for assertion in 4 5 6 7 8 9 10 11 13 CAPABILITIES; do
  grep -Fxq "E4_ASSERT_${assertion}=PASS" "$stage/probe.out" || fail "ASSERT_${assertion}"
done
printf 'E4_ASSERT_1=PASS\nE4_ASSERT_2=PASS\nE4_ASSERT_3=PASS\n'
[[ $(sha256sum "$sentinel" | awk '{print $1}') == "$sentinel_before" ]] || fail SENTINEL_CHANGED
printf 'E4_ASSERT_12=PASS\n'

# A second invocation proves that --die-with-parent leaves no owned child.
verify_bwrap_now
collect_descendants() {
  local pending=("$1") parent child
  while (( ${#pending[@]} > 0 )); do
    parent=${pending[0]}
    pending=("${pending[@]:1}")
    while IFS= read -r child; do
      [[ -n "$child" ]] || continue
      printf '%s\n' "$child"
      pending+=("$child")
    done < <(ps -o pid= --ppid "$parent" | tr -d ' ')
  done
}
"$expected_bwrap" "${bwrap_args[@]}" -- /usr/bin/sleep 120 &
sandbox_pid=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
  mapfile -t children < <(collect_descendants "$sandbox_pid")
  for child in "${children[@]}"; do
    if [[ $(ps -o comm= -p "$child" 2>/dev/null | tr -d ' ') == sleep ]]; then break 2; fi
  done
  sleep 0.2
done
sleep_seen=0
for child in "${children[@]}"; do
  if [[ $(ps -o comm= -p "$child" 2>/dev/null | tr -d ' ') == sleep ]]; then sleep_seen=1; fi
done
[[ "$sleep_seen" == 1 ]] || fail CHILD_NOT_STARTED
for child in "${children[@]}"; do
  owned_pids+=("$child")
  owned_starts+=("$(proc_start "$child")")
done
kill -KILL "$sandbox_pid"
wait "$sandbox_pid" 2>/dev/null || true
sandbox_pid=
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if ! owned_alive; then break; fi
  sleep 0.2
done
owned_alive && fail OWNED_CHILD_SURVIVED
printf 'E4_ASSERT_14=PASS\n'
proof_passed=1
