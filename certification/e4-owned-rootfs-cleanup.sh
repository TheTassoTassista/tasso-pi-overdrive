#!/usr/bin/env bash
set -euo pipefail

# Remove only the exact stage created by e4-ubuntu-preflight.sh. Docker export
# preserves directory modes; an owned 0555 directory prevents its own unlink.
fail() { printf 'E4_OWNED_ROOTFS_CLEANUP_FAIL=%s\n' "$1" >&2; exit 1; }
[[ $# == 2 ]] || fail ARGUMENTS
stage=$1
expected_temp=$2
[[ -d "$expected_temp" && ! -L "$expected_temp" ]] || fail TEMP_ROOT
[[ $(dirname -- "$stage") == "$expected_temp" && $(basename -- "$stage") =~ ^phi-e4-preflight\.[A-Za-z0-9]{8}$ ]] || fail STAGE_SHAPE
[[ ! -L "$stage" ]] || fail STAGE_IDENTITY
already_absent=0
if [[ ! -e "$stage" ]]; then already_absent=1; fi
if [[ "$already_absent" == 0 ]]; then
  [[ -d "$stage" && $(realpath -e -- "$stage") == "$stage" ]] || fail STAGE_IDENTITY
  [[ $(stat -c %u -- "$stage") == "$(id -u)" && $(stat -c %a -- "$stage") == 700 ]] || fail STAGE_OWNER
fi
rootfs="$stage/rootfs"
[[ "$already_absent" == 1 || ! -L "$rootfs" ]] || fail ROOTFS_SYMLINK
if [[ "$already_absent" == 0 && -e "$rootfs" ]]; then
  [[ -d "$rootfs" && $(stat -c %u -- "$rootfs") == "$(id -u)" ]] || fail ROOTFS_OWNER
fi

# All payload namespaces must have exited before removal. A host-visible mount
# inside the owned stage is not silently unmounted or traversed.
mounts=$(findmnt -rn -o TARGET) || fail MOUNT_CENSUS
while IFS= read -r target; do
  [[ "$target" != "$stage" && "$target" != "$stage/"* ]] || fail ACTIVE_MOUNT
done <<< "$mounts"
if [[ "$already_absent" == 1 ]]; then
  printf 'E4_OWNED_ROOTFS_CLEANUP=PASS already_absent=1\n'
  exit 0
fi

# Docker export may preserve directories without owner search permission. Log
# the historically failing path's metadata before changing anything; no file
# contents are emitted. This distinguishes mode/owner from an unknown ACL case.
dissect="$rootfs/run/systemd/dissect-root"
if [[ -e "$dissect" || -L "$dissect" ]]; then
  stat -c 'E4_OWNED_ROOTFS_DISSECT_BEFORE=uid:%u gid:%g mode:%a type:%F' -- "$dissect" || fail DISSECT_METADATA
  if [[ -L "$dissect" ]]; then
    printf 'E4_OWNED_ROOTFS_DISSECT_ACL=NOT_APPLICABLE symlink\n'
  elif command -v getfacl >/dev/null 2>&1; then
    getfacl -cp -- "$dissect" 2>/dev/null | sed -n '1,12p' || fail DISSECT_ACL
  else
    printf 'E4_OWNED_ROOTFS_DISSECT_ACL=UNKNOWN tool-unavailable\n'
  fi
fi

# Traverse top-down, repairing only directories that lack owner read/search.
# This makes an unreadable child inspectable without a shell per normal image
# directory. GNU find -P does not follow symlinks; mounted-stage census above
# must be complete before this step.
foreign=$(find -P "$stage" -xdev -type d ! -perm -u+rx \( -exec bash -c '
  dir=$1 owner=$2
  [[ ! -L "$dir" && $(stat -c %u -- "$dir") == "$owner" ]] && chmod u+rx -- "$dir"
' _ {} "$(id -u)" \; -o -print -quit \)) || fail DIRECTORY_CENSUS
[[ -z "$foreign" ]] || fail FOREIGN_DIRECTORY
foreign=$(find -P "$stage" -xdev ! -uid "$(id -u)" -print -quit) || fail ENTRY_CENSUS
[[ -z "$foreign" ]] || fail FOREIGN_ENTRY
# All entries are now inspectable and owner-verified. Restore write only where
# necessary, batched to avoid per-directory process launch on the full rootfs.
find -P "$stage" -xdev -type d ! -perm -u+w -exec chmod u+w -- {} + || fail DIRECTORY_MODE
rm -rf -- "$stage" || fail REMOVE
[[ ! -e "$stage" && ! -L "$stage" ]] || fail REMOVAL_UNVERIFIED
printf 'E4_OWNED_ROOTFS_CLEANUP=PASS\n'
