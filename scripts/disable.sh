#!/usr/bin/env bash
set -euo pipefail

package_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
agent_dir=${PI_CODING_AGENT_DIR:-"$HOME/.pi/agent"}
web_config_root=${XDG_CONFIG_HOME:-"$HOME/.config"}
node "$package_root/scripts/settings-tool.mjs" disable \
  "$agent_dir/settings.json" \
  "$package_root/config/settings-patch.json" \
  "$agent_dir/tasso-pi-overdrive-install.json" \
  "$package_root"
if [[ -f "$agent_dir/tasso-pi-overdrive-web-install.json" ]]; then
  node "$package_root/scripts/config-policy-tool.mjs" disable \
    "$web_config_root/rpiv-web-tools/config.json" \
    "$package_root/config/web-tools.json" \
    "$agent_dir/tasso-pi-overdrive-web-install.json"
fi
echo "Restart Pi. Files and package caches were retained for reversible re-enable."
