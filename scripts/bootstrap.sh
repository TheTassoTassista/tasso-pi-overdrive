#!/usr/bin/env bash
set -euo pipefail

package_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
pi_bin=${PI_BIN:-$(command -v pi || true)}
npm_bin=${NPM_BIN:-$(command -v npm || true)}
agent_dir=${PI_CODING_AGENT_DIR:-"$HOME/.pi/agent"}
settings_file="$agent_dir/settings.json"
install_manifest="$agent_dir/tasso-pi-overdrive-install.json"
required_pi=0.85.1

if [[ -z "$pi_bin" || -z "$npm_bin" ]]; then
  echo "Pi and npm must already be available on PATH." >&2
  exit 1
fi
installed_pi=$($pi_bin --version | tr -d '[:space:]')
if [[ "$installed_pi" != "$required_pi" ]]; then
  echo "Refusing an unreviewed Pi version: expected $required_pi, found $installed_pi." >&2
  exit 1
fi

timestamp=$(date -u +%Y%m%d-%H%M%S)
backup_root=${PI_OVERDRIVE_BACKUP_ROOT:-"$HOME/Documents/Codex/pi-overdrive-backups"}
backup_dir="$backup_root/$timestamp"
install -d -m 700 "$backup_root" "$backup_dir" "$backup_dir/pi-original" "$backup_dir/pi-original/agent" "$backup_dir/pi-original/config"
backup_file() {
  local source=$1
  local destination=$2
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
backup_file "$HOME/.pi/config/pi-agent-browser-native/config.json" "$backup_dir/pi-original/config/pi-agent-browser-native/config.json"
echo "Backup: $backup_dir"

install -d -m 700 "$agent_dir"
node "$package_root/scripts/settings-tool.mjs" snapshot "$settings_file" "$package_root/config/settings-patch.json" "$install_manifest" "$package_root"
node "$package_root/scripts/update-manifest.mjs" "$install_manifest" "$package_root/config/packages.json"

while IFS= read -r source; do
  "$pi_bin" install "$source"
done < <(node -e 'const p=require(process.argv[1]); for(const x of p.selected) console.log(x)' "$package_root/config/packages.json")
"$pi_bin" install "$package_root"

install -m 600 "$package_root/config/pi-fff.json" "$agent_dir/pi-fff.json"
install -m 600 "$package_root/config/lsp.json" "$agent_dir/lsp.json"
install -d -m 700 "$agent_dir/extensions/subagent" "$agent_dir/observability" "$HOME/.pi/config/pi-agent-browser-native"
install -m 600 "$package_root/config/subagents.json" "$agent_dir/extensions/subagent/config.json"
install -m 600 "$package_root/config/observability-settings" "$agent_dir/observability/settings"
install -m 600 "$package_root/config/browser.json" "$HOME/.pi/config/pi-agent-browser-native/config.json"
node "$package_root/scripts/settings-tool.mjs" enable "$settings_file" "$package_root/config/settings-patch.json" "$install_manifest" "$package_root"

tool_root="$HOME/.local/share/pi-overdrive/lsp-node"
install -d -m 700 "$tool_root" "$HOME/.local/bin"
"$npm_bin" install --prefix "$tool_root" --no-audit --no-fund \
  @vtsls/language-server@0.3.0 typescript@6.0.3 pyright@1.1.410 \
  yaml-language-server@1.23.0 vscode-langservers-extracted@4.10.0 \
  bash-language-server@5.6.0 @ast-grep/cli@0.45.3

for tool in ast-grep sg vtsls pyright pyright-langserver yaml-language-server bash-language-server vscode-css-language-server vscode-html-language-server vscode-json-language-server; do
  source_path="$tool_root/node_modules/.bin/$tool"
  target_path="$HOME/.local/bin/$tool"
  if [[ -x "$source_path" && ! -e "$target_path" && ! -L "$target_path" ]]; then
    ln -s -- "$source_path" "$target_path"
  fi
done

"$package_root/scripts/install-agent-browser.sh"
echo "Pi Overdrive installed. Restart Pi, then run /doctor, /lsp, and /subagents-models."
