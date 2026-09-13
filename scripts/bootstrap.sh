#!/usr/bin/env bash
set -euo pipefail

package_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
install_system=false
install_pi=false
check_only=false
skip_browser=false
for argument in "$@"; do
  case "$argument" in
    --install-system) install_system=true ;;
    --install-pi) install_pi=true ;;
    --check-only) check_only=true ;;
    --skip-browser) skip_browser=true ;;
    *) echo "unknown bootstrap option: $argument" >&2; exit 2 ;;
  esac
done
prerequisite_args=()
[[ "$install_system" == true ]] && prerequisite_args+=(--install-system)
[[ "$install_pi" == true ]] && prerequisite_args+=(--install-pi)
"$package_root/scripts/prerequisites.sh" "${prerequisite_args[@]}"
pi_bin=${PI_BIN:-$(command -v pi || true)}
npm_bin=${NPM_BIN:-$(command -v npm || true)}
agent_dir=${PI_CODING_AGENT_DIR:-"$HOME/.pi/agent"}
lsp_manifest_root="$package_root/runtime/lsp"
lsp_runtime_root=${PI_OVERDRIVE_LSP_RUNTIME:-"$lsp_manifest_root"}
settings_file="$agent_dir/settings.json"
install_manifest="$agent_dir/tasso-pi-overdrive-install.json"
web_config_root=${XDG_CONFIG_HOME:-"$HOME/.config"}
web_config="$web_config_root/rpiv-web-tools/config.json"
web_manifest="$agent_dir/tasso-pi-overdrive-web-install.json"
model_policy_root=${XDG_CONFIG_HOME:-"$HOME/.config"}
model_policy="$model_policy_root/pi-overdrive/model-policy.json"
model_callability="$model_policy_root/pi-overdrive/model-callability.json"
required_pi=0.85.1

installed_pi=$($pi_bin --version | tr -d '[:space:]')
if [[ "$installed_pi" != "$required_pi" ]]; then
  echo "Refusing an unreviewed Pi version: expected $required_pi, found $installed_pi." >&2
  exit 1
fi

if [[ "$check_only" == true ]]; then
  node "$package_root/scripts/validate-package.mjs"
  "$pi_bin" list
  "$npm_bin" list --prefix "$package_root/runtime/mcp" --depth=0 \
    pi-mcp-adapter@2.32.1 @modelcontextprotocol/sdk@1.30.0
  "$npm_bin" list --prefix "$lsp_runtime_root" --depth=0 \
    @vtsls/language-server@0.3.0 pyright@1.1.410 typescript@6.0.3 \
    vscode-langservers-extracted@4.10.0 yaml-language-server@1.23.0 \
    bash-language-server@5.6.0 vscode-jsonrpc@9.0.2
  node "$package_root/scripts/install-managed-lsp.mjs" --check --runtime "$lsp_runtime_root"
  "$npm_bin" list --prefix "$HOME/.local/share/pi-overdrive/lsp-node" --depth=0 \
    @ast-grep/cli@0.45.3
  node "$package_root/scripts/model-policy-tool.mjs" check "$model_policy"
  node "$package_root/scripts/model-callability-tool.mjs" check "$model_callability"
  node "$package_root/scripts/setup-second-brain.mjs"
  if [[ ${PI_OVERDRIVE_SKIP_MEMORY_SERVICES:-0} != 1 ]]; then "$package_root/scripts/setup-second-brain-services.sh" --check; fi
  command -v agent-browser >/dev/null 2>&1 && agent-browser --version
  echo "Bootstrap validation: PASS (configuration only; authentication intentionally not inspected)."
  exit 0
fi

timestamp=$(date -u +%Y%m%d-%H%M%S)
backup_root=${PI_OVERDRIVE_BACKUP_ROOT:-"${XDG_STATE_HOME:-$HOME/.local/state}/pi-overdrive/backups"}
install -d -m 700 "$backup_root"
backup_dir=$(mktemp -d "$backup_root/${timestamp}-XXXXXX")
chmod 700 "$backup_dir"
install -d -m 700 "$backup_dir/pi-original" "$backup_dir/pi-original/agent" "$backup_dir/pi-original/config"
backup_file() {
  local source=$1
  local destination=$2
  if [[ -L "$source" ]]; then
    echo "Refusing symlinked Pi configuration during backup: $source" >&2
    exit 1
  fi
  if [[ -f "$source" ]]; then
    install -d -m 700 -- "$(dirname -- "$destination")"
    cp -a -- "$source" "$destination"
  fi
}
backup_file "$settings_file" "$backup_dir/pi-original/agent/settings.json"
backup_file "$agent_dir/pi-fff.json" "$backup_dir/pi-original/agent/pi-fff.json"
backup_file "$agent_dir/lsp.json" "$backup_dir/pi-original/agent/lsp.json"
backup_file "$agent_dir/extensions/subagent/config.json" "$backup_dir/pi-original/agent/extensions/subagent/config.json"
backup_file "$agent_dir/observability/settings" "$backup_dir/pi-original/agent/observability/settings"
backup_file "$install_manifest" "$backup_dir/pi-original/agent/tasso-pi-overdrive-install.json"
backup_file "$web_config" "$backup_dir/pi-original/config/rpiv-web-tools/config.json"
backup_file "$HOME/.pi/config/pi-agent-browser-native/config.json" "$backup_dir/pi-original/config/pi-agent-browser-native/config.json"
echo "Backup: $backup_dir"

"$npm_bin" ci --prefix "$package_root/runtime/mcp" --omit=dev --ignore-scripts --no-audit --no-fund
if [[ "$lsp_runtime_root" != "$lsp_manifest_root" ]]; then
  install -d -m 700 "$lsp_runtime_root"
  install -m 600 "$lsp_manifest_root/package.json" "$lsp_runtime_root/package.json"
  install -m 600 "$lsp_manifest_root/package-lock.json" "$lsp_runtime_root/package-lock.json"
fi
"$npm_bin" ci --prefix "$lsp_runtime_root" --omit=dev --ignore-scripts --no-audit --no-fund
node "$package_root/scripts/install-managed-lsp.mjs" --runtime "$lsp_runtime_root"

install -d -m 700 "$agent_dir"
node "$package_root/scripts/settings-tool.mjs" snapshot "$settings_file" "$package_root/config/settings-patch.json" "$install_manifest" "$package_root"
node "$package_root/scripts/config-policy-tool.mjs" snapshot "$web_config" "$package_root/config/web-tools.json" "$web_manifest"
node "$package_root/scripts/update-manifest.mjs" "$install_manifest" "$package_root/config/packages.json"

while IFS= read -r source; do
  "$pi_bin" install "$source"
done < <(node -e 'const p=require(process.argv[1]); for(const x of p.selected) console.log(x)' "$package_root/config/packages.json")
"$pi_bin" install "$package_root"

install -m 600 "$package_root/config/pi-fff.json" "$agent_dir/pi-fff.json"
install -d -m 700 "$agent_dir/extensions/subagent" "$agent_dir/observability" "$HOME/.pi/config/pi-agent-browser-native"
install -m 600 "$package_root/config/subagents.json" "$agent_dir/extensions/subagent/config.json"
install -m 600 "$package_root/config/observability-settings" "$agent_dir/observability/settings"
install -m 600 "$package_root/config/browser.json" "$HOME/.pi/config/pi-agent-browser-native/config.json"
node "$package_root/scripts/config-policy-tool.mjs" enable "$web_config" "$package_root/config/web-tools.json" "$web_manifest"
node "$package_root/scripts/settings-tool.mjs" enable "$settings_file" "$package_root/config/settings-patch.json" "$install_manifest" "$package_root"
node "$package_root/scripts/model-policy-tool.mjs" initialize "$model_policy" "$package_root/config/model-policy.json"
node "$package_root/scripts/model-callability-tool.mjs" initialize "$model_callability" "$package_root/config/model-callability.json"
node "$package_root/scripts/setup-second-brain.mjs"
if [[ ${PI_OVERDRIVE_SKIP_MEMORY_SERVICES:-0} != 1 ]]; then "$package_root/scripts/setup-second-brain-services.sh" --install; fi

tool_root="$HOME/.local/share/pi-overdrive/lsp-node"
install -d -m 700 "$tool_root" "$HOME/.local/bin"
"$npm_bin" install --prefix "$tool_root" --no-audit --no-fund \
  --save-exact @ast-grep/cli@0.45.3

for tool in ast-grep sg; do
  source_path="$tool_root/node_modules/.bin/$tool"
  target_path="$HOME/.local/bin/$tool"
  if [[ -x "$source_path" && ! -e "$target_path" && ! -L "$target_path" ]]; then
    ln -s -- "$source_path" "$target_path"
  fi
done

if [[ "$skip_browser" != true ]]; then "$package_root/scripts/install-agent-browser.sh"; fi
"$package_root/scripts/install-pi-launcher.sh" --install
node "$package_root/scripts/validate-package.mjs"
"$pi_bin" list
echo "Pi Overdrive installed. Restart Pi, then run /doctor, /memory, /subagents-models, and /notebook."
