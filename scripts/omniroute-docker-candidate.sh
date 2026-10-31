#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# One-shot operator-run candidate only. This script never touches the existing
# AppImage installation, the stable Phi CLI, SearXNG, or Second Brain.

readonly OMNI_TAG='diegosouzapw/omniroute:3.8.50'
readonly OMNI_DIGEST='sha256:085c57adf499a8aaa9f35ccde95c0df9c11bd9ecd18d6c9edbf3b68b8079ba9d'
readonly OMNI_IMAGE="diegosouzapw/omniroute@${OMNI_DIGEST}"
readonly CADDY_IMAGE='docker.io/library/caddy@sha256:eb4d35b7452d1ab6171fbdbe8d9275b2301dad6dad92115d91e19fb9b24d510f'
readonly RECOVERY_DAEMON_ID='b64b0d52-95ab-4b1a-a971-5f09a4d6e36d'
readonly RECOVERY_NETWORK_ID='a2428c56b520dabc38140474ff2559bcfc50a84587ab4953460b1fd80445ae0f'
readonly RECOVERY_EDGE_ID='f31a9d41602d7321cf080974bf00ca550551528d620453346ee0186d8f18f83e'
readonly RECOVERY_LEGACY_BACKEND_ID='b5c5de6334a53acb5f4a127f5d60734ca61890b6a684271d0df288444294b74d'
readonly RECOVERY_AUTH_BACKEND_ID='b225f9f2456449c7f6287713baa67f1de203f63ec864fd165f468468851c0f02'
readonly ROOT='/etc/phi-omniroute-candidate'
readonly HOST_PORT='20129'
readonly BACKEND_PORT='20128'
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly POLICY_SCRIPT="$SCRIPT_DIR/omniroute-egress-policy.py"
readonly EGRESS_PROBE_SCRIPT="$SCRIPT_DIR/omniroute-egress-probe.cjs"
readonly EGRESS_REPORT_SCRIPT="$SCRIPT_DIR/omniroute-egress-probe-report.py"
readonly TLS_HEALTH_REPORT_SCRIPT="$SCRIPT_DIR/omniroute-tls-health-report.py"
readonly EDGE_ATTEST_SCRIPT="$SCRIPT_DIR/omniroute-edge-attest.py"
readonly BACKEND_ATTEST_SCRIPT="$SCRIPT_DIR/omniroute-backend-attest.py"
readonly BACKEND_AUTH_CONFIG_SCRIPT="$SCRIPT_DIR/omniroute-backend-auth-config.py"
readonly POLICY_SCRIPT_SHA256='96a360bd1020bb10f0085355c7f1acdc50e44bdd59072a5ee58fdbd20bb0ae9c'
readonly EGRESS_PROBE_SHA256='85a4ec7cfc0396c65a93ce0d95722c6340b2e1c32eab326876170999012a779d'
readonly EGRESS_REPORT_SHA256='c7dc6ad7b39814a193297f5abc1e487d60b50e5babb29bea19216f2b9d9a2e9c'
readonly TLS_HEALTH_REPORT_SHA256='b87d6fe56e7856c6d55a50f376f1aaac99ee7a1e09aaee74df0fd33630396cb5'
readonly EDGE_ATTEST_SHA256='cd5801cb7a05895639b4f8d305f0bc1814dc8c13b1010b97382e0c9336904df2'
readonly BACKEND_ATTEST_SHA256='a6e92e046bd76fe8235286c9de161f586be18aec3c9e5229f20c00e4140e9aef'
readonly BACKEND_AUTH_CONFIG_SHA256='d5bee35fb391f9995122e4250ab39328fc6b084d835ca0b057fe44145a8402fb'

edge_id=''
backend_id=''
legacy_backend_id=''
backend_container_name=''
backend_env_file=''
backend_auth_mode='unknown'
backend_api_key_sha256=''
edge_ip=''
edge_started=0
backend_started=0
completed=0
caddy_log=''
egress_probe_report=''
models_file=''
models_curl_exit=0
models_writeout=''
models_status='000'
models_report=''
models_report_exit=0

fail() { printf 'OMNIROUTE_CANDIDATE=FAIL reason=%s\n' "$1" >&2; exit 1; }
log() { printf 'OMNIROUTE_CANDIDATE=%s\n' "$1"; }

attest_edge_address() {
	local edge_runtime_networks network_runtime_ipam
	local -a edge_subnet_args=()
	edge_ip=''
	edge_runtime_networks=$(docker inspect --format '{{.Id}}|{{json .NetworkSettings.Networks}}' "$edge_id") || return 1
	network_runtime_ipam=$(docker network inspect --format '{{.Id}}|{{json .IPAM.Config}}' "$network_id") || return 1
	if (( egress_candidate == 1 )); then
		[[ -n "${policy_subnet:-}" ]] || return 1
		edge_subnet_args=(--expected-subnet "$policy_subnet")
	fi
	edge_ip=$(python3 "$TLS_HEALTH_REPORT_SCRIPT" edge-ip \
		--edge-snapshot "$edge_runtime_networks" --network-snapshot "$network_runtime_ipam" \
		--expected-edge-id "$edge_id" --expected-network-id "$network_id" --network-name "$NETWORK" \
		"${edge_subnet_args[@]}" 2>/dev/null) || { edge_ip=''; return 1; }
	[[ "$edge_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { edge_ip=''; return 1; }
}

render_caddyfile() {
	local port=$1
	printf ':8443 {\n\ttls /etc/caddy/tls.crt /etc/caddy/tls.key\n\t@unauthorized not header Authorization "Bearer {$OMNIROUTE_PROXY_TOKEN}"\n\trespond @unauthorized "unauthorized" 401\n\treverse_proxy 127.0.0.1:%s\n}\n' "$port"
}

# Harmless offline fixture hook used by regression tests; it does not access
# Docker, host paths, or any operator secrets.
if [[ ${1:-} == '--render-caddyfile' ]]; then
	[[ $# -eq 2 && $2 == "$BACKEND_PORT" ]] || fail 'invalid_caddyfile_fixture_arguments'
	render_caddyfile "$BACKEND_PORT"
	exit 0
fi
resume_existing=0
egress_candidate=0
resume_egress_network_id=''
resume_edge_container_id=''
resume_backend_container_id=''
resume_auth_backend_container_id=''
backend_api_key_upgrade=0
recover_missing_egress_policy=0
while (($#)); do
	case "$1" in
		--resume-existing) (( resume_existing == 0 )) || fail 'duplicate_resume_flag'; resume_existing=1 ;;
		--egress-candidate) (( egress_candidate == 0 )) || fail 'duplicate_egress_flag'; egress_candidate=1 ;;
		--resume-egress-network-id)
			(($# >= 2)) || fail 'resume_egress_network_id_missing'
			[[ -z "$resume_egress_network_id" ]] || fail 'duplicate_resume_egress_network_id'
			resume_egress_network_id=$2
			shift
			;;
		--resume-edge-container-id)
			(($# >= 2)) || fail 'resume_edge_container_id_missing'
			[[ -z "$resume_edge_container_id" ]] || fail 'duplicate_resume_edge_container_id'
			[[ "$2" =~ ^[a-f0-9]{64}$ ]] || fail 'resume_edge_container_id_invalid'
			resume_edge_container_id=$2
			shift
			;;
		--resume-backend-container-id)
			(($# >= 2)) || fail 'resume_backend_container_id_missing'
			[[ -z "$resume_backend_container_id" ]] || fail 'duplicate_resume_backend_container_id'
			[[ "$2" =~ ^[a-f0-9]{64}$ ]] || fail 'resume_backend_container_id_invalid'
			resume_backend_container_id=$2
			shift
			;;
		--resume-auth-backend-container-id)
			(($# >= 2)) || fail 'resume_auth_backend_container_id_missing'
			[[ -z "$resume_auth_backend_container_id" ]] || fail 'duplicate_resume_auth_backend_container_id'
			[[ "$2" =~ ^[a-f0-9]{64}$ ]] || fail 'resume_auth_backend_container_id_invalid'
			resume_auth_backend_container_id=$2
			shift
			;;
		--backend-api-key-upgrade)
			(( backend_api_key_upgrade == 0 )) || fail 'duplicate_backend_api_key_upgrade_flag'
			backend_api_key_upgrade=1
			;;
		--recover-missing-egress-policy)
			(( recover_missing_egress_policy == 0 )) || fail 'duplicate_egress_policy_recovery_flag'
			recover_missing_egress_policy=1
			;;
		*) fail 'unsupported_arguments' ;;
	esac
	shift
done
if (( egress_candidate == 1 )); then
	readonly NETWORK='phi-omniroute-egress-candidate-v1'
	readonly EDGE_NAME='phi-omniroute-egress-edge-v1'
	readonly BACKEND_NAME='phi-omniroute-egress-backend-v1'
	readonly BACKEND_AUTH_NAME='phi-omniroute-egress-backend-auth-v1'
	readonly NETWORK_LABEL='phi.omniroute.candidate.egress=v1'
else
	readonly NETWORK='phi-omniroute-candidate-3_8_50'
	readonly EDGE_NAME='phi-omniroute-candidate-edge-3_8_50'
	readonly BACKEND_NAME='phi-omniroute-candidate-backend-3_8_50'
	readonly BACKEND_AUTH_NAME='phi-omniroute-candidate-backend-auth-3_8_50'
	readonly NETWORK_LABEL='phi.omniroute.candidate=true'
fi
if (( backend_api_key_upgrade == 1 )); then
	(( egress_candidate == 1 && resume_existing == 1 )) || fail 'backend_api_key_upgrade_requires_egress_resume'
	[[ -n "$resume_egress_network_id" && -n "$resume_edge_container_id" && -n "$resume_backend_container_id" ]] || fail 'backend_api_key_upgrade_requires_exact_existing_ids'
fi
if (( egress_candidate == 1 && resume_existing == 1 )); then
	[[ "$resume_egress_network_id" =~ ^[a-f0-9]{64}$ ]] || fail 'resume_egress_network_id_required'
elif [[ -n "$resume_egress_network_id" ]]; then
	fail 'resume_egress_network_id_requires_egress_resume_mode'
fi
if [[ -n "$resume_edge_container_id" ]]; then
	(( egress_candidate == 1 && resume_existing == 1 )) || fail 'resume_edge_id_requires_egress_resume_mode'
	[[ "$resume_edge_container_id" =~ ^[a-f0-9]{64}$ ]] || fail 'resume_edge_container_id_invalid'
fi
if [[ -n "$resume_backend_container_id" ]]; then
	(( egress_candidate == 1 && resume_existing == 1 )) || fail 'resume_backend_id_requires_egress_resume_mode'
	[[ -n "$resume_edge_container_id" ]] || fail 'resume_backend_requires_exact_edge_id'
	[[ "$resume_backend_container_id" =~ ^[a-f0-9]{64}$ ]] || fail 'resume_backend_container_id_invalid'
fi
if [[ -n "$resume_auth_backend_container_id" ]]; then
	(( egress_candidate == 1 && resume_existing == 1 && backend_api_key_upgrade == 0 )) || fail 'resume_auth_backend_requires_egress_resume_without_upgrade'
	[[ -n "$resume_egress_network_id" && -n "$resume_edge_container_id" && -n "$resume_backend_container_id" ]] || fail 'resume_auth_backend_requires_exact_network_edge_and_legacy_backend_ids'
	[[ "$resume_auth_backend_container_id" =~ ^[a-f0-9]{64}$ ]] || fail 'resume_auth_backend_container_id_invalid'
fi
if (( recover_missing_egress_policy == 1 )); then
	(( egress_candidate == 1 && resume_existing == 1 && backend_api_key_upgrade == 0 )) || fail 'egress_policy_recovery_requires_exact_candidate_resume'
	[[ "$resume_egress_network_id" == "$RECOVERY_NETWORK_ID" && "$resume_edge_container_id" == "$RECOVERY_EDGE_ID" && "$resume_backend_container_id" == "$RECOVERY_LEGACY_BACKEND_ID" && "$resume_auth_backend_container_id" == "$RECOVERY_AUTH_BACKEND_ID" ]] || fail 'egress_policy_recovery_scope_identity_mismatch'
fi

on_exit() {
	local status=$?
	if [[ -n "$caddy_log" && -f "$caddy_log" && ! -L "$caddy_log" ]]; then rm -f -- "$caddy_log"; fi
	if [[ -n "$egress_probe_report" && -f "$egress_probe_report" && ! -L "$egress_probe_report" ]]; then rm -f -- "$egress_probe_report"; fi
	if [[ -n "$models_file" && -f "$models_file" && ! -L "$models_file" ]]; then rm -f -- "$models_file"; fi
	if (( status != 0 && completed == 0 )); then
		if [[ -e "$ROOT" || -L "$ROOT" ]]; then printf 'OMNIROUTE_CANDIDATE=PROTECTED_HOST_CONFIG_PRESERVED path=%s\n' "$ROOT" >&2; fi
		# Stop only exact IDs created by this invocation. Never remove anything.
		if (( backend_started == 1 )) && [[ -n "$backend_id" ]]; then docker stop --time 5 "$backend_id" >/dev/null 2>&1 || true; fi
		if (( edge_started == 1 )) && [[ -n "$edge_id" ]]; then docker stop --time 5 "$edge_id" >/dev/null 2>&1 || true; fi
		printf 'OMNIROUTE_CANDIDATE=PARTIAL_STATE_PRESERVED network_id=%s edge_id=%s backend_id=%s egress_policy=retained\n' "${network_id:-none}" "${edge_id:-none}" "${backend_id:-none}" >&2
	fi
}
trap on_exit EXIT

[[ ${EUID:-$(id -u)} -eq 0 ]] || fail 'run_from_authorized_host_terminal_with_sudo'
for command in docker openssl curl ss sha256sum install python3 ip; do command -v "$command" >/dev/null 2>&1 || fail "missing_host_command_${command}"; done
printf '%s  %s\n' "$TLS_HEALTH_REPORT_SHA256" "$TLS_HEALTH_REPORT_SCRIPT" | sha256sum --check --status || fail 'tls_health_report_script_digest_mismatch'
if (( egress_candidate == 1 )); then
	[[ "$POLICY_SCRIPT_SHA256" != TO_BE_PINNED ]] || fail 'egress_policy_script_digest_not_pinned'
	printf '%s  %s\n' "$POLICY_SCRIPT_SHA256" "$POLICY_SCRIPT" | sha256sum --check --status || fail 'egress_policy_script_digest_mismatch'
	[[ "$EGRESS_PROBE_SHA256" != TO_BE_PINNED ]] || fail 'egress_probe_script_digest_not_pinned'
	printf '%s  %s\n' "$EGRESS_PROBE_SHA256" "$EGRESS_PROBE_SCRIPT" | sha256sum --check --status || fail 'egress_probe_script_digest_mismatch'
	[[ "$EGRESS_REPORT_SHA256" != TO_BE_PINNED ]] || fail 'egress_probe_report_script_digest_not_pinned'
	printf '%s  %s\n' "$EGRESS_REPORT_SHA256" "$EGRESS_REPORT_SCRIPT" | sha256sum --check --status || fail 'egress_probe_report_script_digest_mismatch'
	[[ "$EDGE_ATTEST_SHA256" != TO_BE_PINNED ]] || fail 'edge_attestation_script_digest_not_pinned'
	printf '%s  %s\n' "$EDGE_ATTEST_SHA256" "$EDGE_ATTEST_SCRIPT" | sha256sum --check --status || fail 'edge_attestation_script_digest_mismatch'
	[[ "$BACKEND_ATTEST_SHA256" != TO_BE_PINNED ]] || fail 'backend_attestation_script_digest_not_pinned'
	printf '%s  %s\n' "$BACKEND_ATTEST_SHA256" "$BACKEND_ATTEST_SCRIPT" | sha256sum --check --status || fail 'backend_attestation_script_digest_mismatch'
	[[ "$BACKEND_AUTH_CONFIG_SHA256" != TO_BE_PINNED ]] || fail 'backend_auth_config_script_digest_not_pinned'
	printf '%s  %s\n' "$BACKEND_AUTH_CONFIG_SHA256" "$BACKEND_AUTH_CONFIG_SCRIPT" | sha256sum --check --status || fail 'backend_auth_config_script_digest_mismatch'
fi

# Pin the local Docker context/daemon to the system Docker socket. Do not fall
# back to a user's context, remote daemon, rootless daemon, or implicit pull.
context=$(docker context show 2>/dev/null) || fail 'docker_context_unavailable'
[[ "$context" == default ]] || fail 'docker_context_not_default'
socket=$(docker context inspect default --format '{{(index .Endpoints "docker").Host}}' 2>/dev/null) || fail 'docker_endpoint_unavailable'
[[ "$socket" == unix:///var/run/docker.sock ]] || fail 'docker_endpoint_not_system_socket'
daemon_id=$(docker info --format '{{.ID}}' 2>/dev/null) || fail 'docker_daemon_unavailable'
[[ "$daemon_id" =~ ^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$ ]] || fail 'docker_daemon_identity_invalid'
if (( recover_missing_egress_policy == 1 )); then
	[[ "$daemon_id" == "$RECOVERY_DAEMON_ID" ]] || fail 'egress_policy_recovery_daemon_identity_mismatch'
fi

# OmniRoute must already be local under the exact operator-supplied digest.
omni_id=$(docker image inspect "$OMNI_TAG" --format '{{.Id}}' 2>/dev/null) || fail 'approved_omniroute_image_not_local'
omni_digests=$(docker image inspect "$OMNI_TAG" --format '{{json .RepoDigests}}' 2>/dev/null) || fail 'omniroute_image_metadata_unavailable'
[[ "$omni_digests" == *"diegosouzapw/omniroute@${OMNI_DIGEST}"* ]] || fail 'omniroute_digest_mismatch_no_pull_attempted'
resolved_omni_id=$(docker image inspect "$OMNI_IMAGE" --format '{{.Id}}' 2>/dev/null) || fail 'approved_omniroute_digest_unavailable_locally'
[[ "$resolved_omni_id" == "$omni_id" ]] || fail 'omniroute_tag_digest_disagreement'

if [[ -n "$resume_edge_container_id" ]]; then
	existing_edge_id=$(docker container inspect --format '{{.Id}}' "$EDGE_NAME" 2>/dev/null) || fail 'resume_edge_container_name_missing_preserved'
	[[ "$existing_edge_id" == "$resume_edge_container_id" ]] || fail 'resume_edge_container_name_identity_mismatch_preserved'
else
	docker container inspect "$EDGE_NAME" >/dev/null 2>&1 && fail 'edge_name_already_exists'
fi
if [[ -n "$resume_backend_container_id" ]]; then
	existing_backend_id=$(docker container inspect --format '{{.Id}}' "$BACKEND_NAME" 2>/dev/null) || fail 'resume_backend_container_name_missing_preserved'
	[[ "$existing_backend_id" == "$resume_backend_container_id" ]] || fail 'resume_backend_container_name_identity_mismatch_preserved'
	legacy_backend_id=$resume_backend_container_id
	if (( backend_api_key_upgrade == 1 )); then
		docker container inspect "$BACKEND_AUTH_NAME" >/dev/null 2>&1 && fail 'auth_upgrade_backend_name_already_exists_preserved'
	elif [[ -n "$resume_auth_backend_container_id" ]]; then
		existing_auth_backend_id=$(docker container inspect --format '{{.Id}}' "$BACKEND_AUTH_NAME" 2>/dev/null) || fail 'resume_auth_backend_name_missing_preserved'
		[[ "$existing_auth_backend_id" == "$resume_auth_backend_container_id" ]] || fail 'resume_auth_backend_name_identity_mismatch_preserved'
		backend_id=$resume_auth_backend_container_id
	else
		docker container inspect "$BACKEND_AUTH_NAME" >/dev/null 2>&1 && fail 'auth_backend_exists_requires_exact_resume_id_preserved'
		backend_id=$resume_backend_container_id
	fi
elif [[ -n "$resume_auth_backend_container_id" ]]; then
	fail 'resume_auth_backend_requires_exact_legacy_backend_id'
else
	docker container inspect "$BACKEND_NAME" >/dev/null 2>&1 && fail 'backend_name_already_exists'
	docker container inspect "$BACKEND_AUTH_NAME" >/dev/null 2>&1 && fail 'auth_backend_name_already_exists_preserved'
fi
if [[ -n "$resume_egress_network_id" ]]; then
	network_id=$(docker network inspect --format '{{.Id}}' "$NETWORK" 2>/dev/null) || fail 'resume_candidate_network_missing_preserved'
	[[ "$network_id" == "$resume_egress_network_id" ]] || fail 'resume_candidate_network_identity_mismatch_preserved'
else
	docker network inspect "$NETWORK" >/dev/null 2>&1 && fail 'network_already_exists'
fi
root_exists=0
if [[ -e "$ROOT" || -L "$ROOT" ]]; then root_exists=1; fi
if (( resume_existing == 1 && root_exists == 0 )); then fail 'resume_protected_host_config_missing_no_new_credentials_requested'; fi
if (( root_exists == 1 )) && { [[ ! -d "$ROOT" ]] || [[ -L "$ROOT" ]]; }; then fail 'existing_protected_path_not_a_directory_preserved'; fi
[[ -z "$(ss -Hln 'sport = :20129' 2>/dev/null)" ]] || fail 'loopback_tls_port_already_in_use'

run_resume_policy_preflight() {
	if (( recover_missing_egress_policy == 1 )); then
		local -a recovery_key_args=()
		if [[ -n "$backend_api_key_sha256" ]]; then
			recovery_key_args=(--expected-api-key-sha256 "$backend_api_key_sha256")
		fi
		python3 "$POLICY_SCRIPT" recovery-preflight --network-id "$network_id" --daemon-id "$daemon_id" --expect-empty \
			--edge-container-id "$resume_edge_container_id" --legacy-backend-container-id "$resume_backend_container_id" \
			--auth-backend-container-id "$resume_auth_backend_container_id" --expected-edge-image-id "$caddy_id" --expected-backend-image-id "$omni_id" \
			"${recovery_key_args[@]}"
	else
		python3 "$POLICY_SCRIPT" preflight-input --network-id "$network_id" --daemon-id "$daemon_id" --expect-empty
	fi
}

validate_resume_policy_preflight() {
	if (( recover_missing_egress_policy == 1 )); then
		[[ "$policy_result" == OMNIROUTE_EGRESS_POLICY=RECOVERY_ABSENT\ backend=*\ network="${network_id:0:12}" || "$policy_result" == OMNIROUTE_EGRESS_POLICY=RECOVERY_VERIFIED\ backend=*\ network="${network_id:0:12}" ]]
	else
		[[ "$policy_result" == OMNIROUTE_EGRESS_POLICY=VERIFIED\ backend=*\ network="${network_id:0:12}"\ input_migration=ready || "$policy_result" == OMNIROUTE_EGRESS_POLICY=LEGACY_VERIFIED\ backend=*\ network="${network_id:0:12}"\ input_migration=ready ]]
	fi
}

# Pre-attest an existing candidate network and its complete policy before the
# validator container, Caddy config repair, or any other new Docker mutation.
# A mismatch or partial policy is preserved for manual inspection; this resume
# path never reapplies, duplicates, repairs, or removes existing firewall rules.
if (( egress_candidate == 1 )); then
	policy_result=$(python3 "$POLICY_SCRIPT" preflight --daemon-id "$daemon_id") || fail 'egress_policy_host_preflight_failed'
	[[ "$policy_result" == OMNIROUTE_EGRESS_POLICY=READY\ backend=*\ host_ipv4_count=*\ egress=* ]] || fail 'egress_policy_host_preflight_receipt_invalid'
	log "$policy_result"
	if [[ -n "$resume_egress_network_id" ]]; then
		policy_result=$(run_resume_policy_preflight) || fail 'existing_candidate_policy_or_network_not_attested_preserved'
		validate_resume_policy_preflight || fail 'existing_candidate_policy_receipt_invalid_preserved'
		log "$policy_result"
	fi
fi

# Reuse only the already-present edge image for this egress experiment. This
# operation never pulls or changes any image; the legacy mode retains its
# previously documented pinned-Caddy pull fallback.
if ! docker image inspect "$CADDY_IMAGE" >/dev/null 2>&1; then
	if (( egress_candidate == 1 )); then fail 'pinned_caddy_image_not_local_no_pull_attempted'; fi
	log 'PULLING_PINNED_CADDY_EDGE_IMAGE'
	docker pull "$CADDY_IMAGE" >/dev/null || fail 'pinned_caddy_image_pull_failed'
fi
caddy_id=$(docker image inspect "$CADDY_IMAGE" --format '{{.Id}}' 2>/dev/null) || fail 'pinned_caddy_image_unavailable'
[[ "$caddy_id" =~ ^sha256:[a-f0-9]{64}$ ]] || fail 'caddy_image_identity_invalid'

prepare_protected_config() {
	if (( root_exists == 1 )); then
		# A prior run can reach the Caddy validation gate after creating these
		# files. Reuse them only when the full expected object set, ownership,
		# modes, and secret schema match; never ask for replacement secrets.
		local existing_config_receipt
		existing_config_receipt=$(python3 - "$ROOT" <<'PY'
import os, re, stat, sys
root = sys.argv[1]
base_names = {"Caddyfile", "backend.env", "ca.crt", "caddy.env", "tls.key"}
try:
    root_stat = os.lstat(root)
    if not stat.S_ISDIR(root_stat.st_mode) or stat.S_ISLNK(root_stat.st_mode) or (root_stat.st_uid, root_stat.st_gid, stat.S_IMODE(root_stat.st_mode)) != (0, 0, 0o755): raise ValueError
    names = set(os.listdir(root))
    if names not in (base_names, base_names | {"backend-auth.env"}): raise ValueError
    files = {}
    modes = {"Caddyfile": 0o644, "backend.env": 0o600, "ca.crt": 0o644, "caddy.env": 0o600, "tls.key": 0o600}
    if "backend-auth.env" in names: modes["backend-auth.env"] = 0o600
    for name, mode in modes.items():
        path = os.path.join(root, name)
        before = os.lstat(path)
        if not stat.S_ISREG(before.st_mode) or stat.S_ISLNK(before.st_mode) or (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode), before.st_nlink) != (0, 0, mode, 1): raise ValueError
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        try:
            opened = os.fstat(fd)
            data = b""
            while True:
                part = os.read(fd, 65536)
                if not part: break
                data += part
                if len(data) > 1024 * 1024: raise ValueError
            after = os.fstat(fd)
            named = os.lstat(path)
            if (opened.st_dev, opened.st_ino, opened.st_size) != (after.st_dev, after.st_ino, after.st_size) or (named.st_dev, named.st_ino) != (opened.st_dev, opened.st_ino): raise ValueError
            files[name] = data
        finally: os.close(fd)
    def parse_env(data):
        text = data.decode("ascii")
        if not text.endswith("\n") or "\r" in text or "\x00" in text: raise ValueError
        rows = [line.split("=", 1) for line in text.splitlines()]
        if any(len(row) != 2 or not row[0] for row in rows): raise ValueError
        parsed = dict(rows)
        if len(parsed) != len(rows): raise ValueError
        return parsed
    proxy = parse_env(files["caddy.env"])
    if set(proxy) != {"OMNIROUTE_PROXY_TOKEN"} or not re.fullmatch(r"[A-Fa-f0-9]{64,4096}", proxy["OMNIROUTE_PROXY_TOKEN"]): raise ValueError
    backend = parse_env(files["backend.env"])
    base_expected = {"JWT_SECRET", "API_KEY_SECRET", "INITIAL_PASSWORD", "FORCE_OWNERSHIP", "REQUIRE_API_KEY", "HOSTNAME", "PORT", "BASE_URL", "NEXT_PUBLIC_BASE_URL", "AUTH_COOKIE_SECURE"}
    if set(backend) not in (base_expected, base_expected | {"OMNIROUTE_API_KEY"}): raise ValueError
    if not re.fullmatch(r"[a-f0-9]{64}", backend["JWT_SECRET"]) or not re.fullmatch(r"[a-f0-9]{64}", backend["API_KEY_SECRET"]): raise ValueError
    if not re.fullmatch(r"[A-Za-z0-9._~!@#%+=-]{24,}", backend["INITIAL_PASSWORD"]): raise ValueError
    for key, value in {"FORCE_OWNERSHIP":"false", "HOSTNAME":"127.0.0.1", "PORT":"20128", "BASE_URL":"http://127.0.0.1:20128", "NEXT_PUBLIC_BASE_URL":"https://127.0.0.1:20129", "AUTH_COOKIE_SECURE":"true"}.items():
        if backend[key] != value: raise ValueError
    if set(backend) == base_expected:
        if backend["REQUIRE_API_KEY"] != "false": raise ValueError
        auth_mode = "legacy"
    else:
        if backend["REQUIRE_API_KEY"] != "true" or backend["OMNIROUTE_API_KEY"] != proxy["OMNIROUTE_PROXY_TOKEN"]: raise ValueError
        auth_mode = "enforced"
    if "backend-auth.env" in names:
        if auth_mode != "legacy": raise ValueError
        auth = parse_env(files["backend-auth.env"])
        expected_auth = dict(backend, REQUIRE_API_KEY="true", OMNIROUTE_API_KEY=proxy["OMNIROUTE_PROXY_TOKEN"])
        if auth != expected_auth: raise ValueError
        # backend.env intentionally remains the preserved legacy source file;
        # the separate, exact sidecar is what the authenticated replacement
        # consumes. Report the effective candidate mode, not the base file's
        # mode, so an exact-ID resume reaches the enforced-backend branch.
        auth_mode = "enforced"
except Exception:
    print("OMNIROUTE_CANDIDATE=EXISTING_CONFIG_CHECK=FAIL_CLOSED", file=sys.stderr)
    raise SystemExit(1)
print(f"OMNIROUTE_CANDIDATE=EXISTING_CONFIG_CHECK=PASS auth_mode={auth_mode}")
PY
		) || fail 'existing_protected_config_untrusted_preserved'
		case "$existing_config_receipt" in
			OMNIROUTE_CANDIDATE=EXISTING_CONFIG_CHECK=PASS\ auth_mode=legacy) backend_auth_mode='legacy' ;;
			OMNIROUTE_CANDIDATE=EXISTING_CONFIG_CHECK=PASS\ auth_mode=enforced) backend_auth_mode='enforced' ;;
			*) fail 'existing_protected_config_receipt_invalid_preserved' ;;
		esac
		local expected_caddy known_bad_caddy old_identity temp_caddy
		expected_caddy=$(render_caddyfile "$BACKEND_PORT")
		known_bad_caddy=${expected_caddy/@unauthorized/\\@unauthorized}
		old_identity=$(stat -c '%d:%i' "$ROOT/Caddyfile") || fail 'existing_caddyfile_identity_unavailable_preserved'
		if cmp -s <(printf '%s
' "$expected_caddy") "$ROOT/Caddyfile"; then
			log 'EXISTING_PROTECTED_CONFIG_REUSED'
		elif cmp -s <(printf '%s
' "$known_bad_caddy") "$ROOT/Caddyfile"; then
			# The only repair allowed is the known erroneous literal backslash
			# before the Caddy matcher. Any other content remains untouched.
			temp_caddy=$(mktemp "$ROOT/.Caddyfile.recovery.XXXXXX") || fail 'caddyfile_recovery_temp_failed_preserved'
			printf '%s
' "$expected_caddy" > "$temp_caddy"
			chown root:root "$temp_caddy" && chmod 0644 "$temp_caddy" || fail 'caddyfile_recovery_metadata_failed_preserved'
			[[ $(stat -c '%d' "$temp_caddy") == "${old_identity%%:*}" ]] || fail 'caddyfile_recovery_cross_filesystem'
			[[ $(stat -c '%d:%i' "$ROOT/Caddyfile") == "$old_identity" ]] || fail 'caddyfile_changed_during_recovery_preserved'
			mv -T -- "$temp_caddy" "$ROOT/Caddyfile" || fail 'caddyfile_recovery_publish_failed_preserved'
			log 'KNOWN_CADDYFILE_ESCAPE_CORRECTED'
		else
			fail 'existing_caddyfile_unrecognized_preserved'
		fi
		proxy_token=$(awk -F= '$1 == "OMNIROUTE_PROXY_TOKEN" { print substr($0, index($0, "=") + 1) }' "$ROOT/caddy.env") || fail 'existing_proxy_token_unreadable_preserved'
		[[ -n "$proxy_token" ]] || fail 'existing_proxy_token_missing_preserved'
	else
		(( resume_existing == 0 )) || fail 'resume_protected_host_config_missing_no_new_credentials_requested'
		printf 'Inserisci un bearer token esadecimale casuale di almeno 64 caratteri. Non verrà mostrato né registrato.\n' >&2
		IFS= read -r -s -p 'Bearer token candidato: ' proxy_token || fail 'token_input_failed'
		printf '\n' >&2
		[[ "$proxy_token" =~ ^[a-fA-F0-9]{64,}$ ]] || fail 'bearer_token_must_be_at_least_256_random_bits_hex'

		printf 'Inserisci la password iniziale dell’account amministratore OmniRoute (almeno 24 caratteri). Non verrà mostrata né registrata.\n' >&2
		IFS= read -r -s -p 'Password iniziale: ' initial_password || fail 'admin_password_input_failed'
		printf '\n' >&2
		[[ "$initial_password" =~ ^[A-Za-z0-9._~!@#%+=-]{24,}$ ]] || fail 'admin_password_must_be_24_plus_safe_ascii_characters'

		# Exclusive mkdir prevents overwriting a raced-in object. /etc itself is
		# root-owned and non-user-writable; a collision fails without touching it.
		mkdir -m 0755 -- "$ROOT" || fail 'protected_directory_create_failed_no_overwrite'
		[[ ! -L "$ROOT" && $(stat -c '%u:%g:%a' "$ROOT") == '0:0:755' ]] || fail 'protected_directory_metadata_mismatch'

		openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 365 \
			-keyout "$ROOT/tls.key" -out "$ROOT/ca.crt" -subj '/CN=127.0.0.1' \
			-addext 'subjectAltName=IP:127.0.0.1' \
			-addext 'basicConstraints=critical,CA:TRUE' \
			-addext 'keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign' >/dev/null 2>&1 || fail 'tls_certificate_generation_failed'
		chmod 0600 "$ROOT/tls.key"
		chmod 0644 "$ROOT/ca.crt"
		openssl verify -CAfile "$ROOT/ca.crt" -verify_ip 127.0.0.1 "$ROOT/ca.crt" >/dev/null 2>&1 || fail 'tls_certificate_ip_verification_failed'
		cert_pub=$(openssl x509 -in "$ROOT/ca.crt" -pubkey -noout | sha256sum | awk '{print $1}')
		key_pub=$(openssl pkey -in "$ROOT/tls.key" -pubout 2>/dev/null | sha256sum | awk '{print $1}')
		[[ -n "$cert_pub" && "$cert_pub" == "$key_pub" ]] || fail 'tls_key_certificate_mismatch'

		# The random bearer is also configured as OmniRoute's dedicated API key.
		# Caddy enforces it at the host edge and the backend enforces it again for
		# catalog and inference routes, including any same-namespace path.
		printf 'OMNIROUTE_PROXY_TOKEN=%s\n' "$proxy_token" > "$ROOT/caddy.env"
		printf 'JWT_SECRET=%s\nAPI_KEY_SECRET=%s\nINITIAL_PASSWORD=%s\nFORCE_OWNERSHIP=false\nREQUIRE_API_KEY=true\nOMNIROUTE_API_KEY=%s\nHOSTNAME=127.0.0.1\nPORT=%s\nBASE_URL=http://127.0.0.1:%s\nNEXT_PUBLIC_BASE_URL=https://127.0.0.1:%s\nAUTH_COOKIE_SECURE=true\n' \
			"$(openssl rand -hex 32)" "$(openssl rand -hex 32)" "$initial_password" "$proxy_token" "$BACKEND_PORT" "$BACKEND_PORT" "$HOST_PORT" > "$ROOT/backend.env"
		render_caddyfile "$BACKEND_PORT" > "$ROOT/Caddyfile"
		chown root:root "$ROOT" "$ROOT/ca.crt" "$ROOT/tls.key" "$ROOT/caddy.env" "$ROOT/backend.env" "$ROOT/Caddyfile"
		chmod 0600 "$ROOT/caddy.env" "$ROOT/backend.env"
		chmod 0644 "$ROOT/Caddyfile"
		backend_auth_mode='enforced'
	fi

	# Validate the reused/generated credentials and certificate without exposing
	# their contents; all cases remain fail-closed.
	[[ ! -L "$ROOT" && $(stat -c '%u:%g:%a' "$ROOT") == '0:0:755' ]] || fail 'protected_directory_metadata_mismatch'
	for entry in ca.crt tls.key caddy.env backend.env Caddyfile; do
		[[ ! -L "$ROOT/$entry" && -f "$ROOT/$entry" ]] || fail 'protected_config_entry_not_regular'
	done
	if [[ -e "$ROOT/backend-auth.env" || -L "$ROOT/backend-auth.env" ]]; then
		[[ ! -L "$ROOT/backend-auth.env" && -f "$ROOT/backend-auth.env" && $(stat -c '%u:%g:%a' "$ROOT/backend-auth.env") == '0:0:600' ]] || fail 'backend_auth_config_metadata_mismatch_preserved'
	fi
	[[ $(stat -c '%u:%g:%a' "$ROOT/tls.key") == '0:0:600' ]] || fail 'tls_private_key_permissions_mismatch'
	[[ $(stat -c '%u:%g:%a' "$ROOT/caddy.env") == '0:0:600' && $(stat -c '%u:%g:%a' "$ROOT/backend.env") == '0:0:600' ]] || fail 'secret_file_permissions_mismatch'
	[[ $(stat -c '%u:%g:%a' "$ROOT/ca.crt") == '0:0:644' ]] || fail 'client_ca_permissions_mismatch'
	openssl verify -CAfile "$ROOT/ca.crt" -verify_ip 127.0.0.1 "$ROOT/ca.crt" >/dev/null 2>&1 || fail 'tls_certificate_ip_verification_failed'
	cert_pub=$(openssl x509 -in "$ROOT/ca.crt" -pubkey -noout | sha256sum | awk '{print $1}')
	key_pub=$(openssl pkey -in "$ROOT/tls.key" -pubout 2>/dev/null | sha256sum | awk '{print $1}')
	[[ -n "$cert_pub" && "$cert_pub" == "$key_pub" ]] || fail 'tls_key_certificate_mismatch'
}

prepare_protected_config

backend_container_name=$BACKEND_NAME
backend_env_file="$ROOT/backend.env"
if (( egress_candidate == 1 )); then
	if [[ "$backend_auth_mode" == legacy ]]; then
		(( backend_api_key_upgrade == 1 )) || fail 'catalog_and_inference_api_key_enforcement_required'
		[[ -n "$legacy_backend_id" ]] || fail 'auth_upgrade_requires_exact_legacy_backend_id'
		# Confirm the existing backend is the exact stopped, unauthenticated object
		# whose immutable env needs replacement. No secret values are emitted.
		docker inspect --format '{{json .}}' "$legacy_backend_id" | python3 "$BACKEND_ATTEST_SCRIPT" \
			--expected-id "$legacy_backend_id" --expected-image-id "$omni_id" --expected-image-ref "$OMNI_IMAGE" \
			--edge-id "$resume_edge_container_id" --container-name "$BACKEND_NAME" \
			--label-key phi.omniroute.candidate.egress --label-value v1 --phase pre-start --expected-auth-mode legacy \
			|| fail 'legacy_backend_identity_or_auth_state_mismatch_preserved'
		python3 "$BACKEND_AUTH_CONFIG_SCRIPT" prepare --root "$ROOT" || fail 'backend_auth_config_prepare_failed_preserved'
		backend_api_key_sha256=$(python3 "$BACKEND_AUTH_CONFIG_SCRIPT" key-digest --root "$ROOT") || fail 'backend_auth_config_digest_unavailable_preserved'
		backend_container_name=$BACKEND_AUTH_NAME
		backend_env_file="$ROOT/backend-auth.env"
	elif [[ "$backend_auth_mode" == enforced ]]; then
		(( backend_api_key_upgrade == 0 )) || fail 'backend_auth_upgrade_not_needed_or_config_mismatch_preserved'
		backend_api_key_sha256=$(python3 "$BACKEND_AUTH_CONFIG_SCRIPT" key-digest --root "$ROOT") || fail 'backend_auth_config_digest_unavailable_preserved'
		if [[ -n "$resume_auth_backend_container_id" ]]; then
			[[ -n "$legacy_backend_id" ]] || fail 'resume_auth_backend_legacy_id_missing_preserved'
			backend_container_name=$BACKEND_AUTH_NAME
			backend_env_file="$ROOT/backend-auth.env"
			backend_id=$resume_auth_backend_container_id
			# Re-attest the original stopped legacy backend before resuming its
			# authenticated replacement. Neither object is adopted by name alone.
			docker inspect --format '{{json .}}' "$legacy_backend_id" | python3 "$BACKEND_ATTEST_SCRIPT" \
				--expected-id "$legacy_backend_id" --expected-image-id "$omni_id" --expected-image-ref "$OMNI_IMAGE" \
				--edge-id "$resume_edge_container_id" --container-name "$BACKEND_NAME" \
				--label-key phi.omniroute.candidate.egress --label-value v1 --phase pre-start --expected-auth-mode legacy \
				|| fail 'legacy_backend_preservation_attestation_failed_preserved'
		fi
	else
		fail 'backend_auth_state_unknown_preserved'
	fi
elif (( backend_api_key_upgrade == 1 )); then
	fail 'backend_api_key_upgrade_requires_egress_candidate'
elif [[ "$backend_auth_mode" == legacy ]]; then
	fail 'catalog_and_inference_api_key_enforcement_required'
fi

# Recovery is deliberately completed and fully re-attested before even the
# isolated Caddy validator container is started. This explicit mode only
# resumes the exact already-stopped edge/legacy/auth-backend objects.
if (( recover_missing_egress_policy == 1 )); then
	edge_id=$resume_edge_container_id
	backend_id=$resume_auth_backend_container_id
	docker inspect --format '{{json .}}' "$edge_id" | python3 "$EDGE_ATTEST_SCRIPT" \
		--expected-id "$edge_id" --expected-image-id "$caddy_id" --expected-image-ref "$CADDY_IMAGE" \
		--network-id "$network_id" --network-name "$NETWORK" --container-name "$EDGE_NAME" --root "$ROOT" \
		--label-key phi.omniroute.candidate.egress --label-value v1 --host-port "$HOST_PORT" --phase pre-start \
		|| fail 'edge_prestart_identity_or_configuration_attestation_failed_preserved'
	docker inspect --format '{{json .}}' "$legacy_backend_id" | python3 "$BACKEND_ATTEST_SCRIPT" \
		--expected-id "$legacy_backend_id" --expected-image-id "$omni_id" --expected-image-ref "$OMNI_IMAGE" \
		--edge-id "$edge_id" --container-name "$BACKEND_NAME" \
		--label-key phi.omniroute.candidate.egress --label-value v1 --phase pre-start --expected-auth-mode legacy \
		|| fail 'legacy_backend_preservation_attestation_failed_preserved'
	docker inspect --format '{{json .}}' "$backend_id" | python3 "$BACKEND_ATTEST_SCRIPT" \
		--expected-id "$backend_id" --expected-image-id "$omni_id" --expected-image-ref "$OMNI_IMAGE" \
		--edge-id "$edge_id" --container-name "$BACKEND_AUTH_NAME" \
		--label-key phi.omniroute.candidate.egress --label-value auth-v1 --phase pre-start \
		--expected-auth-mode enforced --expected-api-key-sha256 "$backend_api_key_sha256" \
		|| fail 'backend_prestart_identity_or_configuration_attestation_failed_preserved'
	policy_result=$(python3 "$POLICY_SCRIPT" recover --network-id "$network_id" --daemon-id "$daemon_id" --expect-empty \
		--edge-container-id "$edge_id" --legacy-backend-container-id "$legacy_backend_id" \
		--auth-backend-container-id "$backend_id" --expected-edge-image-id "$caddy_id" --expected-backend-image-id "$omni_id" \
		--expected-api-key-sha256 "$backend_api_key_sha256") \
		|| fail 'egress_policy_recovery_failed_state_preserved'
	[[ "$policy_result" == OMNIROUTE_EGRESS_POLICY=RECOVERY_RECOVERED\ backend=*\ network="${network_id:0:12}" || "$policy_result" == OMNIROUTE_EGRESS_POLICY=RECOVERY_ALREADY_VERIFIED\ backend=*\ network="${network_id:0:12}" ]] || fail 'egress_policy_recovery_receipt_invalid_preserved'
	log "$policy_result"
	policy_result=$(python3 "$POLICY_SCRIPT" verify --network-id "$network_id" --daemon-id "$daemon_id" --expect-empty) || fail 'egress_policy_recovery_reverification_failed_preserved'
	[[ "$policy_result" == OMNIROUTE_EGRESS_POLICY=VERIFIED\ backend=*\ network="${network_id:0:12}" ]] || fail 'egress_policy_recovery_reverification_receipt_invalid_preserved'
	log "$policy_result"
fi

# Validate Caddy's actual Caddyfile with the pinned image, no network and only
# disposable tmpfs state. This creates and auto-removes one short-lived validator.
validate_caddyfile() {
	caddy_log=$(mktemp /run/phi-omniroute-caddy-validate.XXXXXX) || fail 'caddy_diagnostic_temp_unavailable'
	chmod 0600 "$caddy_log" || fail 'caddy_diagnostic_permissions_failed'
	if docker run --rm --pull=never --network none --read-only --user 0:0 \
		--cap-drop ALL --cap-add NET_BIND_SERVICE --security-opt no-new-privileges \
		--tmpfs /data:rw,noexec,nosuid,size=16m --tmpfs /config:rw,noexec,nosuid,size=16m --tmpfs /tmp:rw,noexec,nosuid,size=16m \
		--mount "type=bind,src=$ROOT/Caddyfile,dst=/etc/caddy/Caddyfile,readonly" \
		--mount "type=bind,src=$ROOT/ca.crt,dst=/etc/caddy/tls.crt,readonly" \
		--mount "type=bind,src=$ROOT/tls.key,dst=/etc/caddy/tls.key,readonly" \
		--env-file "$ROOT/caddy.env" --entrypoint caddy "$CADDY_IMAGE" validate --config /etc/caddy/Caddyfile --adapter caddyfile >"$caddy_log" 2>&1; then
		rm -f -- "$caddy_log"
		caddy_log=''
		log 'CADDYFILE_VALIDATION_PASS'
		return 0
	fi
	printf 'Caddy validation failed; sanitized diagnostic follows (token/password values are redacted):\n' >&2
	if ! python3 - "$caddy_log" "$ROOT/caddy.env" "$ROOT/backend.env" <<'PY'
import re, sys
try:
    diagnostic = open(sys.argv[1], "r", encoding="utf-8", errors="replace").read(65536)
    secrets = []
    for path in sys.argv[2:]:
        with open(path, "r", encoding="ascii") as stream:
            for row in stream:
                key, sep, value = row.rstrip("\n").partition("=")
                if sep and key in {"OMNIROUTE_PROXY_TOKEN", "JWT_SECRET", "API_KEY_SECRET", "INITIAL_PASSWORD"} and value:
                    secrets.append(value)
    for secret in sorted(secrets, key=len, reverse=True):
        diagnostic = diagnostic.replace(secret, "[REDACTED]")
    diagnostic = re.sub(r"(?i)(bearer\s+)[a-f0-9]{32,}", r"\1[REDACTED]", diagnostic)
    diagnostic = re.sub(r"(?i)((?:token|password|secret)\s*[=:]\s*)[^\s,;]+", r"\1[REDACTED]", diagnostic)
    diagnostic = "".join(char if char in "\n\t" or ord(char) >= 32 else "?" for char in diagnostic)
    print(diagnostic[:4096].rstrip())
except Exception:
    raise SystemExit(1)
PY
	then
		printf 'Diagnostic omitted because redaction could not be guaranteed.\n' >&2
	fi
	fail 'caddy_config_validation_failed'
}

validate_caddyfile


if (( egress_candidate == 1 )); then
	if [[ -n "$resume_egress_network_id" ]]; then
		# Reconfirm exact Docker identity and full policy after the temporary
		# validator, immediately before creating the first endpoint.
		actual_network_id=$(docker network inspect --format '{{.Id}}' "$NETWORK" 2>/dev/null) || fail 'resume_candidate_network_disappeared_preserved'
		[[ "$actual_network_id" == "$resume_egress_network_id" ]] || fail 'resume_candidate_network_replaced_preserved'
		network_id=$actual_network_id
		policy_result=$(run_resume_policy_preflight) || fail 'existing_candidate_policy_changed_preserved'
		validate_resume_policy_preflight || fail 'existing_candidate_policy_receipt_invalid_preserved'
		log "$policy_result"
	else
		# A new bridge has no endpoint while its candidate-specific deny policy is
		# installed and verified.
		network_id=$(docker network create --driver bridge --ipv6=false --label "$NETWORK_LABEL" --opt com.docker.network.bridge.enable_ip_masquerade=true "$NETWORK") || fail 'egress_candidate_network_create_failed'
	fi
else
	network_id=$(docker network create --driver bridge --internal --label "$NETWORK_LABEL" "$NETWORK") || fail 'candidate_network_create_failed'
fi
[[ "$network_id" =~ ^[a-f0-9]{64}$ ]] || fail 'candidate_network_create_returned_invalid_id'
if (( egress_candidate == 1 )) && [[ -z "$resume_egress_network_id" ]]; then
	policy_result=$(python3 "$POLICY_SCRIPT" apply --network-id "$network_id" --daemon-id "$daemon_id") || fail 'egress_policy_application_or_verification_failed'
	[[ "$policy_result" == OMNIROUTE_EGRESS_POLICY=APPLIED\ backend=*\ network="${network_id:0:12}"\ bridge=*\ subnet=*\ gateway=*\ egress=* ]] || fail 'egress_policy_apply_receipt_invalid'
	log "$policy_result"
	policy_backend=${policy_result#*backend=}
	policy_backend=${policy_backend%% *}
	policy_bridge=${policy_result#*bridge=}
	policy_bridge=${policy_bridge%% *}
	policy_subnet=${policy_result#*subnet=}
	policy_subnet=${policy_subnet%% *}
	policy_gateway=${policy_result#*gateway=}
	policy_gateway=${policy_gateway%% *}
	policy_egress=${policy_result#*egress=}
	python3 - "$network_id" "$policy_bridge" "$policy_subnet" "$policy_gateway" "$policy_egress" <<'PY' || fail 'egress_policy_network_facts_invalid'
import ipaddress, re, sys
network, bridge, subnet, gateway, egress = sys.argv[1:]
if not re.fullmatch(r"[a-f0-9]{64}", network) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,15}", bridge) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,15}", egress): raise SystemExit(1)
parsed = ipaddress.ip_network(subnet, strict=True)
if parsed.version != 4 or ipaddress.ip_address(gateway) not in parsed: raise SystemExit(1)
PY
	policy_result=$(python3 "$POLICY_SCRIPT" verify --network-id "$network_id" --daemon-id "$daemon_id" --expect-empty) || fail 'egress_policy_reverification_failed'
	log "$policy_result"
elif (( egress_candidate == 1 )); then
	# A resumed network may have the exact legacy INPUT policy. Classify only
	# the complete current/legacy policy here; migration is deliberately later,
	# after the exact edge has passed pre-start attestation. A full current-policy
	# verify here would reject LEGACY_VERIFIED before that authorized migration.
	policy_result=$(run_resume_policy_preflight) || fail 'existing_candidate_policy_reverification_failed_preserved'
	validate_resume_policy_preflight || fail 'existing_candidate_policy_reverification_receipt_invalid_preserved'
	log "$policy_result"
else
	network_facts=$(docker network inspect --format '{{.Id}}|{{.Driver}}|{{.Internal}}|{{.Attachable}}' "$NETWORK") || fail 'candidate_network_inspect_failed'
	[[ "$network_facts" == "$network_id|bridge|true|false" ]] || fail 'candidate_network_isolation_mismatch'
fi

edge_label='phi.omniroute.candidate=true'
backend_label='phi.omniroute.candidate=true'
backend_label_value='true'
network_sysctl=()
if (( egress_candidate == 1 )); then
	edge_label='phi.omniroute.candidate.egress=v1'
	backend_label='phi.omniroute.candidate.egress=v1'
	backend_label_value='v1'
	network_sysctl+=(--sysctl net.ipv6.conf.all.disable_ipv6=1 --sysctl net.ipv6.conf.default.disable_ipv6=1)
fi
if (( backend_api_key_upgrade == 1 )) || [[ -n "$resume_auth_backend_container_id" ]]; then
	backend_label='phi.omniroute.candidate.egress=auth-v1'
	backend_label_value='auth-v1'
fi

if [[ -n "$resume_edge_container_id" ]]; then
	# Resume only the operator-specified immutable ID. The name lookup above is
	# an additional consistency check, never the authority for identity.
	edge_id=$resume_edge_container_id
	log "RESUMING_EXACT_EDGE_ID_${edge_id:0:12}"
else
	edge_id=$(docker create --name "$EDGE_NAME" --label "$edge_label" \
		--network "$NETWORK" --publish "127.0.0.1:${HOST_PORT}:8443/tcp" \
		"${network_sysctl[@]}" --restart no --read-only --user 0:0 --cap-drop ALL --cap-add NET_BIND_SERVICE --security-opt no-new-privileges --pids-limit 128 \
		--tmpfs /data:rw,noexec,nosuid,size=16m --tmpfs /config:rw,noexec,nosuid,size=16m --tmpfs /tmp:rw,noexec,nosuid,size=16m \
		--mount "type=bind,src=$ROOT/Caddyfile,dst=/etc/caddy/Caddyfile,readonly" \
		--mount "type=bind,src=$ROOT/ca.crt,dst=/etc/caddy/tls.crt,readonly" \
		--mount "type=bind,src=$ROOT/tls.key,dst=/etc/caddy/tls.key,readonly" \
		--env-file "$ROOT/caddy.env" --entrypoint caddy "$CADDY_IMAGE" run --config /etc/caddy/Caddyfile --adapter caddyfile) || fail 'edge_create_failed'
	[[ "$edge_id" =~ ^[a-f0-9]{64}$ ]] || fail 'edge_create_returned_invalid_id'
fi

if (( egress_candidate == 1 )); then
	# docker create does not activate a network endpoint. Attest the created
	# object by exact ID and its requested network configuration before start,
	# while policy verification still requires the network endpoint set empty.
	docker inspect --format '{{json .}}' "$edge_id" | python3 "$EDGE_ATTEST_SCRIPT" \
		--expected-id "$edge_id" --expected-image-id "$caddy_id" --expected-image-ref "$CADDY_IMAGE" \
		--network-id "$network_id" --network-name "$NETWORK" --container-name "$EDGE_NAME" --root "$ROOT" \
		--label-key phi.omniroute.candidate.egress --label-value v1 --host-port "$HOST_PORT" --phase pre-start \
		|| fail 'edge_prestart_identity_or_configuration_attestation_failed_preserved'
	if (( recover_missing_egress_policy == 1 )); then
		policy_result=$(python3 "$POLICY_SCRIPT" recovery-preflight --network-id "$network_id" --daemon-id "$daemon_id" --expect-empty \
			--edge-container-id "$edge_id" --legacy-backend-container-id "$legacy_backend_id" \
			--auth-backend-container-id "$backend_id" --expected-edge-image-id "$caddy_id" --expected-backend-image-id "$omni_id" \
			--expected-api-key-sha256 "$backend_api_key_sha256") \
			|| fail 'egress_policy_recovery_changed_before_start_preserved'
		[[ "$policy_result" == OMNIROUTE_EGRESS_POLICY=RECOVERY_VERIFIED\ backend=*\ network="${network_id:0:12}" ]] || fail 'egress_policy_recovery_missing_before_start_preserved'
	else
		policy_result=$(python3 "$POLICY_SCRIPT" migrate-input --network-id "$network_id" --daemon-id "$daemon_id" --expect-empty) || fail 'egress_policy_input_migration_failed_preserved'
		[[ "$policy_result" == OMNIROUTE_EGRESS_POLICY=MIGRATED\ backend=*\ network="${network_id:0:12}"\ rule=host_reply_only || "$policy_result" == OMNIROUTE_EGRESS_POLICY=ALREADY_VERIFIED\ backend=*\ network="${network_id:0:12}"\ rule=host_reply_only ]] || fail 'egress_policy_input_migration_receipt_invalid_preserved'
	fi
	log "$policy_result"
	policy_result=$(python3 "$POLICY_SCRIPT" verify --network-id "$network_id" --daemon-id "$daemon_id" --expect-empty) || fail 'egress_policy_prestart_or_empty_endpoint_verification_failed_preserved'
	[[ "$policy_result" == OMNIROUTE_EGRESS_POLICY=VERIFIED\ backend=*\ network="${network_id:0:12}" ]] || fail 'egress_policy_prestart_receipt_invalid_preserved'
	log "$policy_result"
fi

# The namespace-sharing target must already be running so Docker can attach
# the backend to its live network namespace. The edge stays bounded/fail-soft:
# its upstream returns unavailable until the backend below is started.
edge_started=1
docker start "$edge_id" >/dev/null || fail 'edge_start_failed'

if (( egress_candidate == 1 )); then
	# This is intentionally the first inspection after docker start: the running
	# snapshot must now contain the exact network and a real endpoint ID. Only
	# then may the firewall verifier accept this exact endpoint.
	docker inspect --format '{{json .}}' "$edge_id" | python3 "$EDGE_ATTEST_SCRIPT" \
		--expected-id "$edge_id" --expected-image-id "$caddy_id" --expected-image-ref "$CADDY_IMAGE" \
		--network-id "$network_id" --network-name "$NETWORK" --container-name "$EDGE_NAME" --root "$ROOT" \
		--label-key phi.omniroute.candidate.egress --label-value v1 --host-port "$HOST_PORT" --phase post-start \
		|| fail 'edge_poststart_identity_or_endpoint_attestation_failed_preserved'
	policy_result=$(python3 "$POLICY_SCRIPT" facts --network-id "$network_id" --daemon-id "$daemon_id" --expected-endpoint-id "$edge_id") || fail 'egress_policy_post_edge_start_verification_failed_preserved'
	[[ "$policy_result" == OMNIROUTE_EGRESS_POLICY=VERIFIED\ backend=*\ network="${network_id:0:12}"\ bridge=*\ subnet=*\ gateway=*\ egress=* ]] || fail 'egress_policy_post_edge_start_receipt_invalid_preserved'
	policy_backend=${policy_result#*backend=}; policy_backend=${policy_backend%% *}
	policy_bridge=${policy_result#*bridge=}; policy_bridge=${policy_bridge%% *}
	policy_subnet=${policy_result#*subnet=}; policy_subnet=${policy_subnet%% *}
	policy_gateway=${policy_result#*gateway=}; policy_gateway=${policy_gateway%% *}
	policy_egress=${policy_result#*egress=}; policy_egress=${policy_egress%% *}
	python3 - "$network_id" "$policy_bridge" "$policy_subnet" "$policy_gateway" "$policy_egress" <<'PY' || fail 'egress_policy_network_facts_invalid_preserved'
import ipaddress, re, sys
network, bridge, subnet, gateway, egress = sys.argv[1:]
if not re.fullmatch(r"[a-f0-9]{64}", network) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,15}", bridge) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,15}", egress): raise SystemExit(1)
parsed = ipaddress.ip_network(subnet, strict=True)
if parsed.version != 4 or ipaddress.ip_address(gateway) not in parsed: raise SystemExit(1)
PY
	log "$policy_result"
fi

attest_edge_address || fail 'edge_attested_ipv4_unavailable'

if (( backend_api_key_upgrade == 1 )); then
	# The legacy container was attested stopped before any new object is created.
	# Keep it intact under its old name for operator-controlled rollback.
	backend_id=$(docker create --name "$backend_container_name" --label "$backend_label" \
		--network "container:${edge_id}" --restart no --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 \
		--env-file "$backend_env_file" "$OMNI_IMAGE") || fail 'auth_backend_create_failed_legacy_backend_preserved'
	[[ "$backend_id" =~ ^[a-f0-9]{64}$ ]] || fail 'auth_backend_create_returned_invalid_id_preserved'
	log "AUTH_BACKEND_CREATED_EXACT_ID_${backend_id:0:12}_LEGACY_ID_${legacy_backend_id:0:12}_PRESERVED"
	elif [[ -n "$resume_auth_backend_container_id" ]]; then
	# Resume the exact already-created authenticated replacement. Never create a
	# duplicate and never change or remove the preserved legacy backend.
	log "RESUMING_EXACT_AUTH_BACKEND_ID_${backend_id:0:12}_LEGACY_ID_${legacy_backend_id:0:12}_PRESERVED"
elif [[ -n "$resume_backend_container_id" ]]; then
	# Validate the named object by its supplied immutable ID and exact image,
	# stopped state, hardening, and namespace target before any start operation.
	log "RESUMING_EXACT_BACKEND_ID_${backend_id:0:12}"
else
	backend_id=$(docker create --name "$backend_container_name" --label "$backend_label" \
		--network "container:${edge_id}" --restart no --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 \
		--env-file "$backend_env_file" "$OMNI_IMAGE") || fail 'backend_create_failed'
	[[ "$backend_id" =~ ^[a-f0-9]{64}$ ]] || fail 'backend_create_returned_invalid_id'
fi

if (( egress_candidate == 1 )); then
	docker inspect --format '{{json .}}' "$backend_id" | python3 "$BACKEND_ATTEST_SCRIPT" \
		--expected-id "$backend_id" --expected-image-id "$omni_id" --expected-image-ref "$OMNI_IMAGE" \
		--edge-id "$edge_id" --container-name "$backend_container_name" \
		--label-key phi.omniroute.candidate.egress --label-value "$backend_label_value" --phase pre-start \
		--expected-auth-mode enforced --expected-api-key-sha256 "$backend_api_key_sha256" \
		|| fail 'backend_prestart_identity_or_configuration_attestation_failed_preserved'
fi

# Start only the exact, pre-attested backend ID. Do not retry or remove either container.
backend_started=1
docker start "$backend_id" >/dev/null || fail 'backend_start_failed'
if (( egress_candidate == 1 )); then
	docker inspect --format '{{json .}}' "$backend_id" | python3 "$BACKEND_ATTEST_SCRIPT" \
		--expected-id "$backend_id" --expected-image-id "$omni_id" --expected-image-ref "$OMNI_IMAGE" \
		--edge-id "$edge_id" --container-name "$backend_container_name" \
		--label-key phi.omniroute.candidate.egress --label-value "$backend_label_value" --phase post-start \
		--expected-auth-mode enforced --expected-api-key-sha256 "$backend_api_key_sha256" \
		|| fail 'backend_poststart_identity_or_namespace_attestation_failed_preserved'
fi

if (( egress_candidate == 1 )); then
	policy_result=$(python3 "$POLICY_SCRIPT" verify --network-id "$network_id" --daemon-id "$daemon_id" --expected-endpoint-id "$edge_id") || fail 'egress_policy_post_start_verification_failed'
	log "$policy_result"
	probe_counters_before=''
	if probe_counters_before=$(python3 "$POLICY_SCRIPT" counters --network-id "$network_id" --daemon-id "$daemon_id" --expected-endpoint-id "$edge_id" 2>/dev/null); then
		:
	else
		printf 'OMNIROUTE_EGRESS_RUNTIME_COUNTERS=FAIL phase=COUNTERS_BEFORE_COMMAND\n' >&2
		fail 'egress_policy_counter_snapshot_failed'
	fi
	host_ips_json=$(ip -j -4 address show | python3 -c 'import ipaddress,json,sys; data=json.load(sys.stdin); vals=sorted({str(ipaddress.IPv4Address(x["local"])) for d in data for x in d.get("addr_info",[]) if x.get("family")=="inet"}); assert 0<len(vals)<=64; print(json.dumps(vals,separators=(",",":")))') || fail 'host_ipv4_snapshot_failed'
	probe_code=$(<"$EGRESS_PROBE_SCRIPT")
	egress_probe_report=$(mktemp /run/phi-omniroute-egress-probe.XXXXXX) || fail 'egress_probe_report_create_failed'
	chmod 0600 "$egress_probe_report" || fail 'egress_probe_report_permissions_failed'
	probe_exit=0
	if docker exec "$backend_id" node -e "$probe_code" "$policy_gateway" "$host_ips_json" > "$egress_probe_report" 2>/dev/null; then
		probe_exit=0
	else
		probe_exit=$?
	fi
	probe_diagnostic=$(python3 "$EGRESS_REPORT_SCRIPT" --exit-code "$probe_exit" < "$egress_probe_report") || fail 'egress_probe_diagnostic_sanitization_failed'
	printf '%s\n' "$probe_diagnostic" > "$egress_probe_report"
	probe_status=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])' <<<"$probe_diagnostic") || fail 'egress_probe_diagnostic_shape_invalid'
	if [[ "$probe_status" != PASS || "$probe_exit" -ne 0 ]]; then
		probe_phase=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["phase"])' <<<"$probe_diagnostic") || probe_phase=PROBE_OUTPUT_VALIDATION
		printf 'OMNIROUTE_EGRESS_RUNTIME_PROBE=FAIL phase=%s diagnostic=%s\n' "$probe_phase" "$probe_diagnostic" >&2
		fail 'egress_runtime_probe_failed'
	fi
	probe_counters_after=''
	probe_counters_after_exit=0
	if probe_counters_after=$(python3 "$POLICY_SCRIPT" counters --network-id "$network_id" --daemon-id "$daemon_id" --expected-endpoint-id "$edge_id" 2>/dev/null); then
		probe_counters_after_exit=0
	else
		probe_counters_after_exit=$?
	fi
	counter_diagnostic=''
	if counter_diagnostic=$(python3 "$EGRESS_REPORT_SCRIPT" --counter-gate \
		--before-json "$probe_counters_before" --after-json "$probe_counters_after" \
		--after-exit-code "$probe_counters_after_exit" < "$egress_probe_report" 2>/dev/null); then
		:
	else
		printf 'OMNIROUTE_EGRESS_RUNTIME_COUNTERS=FAIL phase=COUNTER_VALIDATOR\n' >&2
		fail 'egress_runtime_counters_not_proven'
	fi
	if [[ "$counter_diagnostic" != 'OMNIROUTE_EGRESS_COUNTERS=PASS phase=COMPLETE' ]]; then
		if [[ "$counter_diagnostic" =~ ^OMNIROUTE_EGRESS_COUNTERS=FAIL\ phase=([A-Z_]+)$ ]]; then
			printf 'OMNIROUTE_EGRESS_RUNTIME_COUNTERS=FAIL phase=%s\n' "${BASH_REMATCH[1]}" >&2
		else
			printf 'OMNIROUTE_EGRESS_RUNTIME_COUNTERS=FAIL phase=COUNTER_RESULT_INVALID\n' >&2
		fi
		fail 'egress_runtime_counters_not_proven'
	fi
	printf '%s\n' "$counter_diagnostic"
	log 'EGRESS_POLICY_RUNTIME_PROBES_PASS'
fi

tls_last_exit=0
tls_last_writeout='000|0.000000|0.000000|0.000000|0.000000'
wait_status() {
	local code=$1
	local deadline=$((SECONDS + 75))
	local writeout curl_exit http_status
	while (( SECONDS < deadline )); do
		if writeout=$(curl --noproxy '*' --silent --output /dev/null \
			--write-out '%{http_code}|%{time_connect}|%{time_appconnect}|%{time_starttransfer}|%{time_total}' \
			--connect-timeout 1 --max-time 3 --cacert "$ROOT/ca.crt" \
			-H "Authorization: Bearer $proxy_token" "https://127.0.0.1:${HOST_PORT}/healthz" 2>/dev/null); then
			curl_exit=0
		else
			curl_exit=$?
		fi
		http_status=${writeout%%|*}
		[[ "$curl_exit" == 0 && "$http_status" == "$code" ]] && return 0
		tls_last_exit=$curl_exit
		tls_last_writeout=$writeout
		sleep 1
	done
	return 1
}

diagnose_tls_health_failure() {
	local port_snapshot counter_after='' counter_after_exit=1
	local backend_output='' backend_exit=1 edge_output='' edge_exit=1 auth_edge_output='' auth_edge_exit=1 report
	if ! attest_edge_address; then
		printf 'OMNIROUTE_TLS_EDGE_ENDPOINT=UNKNOWN phase=ATTESTATION_FAILED\n' >&2
	fi
	port_snapshot=$(docker inspect --format '{{json .HostConfig.PortBindings}}|{{json .NetworkSettings.Ports}}' "$edge_id" 2>/dev/null) || port_snapshot='{}|{}'
	# Readiness is requested inside the existing shared edge namespace; the
	# backend remains unpublished to the host and no response body is retained.
	if backend_output=$(docker exec "$backend_id" node -e '
const http=require("node:http");let done=false,connected=false;const start=process.hrtime.bigint();let connect=0,timer;
const emit=(phase,status,errorCode)=>{if(done)return;done=true;clearTimeout(timer);const total=Number(process.hrtime.bigint()-start)/1e9;process.stdout.write(JSON.stringify({phase,status,errorCode,timeConnect:connect,timeAppconnect:0,timeTotal:total}));};
const req=http.get({hostname:"127.0.0.1",port:20128,path:"/healthz",timeout:2500},res=>{res.resume();emit("http",res.statusCode,null);});
req.on("socket",s=>s.on("connect",()=>{connected=true;connect=Number(process.hrtime.bigint()-start)/1e9;}));
timer=setTimeout(()=>{req.destroy();emit("timeout",null,"ETIMEDOUT");},2500);
req.on("timeout",()=>{req.destroy();emit("timeout",null,"ETIMEDOUT");});
req.on("error",e=>emit(connected?"http":"connect",null,/^[A-Z0-9_]{1,48}$/.test(e.code||"")?e.code:"OTHER"));
' 2>/dev/null); then
		backend_exit=0
	else
		backend_exit=$?
	fi
	# Probe Caddy directly from the backend's shared namespace. Node's HTTPS
	# verifier is explicitly enabled and uses only the candidate CA and logical
	# IP identity. It intentionally sends no bearer token to the backend container.
	local edge_tls_probe_code='const https=require("node:https");let raw="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>raw+=c);process.stdin.on("end",()=>{let input;try{input=JSON.parse(raw);if(typeof input.ca!=="string")throw Error();}catch{process.stdout.write(JSON.stringify({phase:"input",status:null,errorCode:"INVALID_INPUT",timeConnect:0,timeAppconnect:0,timeTotal:0}));return;}let done=false,connected=false,secured=false,connect=0,appconnect=0,timer;const start=process.hrtime.bigint();const emit=(phase,status,errorCode)=>{if(done)return;done=true;clearTimeout(timer);const total=Number(process.hrtime.bigint()-start)/1e9;process.stdout.write(JSON.stringify({phase,status,errorCode,timeConnect:connect,timeAppconnect:appconnect,timeTotal:total}));};const req=https.get({hostname:"127.0.0.1",port:8443,path:"/healthz",method:"GET",ca:input.ca,rejectUnauthorized:true,timeout:2500},res=>{res.resume();emit("http",res.statusCode,null);});req.on("socket",s=>{s.on("connect",()=>{connected=true;connect=Number(process.hrtime.bigint()-start)/1e9;});s.on("secureConnect",()=>{secured=true;appconnect=Number(process.hrtime.bigint()-start)/1e9;});});timer=setTimeout(()=>{req.destroy();emit("timeout",null,"ETIMEDOUT");},2500);req.on("timeout",()=>{req.destroy();emit("timeout",null,"ETIMEDOUT");});req.on("error",e=>emit(!connected?"connect":!secured?"tls":"http",null,/^[A-Z0-9_]{1,48}$/.test(e.code||"")?e.code:"OTHER"));});'
	if edge_output=$(
		python3 - "$ROOT/ca.crt" 2>/dev/null <<'PY' |
import json,sys
ca=open(sys.argv[1],"r",encoding="ascii").read()
if len(ca)>65536 or "-----BEGIN CERTIFICATE-----" not in ca or "-----END CERTIFICATE-----" not in ca: raise SystemExit(1)
print(json.dumps({"ca":ca},separators=(",",":")))
PY
		docker exec -i "$backend_id" node -e "$edge_tls_probe_code" 2>/dev/null
	); then
		edge_exit=0
	else
		edge_exit=$?
	fi
	# Send the authenticated direct-edge diagnostic to curl over stdin config.
	# connect-to changes only the TCP target; the URL hostname remains 127.0.0.1
	# so CA and IP-SAN verification are unchanged. The token is never argv/log.
	if [[ -n "$edge_ip" ]]; then
		if auth_edge_output=$(
			python3 "$TLS_HEALTH_REPORT_SCRIPT" curl-config --ca-file "$ROOT/ca.crt" --env-file "$ROOT/caddy.env" --edge-address "$edge_ip" 2>/dev/null |
			curl --disable --config - 2>/dev/null
		); then
			auth_edge_exit=0
		else
			auth_edge_exit=$?
		fi
	fi
	if (( egress_candidate == 1 )); then
		if counter_after=$(python3 "$POLICY_SCRIPT" counters --network-id "$network_id" --daemon-id "$daemon_id" --expected-endpoint-id "$edge_id" 2>/dev/null); then
			counter_after_exit=0
		else
			counter_after_exit=$?
		fi
	fi
	if report=$(python3 "$TLS_HEALTH_REPORT_SCRIPT" failure \
		--port-snapshot "$port_snapshot" --curl-exit "$tls_last_exit" --curl-output "$tls_last_writeout" \
		--backend-exit "$backend_exit" --backend-output "$backend_output" \
		--edge-exit "$edge_exit" --edge-output "$edge_output" \
		--auth-edge-curl-exit "$auth_edge_exit" --auth-edge-curl-output "$auth_edge_output" \
		--counter-before "${probe_counters_after:-}" --counter-after "$counter_after" \
		--counter-after-exit "$counter_after_exit" 2>/dev/null); then
		printf '%s\n' "$report" >&2
	else
		printf 'OMNIROUTE_TLS_DIAGNOSTIC=FAIL phase=SAFE_REPORT_GENERATION_FAILED\n' >&2
	fi
}

# Compare Docker's configured and active port views while the exact edge ID is
# still running. A post-cleanup inspect is never used to infer this state.
tls_runtime_port_snapshot=$(docker inspect --format '{{json .HostConfig.PortBindings}}|{{json .NetworkSettings.Ports}}' "$edge_id") || fail 'edge_runtime_port_snapshot_unavailable'
if tls_port_receipt=$(python3 "$TLS_HEALTH_REPORT_SCRIPT" ports --snapshot "$tls_runtime_port_snapshot"); then
	printf '%s\n' "$tls_port_receipt"
else
	printf '%s\n' "$tls_port_receipt" >&2
	fail 'edge_runtime_port_publication_mismatch'
fi
if ! wait_status 200; then
	diagnose_tls_health_failure
	fail 'authenticated_tls_health_timeout'
fi
unauth_status=$(curl --noproxy '*' --silent --output /dev/null --write-out '%{http_code}' --connect-timeout 1 --max-time 3 --cacert "$ROOT/ca.crt" "https://127.0.0.1:${HOST_PORT}/v1/models" 2>/dev/null || true)
[[ "$unauth_status" == 401 ]] || fail 'unauthenticated_request_not_rejected'
wrong_status=$(curl --noproxy '*' --silent --output /dev/null --write-out '%{http_code}' --connect-timeout 1 --max-time 3 --cacert "$ROOT/ca.crt" -H 'Authorization: Bearer invalid-candidate-token' "https://127.0.0.1:${HOST_PORT}/v1/models" 2>/dev/null || true)
[[ "$wrong_status" == 401 ]] || fail 'invalid_bearer_not_rejected'

models_file=$(mktemp)
if models_writeout=$(curl --noproxy '*' --silent --show-error --max-filesize 4194304 --output "$models_file" \
	--write-out '%{http_code}|%{time_connect}|%{time_appconnect}|%{time_starttransfer}|%{time_total}' \
	--connect-timeout 1 --max-time 10 --cacert "$ROOT/ca.crt" -H "Authorization: Bearer $proxy_token" \
	"https://127.0.0.1:${HOST_PORT}/v1/models" 2>/dev/null); then
	models_curl_exit=0
else
	models_curl_exit=$?
fi
models_status=${models_writeout%%|*}
if models_report=$(python3 "$TLS_HEALTH_REPORT_SCRIPT" models \
	--curl-exit "$models_curl_exit" --curl-output "$models_writeout" --body-file "$models_file" 2>/dev/null); then
	models_report_exit=0
else
	models_report_exit=$?
fi
if [[ -n "$models_report" ]]; then
	printf '%s\n' "$models_report"
else
	printf 'OMNIROUTE_MODELS=UNKNOWN phase=VALIDATOR_UNAVAILABLE curl_exit=%s http_status=%s json=UNKNOWN schema=UNKNOWN models=UNKNOWN count=UNKNOWN\n' \
		"$models_curl_exit" "${models_status:-000}" >&2
fi
[[ "$models_report_exit" -eq 0 ]] || fail 'authenticated_models_endpoint_failed'
rm -f -- "$models_file"
models_file=''

# Confirm server-side and Docker topology, without printing environment values.
edge_facts=$(docker inspect --format '{{.Id}}|{{.Image}}|{{.State.Status}}|{{.HostConfig.NetworkMode}}|{{json .HostConfig.PortBindings}}|{{.HostConfig.RestartPolicy.Name}}' "$edge_id") || fail 'edge_postcreate_inspect_failed'
backend_facts=$(docker inspect --format '{{.Id}}|{{.Image}}|{{.State.Status}}|{{.HostConfig.NetworkMode}}|{{json .HostConfig.PortBindings}}|{{.HostConfig.RestartPolicy.Name}}' "$backend_id") || fail 'backend_postcreate_inspect_failed'
edge_networks=$(docker inspect --format '{{json .NetworkSettings.Networks}}' "$edge_id") || fail 'edge_network_membership_unavailable'
python3 - "$edge_facts" "$backend_facts" "$edge_id" "$backend_id" "$caddy_id" "$omni_id" "$NETWORK" "$edge_networks" <<'PY' || fail 'container_identity_or_port_topology_mismatch'
import json,sys
edge,backend,edge_id,backend_id,caddy_id,omni_id,network,edge_networks=sys.argv[1:]
e=edge.split('|',5); b=backend.split('|',5)
if len(e)!=6 or len(b)!=6: raise SystemExit(1)
if e[:4] != [edge_id,caddy_id,'running',network] or e[5] != 'no': raise SystemExit(1)
ports=json.loads(e[4])
if ports != {'8443/tcp':[{'HostIp':'127.0.0.1','HostPort':'20129'}]}: raise SystemExit(1)
if b[:4] != [backend_id,omni_id,'running',f'container:{edge_id}'] or b[5] != 'no': raise SystemExit(1)
if json.loads(b[4]) not in (None,{}): raise SystemExit(1)
if list(json.loads(edge_networks)) != [network]: raise SystemExit(1)
PY

if (( egress_candidate == 1 )); then
	# Reuse the same canonical attestators that accepted the exact-ID pre/post
	# start snapshots. A second hand-written inspect predicate drifted from the
	# edge capability canonicalization and collapsed distinct failures into a
	# generic security mismatch. Fresh single-object snapshots bind this final
	# gate to the immutable IDs and keep the checks fail-closed.
	docker inspect --format '{{json .}}' "$edge_id" | python3 "$EDGE_ATTEST_SCRIPT" \
		--expected-id "$edge_id" --expected-image-id "$caddy_id" --expected-image-ref "$CADDY_IMAGE" \
		--network-id "$network_id" --network-name "$NETWORK" --container-name "$EDGE_NAME" --root "$ROOT" \
		--label-key phi.omniroute.candidate.egress --label-value v1 --host-port "$HOST_PORT" --phase post-start \
		|| fail 'egress_candidate_final_edge_attestation_failed'
	docker inspect --format '{{json .}}' "$backend_id" | python3 "$BACKEND_ATTEST_SCRIPT" \
		--expected-id "$backend_id" --expected-image-id "$omni_id" --expected-image-ref "$OMNI_IMAGE" \
		--edge-id "$edge_id" --container-name "$backend_container_name" \
		--label-key phi.omniroute.candidate.egress --label-value "$backend_label_value" --phase post-start \
		--expected-auth-mode enforced --expected-api-key-sha256 "$backend_api_key_sha256" \
		|| fail 'egress_candidate_final_backend_attestation_failed'
	log 'SECURITY_ATTESTATION=PASS'
fi

if curl --noproxy '*' --silent --output /dev/null --connect-timeout 1 --max-time 2 "http://${edge_ip}:${BACKEND_PORT}/healthz" >/dev/null 2>&1; then
	fail 'backend_reachable_directly_from_host'
fi

# Attest the socket inside the shared namespace: exact loopback bind, not
# wildcard; report only the owning process identity tuple, never command args.
socket_json=$(docker exec "$backend_id" node -e '
const fs=require("node:fs");
const hex="4EA0"; const listeners=[];
for(const file of ["/proc/net/tcp","/proc/net/tcp6"]) {
 let rows; try { rows=fs.readFileSync(file,"utf8").trim().split("\n").slice(1); } catch { continue; }
 for(const row of rows) { const c=row.trim().split(/\s+/); if(c[3]==="0A" && c[1].endsWith(":"+hex)) listeners.push({file,local:c[1],inode:c[9]}); }
}
if(listeners.length!==1 || listeners[0].file!=="/proc/net/tcp" || !listeners[0].local.startsWith("0100007F:")) process.exit(2);
let owner=null;
for(const entry of fs.readdirSync("/proc")) { if(!/^\d+$/.test(entry)) continue; let fds; try { fds=fs.readdirSync(`/proc/${entry}/fd`); } catch { continue; } for(const fd of fds) { try { if(fs.readlinkSync(`/proc/${entry}/fd/${fd}`)===`socket:[${listeners[0].inode}]`) { const st=fs.statSync(`/proc/${entry}`); const exe=fs.readlinkSync(`/proc/${entry}/exe`).split("/").pop(); owner={pid:Number(entry),uid:st.uid,exe}; break; } } catch {} } if(owner) break; }
if(!owner) process.exit(3); process.stdout.write(JSON.stringify({listeners,owner}));
') || fail 'backend_loopback_listener_attestation_failed'
printf '%s' "$socket_json" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["owner"]["pid"] > 0 and d["owner"]["exe"] and d["listeners"][0]["local"].startswith("0100007F:")' || fail 'backend_socket_owner_invalid'

if (( egress_candidate == 1 )); then
	# A default route is expected on this non-internal bridge; the installed
	# candidate-only filter, not route absence, is the egress security boundary.
	route_json=$(docker exec "$backend_id" node -e '
const fs=require("node:fs");let ipv4Default=false,ipv6Default=false;
try { for(const row of fs.readFileSync("/proc/net/route","utf8").trim().split("\n").slice(1)) { const c=row.trim().split(/\s+/); if(c[1]==="00000000"&&c[7]==="00000000"&&(parseInt(c[3],16)&1)!==0) ipv4Default=true; } } catch {}
try { for(const row of fs.readFileSync("/proc/net/ipv6_route","utf8").split("\n")) { if(!row.trim())continue; const c=row.trim().split(/\s+/); if(c.length!==10||!/^[0-9a-fA-F]{32}$/.test(c[0])||!/^[0-9a-fA-F]{2}$/.test(c[1])||!/^[0-9a-fA-F]{8}$/.test(c[8]))process.exit(2); if(c[0]==="00000000000000000000000000000000"&&c[1]==="00"&&(parseInt(c[8],16)&0x200)===0)ipv6Default=true; } } catch {process.exit(2)}
process.stdout.write(JSON.stringify({ipv4Default,ipv6Default}));if(!ipv4Default||ipv6Default)process.exitCode=2;
') || fail 'egress_candidate_route_state_invalid'
	[[ "$route_json" == '{"ipv4Default":true,"ipv6Default":false}' ]] || fail 'egress_candidate_route_state_invalid'
	egress_json=$(<"$egress_probe_report")
else
	# Internal-network baseline retained for the prior non-egress candidate mode.
	route_json=$(docker exec "$backend_id" node -e '
const fs=require("node:fs");let ipv4Default=false,ipv6Default=false;
try { for(const row of fs.readFileSync("/proc/net/route","utf8").trim().split("\n").slice(1)) { const c=row.trim().split(/\s+/); if(c[1]==="00000000"&&c[7]==="00000000"&&(parseInt(c[3],16)&1)!==0) ipv4Default=true; } } catch {}
try { for(const row of fs.readFileSync("/proc/net/ipv6_route","utf8").split("\n")) { if(!row.trim())continue; const c=row.trim().split(/\s+/); if(c.length!==10||!/^[0-9a-fA-F]{32}$/.test(c[0])||!/^[0-9a-fA-F]{2}$/.test(c[1])||!/^[0-9a-fA-F]{8}$/.test(c[8]))process.exit(2); if(c[0]==="00000000000000000000000000000000"&&c[1]==="00"&&(parseInt(c[8],16)&0x200)===0)ipv6Default=true; } } catch {process.exit(2)}
process.stdout.write(JSON.stringify({ipv4Default,ipv6Default}));if(ipv4Default||ipv6Default)process.exitCode=2;
') || fail 'backend_default_route_present_or_unreadable'
	[[ "$route_json" == '{"ipv4Default":false,"ipv6Default":false}' ]] || fail 'unexpected_default_route'
	egress_json=$(docker exec "$backend_id" node -e '
const net=require("node:net");
function probe(host,family){return new Promise(resolve=>{const s=net.connect({host,port:443,family}); let done=false; const finish=value=>{if(done)return;done=true;s.destroy();resolve(value)}; s.setTimeout(1200,()=>finish("blocked")); s.once("connect",()=>finish("reachable")); s.once("error",()=>finish("blocked"));});}
Promise.all([probe("1.1.1.1",4),probe("2606:4700:4700::1111",6)]).then(([ipv4,ipv6])=>{process.stdout.write(JSON.stringify({ipv4,ipv6}));if(ipv4!=="blocked"||ipv6!=="blocked")process.exitCode=2;});
') || fail 'public_egress_probe_failed_or_reachable'
	[[ "$egress_json" == '{"ipv4":"blocked","ipv6":"blocked"}' ]] || fail 'public_egress_not_blocked'
fi

log 'CREATED_RUNNING_HEALTHY'
printf 'daemonId=%s\nedgeContainerId=%s\nbackendContainerId=%s\nimageId=%s\nedgeImageId=%s\nnetwork=%s\nendpoint=https://127.0.0.1:%s\nbackendBinding=verified_namespace_loopback_only\nunauthenticatedHttp=401\ninvalidBearerHttp=401\nauthenticatedHealthHttp=200\nmodelsEndpointHttp=%s\nprivateKey=0600_root_only\nPhiBearerToken=operator_supplied_not_printed\nexternalProviderInference=NOT_PERFORMED\n' \
	"$daemon_id" "$edge_id" "$backend_id" "$omni_id" "$caddy_id" "$NETWORK" "$HOST_PORT" "$models_status"
printf 'socketAttestation=%s\n' "$socket_json"
printf 'publicEgressProbe=%s\n' "$egress_json"
if (( egress_candidate == 1 )); then
	printf 'egressFirewallBackend=%s\negressPolicy=TCP443_PUBLIC_IPV4_ONLY_DNS_DOCKER_RESOLVER\negressPolicyRuntime=PROBED\n' "$policy_backend"
	printf 'egressPolicyNetworkId=%s\negressPolicyBridge=%s\negressPolicySubnet=%s\negressPolicyInterface=%s\n' "$network_id" "$policy_bridge" "$policy_subnet" "$policy_egress"
else
	printf 'LIMITATION=docker_internal_network_blocks_external_routes_but_host_gateway_access_is_not_proven_blocked\n'
fi
completed=1
