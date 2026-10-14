#!/usr/bin/env bash
set -euo pipefail

# Exact structural destinations for the host Bubblewrap feasibility invocation.
# /phi is empty in the rootfs; only the explicit runtime bind makes it writable.
fail() { printf 'E4_HOST_FAIL=ROOTFS_MOUNTPOINT_MISSING:%s\n' "$1" >&2; exit 1; }
[[ $# == 3 && ( $1 == prepare || $1 == validate ) ]] || fail ARGUMENTS
mode=$1
root=$2
probe=$3
[[ -d "$root" && ! -L "$root" && -f "$probe" && ! -L "$probe" ]] || fail INPUT
root=$(realpath -e -- "$root")

# The root is class A (immutable). These are structural prerequisites for
# class B synthetic /proc and /dev, and class C bounded /tmp, /run, /phi and
# /evidence mounts. Other destinations are rejected by the exact-argv test.
for destination in phi evidence proc dev tmp run usr usr/local usr/local/bin; do
  path="$root/$destination"
  [[ ! -L "$path" ]] || fail "$destination"
  if [[ $mode == prepare ]]; then mkdir -p -- "$path"; fi
  [[ -d "$path" && ! -L "$path" && $(realpath -e -- "$path") == "$root/"* ]] || fail "$destination"
done
[[ -z $(find "$root/phi" -mindepth 1 -print -quit) ]] || fail PHI_NOT_EMPTY
probe_target="$root/usr/local/bin/phi-e4-probe"
[[ ! -L "$probe_target" ]] || fail PROBE
if [[ $mode == prepare ]]; then
  cp --remove-destination -- "$probe" "$probe_target"
  chmod 555 "$probe_target"
fi
[[ -f "$probe_target" && ! -L "$probe_target" && $(sha256sum "$probe_target" | awk '{print $1}') == $(sha256sum "$probe" | awk '{print $1}') ]] || fail PROBE
printf 'E4_ROOTFS_SCHEMA=phi-e4-host-v1\nE4_ROOTFS_MOUNTPOINTS=/,/proc,/dev,/tmp,/run,/phi,/evidence\n'
