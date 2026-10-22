#!/usr/bin/env bash
set -euo pipefail

umask 077

# Phi reuses the existing serialized OmniRoute launcher without executing the
# legacy all-services/browser/Pi path. This mode is never a Docker entrypoint.
phi_prepare_omniroute=false
if [[ ${1:-} == --phi-prepare-omniroute && $# == 1 ]]; then
  phi_prepare_omniroute=true
fi

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
ss_bin=/usr/bin/ss
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
  ss_bin=$test_bin_dir/ss
  memory_manager_bin=${PI_OVERDRIVE_TEST_MEMORY_MANAGER:-$test_bin_dir/pi-overdrive-memory-services}
  omniroute_url=${PI_OVERDRIVE_TEST_OMNIROUTE_URL:-$omniroute_url}
  omniroute_health_url=${PI_OVERDRIVE_TEST_OMNIROUTE_HEALTH_URL:-$omniroute_url/api/health/ping}
  searxng_health_url=${PI_OVERDRIVE_TEST_SEARXNG_HEALTH_URL:-$searxng_health_url}
  wait_attempts=${PI_OVERDRIVE_TEST_WAIT_ATTEMPTS:-$wait_attempts}
  wait_interval=${PI_OVERDRIVE_TEST_WAIT_INTERVAL:-$wait_interval}
fi
if [[ "$phi_prepare_omniroute" == true && ${PI_OVERDRIVE_LAUNCHER_TEST_MODE:-0} != 1 ]]; then
  wait_attempts=4
  wait_interval=0.25
fi

required_bins=("$curl_bin" "$flock_bin" "$omniroute_bin")
if [[ "$phi_prepare_omniroute" == true ]]; then
  required_bins+=("$ss_bin")
else
  required_bins+=("$sudo_bin" "$docker_bin" "$browser_bin")
fi
for required in "${required_bins[@]}"; do
  [[ -x "$required" ]] || {
    echo "Pi Overdrive launcher prerequisite is missing: $required" >&2
    exit 1
  }
done

state_home=${XDG_STATE_HOME:-"$HOME/.local/state"}
if [[ "$phi_prepare_omniroute" == true && ${PI_OVERDRIVE_LAUNCHER_TEST_MODE:-0} != 1 ]]; then
  [[ "$state_home" == /* ]] || { echo 'PHI_OPTIONAL_OMNIROUTE SECURITY_MISMATCH' >&2; exit 3; }
  cursor=$state_home
  while [[ "$cursor" != / ]]; do
    if [[ -e "$cursor" || -L "$cursor" ]]; then
      [[ ! -L "$cursor" ]] || { echo 'PHI_OPTIONAL_OMNIROUTE SECURITY_MISMATCH' >&2; exit 3; }
      owner=$(/usr/bin/stat -c %u -- "$cursor")
      mode=$(/usr/bin/stat -c %a -- "$cursor")
      [[ ( "$owner" == 0 || "$owner" == "$EUID" ) && $((8#$mode & 022)) -eq 0 ]] || { echo 'PHI_OPTIONAL_OMNIROUTE SECURITY_MISMATCH' >&2; exit 3; }
    fi
    cursor=$(/usr/bin/dirname -- "$cursor")
  done
fi
launcher_state=$state_home/pi-overdrive/launcher
/usr/bin/install -d -m 700 -- "$launcher_state"
[[ -d "$launcher_state" && ! -L "$launcher_state" ]] || {
  echo "Pi Overdrive launcher state directory is unsafe." >&2
  exit 1
}
/usr/bin/chmod 700 -- "$launcher_state"
if [[ "$phi_prepare_omniroute" == true ]]; then
  [[ $(/usr/bin/stat -c %u -- "$launcher_state") == "$EUID" ]] || { echo 'PHI_OPTIONAL_OMNIROUTE SECURITY_MISMATCH' >&2; exit 3; }
  if [[ -e "$launcher_state/startup.lock" || -L "$launcher_state/startup.lock" ]]; then
    [[ -f "$launcher_state/startup.lock" && ! -L "$launcher_state/startup.lock" && $(/usr/bin/stat -c %u -- "$launcher_state/startup.lock") == "$EUID" ]] || { echo 'PHI_OPTIONAL_OMNIROUTE SECURITY_MISMATCH' >&2; exit 3; }
  fi
fi

exec 9>"$launcher_state/startup.lock"
if [[ "$phi_prepare_omniroute" == true ]]; then
  "$flock_bin" -w 2 -x 9 || { echo 'PHI_OPTIONAL_OMNIROUTE UNAVAILABLE' >&2; exit 2; }
else
  "$flock_bin" -x 9
fi

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
    local log_file
    log_file=$launcher_state/omniroute-$(/usr/bin/date -u +%Y%m%d).log
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

# The new Phi entrypoint cannot treat a 200 response as gateway identity. A
# private, owner-controlled configuration, the reviewed binary chain, a live
# managed PID and the loopback listener must all agree. Unknown is a denial.
phi_omniroute_trusted_files() {
  local config_dir=${XDG_CONFIG_HOME:-"$HOME/.config"}/omniroute
  local config_file=$config_dir/server.env
  local item owner mode cursor
  [[ -d "$config_dir" && ! -L "$config_dir" && -f "$config_file" && ! -L "$config_file" ]] || return 1
  for item in "$config_dir" "$config_file"; do
    owner=$(/usr/bin/stat -c %u -- "$item") || return 1
    mode=$(/usr/bin/stat -c %a -- "$item") || return 1
    [[ "$owner" == "$EUID" && $((8#$mode & 077)) -eq 0 ]] || return 1
  done
  if [[ ${PI_OVERDRIVE_LAUNCHER_TEST_MODE:-0} != 1 ]]; then
    cursor=$config_file
    while [[ "$cursor" != / ]]; do
      [[ ! -L "$cursor" ]] || return 1
      owner=$(/usr/bin/stat -c %u -- "$cursor") || return 1
      mode=$(/usr/bin/stat -c %a -- "$cursor") || return 1
      [[ ( "$owner" == 0 || "$owner" == "$EUID" ) && $((8#$mode & 022)) -eq 0 ]] || return 1
      cursor=$(/usr/bin/dirname -- "$cursor")
    done
    for item in /usr /usr/bin /usr/bin/env /usr/bin/bash /usr/bin/omniroute /opt /opt/omniroute-bin /opt/omniroute-bin/OmniRoute.AppImage; do
      [[ -e "$item" && ! -L "$item" ]] || return 1
      owner=$(/usr/bin/stat -c %u -- "$item") || return 1
      mode=$(/usr/bin/stat -c %a -- "$item") || return 1
      [[ "$owner" == 0 && $((8#$mode & 022)) -eq 0 ]] || return 1
    done
  fi
}

phi_omniroute_attested() {
  local pid listener listener_address proc_owner proc_exe
  [[ -f "$launcher_state/omniroute.pid" && ! -L "$launcher_state/omniroute.pid" ]] || return 1
  IFS= read -r pid < "$launcher_state/omniroute.pid" || return 1
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  managed_omniroute_running || return 1
  if [[ ${PI_OVERDRIVE_LAUNCHER_TEST_MODE:-0} != 1 ]]; then
    proc_owner=$(/usr/bin/stat -c %u -- "/proc/$pid") || return 1
    proc_exe=$(/usr/bin/readlink -f -- "/proc/$pid/exe") || return 1
    [[ "$proc_owner" == "$EUID" && "$proc_exe" == /opt/omniroute-bin/OmniRoute.AppImage ]] || return 1
  fi
  listener=$("$ss_bin" -H -lntp '( sport = :20128 )') || return 1
  [[ $(/usr/bin/printf '%s\n' "$listener" | /usr/bin/grep -c .) -eq 1 ]] || return 1
  listener_address=$(/usr/bin/awk '{print $4}' <<< "$listener")
  [[ "$listener_address" == 127.0.0.1:20128 ]] || return 1
  /usr/bin/grep -Eq "users:\(\(\"[^\"]+\",pid=$pid,fd=[0-9]+\)\)$" <<< "$listener" || return 1
  http_ready "$omniroute_health_url"
}

phi_prepare_omniroute_only() {
  local config_dir=${XDG_CONFIG_HOME:-"$HOME/.config"}/omniroute
  if [[ ! -e "$config_dir" || ! -e "$config_dir/server.env" ]]; then
    echo 'PHI_OPTIONAL_OMNIROUTE UNAVAILABLE' >&2
    return 2
  fi
  if ! phi_omniroute_trusted_files; then
    echo 'PHI_OPTIONAL_OMNIROUTE SECURITY_MISMATCH' >&2
    return 3
  fi
  if http_ready "$omniroute_health_url"; then
    if phi_omniroute_attested; then
      echo 'PHI_OPTIONAL_OMNIROUTE VERIFIED_HEALTHY'
      return 0
    fi
    echo 'PHI_OPTIONAL_OMNIROUTE IDENTITY_UNVERIFIED' >&2
    return 3
  fi
  if unmanaged_omniroute_running || managed_omniroute_running; then
    echo 'PHI_OPTIONAL_OMNIROUTE IDENTITY_UNVERIFIED' >&2
    return 3
  fi
  if ! start_omniroute; then
    echo 'PHI_OPTIONAL_OMNIROUTE UNAVAILABLE' >&2
    return 2
  fi
  if ! phi_omniroute_attested; then
    echo 'PHI_OPTIONAL_OMNIROUTE IDENTITY_UNVERIFIED' >&2
    return 3
  fi
  echo 'PHI_OPTIONAL_OMNIROUTE VERIFIED_STARTED'
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

if [[ "$phi_prepare_omniroute" == true ]]; then
  phi_prepare_omniroute_only
  exit $?
fi

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
