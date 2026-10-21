#!/usr/bin/env bash
set -euo pipefail

# Certification-only Ubuntu preflight. The host transports an exact OCI image;
# all validation payloads run as an ordinary user in host Bubblewrap namespaces.
fail() { printf 'E4_PREFLIGHT_FAIL=%s\n' "$1" >&2; exit 1; }
[[ $# == 3 ]] || fail ARGUMENTS
case ${E4_GATE_KIND:-} in
  preflight) gate_marker=E4_UBUNTU_PREFLIGHT ;;
  e4) gate_marker=E4_LINUX_FOUNDATION ;;
  *) fail GATE_KIND ;;
esac
image=$1
product_sha=$2
product_source=$(realpath -e -- "$3")
repo_root=$(realpath -e -- "$(dirname -- "${BASH_SOURCE[0]}")/..")
profile_source="$repo_root/certification/apparmor/phi-e4-bwrap.profile"
probe_source="$repo_root/certification/e4-host-probe.sh"
layout_source="$repo_root/certification/e4-rootfs-layout.sh"
expected_bwrap=$(awk '$1 == "profile" && $2 == "phi-e4-bwrap" {print $3}' "$profile_source")
[[ "$expected_bwrap" =~ ^/[A-Za-z0-9_./-]+$ && "$expected_bwrap" != *'..'* ]] || fail PROFILE_TARGET_INVALID
expected_temp=$(dirname -- "$(dirname -- "$(dirname -- "$(dirname -- "$expected_bwrap")")")")
expected_version=0.9.0-1ubuntu0.3
expected_bwrap_sha=e318903862396f96de3df57264e0158682b952fd3fb53ac23d876413e7b30f71
expected_profile_sha=09fdd69a36701d5e53e732407ac847a21a764a3e3be7ffa1c7d348826d79bf51
expected_seed_sha=ddf8e28d8be90e1e2d941e364b68e735aa5dca3c48295763883d368f97e03f70
expected_image='ghcr.io/thetassotassista/tasso-pi-overdrive-e4@sha256:4fdd60d808c9bfdf31c6c9832424e2fe3804ccb119aa0e59ce788b4f8668c8a2'
if [[ ${E4_CONSOLIDATED_GATE:-false} == true ]]; then
  [[ ${E4_CERTIFIED_IMAGE_DIGEST:-} =~ ^ghcr\.io/thetassotassista/tasso-pi-overdrive-e4@sha256:[a-f0-9]{64}$ ]] || fail CONSOLIDATED_DIGEST
  [[ "$product_sha" == "${GITHUB_SHA:-}" ]] || fail CONSOLIDATED_CANDIDATE
  expected_image=$E4_CERTIFIED_IMAGE_DIGEST
fi
[[ ${RUNNER_OS:-} == Linux && ${RUNNER_TEMP:-} == "$expected_temp" && -n ${ImageVersion:-} ]] || fail RUNNER_IDENTITY
[[ $(id -u) -ne 0 ]] || fail ROOT_RUNNER
[[ "$image" == "$expected_image" && "$product_sha" =~ ^[a-f0-9]{40}$ ]] || fail FROZEN_IDENTITY
[[ "$product_source" != "$repo_root" && -d "$product_source/.git" ]] || fail PRODUCT_SOURCE
[[ $(git -C "$product_source" rev-parse HEAD) == "$product_sha" ]] || fail PRODUCT_SHA
[[ -z $(git -C "$product_source" status --porcelain) ]] || fail PRODUCT_DIRTY
[[ $(sha256sum "$profile_source" | awk '{print $1}') == "$expected_profile_sha" ]] || fail PROFILE_CHANGED
[[ $(sha256sum "$repo_root/config/e4-toolchain-seeds.json" | awk '{print $1}') == "$expected_seed_sha" ]] || fail SEED_MANIFEST_CHANGED
for tool in docker dpkg-deb apt-get apparmor_parser sha256sum getcap timeout tar git npm; do
  command -v "$tool" >/dev/null 2>&1 || fail "TOOL_MISSING_$tool"
done
[[ $(grep -c '^[[:space:]]*userns,[[:space:]]*$' "$profile_source") == 1 ]] || fail PROFILE_USERNS_RULE
[[ $(grep -c 'flags=(unconfined)' "$profile_source") == 1 ]] || fail PROFILE_MODE
grep -Fq "$expected_bwrap" "$profile_source" || fail PROFILE_TARGET
[[ ! -e "$expected_temp/phi-e4-tools" ]] || fail TOOL_STAGE_EXISTS

stage=$(mktemp -d "$expected_temp/phi-e4-preflight.XXXXXXXX")
container_id=
profile_loaded=0
tools_owned=0
cleanup_ok=1
preflight_passed=0
owned_rootfs_pids() {
  local entry pid root command_line started
  for entry in /proc/[0-9]*/root; do
    [[ -L "$entry" ]] || continue
    pid=${entry#/proc/}
    pid=${pid%/root}
    root=$(readlink "$entry" 2>/dev/null || true)
    command_line=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
    started=$(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null || true)
    if [[ -n "$started" && ( "$root" == "$stage/rootfs" || "$command_line" == *"$stage/rootfs"* ) ]]; then printf '%s:%s\n' "$pid" "$started"; fi
  done
}
still_owned() {
  local identity=$1 pid=${1%%:*} started=${1#*:}
  [[ $(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null || true) == "$started" ]] || return 1
  local root command_line
  root=$(readlink "/proc/$pid/root" 2>/dev/null || true)
  command_line=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
  [[ "$root" == "$stage/rootfs" || "$command_line" == *"$stage/rootfs"* ]]
}
cleanup() {
  local original=$? identity pid
  trap - EXIT
  mapfile -t residual < <(owned_rootfs_pids)
  for identity in "${residual[@]}"; do
    pid=${identity%%:*}
    if still_owned "$identity"; then kill -TERM "$pid" 2>/dev/null || true; fi
  done
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    mapfile -t residual < <(owned_rootfs_pids)
    (( ${#residual[@]} == 0 )) && break
    sleep 0.2
  done
  for identity in "${residual[@]}"; do
    pid=${identity%%:*}
    if still_owned "$identity"; then kill -KILL "$pid" 2>/dev/null || true; fi
  done
  mapfile -t residual < <(owned_rootfs_pids)
  (( ${#residual[@]} == 0 )) || cleanup_ok=0
  if [[ "$profile_loaded" == 1 ]]; then sudo -n apparmor_parser -R "$profile_source" || cleanup_ok=0; fi
  if [[ -n "$container_id" ]]; then docker rm -f "$container_id" >/dev/null 2>&1 || cleanup_ok=0; fi
  rm -rf -- "$stage" || cleanup_ok=0
  if [[ "$tools_owned" == 1 ]]; then rm -rf -- "$expected_temp/phi-e4-tools" || cleanup_ok=0; fi
  [[ ! -e "$stage" ]] || cleanup_ok=0
  if [[ "$tools_owned" == 1 && -e "$expected_temp/phi-e4-tools" ]]; then cleanup_ok=0; fi
  if [[ -n "$container_id" ]] && docker container inspect "$container_id" >/dev/null 2>&1; then cleanup_ok=0; fi
  printf 'E4_PREFLIGHT_CLEANUP=%s\n' "$([[ "$cleanup_ok" == 1 ]] && echo PASS || echo FAIL)"
  printf 'E4_PREFLIGHT_RESIDUAL_OWNED_PROCESSES=%s\n' "${#residual[@]}"
  printf 'E4_PREFLIGHT_RESIDUAL_OWNED_CONTAINERS=%s\n' "$([[ "$cleanup_ok" == 1 ]] && echo 0 || echo UNKNOWN)"
  if [[ "$original" != 0 || "$cleanup_ok" != 1 || "$preflight_passed" != 1 ]]; then
    printf '%s=FAIL\n' "$gate_marker"
    exit 1
  fi
  printf '%s=PASS\n' "$gate_marker"
}
trap cleanup EXIT
trap 'exit 1' INT TERM

# Same signed package, exact executable and narrow profile as accepted Run 3.
mkdir -m 700 "$expected_temp/phi-e4-tools"
tools_owned=1
(cd "$stage" && apt-get download "bubblewrap=$expected_version") || fail BWRAP_PACKAGE_UNAVAILABLE
deb="$stage/bubblewrap_${expected_version}_amd64.deb"
[[ -f "$deb" ]] || fail BWRAP_PACKAGE_MISSING
[[ $(dpkg-deb -f "$deb" Package) == bubblewrap && $(dpkg-deb -f "$deb" Version) == "$expected_version" && $(dpkg-deb -f "$deb" Architecture) == amd64 ]] || fail BWRAP_PACKAGE_IDENTITY
dpkg-deb -x "$deb" "$expected_temp/phi-e4-tools" || fail BWRAP_EXTRACTION
[[ -f "$expected_bwrap" && ! -L "$expected_bwrap" && -x "$expected_bwrap" ]] || fail BWRAP_BINARY
[[ $(stat -c %a "$expected_bwrap") == 755 && -z $(getcap "$expected_bwrap") ]] || fail BWRAP_MODE_OR_CAPS
[[ $(sha256sum "$expected_bwrap" | awk '{print $1}') == "$expected_bwrap_sha" ]] || fail BWRAP_DIGEST
[[ $("$expected_bwrap" --version) == 'bubblewrap 0.9.0' ]] || fail BWRAP_VERSION
[[ $(awk '/^CapEff:/ {print $2}' /proc/self/status) == 0000000000000000 && $(awk '/^CapPrm:/ {print $2}' /proc/self/status) == 0000000000000000 ]] || fail HOST_CAPABILITIES
[[ $(cat /sys/module/apparmor/parameters/enabled 2>/dev/null) == Y && $(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null) == 1 ]] || fail HOST_USERNS_POLICY
apparmor_parser -Q -K "$profile_source" || fail PROFILE_PARSE
sudo -n apparmor_parser -r "$profile_source" || fail PROFILE_LOAD
profile_loaded=1

# Docker never enters the payload and exports only the immutable digest.
docker pull "$image" >/dev/null || fail IMAGE_PULL
docker image inspect "$image" --format '{{json .RepoDigests}}' | grep -Fq "${image##*@}" || fail IMAGE_DIGEST
[[ $(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}') == "$product_sha" ]] || fail IMAGE_REVISION
container_id=$(docker create "$image" /usr/bin/true) || fail IMAGE_CREATE
docker export "$container_id" -o "$stage/rootfs.tar" || fail ROOTFS_EXPORT
mkdir -m 700 "$stage/rootfs" "$stage/fixture" "$stage/evidence"
tar -tf "$stage/rootfs.tar" | awk '/^\// || /(^|\/)\.\.($|\/)/ {bad=1} END {exit bad}' || fail ROOTFS_ARCHIVE_PATH
tar --no-same-owner -xf "$stage/rootfs.tar" -C "$stage/rootfs" || fail ROOTFS_EXTRACTION
[[ -x "$stage/rootfs/usr/bin/sh" && -f "$stage/rootfs/etc/os-release" ]] || fail ROOTFS_INVALID
grep -q '^ID=arch$' "$stage/rootfs/etc/os-release" || fail ROOTFS_IDENTITY
bash "$layout_source" prepare "$stage/rootfs" "$probe_source" || fail ROOTFS_SCHEMA
bash "$layout_source" validate "$stage/rootfs" "$probe_source" || fail ROOTFS_SCHEMA
[[ $(sha256sum "$stage/rootfs/opt/phi/config/e4-toolchain-seeds.json" | awk '{print $1}') == "$expected_seed_sha" ]] || fail ROOTFS_SEED_MANIFEST
rootfs_id="phi-e4-host-v1:${image##*@}"
[[ ! -e "$stage/rootfs/etc/phi-e4-rootfs-id" && ! -L "$stage/rootfs/etc/phi-e4-rootfs-id" ]] || fail ROOTFS_MARKER_EXISTS
printf '%s\n' "$rootfs_id" > "$stage/rootfs/etc/phi-e4-rootfs-id"
printf 'phi-e4-fixture:%s\n' "${image##*@}" > "$stage/fixture/fixture-identity"
printf 'E4_PREFLIGHT_IMAGE=%s\nE4_PREFLIGHT_PRODUCT_SHA=%s\nE4_PREFLIGHT_PROFILE_SHA=%s\nE4_PREFLIGHT_BWRAP_SHA=%s\nE4_PREFLIGHT_ROOTFS_SCHEMA=phi-e4-host-v1\n' \
  "$image" "$product_sha" "$expected_profile_sha" "$expected_bwrap_sha"

sentinel="$stage/host-sentinel"
printf 'phi-e4-preflight-sentinel\n' > "$sentinel"
chmod 600 "$sentinel"
sentinel_before=$(sha256sum "$sentinel" | awk '{print $1}')
host_workspace=${GITHUB_WORKSPACE:-$repo_root}
bwrap_args=(
  --unshare-all --unshare-user --disable-userns --clearenv --die-with-parent --new-session
  --ro-bind "$stage/rootfs" /
  --proc /proc --dev /dev --tmpfs /tmp --tmpfs /run
  --bind "$stage/fixture" /phi --bind "$stage/evidence" /evidence
  --setenv PATH /usr/bin:/bin --setenv HOME /tmp --setenv TMPDIR /tmp
  --setenv E4_HOST_USERNS "$(readlink /proc/self/ns/user)" --setenv E4_HOST_MNTNS "$(readlink /proc/self/ns/mnt)"
  --setenv E4_HOST_PIDNS "$(readlink /proc/self/ns/pid)" --setenv E4_HOST_IPCNS "$(readlink /proc/self/ns/ipc)"
  --setenv E4_HOST_UTSNS "$(readlink /proc/self/ns/uts)" --setenv E4_HOST_NETNS "$(readlink /proc/self/ns/net)"
  --setenv E4_HOST_PID "$$" --setenv E4_HOST_SENTINEL "$sentinel"
  --setenv E4_HOST_WORKSPACE "$host_workspace"
  --setenv E4_ROOTFS_ID "$rootfs_id" --setenv E4_FIXTURE_ID "phi-e4-fixture:${image##*@}"
)
verify_frozen() {
  [[ $(sha256sum "$expected_bwrap" | awk '{print $1}') == "$expected_bwrap_sha" ]] || fail BWRAP_CHANGED
  [[ $(sha256sum "$profile_source" | awk '{print $1}') == "$expected_profile_sha" ]] || fail PROFILE_CHANGED
  bash "$layout_source" validate "$stage/rootfs" "$probe_source" || fail ROOTFS_SCHEMA
}
run_payload() {
  verify_frozen
  timeout --signal=TERM --kill-after=5s 20m "$expected_bwrap" "${bwrap_args[@]}" -- "$@"
}
assert_no_owned() {
  local seen=()
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    mapfile -t seen < <(owned_rootfs_pids)
    (( ${#seen[@]} == 0 )) && return 0
    sleep 0.2
  done
  fail OWNED_PROCESS_REMAINED
}

# Native host precheck first; the accepted 24/24 feasibility run is not rerun.
run_payload /usr/bin/sh /usr/local/bin/phi-e4-probe | tee "$stage/probe.out" || fail HOST_PRECHECK
for assertion in 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 20 NETWORK; do
  grep -Fxq "E4_ASSERT_${assertion}=PASS" "$stage/probe.out" || fail "HOST_ASSERT_${assertion}"
done
grep -Fxq 'E4_PROBE_COMPLETE=1' "$stage/probe.out" || fail HOST_PROBE_INCOMPLETE
assert_no_owned
[[ $(sha256sum "$sentinel" | awk '{print $1}') == "$sentinel_before" ]] || fail SENTINEL_CHANGED
printf 'E4_PREFLIGHT_HOST_PRECHECK=PASS\n'

# The host probe writes exactly three controlled entries. Attest and remove
# only that footprint before the image self-check's empty-/phi assertion.
bash "$repo_root/certification/e4-probe-fixture-reset.sh" "$stage/fixture" "phi-e4-fixture:${image##*@}" || fail PROBE_FIXTURE_RESET

# The image's own complete identity check runs inside the final host sandbox,
# before the bounded source fixture is introduced into /phi.
run_payload /usr/bin/node /opt/phi/e4-image-selfcheck.mjs | tee "$stage/toolchain.out" || fail TOOLCHAIN_CHECK
grep -Fxq 'E4_IMAGE_SELFCHECK=PASS' "$stage/toolchain.out" || fail TOOLCHAIN_INCOMPLETE
assert_no_owned
printf 'E4_PREFLIGHT_TOOLCHAIN=PASS\n'

# A disposable exact-SHA checkout is the only project write surface. The
# attested Pi and LSP dependencies are read-only inside the rootfs.
mkdir -m 700 "$stage/fixture/project"
cp -a -- "$product_source/." "$stage/fixture/project/" || fail PRODUCT_COPY
[[ $(git -C "$stage/fixture/project" rev-parse HEAD) == "$product_sha" ]] || fail COPIED_PRODUCT_SHA
ln -s /opt/phi/pi/npm/node_modules "$stage/fixture/project/node_modules"
mkdir -p "$stage/fixture/project/runtime/lsp"
# Product attestation requires a canonical, single-link compiler file at the
# project-relative path. LSP servers use the separately attested image runtime.
compiler_source="$stage/rootfs/opt/phi/runtime/lsp/node_modules/typescript/lib/typescript.js"
compiler_target="$stage/fixture/project/runtime/lsp/node_modules/typescript/lib/typescript.js"
mkdir -p "$(dirname -- "$compiler_target")"
cp -- "$compiler_source" "$compiler_target" || fail TYPESCRIPT_FIXTURE_COPY
[[ -f "$compiler_target" && ! -L "$compiler_target" && $(stat -c %h "$compiler_target") == 1 &&
   $(sha256sum "$compiler_target" | awk '{print $1}') == 569177652966bd528c319171c7dd22860dbf72bde116cbc4f644f1d02bb12e39 ]] || fail TYPESCRIPT_FIXTURE_IDENTITY
# debugpy is also checked by the product at a project-relative canonical tree.
mkdir -p "$stage/fixture/project/runtime/dap/python"
cp -a -- "$stage/rootfs/opt/phi/runtime/dap/python/debugpy" "$stage/fixture/project/runtime/dap/python/debugpy" || fail DAP_FIXTURE_COPY
ast_bin=/opt/phi/pi/npm/node_modules/@ast-grep/cli-linux-x64-gnu/ast-grep
# Tier A above retains --disable-userns. Only the trusted certification
# regression driver removes that one switch so its production sandbox tests
# may create their own bounded child user namespaces. Mounts, environment,
# network and all production Worker policies are otherwise unchanged.
trusted_regression_args=()
for argument in "${bwrap_args[@]}"; do
  [[ "$argument" == --disable-userns ]] || trusted_regression_args+=("$argument")
done
(( ${#trusted_regression_args[@]} + 1 == ${#bwrap_args[@]} )) || fail TIER_B_POLICY
validation_args=("${trusted_regression_args[@]}"
  --dir /tmp/.local --dir /tmp/.local/share --dir /tmp/.local/share/pi-overdrive
  --ro-bind "$stage/rootfs/opt/phi/browser/agent-browser-0.36.0" /tmp/.local/share/pi-overdrive/agent-browser-0.36.0
  --dir /tmp/.agent-browser --dir /tmp/.agent-browser/browsers
  --ro-bind "$stage/rootfs/opt/phi/browser/chrome-152.0.7977.82" /tmp/.agent-browser/browsers/chrome-152.0.7977.82
  --setenv PI_PACKAGE_ROOT /opt/phi/pi/npm/node_modules/@earendil-works/pi-coding-agent
  --setenv PI_CODING_AGENT_DIR /opt/phi/pi
  --setenv PI_OVERDRIVE_LSP_RUNTIME /opt/phi/runtime/lsp
  --setenv PI_OVERDRIVE_AST_GREP_BIN "$ast_bin"
  --setenv NODE_OPTIONS --test-reporter=tap
  --setenv PYTHONDONTWRITEBYTECODE 1
  --setenv PYTHONPATH /opt/phi/runtime/dap/python)
run_validation() {
  verify_frozen
  timeout --signal=TERM --kill-after=5s 20m "$expected_bwrap" "${validation_args[@]}" -- /usr/bin/sh -c "cd /phi/project && $1"
}
# The single-quoted expression is evaluated by the isolated child shell.
# shellcheck disable=SC2016
run_validation 'test ! -e /host && test ! -e /workspace && test ! -e /run/docker.sock && test ! -e /var/run/docker.sock && test ! -e "$E4_HOST_SENTINEL" && test ! -e "$E4_HOST_WORKSPACE" && test "$(awk '\''/^CapEff:/ {print $2}'\'' /proc/self/status)" = 0000000000000000 && /usr/bin/unshare --user --map-root-user /usr/bin/true' || fail TIER_B_CAPABILITY
assert_no_owned
printf 'E4_PREFLIGHT_TIER_B_CAPABILITY=PASS\n'
run_validation 'npm run check' | tee "$stage/full-check.log" || fail FULL_CHECK
node "$repo_root/scripts/e4-preflight-assertions.mjs" "$stage/full-check.log" "$stage/fixture/project" || fail HISTORICAL_ASSERTIONS
assert_no_owned
printf 'E4_PREFLIGHT_NPM_CHECK=PASS\n'
run_validation 'node scripts/phi-owned-main-suite.mjs' || fail LINUX_REGRESSION
assert_no_owned
printf 'E4_PREFLIGHT_LINUX_REGRESSION=PASS\n'
run_validation 'node scripts/phi-repository-audit.mjs' || fail INDEXED_AUDIT
assert_no_owned
printf 'E4_PREFLIGHT_INDEXED_AUDIT=PASS\n'
[[ $(sha256sum "$sentinel" | awk '{print $1}') == "$sentinel_before" ]] || fail SENTINEL_CHANGED
preflight_passed=1
