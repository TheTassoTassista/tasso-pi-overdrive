#!/usr/bin/env bash
set -euo pipefail

package_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
exec node "$package_root/scripts/trace-retention.mjs" "${1:---dry-run}"
