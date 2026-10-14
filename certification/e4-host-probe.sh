#!/bin/sh
set -eu

failed=0
assert() {
  number=$1
  shift
  if "$@"; then
    printf 'E4_ASSERT_%s=PASS\n' "$number"
  else
    printf 'E4_ASSERT_%s=FAIL\n' "$number"
    failed=1
  fi
}
different_namespace() {
  test "$(readlink "/proc/self/ns/$1")" != "$2"
}
rootfs_identity() {
  grep -q '^ID=arch$' /etc/os-release &&
    test "$(cat /etc/phi-e4-rootfs-id)" = "$E4_ROOTFS_ID"
}
readonly_root_and_bounded_writes() {
  awk '$5 == "/" { n++; if ("," $6 "," !~ /,ro,/) exit 1 } END { if (n != 1) exit 1 }' /proc/self/mountinfo &&
    : > /phi/writable && : > /evidence/writable && : > /tmp/writable && : > /run/writable &&
    ! (: > /etc/phi-e4-forbidden) 2>/dev/null &&
    ! (: > /usr/phi-e4-forbidden) 2>/dev/null
}
phi_bind() {
  test "$(cat /phi/fixture-identity)" = "$E4_FIXTURE_ID" &&
    : > /phi/fixture-writable
}
no_host_root() {
  test ! -e /host && test ! -e /workspace &&
    test ! -e "$E4_HOST_SENTINEL"
}
no_host_home_or_workspace() {
  test ! -e /home/runner && test ! -e "$E4_HOST_WORKSPACE"
}
no_docker_socket() {
  test ! -e /var/run/docker.sock && test ! -e /run/docker.sock
}
no_host_processes() {
  test ! -d "/proc/$E4_HOST_PID"
}
no_effective_caps() {
  test "$(id -u)" -ne 0 &&
    test "$(awk '/^CapEff:/ {print $2}' /proc/self/status)" = 0000000000000000
}
no_nested_userns() {
  command -v unshare >/dev/null 2>&1 &&
    ! unshare --user --map-root-user /usr/bin/true >/dev/null 2>&1
}
no_sentinel_access() {
  test ! -e "$E4_HOST_SENTINEL" && test ! -r "$E4_HOST_SENTINEL"
}
no_arbitrary_mount() {
  command -v mount >/dev/null 2>&1 && mkdir -p /tmp/phi-e4-mount &&
    ! mount -t tmpfs tmpfs /tmp/phi-e4-mount >/dev/null 2>&1
}
no_external_network() {
  ! grep -Eq '^[^[:space:]]+[[:space:]]+00000000[[:space:]]' /proc/net/route &&
    awk 'NR > 2 && $1 !~ /^lo:/ { foreign = 1 } END { exit foreign }' /proc/net/dev
}

printf 'E4_PAYLOAD_UID=%s\nE4_PAYLOAD_GID=%s\n' "$(id -u)" "$(id -g)"
printf 'E4_PAYLOAD_CAP_FIELDS=%s\n' "$(awk '/^Cap(Inh|Prm|Eff|Bnd|Amb):/ {printf "%s%s", $1, $2}' /proc/self/status)"
for namespace in user mnt pid ipc uts net; do
  printf 'E4_PAYLOAD_NS_%s=%s\n' "$namespace" "$(readlink "/proc/self/ns/$namespace")"
done
assert 3 different_namespace user "$E4_HOST_USERNS"
assert 4 different_namespace mnt "$E4_HOST_MNTNS"
assert 5 different_namespace pid "$E4_HOST_PIDNS"
assert 6 different_namespace ipc "$E4_HOST_IPCNS"
assert 7 different_namespace uts "$E4_HOST_UTSNS"
assert 8 different_namespace net "$E4_HOST_NETNS"
assert 9 rootfs_identity
assert 10 readonly_root_and_bounded_writes
assert 11 phi_bind
assert 12 no_host_root
assert 13 no_host_home_or_workspace
assert 14 no_docker_socket
assert 15 no_host_processes
assert 16 no_effective_caps
assert 17 no_nested_userns
assert 18 no_sentinel_access
assert 20 no_arbitrary_mount
assert NETWORK no_external_network
printf 'E4_PROBE_COMPLETE=1\n'
exit "$failed"
