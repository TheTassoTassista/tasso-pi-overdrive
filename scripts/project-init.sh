#!/usr/bin/env bash
set -euo pipefail

package_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
target=${1:-$PWD}
template="$package_root/templates/project-docs"
if [[ ! -d "$target/.git" && ! -f "$target/.git" ]]; then
  echo "Target is not a Git checkout: $target" >&2
  exit 1
fi
while IFS= read -r -d '' source_dir; do
  relative=${source_dir#"$template/"}
  [[ -z "$relative" ]] || install -d -- "$target/$relative"
done < <(find "$template" -type d -print0 | sort -z)
while IFS= read -r -d '' source; do
  relative=${source#"$template/"}
  destination="$target/$relative"
  if [[ -e "$destination" ]]; then
    echo "KEEP $relative"
    continue
  fi
  install -d -- "$(dirname -- "$destination")"
  install -m 644 -- "$source" "$destination"
  echo "ADD  $relative"
done < <(find "$template" -type f -print0 | sort -z)
