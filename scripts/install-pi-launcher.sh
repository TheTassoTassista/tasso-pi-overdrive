#!/usr/bin/env bash
set -euo pipefail

package_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
launcher_source=$package_root/scripts/pi-launcher.sh
fish_source=$package_root/shell/pi.fish
launcher_dir=${PI_OVERDRIVE_LAUNCHER_DIR:-"$HOME/.local/bin"}
fish_dir=${PI_OVERDRIVE_FISH_FUNCTION_DIR:-"$HOME/.config/fish/functions"}
launcher_target=$launcher_dir/pi-overdrive-launcher
fish_target=$fish_dir/pi.fish
mode=${1:---install}

case "$mode" in
  --check)
    cmp --silent -- "$launcher_source" "$launcher_target" || {
      echo "Installed Pi Overdrive launcher is missing or stale: $launcher_target" >&2
      exit 1
    }
    cmp --silent -- "$fish_source" "$fish_target" || {
      echo "Installed Pi Fish function is missing or stale: $fish_target" >&2
      exit 1
    }
    [[ -x "$launcher_target" ]] || {
      echo "Installed Pi Overdrive launcher is not executable: $launcher_target" >&2
      exit 1
    }
    echo "Pi startup launcher installation: PASS"
    ;;
  --install)
    install -d -m 700 -- "$launcher_dir" "$fish_dir"
    if [[ -e "$fish_target" && ! -L "$fish_target" ]] && ! cmp --silent -- "$fish_source" "$fish_target"; then
      backup_target=$fish_target.pre-overdrive
      if [[ ! -e "$backup_target" && ! -L "$backup_target" ]]; then
        install -m 600 -- "$fish_target" "$backup_target"
      fi
    fi
    install -m 700 -- "$launcher_source" "$launcher_target"
    install -m 600 -- "$fish_source" "$fish_target"
    echo "Installed Pi Overdrive launcher and Fish function."
    ;;
  *)
    echo "usage: install-pi-launcher.sh [--install|--check]" >&2
    exit 2
    ;;
esac
