#!/bin/sh
set -eu
# Thin entry point only. All shared installation logic lives in Node.
if [ "$(uname -s)" != Linux ]; then
  echo 'Phi Linux bootstrap requires native Linux.' >&2
  exit 1
fi
phi_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
if ! command -v node >/dev/null 2>&1; then
  echo 'Install Node >=22.19 and Git using your distribution package manager.' >&2
  exit 1
fi
exec node "$phi_root/bootstrap/core.mjs" "${@---foundation}"
