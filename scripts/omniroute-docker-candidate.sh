#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# One-shot operator-run candidate only. This script never touches the existing
# AppImage installation, the stable Phi CLI, SearXNG, or Second Brain.

readonly OMNI_TAG='diegosouzapw/omniroute:3.8.50'
readonly OMNI_DIGEST='sha256:085c57adf499a8aaa9f35ccde95c0df9c11bd9ecd18d6c9edbf3b68b8079ba9d'
readonly OMNI_IMAGE="diegosouzapw/omniroute@${OMNI_DIGEST}"
readonly CADDY_IMAGE='docker.io/library/caddy@sha256:eb4d35b7452d1ab6171fbdbe8d9275b2301dad6dad92115d91e19fb9b24d510f'
readonly ROOT='/etc/phi-omniroute-candidate'
readonly HOST_PORT='20129'
readonly BACKEND_PORT='20128'
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly POLICY_SCRIPT="$SCRIPT_DIR/omniroute-egress-policy.py"
readonly EGRESS_PROBE_SCRIPT="$SCRIPT_DIR/omniroute-egress-probe.cjs"
readonly EDGE_ATTEST_SCRIPT="$SCRIPT_DIR/omniroute-edge-attest.py"
readonly POLICY_SCRIPT_SHA256='58ac39dd9cc0b6f4997e2618c4492b7acf6d61ab0ae75de18161ff9da85bef6f'
readonly EGRESS_PROBE_SHA256='a129135a3731e38fc4fc7f1bb2920319ce14e7cda4042947b48cb4b3a3fba712'
readonly EDGE_ATTEST_SHA256='288f238158dad3ba32507028403cbc27f157c6a70293ae3dcf39d4c4ec0224e8'

edge_id=''
backend_id=''
edge_started=0
backend_started=0
completed=0
caddy_log=''
egress_probe_report=''
models_file=''
inspect_file=''

fail() { printf 'OMNIROUTE_CANDIDATE=FAIL reason=%s\n' "$1" >&2; exit 1; }
log() { printf 'OMNIROUTE_CANDIDATE=%s\n' "$1"; }

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
		*) fail 'unsupported_arguments' ;;
	esac
	shift
done
if (( egress_candidate == 1 )); then
	readonly NETWORK='phi-omniroute-egress-candidate-v1'
	readonly EDGE_NAME='phi-omniroute-egress-edge-v1'
	readonly BACKEND_NAME='phi-omniroute-egress-backend-v1'
	readonly NETWORK_LABEL='phi.omniroute.candidate.egress=v1'
else
	readonly NETWORK='phi-omniroute-candidate-3_8_50'
	readonly EDGE_NAME='phi-omniroute-candidate-edge-3_8_50'
	readonly BACKEND_NAME='phi-omniroute-candidate-backend-3_8_50'
	readonly NETWORK_LABEL='phi.omniroute.candidate=true'
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

on_exit() {
	local status=$?
	if [[ -n "$caddy_log" && -f "$caddy_log" && ! -L "$caddy_log" ]]; then rm -f -- "$caddy_log"; fi
	if [[ -n "$egress_probe_report" && -f "$egress_probe_report" && ! -L "$egress_probe_report" ]]; then rm -f -- "$egress_probe_report"; fi
	if [[ -n "$models_file" && -f "$models_file" && ! -L "$models_file" ]]; then rm -f -- "$models_file"; fi
	if [[ -n "$inspect_file" && -f "$inspect_file" && ! -L "$inspect_file" ]]; then rm -f -- "$inspect_file"; fi
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
if (( egress_candidate == 1 )); then
	[[ "$POLICY_SCRIPT_SHA256" != TO_BE_PINNED ]] || fail 'egress_policy_script_digest_not_pinned'
	printf '%s  %s\n' "$POLICY_SCRIPT_SHA256" "$POLICY_SCRIPT" | sha256sum --check --status || fail 'egress_policy_script_digest_mismatch'
	[[ "$EGRESS_PROBE_SHA256" != TO_BE_PINNED ]] || fail 'egress_probe_script_digest_not_pinned'
	printf '%s  %s\n' "$EGRESS_PROBE_SHA256" "$EGRESS_PROBE_SCRIPT" | sha256sum --check --status || fail 'egress_probe_script_digest_mismatch'
	[[ "$EDGE_ATTEST_SHA256" != TO_BE_PINNED ]] || fail 'edge_attestation_script_digest_not_pinned'
	printf '%s  %s\n' "$EDGE_ATTEST_SHA256" "$EDGE_ATTEST_SCRIPT" | sha256sum --check --status || fail 'edge_attestation_script_digest_mismatch'
fi

# Pin the local Docker context/daemon to the system Docker socket. Do not fall
# back to a user's context, remote daemon, rootless daemon, or implicit pull.
context=$(docker context show 2>/dev/null) || fail 'docker_context_unavailable'
[[ "$context" == default ]] || fail 'docker_context_not_default'
socket=$(docker context inspect default --format '{{(index .Endpoints "docker").Host}}' 2>/dev/null) || fail 'docker_endpoint_unavailable'
[[ "$socket" == unix:///var/run/docker.sock ]] || fail 'docker_endpoint_not_system_socket'
daemon_id=$(docker info --format '{{.ID}}' 2>/dev/null) || fail 'docker_daemon_unavailable'
[[ "$daemon_id" =~ ^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$ ]] || fail 'docker_daemon_identity_invalid'

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
docker container inspect "$BACKEND_NAME" >/dev/null 2>&1 && fail 'backend_name_already_exists'
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

# Pre-attest an existing candidate network and its complete policy before the
# validator container, Caddy config repair, or any other new Docker mutation.
# A mismatch or partial policy is preserved for manual inspection; this resume
# path never reapplies, duplicates, repairs, or removes existing firewall rules.
if (( egress_candidate == 1 )); then
	policy_result=$(python3 "$POLICY_SCRIPT" preflight --daemon-id "$daemon_id") || fail 'egress_policy_host_preflight_failed'
	[[ "$policy_result" == OMNIROUTE_EGRESS_POLICY=READY\ backend=*\ host_ipv4_count=*\ egress=* ]] || fail 'egress_policy_host_preflight_receipt_invalid'
	log "$policy_result"
	if [[ -n "$resume_egress_network_id" ]]; then
		policy_result=$(python3 "$POLICY_SCRIPT" verify --network-id "$network_id" --daemon-id "$daemon_id" --expect-empty) || fail 'existing_candidate_policy_or_network_not_attested_preserved'
		[[ "$policy_result" == OMNIROUTE_EGRESS_POLICY=VERIFIED\ backend=*\ network="${network_id:0:12}" ]] || fail 'existing_candidate_policy_receipt_invalid_preserved'
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
		python3 - "$ROOT" <<'PY' || fail 'existing_protected_config_untrusted_preserved'
import os, re, stat, sys
root = sys.argv[1]
expected_names = {"Caddyfile", "backend.env", "ca.crt", "caddy.env", "tls.key"}
try:
    root_stat = os.lstat(root)
    if not stat.S_ISDIR(root_stat.st_mode) or stat.S_ISLNK(root_stat.st_mode) or (root_stat.st_uid, root_stat.st_gid, stat.S_IMODE(root_stat.st_mode)) != (0, 0, 0o755): raise ValueError
    if set(os.listdir(root)) != expected_names: raise ValueError
    files = {}
    modes = {"Caddyfile": 0o644, "backend.env": 0o600, "ca.crt": 0o644, "caddy.env": 0o600, "tls.key": 0o600}
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
    expected = {"JWT_SECRET", "API_KEY_SECRET", "INITIAL_PASSWORD", "FORCE_OWNERSHIP", "REQUIRE_API_KEY", "HOSTNAME", "PORT", "BASE_URL", "NEXT_PUBLIC_BASE_URL", "AUTH_COOKIE_SECURE"}
    if set(backend) != expected: raise ValueError
    if not re.fullmatch(r"[a-f0-9]{64}", backend["JWT_SECRET"]) or not re.fullmatch(r"[a-f0-9]{64}", backend["API_KEY_SECRET"]): raise ValueError
    if not re.fullmatch(r"[A-Za-z0-9._~!@#%+=-]{24,}", backend["INITIAL_PASSWORD"]): raise ValueError
    for key, value in {"FORCE_OWNERSHIP":"false", "REQUIRE_API_KEY":"false", "HOSTNAME":"127.0.0.1", "PORT":"20128", "BASE_URL":"http://127.0.0.1:20128", "NEXT_PUBLIC_BASE_URL":"https://127.0.0.1:20129", "AUTH_COOKIE_SECURE":"true"}.items():
        if backend[key] != value: raise ValueError
except Exception:
    print("OMNIROUTE_CANDIDATE=EXISTING_CONFIG_CHECK=FAIL_CLOSED", file=sys.stderr)
    raise SystemExit(1)
print("OMNIROUTE_CANDIDATE=EXISTING_CONFIG_CHECK=PASS")
PY
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

		# Token is enforced by Caddy at the only host-facing endpoint. The OmniRoute
		# backend has no published port; API auth inside it is disabled only because
		# the isolated Caddy edge performs the bearer check before proxying.
		printf 'OMNIROUTE_PROXY_TOKEN=%s\n' "$proxy_token" > "$ROOT/caddy.env"
		printf 'JWT_SECRET=%s\nAPI_KEY_SECRET=%s\nINITIAL_PASSWORD=%s\nFORCE_OWNERSHIP=false\nREQUIRE_API_KEY=false\nHOSTNAME=127.0.0.1\nPORT=%s\nBASE_URL=http://127.0.0.1:%s\nNEXT_PUBLIC_BASE_URL=https://127.0.0.1:%s\nAUTH_COOKIE_SECURE=true\n' \
			"$(openssl rand -hex 32)" "$(openssl rand -hex 32)" "$initial_password" "$BACKEND_PORT" "$BACKEND_PORT" "$HOST_PORT" > "$ROOT/backend.env"
		render_caddyfile "$BACKEND_PORT" > "$ROOT/Caddyfile"
		chown root:root "$ROOT" "$ROOT/ca.crt" "$ROOT/tls.key" "$ROOT/caddy.env" "$ROOT/backend.env" "$ROOT/Caddyfile"
		chmod 0600 "$ROOT/caddy.env" "$ROOT/backend.env"
		chmod 0644 "$ROOT/Caddyfile"
	fi

	# Validate the reused/generated credentials and certificate without exposing
	# their contents; all cases remain fail-closed.
	[[ ! -L "$ROOT" && $(stat -c '%u:%g:%a' "$ROOT") == '0:0:755' ]] || fail 'protected_directory_metadata_mismatch'
	for entry in ca.crt tls.key caddy.env backend.env Caddyfile; do
		[[ ! -L "$ROOT/$entry" && -f "$ROOT/$entry" ]] || fail 'protected_config_entry_not_regular'
	done
	[[ $(stat -c '%u:%g:%a' "$ROOT/tls.key") == '0:0:600' ]] || fail 'tls_private_key_permissions_mismatch'
	[[ $(stat -c '%u:%g:%a' "$ROOT/caddy.env") == '0:0:600' && $(stat -c '%u:%g:%a' "$ROOT/backend.env") == '0:0:600' ]] || fail 'secret_file_permissions_mismatch'
	[[ $(stat -c '%u:%g:%a' "$ROOT/ca.crt") == '0:0:644' ]] || fail 'client_ca_permissions_mismatch'
	openssl verify -CAfile "$ROOT/ca.crt" -verify_ip 127.0.0.1 "$ROOT/ca.crt" >/dev/null 2>&1 || fail 'tls_certificate_ip_verification_failed'
	cert_pub=$(openssl x509 -in "$ROOT/ca.crt" -pubkey -noout | sha256sum | awk '{print $1}')
	key_pub=$(openssl pkey -in "$ROOT/tls.key" -pubout 2>/dev/null | sha256sum | awk '{print $1}')
	[[ -n "$cert_pub" && "$cert_pub" == "$key_pub" ]] || fail 'tls_key_certificate_mismatch'
}

prepare_protected_config

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
		policy_result=$(python3 "$POLICY_SCRIPT" verify --network-id "$network_id" --daemon-id "$daemon_id" --expect-empty) || fail 'existing_candidate_policy_changed_preserved'
		[[ "$policy_result" == OMNIROUTE_EGRESS_POLICY=VERIFIED\ backend=*\ network="${network_id:0:12}" ]] || fail 'existing_candidate_policy_receipt_invalid_preserved'
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
	# Existing networks are only verified here; never reapply their rules.
	policy_result=$(python3 "$POLICY_SCRIPT" verify --network-id "$network_id" --daemon-id "$daemon_id" --expect-empty) || fail 'egress_policy_reverification_failed'
	log "$policy_result"
else
	network_facts=$(docker network inspect --format '{{.Id}}|{{.Driver}}|{{.Internal}}|{{.Attachable}}' "$NETWORK") || fail 'candidate_network_inspect_failed'
	[[ "$network_facts" == "$network_id|bridge|true|false" ]] || fail 'candidate_network_isolation_mismatch'
fi

edge_label='phi.omniroute.candidate=true'
backend_label='phi.omniroute.candidate=true'
network_sysctl=()
if (( egress_candidate == 1 )); then
	edge_label='phi.omniroute.candidate.egress=v1'
	backend_label='phi.omniroute.candidate.egress=v1'
	network_sysctl+=(--sysctl net.ipv6.conf.all.disable_ipv6=1 --sysctl net.ipv6.conf.default.disable_ipv6=1)
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

backend_id=$(docker create --name "$BACKEND_NAME" --label "$backend_label" \
	--network "container:${edge_id}" --restart no --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 \
	--env-file "$ROOT/backend.env" "$OMNI_IMAGE") || fail 'backend_create_failed'
[[ "$backend_id" =~ ^[a-f0-9]{64}$ ]] || fail 'backend_create_returned_invalid_id'

# Start the backend by exact ID. Do not retry or remove either container.
backend_started=1
docker start "$backend_id" >/dev/null || fail 'backend_start_failed'

if (( egress_candidate == 1 )); then
	policy_result=$(python3 "$POLICY_SCRIPT" verify --network-id "$network_id" --daemon-id "$daemon_id" --expected-endpoint-id "$edge_id") || fail 'egress_policy_post_start_verification_failed'
	log "$policy_result"
	probe_counters_before=$(python3 "$POLICY_SCRIPT" counters --network-id "$network_id" --daemon-id "$daemon_id" --expected-endpoint-id "$edge_id") || fail 'egress_policy_counter_snapshot_failed'
	host_ips_json=$(ip -j -4 address show | python3 -c 'import ipaddress,json,sys; data=json.load(sys.stdin); vals=sorted({str(ipaddress.IPv4Address(x["local"])) for d in data for x in d.get("addr_info",[]) if x.get("family")=="inet"}); assert 0<len(vals)<=64; print(json.dumps(vals,separators=(",",":")))') || fail 'host_ipv4_snapshot_failed'
	probe_code=$(<"$EGRESS_PROBE_SCRIPT")
	egress_probe_report=$(mktemp /run/phi-omniroute-egress-probe.XXXXXX) || fail 'egress_probe_report_create_failed'
	chmod 0600 "$egress_probe_report" || fail 'egress_probe_report_permissions_failed'
	docker exec "$backend_id" node -e "$probe_code" "$policy_gateway" "$host_ips_json" > "$egress_probe_report" || fail 'egress_runtime_probe_failed'
	python3 - "$probe_counters_before" "$(python3 "$POLICY_SCRIPT" counters --network-id "$network_id" --daemon-id "$daemon_id" --expected-endpoint-id "$edge_id")" "$egress_probe_report" <<'PY' || fail 'egress_runtime_counters_not_proven'
import json,sys
before,after,report=(json.loads(x) for x in sys.argv[1:])
if not all(report.values()): raise SystemExit(1)
def increased(name): return after.get(name,0)>before.get(name,0)
if not increased("allowed_tcp443"): raise SystemExit(1)
if not increased("blocked_tcp_other") and not increased("blocked_all_other_egress"): raise SystemExit(1)
if not increased("blocked_udp443"): raise SystemExit(1)
if not increased("blocked_other") and not increased("blocked_all_other_egress"): raise SystemExit(1)
if not increased("blocked_special"): raise SystemExit(1)
if not increased("blocked_host_input") and not increased("blocked_host_local") and not increased("blocked_host_original"): raise SystemExit(1)
print("OMNIROUTE_EGRESS_RUNTIME_PROBES=PASS")
PY
	log 'EGRESS_POLICY_RUNTIME_PROBES_PASS'
fi

wait_status() {
	local code=$1
	local deadline=$((SECONDS + 75))
	while (( SECONDS < deadline )); do
		local status
		status=$(curl --noproxy '*' --silent --show-error --output /dev/null --write-out '%{http_code}' \
			--connect-timeout 1 --max-time 3 --cacert "$ROOT/ca.crt" \
			-H "Authorization: Bearer $proxy_token" "https://127.0.0.1:${HOST_PORT}/healthz" 2>/dev/null || true)
		[[ "$status" == "$code" ]] && return 0
		sleep 1
	done
	return 1
}

wait_status 200 || fail 'authenticated_tls_health_timeout'
unauth_status=$(curl --noproxy '*' --silent --output /dev/null --write-out '%{http_code}' --connect-timeout 1 --max-time 3 --cacert "$ROOT/ca.crt" "https://127.0.0.1:${HOST_PORT}/v1/models" 2>/dev/null || true)
[[ "$unauth_status" == 401 ]] || fail 'unauthenticated_request_not_rejected'
wrong_status=$(curl --noproxy '*' --silent --output /dev/null --write-out '%{http_code}' --connect-timeout 1 --max-time 3 --cacert "$ROOT/ca.crt" -H 'Authorization: Bearer invalid-candidate-token' "https://127.0.0.1:${HOST_PORT}/v1/models" 2>/dev/null || true)
[[ "$wrong_status" == 401 ]] || fail 'invalid_bearer_not_rejected'

models_file=$(mktemp)
models_status=$(curl --noproxy '*' --silent --show-error --output "$models_file" --write-out '%{http_code}' \
	--connect-timeout 1 --max-time 10 --cacert "$ROOT/ca.crt" -H "Authorization: Bearer $proxy_token" \
	"https://127.0.0.1:${HOST_PORT}/v1/models" 2>/dev/null || true)
[[ "$models_status" == 200 ]] || fail 'authenticated_models_endpoint_failed'
python3 - "$models_file" <<'PY' || fail 'models_response_not_valid_json'
import json,sys
with open(sys.argv[1], 'rb') as stream:
    value=json.load(stream)
if not isinstance(value, dict) or not isinstance(value.get('data'), list):
    raise SystemExit(1)
PY
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
	inspect_file=$(mktemp)
	docker inspect "$edge_id" "$backend_id" > "$inspect_file" || fail 'egress_candidate_security_inspect_failed'
	python3 - "$inspect_file" "$edge_id" "$backend_id" "$NETWORK" "$ROOT" "$edge_label" "$backend_label" <<'PY' || fail 'egress_candidate_security_mismatch'
import json,sys
path,edge_id,backend_id,network,root,edge_label,backend_label=sys.argv[1:]
with open(path,"rb") as stream: rows=json.load(stream)
if len(rows)!=2 or rows[0].get("Id")!=edge_id or rows[1].get("Id")!=backend_id: raise SystemExit(1)
edge,backend=rows
e=edge["HostConfig"]; b=backend["HostConfig"]
if e.get("Privileged") or e.get("CapDrop")!=["ALL"] or e.get("CapAdd")!=["NET_BIND_SERVICE"] or not e.get("ReadonlyRootfs") or e.get("RestartPolicy",{}).get("Name")!="no": raise SystemExit(1)
if not any(x in {"no-new-privileges:true","no-new-privileges"} for x in (e.get("SecurityOpt") or [])): raise SystemExit(1)
if e.get("NetworkMode")!=network or e.get("PortBindings")!={"8443/tcp":[{"HostIp":"127.0.0.1","HostPort":"20129"}]}: raise SystemExit(1)
if (edge.get("Config",{}).get("Labels") or {}).get("phi.omniroute.candidate.egress")!="v1": raise SystemExit(1)
if (backend.get("Config",{}).get("Labels") or {}).get("phi.omniroute.candidate.egress")!="v1": raise SystemExit(1)
sysctls=e.get("Sysctls") or {}
if sysctls.get("net.ipv6.conf.all.disable_ipv6")!="1" or sysctls.get("net.ipv6.conf.default.disable_ipv6")!="1": raise SystemExit(1)
mounts={(x.get("Source"),x.get("Destination"),x.get("RW")) for x in (edge.get("Mounts") or [])}
expected={(root+"/Caddyfile","/etc/caddy/Caddyfile",False),(root+"/ca.crt","/etc/caddy/tls.crt",False),(root+"/tls.key","/etc/caddy/tls.key",False)}
if mounts!=expected: raise SystemExit(1)
if b.get("Privileged") or b.get("CapDrop")!=["ALL"] or b.get("CapAdd") not in (None,[]): raise SystemExit(1)
if not any(x in {"no-new-privileges:true","no-new-privileges"} for x in (b.get("SecurityOpt") or [])): raise SystemExit(1)
if b.get("NetworkMode")!="container:"+edge_id or b.get("RestartPolicy",{}).get("Name")!="no" or b.get("PortBindings") not in (None,{}): raise SystemExit(1)
if (backend.get("Mounts") or []) or (backend.get("Config",{}).get("Labels") or {}).get("phi.omniroute.candidate.egress")!="v1": raise SystemExit(1)
print("OMNIROUTE_CANDIDATE_SECURITY_ATTESTATION=PASS")
PY
	rm -f -- "$inspect_file"
	inspect_file=''
fi

network_facts=$(docker inspect --format '{{json .NetworkSettings.Networks}}' "$edge_id") || fail 'edge_ip_unavailable'
edge_ip=$(python3 - "$network_facts" "$NETWORK" <<'PY'
import json,sys
data=json.loads(sys.argv[1]); row=data.get(sys.argv[2],{})
print(row.get('IPAddress',''))
PY
) || fail 'edge_ip_unavailable'
[[ "$edge_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'edge_ip_invalid'
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
try { for(const row of fs.readFileSync("/proc/net/ipv6_route","utf8").trim().split("\n")) { const c=row.trim().split(/\s+/); if(c[0]==="00000000000000000000000000000000"&&c[1]==="00") ipv6Default=true; } } catch {}
process.stdout.write(JSON.stringify({ipv4Default,ipv6Default}));if(!ipv4Default||ipv6Default)process.exitCode=2;
') || fail 'egress_candidate_route_state_invalid'
	[[ "$route_json" == '{"ipv4Default":true,"ipv6Default":false}' ]] || fail 'egress_candidate_route_state_invalid'
	egress_json=$(<"$egress_probe_report")
else
	# Internal-network baseline retained for the prior non-egress candidate mode.
	route_json=$(docker exec "$backend_id" node -e '
const fs=require("node:fs");let ipv4Default=false,ipv6Default=false;
try { for(const row of fs.readFileSync("/proc/net/route","utf8").trim().split("\n").slice(1)) { const c=row.trim().split(/\s+/); if(c[1]==="00000000"&&c[7]==="00000000"&&(parseInt(c[3],16)&1)!==0) ipv4Default=true; } } catch {}
try { for(const row of fs.readFileSync("/proc/net/ipv6_route","utf8").trim().split("\n")) { const c=row.trim().split(/\s+/); if(c[0]==="00000000000000000000000000000000"&&c[1]==="00") ipv6Default=true; } } catch {}
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
