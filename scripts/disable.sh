#!/usr/bin/env bash
set -euo pipefail

package_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
agent_dir=${PI_CODING_AGENT_DIR:-"$HOME/.pi/agent"}
node "$package_root/scripts/settings-tool.mjs" disable \
  "$agent_dir/settings.json" \
  "$package_root/config/settings-patch.json" \
  "$agent_dir/tasso-pi-overdrive-install.json" \
  "$package_root"
echo "Restart Pi. Files and package caches were retained for reversible re-enable."
