#!/usr/bin/env bash
set -euo pipefail

version=0.36.0
expected_sha512=2e38e3e2744a504aadac5174a607aff25c537c2efdb4d80f8faeec362e812e75005881bccbd0aed95408799d0c6373767d341a8280657d0fe9518ff83563c3df
browser_root="$HOME/.local/share/pi-overdrive/agent-browser-$version"
browser_bin="$browser_root/agent-browser"
link_path="$HOME/.local/bin/agent-browser"
temp_root=$(mktemp -d)
trap 'rm -rf -- "$temp_root"' EXIT

npm pack "agent-browser@$version" --pack-destination "$temp_root" >/dev/null
tarball="$temp_root/agent-browser-$version.tgz"
actual_sha512=$(sha512sum "$tarball" | cut -d' ' -f1)
if [[ "$actual_sha512" != "$expected_sha512" ]]; then
  echo "agent-browser tarball checksum mismatch" >&2
  exit 1
fi
install -d -m 700 "$browser_root" "$HOME/.local/bin"
tar -xOf "$tarball" package/bin/agent-browser-linux-x64 > "$browser_bin.tmp"
chmod 755 "$browser_bin.tmp"
mv -f -- "$browser_bin.tmp" "$browser_bin"
if [[ ! -e "$link_path" && ! -L "$link_path" ]]; then
  ln -s -- "$browser_bin" "$link_path"
elif [[ -L "$link_path" && $(readlink -f -- "$link_path") == "$browser_bin" ]]; then
  :
else
  echo "Existing $link_path left untouched; add $browser_root to PATH manually." >&2
fi
"$browser_bin" --version
"$browser_bin" install
