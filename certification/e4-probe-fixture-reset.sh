#!/usr/bin/env bash
set -euo pipefail

fail() { printf 'E4_PROBE_FIXTURE_RESET_FAIL=%s\n' "$1" >&2; exit 1; }
[[ $# == 2 && -d $1 && ! -L $1 && $2 =~ ^phi-e4-fixture:sha256:[a-f0-9]{64}$ ]] || fail ARGUMENTS
fixture=$(realpath -e -- "$1")
expected=$2
mapfile -t entries < <(find "$fixture" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort)
[[ ${entries[*]} == 'fixture-identity fixture-writable writable' ]] || fail UNEXPECTED_ENTRIES
identity="$fixture/fixture-identity"
[[ -f "$identity" && ! -L "$identity" && $(stat -c %s "$identity") -lt 128 ]] || fail IDENTITY_TYPE
[[ $(cat "$identity") == "$expected" ]] || fail IDENTITY_VALUE
for name in fixture-writable writable; do
  file="$fixture/$name"
  [[ -f "$file" && ! -L "$file" && $(stat -c %s "$file") == 0 ]] || fail CANARY
done
rm -- "$identity" "$fixture/fixture-writable" "$fixture/writable"
[[ -z $(find "$fixture" -mindepth 1 -print -quit) ]] || fail NOT_EMPTY
printf 'E4_PREFLIGHT_FIXTURE_RESET=PASS\n'
