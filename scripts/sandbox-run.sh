#!/usr/bin/env bash
set -euo pipefail

runtime_state=
browser_profile=
port=
database=
schema=
relative_cwd=.
workspace_read_only=0
tool_root=${PI_OVERDRIVE_TOOL_ROOT:-"$HOME/.local/share/pi-overdrive/lsp-node"}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --runtime-state) runtime_state=${2:-}; shift 2 ;;
    --browser-profile) browser_profile=${2:-}; shift 2 ;;
    --port) port=${2:-}; shift 2 ;;
    --database) database=${2:-}; shift 2 ;;
    --schema) schema=${2:-}; shift 2 ;;
    --workspace-read-only) workspace_read_only=1; shift ;;
    *) break ;;
  esac
done

if [[ $# -lt 3 ]]; then
  echo "usage: sandbox-run.sh [runtime options] ROOT [--cwd RELATIVE] -- COMMAND [ARG ...]" >&2
  exit 2
fi
root=$(realpath -e -- "$1")
shift
if [[ ${1:-} == --cwd ]]; then
  relative_cwd=${2:-}
  shift 2
fi
if [[ ${1:-} != -- || $# -lt 2 ]]; then
  echo "usage: sandbox-run.sh [runtime options] ROOT [--cwd RELATIVE] -- COMMAND [ARG ...]" >&2
  exit 2
fi
shift

if [[ ! -d "$root" || "$relative_cwd" == /* ]]; then
  echo "Invalid sandbox root/cwd." >&2
  exit 2
fi
host_cwd=$(realpath -e -- "$root/$relative_cwd")
case "$host_cwd/" in "$root/"*) ;; *) echo "Sandbox cwd escapes root." >&2; exit 2 ;; esac
if ! command -v bwrap >/dev/null 2>&1; then
  echo "bubblewrap is required but was not found." >&2
  exit 1
fi

runtime_args=()
tool_args=()
protected_args=()
tool_path=/usr/bin:/bin
if [[ -d "$tool_root/node_modules/.bin" ]]; then
  tool_root=$(realpath -e -- "$tool_root")
  tool_args+=(
    --ro-bind "$tool_root" /opt/pi-overdrive-tools
    --setenv PI_OVERDRIVE_TYPESCRIPT /opt/pi-overdrive-tools/node_modules/typescript/lib/typescript.js
  )
  tool_path=/opt/pi-overdrive-tools/node_modules/.bin:/usr/bin:/bin
fi

# Hide repository-contained credentials from indirect interpreter/test access,
# and make Git metadata read-only. The outer tool guard already denies direct
# access; these mounts enforce the same boundary inside Bubblewrap.
while IFS= read -r -d '' protected_path; do
  protected_relative=${protected_path#"$root"/}
  protected_target=/workspace/$protected_relative
  if [[ -d "$protected_path" && ! -L "$protected_path" ]]; then
    protected_args+=(--tmpfs "$protected_target")
  else
    protected_args+=(--ro-bind /dev/null "$protected_target")
  fi
done < <(
  find -P "$root" -xdev \
    \( -type d \( -name .aws -o -name .gnupg -o -name .password-store -o -name .ssh -o -name browser-data -o -name keyrings \) -print0 -prune \) -o \
    \( \( -type f -o -type l \) \( -name .env -o -name '.env.*' -o -name auth.json -o -name credentials -o -name credentials.json -o -name id_dsa -o -name id_ed25519 -o -name id_ecdsa -o -name id_rsa -o -name known_hosts -o -name netrc -o -name '*.pem' -o -name '*.p12' -o -name '*.pfx' -o -name '*.key' \) -print0 \)
)
if [[ -e "$root/.git" || -L "$root/.git" ]]; then
  protected_args+=(--ro-bind "$root/.git" /workspace/.git)
fi
pi_args=()
if command -v pi >/dev/null 2>&1; then
  pi_entry=$(realpath -e -- "$(command -v pi)")
  pi_root=$(realpath -e -- "$(dirname -- "$pi_entry")/../..")
  if [[ -f "$pi_root/package.json" ]]; then
    pi_args+=(
      --ro-bind "$pi_root" /opt/pi-runtime
      --setenv PI_PACKAGE_ROOT /opt/pi-runtime
      --setenv PI_OVERDRIVE_TSC /opt/pi-overdrive-tools/node_modules/.bin/tsc
    )
  fi
fi
if [[ -n "$runtime_state" || -n "$browser_profile" || -n "$port" || -n "$database" || -n "$schema" ]]; then
  [[ "$port" =~ ^[0-9]{4,5}$ ]] && (( port >= 1024 && port <= 65535 )) || { echo "Invalid runtime port." >&2; exit 2; }
  [[ "$database" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] || { echo "Invalid database identifier." >&2; exit 2; }
  [[ "$schema" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] || { echo "Invalid schema identifier." >&2; exit 2; }
  runtime_state=$(realpath -e -- "$runtime_state")
  browser_profile=$(realpath -e -- "$browser_profile")
  [[ -d "$runtime_state" && -d "$browser_profile" ]] || { echo "Runtime directories are invalid." >&2; exit 2; }
  runtime_args+=(
    --bind "$runtime_state" /runtime-state
    --bind "$browser_profile" /browser-profile
    --setenv PORT "$port"
    --setenv PI_OVERDRIVE_PORT "$port"
    --setenv PI_OVERDRIVE_STATE_DIR /runtime-state
    --setenv XDG_STATE_HOME /runtime-state
    --setenv AGENT_BROWSER_PROFILE /browser-profile
    --setenv PI_OVERDRIVE_DB_NAME "$database"
    --setenv PGDATABASE "$database"
    --setenv PI_OVERDRIVE_DB_SCHEMA "$schema"
    --setenv PGOPTIONS "--search_path=$schema"
  )
fi

sandbox_cwd=/workspace
if [[ "$relative_cwd" != . ]]; then sandbox_cwd="/workspace/$relative_cwd"; fi
workspace_args=(--bind "$root" /workspace)
if (( workspace_read_only == 1 )); then workspace_args=(--ro-bind "$root" /workspace); fi
exec bwrap \
  --unshare-all \
  --clearenv \
  --die-with-parent \
  --new-session \
  --ro-bind /usr /usr \
  --symlink usr/bin /bin \
  --symlink usr/lib /lib \
  --symlink usr/lib /lib64 \
  --symlink usr/bin /sbin \
  --tmpfs /etc \
  --proc /proc \
  --dev /dev \
  --tmpfs /tmp \
  --tmpfs /home \
  --dir /home/sandbox \
  --setenv HOME /home/sandbox \
  --setenv PATH "$tool_path" \
  --setenv LANG C.UTF-8 \
  --setenv NO_COLOR 1 \
  --setenv CI 1 \
  --setenv PI_OVERDRIVE_IN_SANDBOX 1 \
  "${tool_args[@]}" \
  "${pi_args[@]}" \
  "${runtime_args[@]}" \
  "${workspace_args[@]}" \
  "${protected_args[@]}" \
  --chdir "$sandbox_cwd" \
  -- "$@"
