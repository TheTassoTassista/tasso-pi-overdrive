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
readonly NETWORK='phi-omniroute-candidate-3_8_50'
readonly EDGE_NAME='phi-omniroute-candidate-edge-3_8_50'
readonly BACKEND_NAME='phi-omniroute-candidate-backend-3_8_50'
readonly HOST_PORT='20129'
readonly BACKEND_PORT='20128'

edge_id=''
backend_id=''
edge_started=0
backend_started=0
completed=0

fail() { printf 'OMNIROUTE_CANDIDATE=FAIL reason=%s\n' "$1" >&2; exit 1; }
log() { printf 'OMNIROUTE_CANDIDATE=%s\n' "$1"; }

on_exit() {
	local status=$?
	if (( status != 0 && completed == 0 )); then
		# Stop only exact IDs created by this invocation. Never remove anything.
		if (( backend_started == 1 )) && [[ -n "$backend_id" ]]; then docker stop --time 5 "$backend_id" >/dev/null 2>&1 || true; fi
		if (( edge_started == 1 )) && [[ -n "$edge_id" ]]; then docker stop --time 5 "$edge_id" >/dev/null 2>&1 || true; fi
		printf 'OMNIROUTE_CANDIDATE=PARTIAL_STATE_PRESERVED edge_id=%s backend_id=%s\n' "${edge_id:-none}" "${backend_id:-none}" >&2
	fi
}
trap on_exit EXIT

[[ ${EUID:-$(id -u)} -eq 0 ]] || fail 'run_from_authorized_host_terminal_with_sudo'
for command in docker openssl curl ss sha256sum install python3; do command -v "$command" >/dev/null 2>&1 || fail "missing_host_command_${command}"; done

# Pin the local Docker context/daemon to the system Docker socket. Do not fall
# back to a user's context, remote daemon, rootless daemon, or implicit pull.
context=$(docker context show 2>/dev/null) || fail 'docker_context_unavailable'
[[ "$context" == default ]] || fail 'docker_context_not_default'
socket=$(docker context inspect default --format '{{(index .Endpoints "docker").Host}}' 2>/dev/null) || fail 'docker_endpoint_unavailable'
[[ "$socket" == unix:///var/run/docker.sock ]] || fail 'docker_endpoint_not_system_socket'
daemon_id=$(docker info --format '{{.ID}}' 2>/dev/null) || fail 'docker_daemon_unavailable'
[[ "$daemon_id" =~ ^[A-Z0-9:]{8,}$ ]] || fail 'docker_daemon_identity_invalid'

# OmniRoute must already be local under the exact operator-supplied digest.
omni_id=$(docker image inspect "$OMNI_TAG" --format '{{.Id}}' 2>/dev/null) || fail 'approved_omniroute_image_not_local'
omni_digests=$(docker image inspect "$OMNI_TAG" --format '{{json .RepoDigests}}' 2>/dev/null) || fail 'omniroute_image_metadata_unavailable'
[[ "$omni_digests" == *"diegosouzapw/omniroute@${OMNI_DIGEST}"* ]] || fail 'omniroute_digest_mismatch_no_pull_attempted'
resolved_omni_id=$(docker image inspect "$OMNI_IMAGE" --format '{{.Id}}' 2>/dev/null) || fail 'approved_omniroute_digest_unavailable_locally'
[[ "$resolved_omni_id" == "$omni_id" ]] || fail 'omniroute_tag_digest_disagreement'

docker container inspect "$EDGE_NAME" >/dev/null 2>&1 && fail 'edge_name_already_exists'
docker container inspect "$BACKEND_NAME" >/dev/null 2>&1 && fail 'backend_name_already_exists'
docker network inspect "$NETWORK" >/dev/null 2>&1 && fail 'network_already_exists'
[[ ! -e "$ROOT" && ! -L "$ROOT" ]] || fail 'protected_host_path_already_exists'
[[ -z "$(ss -Hln 'sport = :20129' 2>/dev/null)" ]] || fail 'loopback_tls_port_already_in_use'

# Pull only the auxiliary TLS edge at a fixed digest; never pull OmniRoute.
if ! docker image inspect "$CADDY_IMAGE" >/dev/null 2>&1; then
	log 'PULLING_PINNED_CADDY_EDGE_IMAGE'
	docker pull "$CADDY_IMAGE" >/dev/null || fail 'pinned_caddy_image_pull_failed'
fi
caddy_id=$(docker image inspect "$CADDY_IMAGE" --format '{{.Id}}' 2>/dev/null) || fail 'pinned_caddy_image_unavailable'
[[ "$caddy_id" =~ ^sha256:[a-f0-9]{64}$ ]] || fail 'caddy_image_identity_invalid'

printf 'Inserisci un bearer token esadecimale casuale di almeno 64 caratteri. Non verrà mostrato né registrato.\n' >&2
IFS= read -r -s -p 'Bearer token candidato: ' proxy_token || fail 'token_input_failed'
printf '\n' >&2
[[ "$proxy_token" =~ ^[a-fA-F0-9]{64,}$ ]] || fail 'bearer_token_must_be_at_least_256_random_bits_hex'

printf 'Inserisci la password iniziale dell’account amministratore OmniRoute (almeno 24 caratteri). Non verrà mostrata né registrata.\n' >&2
IFS= read -r -s -p 'Password iniziale: ' initial_password || fail 'admin_password_input_failed'
printf '\n' >&2
[[ "$initial_password" =~ ^[A-Za-z0-9._~!@#%+=-]{24,}$ ]] || fail 'admin_password_must_be_24_plus_safe_ascii_characters'

# Caddy is the only published container. The backend shares its isolated
# network namespace and binds to that namespace's IPv4 loopback only.
install -d -o root -g root -m 0755 "$ROOT"
[[ $(stat -c '%u:%g:%a' "$ROOT") == '0:0:755' ]] || fail 'protected_directory_metadata_mismatch'

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
printf ':8443 {\n\ttls /etc/caddy/tls.crt /etc/caddy/tls.key\n\t@unauthorized not header Authorization "Bearer {$OMNIROUTE_PROXY_TOKEN}"\n\trespond @unauthorized "unauthorized" 401\n\treverse_proxy 127.0.0.1:%s\n}\n' "$BACKEND_PORT" > "$ROOT/Caddyfile"
chown root:root "$ROOT" "$ROOT/ca.crt" "$ROOT/tls.key" "$ROOT/caddy.env" "$ROOT/backend.env" "$ROOT/Caddyfile"
chmod 0600 "$ROOT/caddy.env" "$ROOT/backend.env"
chmod 0644 "$ROOT/Caddyfile"
[[ $(stat -c '%u:%g:%a' "$ROOT/tls.key") == '0:0:600' ]] || fail 'tls_private_key_permissions_mismatch'
[[ $(stat -c '%u:%g:%a' "$ROOT/caddy.env") == '0:0:600' && $(stat -c '%u:%g:%a' "$ROOT/backend.env") == '0:0:600' ]] || fail 'secret_file_permissions_mismatch'
[[ $(stat -c '%u:%g:%a' "$ROOT/ca.crt") == '0:0:644' ]] || fail 'client_ca_permissions_mismatch'

# Validate Caddy's actual Caddyfile with the pinned image, no network and only
# disposable tmpfs state. This creates and auto-removes one short-lived validator.
docker run --rm --pull=never --network none --read-only --user 0:0 \
	--cap-drop ALL --security-opt no-new-privileges \
	--tmpfs /data:rw,noexec,nosuid,size=16m --tmpfs /config:rw,noexec,nosuid,size=16m --tmpfs /tmp:rw,noexec,nosuid,size=16m \
	--mount "type=bind,src=$ROOT/Caddyfile,dst=/etc/caddy/Caddyfile,readonly" \
	--mount "type=bind,src=$ROOT/ca.crt,dst=/etc/caddy/tls.crt,readonly" \
	--mount "type=bind,src=$ROOT/tls.key,dst=/etc/caddy/tls.key,readonly" \
	--env-file "$ROOT/caddy.env" --entrypoint caddy "$CADDY_IMAGE" validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || fail 'caddy_config_validation_failed'

network_id=$(docker network create --driver bridge --internal --label phi.omniroute.candidate=true "$NETWORK") || fail 'candidate_network_create_failed'
[[ "$network_id" =~ ^[a-f0-9]{64}$ ]] || fail 'candidate_network_create_returned_invalid_id'
network_facts=$(docker network inspect --format '{{.Id}}|{{.Driver}}|{{.Internal}}|{{.Attachable}}' "$NETWORK") || fail 'candidate_network_inspect_failed'
[[ "$network_facts" == "$network_id|bridge|true|false" ]] || fail 'candidate_network_isolation_mismatch'

edge_id=$(docker create --name "$EDGE_NAME" --label phi.omniroute.candidate=true \
	--network "$NETWORK" --publish "127.0.0.1:${HOST_PORT}:8443/tcp" \
	--restart no --read-only --user 0:0 --cap-drop ALL --security-opt no-new-privileges --pids-limit 128 \
	--tmpfs /data:rw,noexec,nosuid,size=16m --tmpfs /config:rw,noexec,nosuid,size=16m --tmpfs /tmp:rw,noexec,nosuid,size=16m \
	--mount "type=bind,src=$ROOT/Caddyfile,dst=/etc/caddy/Caddyfile,readonly" \
	--mount "type=bind,src=$ROOT/ca.crt,dst=/etc/caddy/tls.crt,readonly" \
	--mount "type=bind,src=$ROOT/tls.key,dst=/etc/caddy/tls.key,readonly" \
	--env-file "$ROOT/caddy.env" --entrypoint caddy "$CADDY_IMAGE" run --config /etc/caddy/Caddyfile --adapter caddyfile) || fail 'edge_create_failed'
[[ "$edge_id" =~ ^[a-f0-9]{64}$ ]] || fail 'edge_create_returned_invalid_id'

# The namespace-sharing target must already be running so Docker can attach
# the backend to its live network namespace. The edge stays bounded/fail-soft:
# its upstream returns unavailable until the backend below is started.
edge_started=1
docker start "$edge_id" >/dev/null || fail 'edge_start_failed'

backend_id=$(docker create --name "$BACKEND_NAME" --label phi.omniroute.candidate=true \
	--network "container:${edge_id}" --restart no --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 \
	--env-file "$ROOT/backend.env" "$OMNI_IMAGE") || fail 'backend_create_failed'
[[ "$backend_id" =~ ^[a-f0-9]{64}$ ]] || fail 'backend_create_returned_invalid_id'

# Start the backend by exact ID. Do not retry or remove either container.
backend_started=1
docker start "$backend_id" >/dev/null || fail 'backend_start_failed'

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
trap 'rm -f -- "$models_file"; on_exit' EXIT
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

# Internal networks have no default route. Also probe public IPv4/IPv6 via the
# backend namespace. Docker's internal network does not block host-gateway access;
# this is an explicit residual boundary and is not described as total egress proof.
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

log 'CREATED_RUNNING_HEALTHY'
printf 'daemonId=%s\nedgeContainerId=%s\nbackendContainerId=%s\nimageId=%s\nedgeImageId=%s\nnetwork=%s\nendpoint=https://127.0.0.1:%s\nbackendBinding=verified_namespace_loopback_only\nunauthenticatedHttp=401\ninvalidBearerHttp=401\nauthenticatedHealthHttp=200\nmodelsEndpointHttp=%s\nprivateKey=0600_root_only\nPhiBearerToken=operator_supplied_not_printed\nexternalProviderInference=NOT_PERFORMED\n' \
	"$daemon_id" "$edge_id" "$backend_id" "$omni_id" "$caddy_id" "$NETWORK" "$HOST_PORT" "$models_status"
printf 'socketAttestation=%s\n' "$socket_json"
printf 'publicEgressProbe=%s\n' "$egress_json"
printf 'LIMITATION=docker_internal_network_blocks_external_routes_but_host_gateway_access_is_not_proven_blocked\n'
completed=1
