#!/usr/bin/env bash
set -euo pipefail

trace_root=${XDG_STATE_HOME:-"$HOME/.local/state"}/pi-overdrive/traces
days=${PI_OVERDRIVE_TRACE_DAYS:-30}
mode=${1:---dry-run}
if [[ ! "$days" =~ ^[0-9]+$ ]]; then
  echo "PI_OVERDRIVE_TRACE_DAYS must be a non-negative integer" >&2
  exit 2
fi
if [[ ! -d "$trace_root" ]]; then
  echo "No trace directory: $trace_root"
  exit 0
fi
if [[ "$mode" == "--dry-run" ]]; then
  find "$trace_root" -maxdepth 1 -type f -name '*.jsonl' -mtime "+$days" -print
  echo "Dry run only. Re-run with --apply to delete only the files listed above."
elif [[ "$mode" == "--apply" ]]; then
  find "$trace_root" -maxdepth 1 -type f -name '*.jsonl' -mtime "+$days" -delete
  echo "Removed metadata-only trace files older than $days days from $trace_root."
else
  echo "usage: cleanup-traces.sh [--dry-run|--apply]" >&2
  exit 2
fi
