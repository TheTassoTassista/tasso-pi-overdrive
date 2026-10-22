#!/usr/bin/env bash
set -euo pipefail

# Build only the project-relative TypeScript compiler chain expected by the
# frozen product's typecheck. Source is the already-attested, read-only OCI LSP
# runtime; neither npm nor the network is used in this disposable fixture.
fail() { printf 'E4_TYPESCRIPT_FIXTURE_FAIL=%s\n' "$1" >&2; exit 1; }
[[ $# == 2 ]] || fail ARGUMENTS
rootfs=$(realpath -e -- "$1") || fail ROOTFS
project=$(realpath -e -- "$2") || fail PROJECT
source="$rootfs/opt/phi/runtime/lsp/node_modules/typescript"
target="$project/runtime/lsp/node_modules"
[[ $(realpath -e -- "$source") == "$source" ]] || fail SOURCE_ESCAPE
[[ $(realpath -e -- "$project/runtime/lsp") == "$project/runtime/lsp" ]] || fail TARGET_ESCAPE
[[ ! -e "$target" && ! -L "$target" ]] || fail TARGET_EXISTS
[[ -f "$source/package.json" && ! -L "$source/package.json" &&
   $(node -p 'require(process.argv[1]).version' "$source/package.json") == 6.0.3 ]] || fail VERSION
for item in \
  'package.json:9332e97c30d3e53ed54910b89207ed657fb444066484df6e5b6965bf130865e9' \
  'bin/tsc:8d5fa5bd883fec0979fc2004f1fe1d99aef40570155d550eadc0b03b55513bf0' \
  'lib/tsc.js:2cffde0b8c6760dfb0b5b0382bbb7e00ba6a8b2d981b9205b256a700a481d983' \
  'lib/_tsc.js:1c59e77a54b186ec43fa7f3e0d3c4bb15ca5eb5ba43e96b1d3a267139eddd3e3' \
  'lib/typescript.js:569177652966bd528c319171c7dd22860dbf72bde116cbc4f644f1d02bb12e39'; do
  file=${item%%:*}
  expected=${item#*:}
  [[ -f "$source/$file" && ! -L "$source/$file" &&
     $(sha256sum "$source/$file" | awk '{print $1}') == "$expected" ]] || fail SOURCE_IDENTITY
done
mkdir -p "$target/typescript/bin" "$target/typescript/lib" "$target/.bin"
for file in package.json bin/tsc; do
  cp -- "$source/$file" "$target/typescript/$file" || fail COPY
done
cp -a -- "$source/lib/." "$target/typescript/lib/" || fail LIB_COPY
ln -s ../typescript/bin/tsc "$target/.bin/tsc" || fail BIN
[[ $(realpath -e -- "$target/.bin/tsc") == "$target/typescript/bin/tsc" &&
   $(stat -c %h -- "$target/typescript/lib/typescript.js") == 1 &&
   $(node "$target/.bin/tsc" --version) == 'Version 6.0.3' ]] || fail COMPILER
printf 'E4_PREFLIGHT_TYPESCRIPT_FIXTURE=PASS version=6.0.3\n'
