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

no_host_root() {
  grep -q '^ID=arch$' /etc/os-release &&
    test ! -e /home/runner && test ! -e /host && test ! -e /workspace
}
explicit_writes_only() {
  : > /phi/fixture/writable && : > /phi/evidence/writable && : > /tmp/writable &&
    ! (: > /etc/phi-e4-forbidden) 2>/dev/null &&
    ! (: > /usr/phi-e4-forbidden) 2>/dev/null
}
no_network() {
  test "$(readlink /proc/self/ns/net)" != "$E4_HOST_NETNS" &&
    ! grep -Eq '^[^[:space:]]+[[:space:]]+00000000[[:space:]]' /proc/net/route &&
    awk 'NR > 2 && $1 !~ /^lo:/ { foreign = 1 } END { exit foreign }' /proc/net/dev
}
no_host_processes() {
  test "$(readlink /proc/self/ns/pid)" != "$E4_HOST_PIDNS" &&
    test ! -d "/proc/$E4_HOST_PID"
}
no_nested_userns() {
  command -v unshare >/dev/null 2>&1 &&
    ! unshare --user --map-root-user /usr/bin/true >/dev/null 2>&1
}
no_socket() {
  test ! -e /var/run/docker.sock && test ! -e /run/docker.sock
}
no_sentinel() {
  test ! -e "$E4_HOST_SENTINEL" && test ! -r "$E4_HOST_SENTINEL"
}
no_mount_authority() {
  command -v mount >/dev/null 2>&1 && mkdir -p /tmp/phi-e4-mount &&
    ! mount -t tmpfs tmpfs /tmp/phi-e4-mount >/dev/null 2>&1
}
no_effective_caps() {
  cap=$(awk '/^CapEff:/ {print $2}' /proc/self/status)
  test "$(id -u)" -ne 0 && test -n "$cap" && test "$cap" = 0000000000000000
}

printf 'E4_PAYLOAD_UID=%s\n' "$(id -u)"
printf 'E4_PAYLOAD_CAPEFF=%s\n' "$(awk '/^CapEff:/ {print $2}' /proc/self/status)"
printf 'E4_PAYLOAD_PIDNS=%s\n' "$(readlink /proc/self/ns/pid)"
printf 'E4_PAYLOAD_NETNS=%s\n' "$(readlink /proc/self/ns/net)"
assert 4 grep -q '^ID=arch$' /etc/os-release
assert 5 no_host_root
assert 6 explicit_writes_only
assert 7 no_network
assert 8 no_host_processes
assert 9 no_nested_userns
assert 10 no_socket
assert 11 no_sentinel
assert 13 no_mount_authority
assert CAPABILITIES no_effective_caps
exit "$failed"
