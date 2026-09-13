#!/usr/bin/env bash
set -euo pipefail

umask 077
systemctl_bin=/usr/bin/systemctl
curl_bin=/usr/bin/curl
units=(pi-overdrive-embeddings.service pi-overdrive-openviking.service pi-overdrive-hindsight.service)
health_urls=(http://127.0.0.1:1934/health http://127.0.0.1:1933/health http://127.0.0.1:8889/health)
attempts=${PI_OVERDRIVE_MEMORY_WAIT_ATTEMPTS:-80}
interval=${PI_OVERDRIVE_MEMORY_WAIT_INTERVAL:-0.25}

[[ "$attempts" =~ ^[0-9]+$ && "$attempts" -ge 1 && "$attempts" -le 240 ]] || { echo "Second Brain wait attempts must be 1..240." >&2; exit 2; }
[[ "$interval" =~ ^(0\.0[1-9]|0\.[1-9][0-9]?|1)$ ]] || { echo "Second Brain wait interval is invalid." >&2; exit 2; }

if [[ ${PI_OVERDRIVE_MEMORY_TEST_MODE:-0} == 1 ]]; then
  test_bin_dir=${PI_OVERDRIVE_MEMORY_TEST_BIN_DIR:?test bin directory is required}
  test_bin_dir=$(realpath -e -- "$test_bin_dir")
  [[ -d "$test_bin_dir" && ! -L "$test_bin_dir" ]] || exit 2
  systemctl_bin=$test_bin_dir/systemctl
  curl_bin=$test_bin_dir/curl
fi

for required in "$systemctl_bin" "$curl_bin"; do [[ -x "$required" ]] || { echo "Second Brain prerequisite missing: $required" >&2; exit 1; }; done

healthy() { "$curl_bin" --fail --silent --show-error --max-time 1 --output /dev/null "$1" 2>/dev/null; }
wait_all() {
  local attempt url ready
  for ((attempt=0; attempt<attempts; attempt+=1)); do
    ready=true
    for url in "${health_urls[@]}"; do healthy "$url" || ready=false; done
    [[ "$ready" == true ]] && return 0
    /usr/bin/sleep "$interval"
  done
  return 1
}

case "${1:-start}" in
  start)
    "$systemctl_bin" --user start "${units[@]}"
    wait_all || { echo "Pi Overdrive: Second Brain services did not become healthy within the bounded wait." >&2; exit 1; }
    echo "Pi Overdrive: local Second Brain services ready."
    ;;
  check|status)
    "$systemctl_bin" --user is-active --quiet "${units[@]}"
    wait_all
    echo "Pi Overdrive Second Brain service health: PASS"
    ;;
  stop)
    "$systemctl_bin" --user stop "${units[@]}"
    ;;
  *) echo "usage: pi-overdrive-memory-services [start|check|status|stop]" >&2; exit 2 ;;
esac
