#!/usr/bin/env bash
set -u

agent_dir=${PI_CODING_AGENT_DIR:-"$HOME/.pi/agent"}
for tool in pi node npm git rg fd jq clangd ast-grep agent-browser; do
  resolved=$(command -v "$tool" 2>/dev/null || true)
  if [[ -n "$resolved" ]]; then printf '%-18s %s\n' "$tool" "$resolved"; else printf '%-18s MISSING\n' "$tool"; fi
done
printf '\nPi packages:\n'
pi list 2>&1 || true
printf '\nConfigured models (names only):\n'
jq -r '.enabledModels[]? // empty' "$agent_dir/settings.json" 2>/dev/null || true
printf '\nCredential values are intentionally not inspected.\n'
