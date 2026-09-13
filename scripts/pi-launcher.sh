#!/usr/bin/env bash
set -euo pipefail

umask 077

omniroute_url=http://127.0.0.1:20128
omniroute_health_url=$omniroute_url/api/health/ping
searxng_health_url=http://127.0.0.1:8888/
container_name=pi-overdrive-searxng
wait_attempts=120
wait_interval=0.25

curl_bin=/usr/bin/curl
flock_bin=/usr/bin/flock
omniroute_bin=/usr/bin/omniroute
sudo_bin=/usr/bin/sudo
docker_bin=/usr/bin/docker
browser_bin=/usr/bin/xdg-open
memory_manager_bin=${PI_OVERDRIVE_MEMORY_MANAGER:-"$HOME/.local/bin/pi-overdrive-memory-services"}

# Test overrides are accepted only behind an explicit test switch. Production
# startup never resolves these privileged helpers through PATH.
if [[ ${PI_OVERDRIVE_LAUNCHER_TEST_MODE:-0} == 1 ]]; then
  test_bin_dir=${PI_OVERDRIVE_LAUNCHER_TEST_BIN_DIR:?test bin directory is required}
  test_bin_dir=$(realpath -e -- "$test_bin_dir")
  [[ -d "$test_bin_dir" && ! -L "$test_bin_dir" ]] || {
    echo "Pi Overdrive launcher test bin directory is unsafe." >&2
    exit 2
  }
  curl_bin=$test_bin_dir/curl
  flock_bin=$test_bin_dir/flock
  omniroute_bin=$test_bin_dir/omniroute
  sudo_bin=$test_bin_dir/sudo
  docker_bin=$test_bin_dir/docker
  browser_bin=$test_bin_dir/xdg-open
  memory_manager_bin=${PI_OVERDRIVE_TEST_MEMORY_MANAGER:-$test_bin_dir/pi-overdrive-memory-services}
  omniroute_url=${PI_OVERDRIVE_TEST_OMNIROUTE_URL:-$omniroute_url}
  omniroute_health_url=${PI_OVERDRIVE_TEST_OMNIROUTE_HEALTH_URL:-$omniroute_url/api/health/ping}
  searxng_health_url=${PI_OVERDRIVE_TEST_SEARXNG_HEALTH_URL:-$searxng_health_url}
  wait_attempts=${PI_OVERDRIVE_TEST_WAIT_ATTEMPTS:-$wait_attempts}
  wait_interval=${PI_OVERDRIVE_TEST_WAIT_INTERVAL:-$wait_interval}
fi

for required in "$curl_bin" "$flock_bin" "$omniroute_bin" "$sudo_bin" "$docker_bin" "$browser_bin"; do
  [[ -x "$required" ]] || {
    echo "Pi Overdrive launcher prerequisite is missing: $required" >&2
    exit 1
  }
done

state_home=${XDG_STATE_HOME:-"$HOME/.local/state"}
launcher_state=$state_home/pi-overdrive/launcher
/usr/bin/install -d -m 700 -- "$launcher_state"
[[ -d "$launcher_state" && ! -L "$launcher_state" ]] || {
  echo "Pi Overdrive launcher state directory is unsafe." >&2
  exit 1
}
/usr/bin/chmod 700 -- "$launcher_state"

exec 9>"$launcher_state/startup.lock"
"$flock_bin" -x 9

http_ready() {
  "$curl_bin" --fail --silent --show-error --max-time 1 --output /dev/null "$1" 2>/dev/null
}

wait_for_http() {
  local url=$1
  local attempt
  for ((attempt = 0; attempt < wait_attempts; attempt += 1)); do
    if http_ready "$url"; then return 0; fi
    /usr/bin/sleep "$wait_interval"
  done
  return 1
}

managed_omniroute_running() {
  local pid_file=$launcher_state/omniroute.pid
  local pid
  [[ -f "$pid_file" && ! -L "$pid_file" ]] || return 1
  IFS= read -r pid < "$pid_file" || return 1
  [[ "$pid" =~ ^[0-9]+$ && -r "/proc/$pid/cmdline" ]] || return 1
  /usr/bin/kill -0 "$pid" 2>/dev/null || return 1
  /usr/bin/tr '\0' ' ' < "/proc/$pid/cmdline" | /usr/bin/grep -Eq 'omniroute[^ ]* .*--(headless|cli)( |$)'
}

unmanaged_omniroute_running() {
  /usr/bin/pgrep -u "$EUID" -f '(^|/)omniroute-desktop .*--(headless|cli)( |$)' >/dev/null 2>&1
}

start_omniroute() {
  if http_ready "$omniroute_health_url"; then
    echo "Pi Overdrive: OmniRoute already healthy."
    return 0
  fi

  if managed_omniroute_running || unmanaged_omniroute_running; then
    echo "Pi Overdrive: waiting for the existing headless OmniRoute process."
  else
    local log_file=$launcher_state/omniroute-$(/usr/bin/date -u +%Y%m%d).log
    [[ ! -L "$log_file" ]] || {
      echo "Pi Overdrive: refusing a symlinked OmniRoute log." >&2
      return 1
    }
    /usr/bin/touch -- "$log_file"
    /usr/bin/chmod 600 -- "$log_file"
    echo "Pi Overdrive: starting OmniRoute headless."
    /usr/bin/nohup "$omniroute_bin" --headless >>"$log_file" 2>&1 9>&- &
    local omni_pid=$!
    local pid_tmp=$launcher_state/.omniroute.pid.$$
    printf '%s\n' "$omni_pid" > "$pid_tmp"
    /usr/bin/chmod 600 -- "$pid_tmp"
    /usr/bin/mv -fT -- "$pid_tmp" "$launcher_state/omniroute.pid"
  fi

  if ! wait_for_http "$omniroute_health_url"; then
    echo "Pi Overdrive: OmniRoute did not become healthy within the bounded wait." >&2
    return 1
  fi
  echo "Pi Overdrive: OmniRoute ready at $omniroute_url."
}

start_searxng() {
  if http_ready "$searxng_health_url"; then
    echo "Pi Overdrive: SearXNG already healthy."
    return 0
  fi

  echo "Pi Overdrive: starting the existing SearXNG container."
  if ! "$sudo_bin" -n "$docker_bin" start "$container_name" >/dev/null; then
    echo "Pi Overdrive: restricted Docker start failed for $container_name." >&2
    return 1
  fi
  if ! wait_for_http "$searxng_health_url"; then
    echo "Pi Overdrive: SearXNG did not become healthy within the bounded wait." >&2
    return 1
  fi
  echo "Pi Overdrive: SearXNG ready at $searxng_health_url."
}

open_dashboard() {
  "$browser_bin" "$omniroute_url" >/dev/null 2>&1 9>&- &
}

start_second_brain() {
  if [[ ! -x "$memory_manager_bin" ]]; then
    echo "Pi Overdrive: local Second Brain manager is not installed; continuing without service-backed memory." >&2
    return 0
  fi
  if ! "$memory_manager_bin" start; then
    echo "Pi Overdrive: local Second Brain is degraded; Pi startup will continue." >&2
  fi
}

resolve_real_pi() {
  if [[ ${PI_OVERDRIVE_LAUNCHER_TEST_MODE:-0} == 1 ]]; then
    printf '%s\n' "${PI_OVERDRIVE_TEST_REAL_PI:?test Pi binary is required}"
    return
  fi
  command -v pi
}

start_omniroute
start_searxng
start_second_brain
open_dashboard

"$flock_bin" -u 9
exec 9>&-

real_pi=$(resolve_real_pi)
[[ -x "$real_pi" ]] || {
  echo "Pi Overdrive: real Pi executable was not found." >&2
  exit 1
}
exec "$real_pi" "$@"
