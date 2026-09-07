#!/usr/bin/env bash
set -euo pipefail

share_network=false
if [[ ${1:-} == "--network" ]]; then
  share_network=true
  shift
fi
if [[ $# -lt 3 || $2 != "--" ]]; then
  echo "usage: sandbox-run.sh [--network] ROOT -- COMMAND [ARG ...]" >&2
  exit 2
fi

root=$(realpath -e -- "$1")
shift 2
if [[ ! -d "$root" ]]; then
  echo "Sandbox root is not a directory: $root" >&2
  exit 2
fi
if ! command -v bwrap >/dev/null 2>&1; then
  echo "bubblewrap is required but was not found." >&2
  exit 1
fi

network_args=()
if [[ "$share_network" == true ]]; then
  network_args+=(--share-net)
fi

exec bwrap \
  --unshare-all \
  "${network_args[@]}" \
  --die-with-parent \
  --new-session \
  --ro-bind /usr /usr \
  --symlink usr/bin /bin \
  --symlink usr/lib /lib \
  --symlink usr/lib /lib64 \
  --symlink usr/bin /sbin \
  --ro-bind /etc /etc \
  --proc /proc \
  --dev /dev \
  --tmpfs /tmp \
  --tmpfs /home \
  --dir /home/sandbox \
  --setenv HOME /home/sandbox \
  --setenv PATH /usr/local/bin:/usr/bin:/bin \
  --setenv LANG C.UTF-8 \
  --bind "$root" /workspace \
  --chdir /workspace \
  -- "$@"
