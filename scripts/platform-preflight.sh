#!/usr/bin/env bash
set -euo pipefail

if (( $# != 2 )); then
  echo "Usage: platform-preflight.sh <kernel> <machine>" >&2
  exit 2
fi

kernel=$1
machine=$2
case "$kernel:$machine" in
  Linux:x86_64)
    printf 'Platform preflight: Linux x86_64 supported.\n'
    ;;
  MINGW*:*|MSYS*:*|CYGWIN*:*|Windows_NT:*)
    echo "Native Windows x86_64 is not yet supported by this Linux/Bubblewrap bootstrap; no changes made." >&2
    exit 1
    ;;
  *)
    echo "Unsupported host $kernel/$machine: this bootstrap requires Linux x86_64; no changes made." >&2
    exit 1
    ;;
esac
