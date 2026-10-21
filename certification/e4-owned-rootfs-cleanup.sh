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
[[ -d "$stage" && ! -L "$stage" && $(realpath -e -- "$stage") == "$stage" ]] || fail STAGE_IDENTITY
[[ $(stat -c %u -- "$stage") == "$(id -u)" && $(stat -c %a -- "$stage") == 700 ]] || fail STAGE_OWNER
rootfs="$stage/rootfs"
[[ ! -L "$rootfs" ]] || fail ROOTFS_SYMLINK
if [[ -e "$rootfs" ]]; then
  [[ -d "$rootfs" && $(stat -c %u -- "$rootfs") == "$(id -u)" ]] || fail ROOTFS_OWNER
fi

# All payload namespaces must have exited before removal. A host-visible mount
# inside the owned stage is not silently unmounted or traversed.
mounts=$(findmnt -rn -o TARGET) || fail MOUNT_CENSUS
while IFS= read -r target; do
  [[ "$target" != "$stage" && "$target" != "$stage/"* ]] || fail ACTIVE_MOUNT
done <<< "$mounts"

# tar --no-same-owner makes directories runner-owned, but preserves restrictive
# image modes such as /etc/ca-certificates/extracted/cadir (0555). Grant only
# that same owner write permission on real directories inside the owned rootfs,
# after all payloads and mounts are gone. find never follows symlinks.
foreign=$(find -P "$stage" -xdev -type d ! -uid "$(id -u)" -print -quit) || fail DIRECTORY_CENSUS
[[ -z "$foreign" ]] || fail FOREIGN_DIRECTORY
find -P "$stage" -xdev -type d -exec chmod u+w -- {} + || fail DIRECTORY_MODE
rm -rf -- "$stage" || fail REMOVE
[[ ! -e "$stage" && ! -L "$stage" ]] || fail REMOVAL_UNVERIFIED
printf 'E4_OWNED_ROOTFS_CLEANUP=PASS\n'
