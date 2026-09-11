#!/usr/bin/env bash
set -euo pipefail

install_system=false
install_pi=false
for argument in "$@"; do
  case "$argument" in
    --install-system) install_system=true ;;
    --install-pi) install_pi=true ;;
    *) echo "unknown prerequisite option: $argument" >&2; exit 2 ;;
  esac
done

required=(git rg fd jq curl wget tar gzip xz unzip python3 gcc g++ make bwrap node npm)
missing=()
for command_name in "${required[@]}"; do
  command -v "$command_name" >/dev/null 2>&1 || missing+=("$command_name")
done

if (( ${#missing[@]} > 0 )) && [[ "$install_system" == true ]]; then
  if command -v pacman >/dev/null 2>&1; then
    sudo pacman -S --needed git ripgrep fd jq curl wget tar unzip zip python gcc make bubblewrap nodejs npm
  elif command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y git ripgrep fd-find jq curl wget tar unzip zip python3 build-essential bubblewrap nodejs npm
    if ! command -v fd >/dev/null 2>&1 && command -v fdfind >/dev/null 2>&1; then
      install -d -m 700 "$HOME/.local/bin"
      ln -s "$(command -v fdfind)" "$HOME/.local/bin/fd"
    fi
  else
    echo "Unsupported package manager. Install: ${missing[*]}" >&2
    exit 1
  fi
  missing=()
  for command_name in "${required[@]}"; do command -v "$command_name" >/dev/null 2>&1 || missing+=("$command_name"); done
fi

if (( ${#missing[@]} > 0 )); then
  echo "Missing required commands: ${missing[*]}" >&2
  echo "Re-run with --install-system, or install them with your distribution package manager." >&2
  exit 1
fi

node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(major<22||(major===22&&minor<19)){console.error(`Node >=22.19 required, found ${process.versions.node}`);process.exit(1)}'

if ! command -v pi >/dev/null 2>&1 && [[ "$install_pi" == true ]]; then
  npm install --global @earendil-works/pi-coding-agent@0.85.1
fi
if ! command -v pi >/dev/null 2>&1; then
  echo "Official Pi 0.85.1 is required. Re-run with --install-pi or install @earendil-works/pi-coding-agent@0.85.1 yourself." >&2
  exit 1
fi
pi_version=$(pi --version | tr -d '[:space:]')
if [[ "$pi_version" != 0.85.1 ]]; then
  echo "Pi version mismatch: expected reviewed 0.85.1, found $pi_version" >&2
  exit 1
fi
printf 'Prerequisites: PASS (Pi %s, Node %s)\n' "$pi_version" "$(node --version)"
optional_missing=()
for command_name in gh tree zip; do command -v "$command_name" >/dev/null 2>&1 || optional_missing+=("$command_name"); done
if (( ${#optional_missing[@]} > 0 )); then printf 'Optional commands not installed: %s\n' "${optional_missing[*]}"; fi
