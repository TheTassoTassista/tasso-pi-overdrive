import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const policyScript = path.join(root, "scripts", "omniroute-egress-policy.py");
const edgeAttestScript = path.join(root, "scripts", "omniroute-edge-attest.py");
const candidateScript = path.join(root, "scripts", "omniroute-docker-candidate.sh");
const probeScript = path.join(root, "scripts", "omniroute-egress-probe.cjs");
const probeReportScript = path.join(root, "scripts", "omniroute-egress-probe-report.py");
const backendAttestScript = path.join(root, "scripts", "omniroute-backend-attest.py");
const backendAuthConfigScript = path.join(root, "scripts", "omniroute-backend-auth-config.py");

test("OmniRoute egress policy planners reject unsafe metadata and generate focused deny-by-default rules", () => {
	const result = spawnSync("python3", [path.join(root, "tests", "test_omniroute_egress_policy.py")], { encoding: "utf8", timeout: 10000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
	assert.equal(result.error, undefined, result.error?.message);
	assert.equal(result.status, 0, result.stdout + "\n" + result.stderr);
});

test("protected backend API-key configuration is derived and preserved fail-closed", () => {
	const result = spawnSync("python3", [path.join(root, "tests", "test_omniroute_backend_auth_config.py")], { encoding: "utf8", timeout: 10000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
	assert.equal(result.error, undefined, result.error?.message);
	assert.equal(result.status, 0, result.stdout + "\n" + result.stderr);
});

test("candidate installs its network policy before endpoint creation and restricts the allowlist to the attested uplink", () => {
	const source = readFileSync(candidateScript, "utf8");
	const probe = readFileSync(probeScript, "utf8");
	const helperDigest = source.match(/POLICY_SCRIPT_SHA256='([a-f0-9]{64})'/u)?.[1];
	const probeDigest = source.match(/EGRESS_PROBE_SHA256='([a-f0-9]{64})'/u)?.[1];
	const probeReportDigest = source.match(/EGRESS_REPORT_SHA256='([a-f0-9]{64})'/u)?.[1];
	const edgeAttestDigest = source.match(/EDGE_ATTEST_SHA256='([a-f0-9]{64})'/u)?.[1];
	const backendAttestDigest = source.match(/BACKEND_ATTEST_SHA256='([a-f0-9]{64})'/u)?.[1];
	const backendAuthConfigDigest = source.match(/BACKEND_AUTH_CONFIG_SHA256='([a-f0-9]{64})'/u)?.[1];
	assert.ok(helperDigest);
	assert.ok(probeDigest);
	assert.ok(probeReportDigest);
	assert.ok(edgeAttestDigest);
	assert.ok(backendAttestDigest);
	assert.ok(backendAuthConfigDigest);
	assert.equal(createHash("sha256").update(readFileSync(policyScript)).digest("hex"), helperDigest);
	assert.equal(createHash("sha256").update(readFileSync(probeScript)).digest("hex"), probeDigest);
	assert.equal(createHash("sha256").update(readFileSync(probeReportScript)).digest("hex"), probeReportDigest);
	assert.equal(createHash("sha256").update(readFileSync(edgeAttestScript)).digest("hex"), edgeAttestDigest);
	assert.equal(createHash("sha256").update(readFileSync(backendAttestScript)).digest("hex"), backendAttestDigest);
	assert.equal(createHash("sha256").update(readFileSync(backendAuthConfigScript)).digest("hex"), backendAuthConfigDigest);
	const networkStart = source.indexOf("network_id=$(docker network create --driver bridge --ipv6=false");
	const networkEnd = source.indexOf("edge_label='phi.omniroute.candidate=true'", networkStart);
	assert.ok(networkStart >= 0 && networkEnd > networkStart);
	const egressNetwork = source.slice(networkStart, networkEnd);
	assert.ok(egressNetwork.includes("docker network create --driver bridge --ipv6=false"));
	assert.ok(source.includes('network_id=$(docker network create --driver bridge --internal'));
	assert.ok(egressNetwork.indexOf("network create --driver bridge --ipv6=false") < egressNetwork.indexOf('POLICY_SCRIPT" apply'));
	assert.ok(egressNetwork.includes('python3 "$POLICY_SCRIPT" apply'));
	assert.ok(egressNetwork.includes('python3 "$POLICY_SCRIPT" verify'));
	assert.ok(egressNetwork.indexOf('POLICY_SCRIPT" apply') < egressNetwork.indexOf('POLICY_SCRIPT" verify'));
	assert.ok(source.indexOf('POLICY_SCRIPT" verify') < source.indexOf('edge_id=$(docker create'));
	assert.ok(source.includes('--publish "127.0.0.1:') && source.includes(':8443/tcp"'));
	assert.ok(source.includes("--sysctl net.ipv6.conf.all.disable_ipv6=1 --sysctl net.ipv6.conf.default.disable_ipv6=1"));
	assert.ok(readFileSync(policyScript, "utf8").includes("LiveRestoreEnabled"));
	assert.ok(source.includes("--restart no"));
	assert.ok(probe.includes("127.0.0.11"));
	assert.ok(probe.includes('dns.resolve4("example.com")'));
	assert.ok(probe.includes('phase = "RESOLVER_CONFIG_READ"'));
	assert.ok(probe.includes('phase = "DNS_RESOLUTION"'));
	assert.ok(probe.includes('phase = "SYSCTL_READ"'));
	assert.ok(probe.includes('{ probeStatus: "FAIL", phase }'));
	assert.ok(probe.includes("const probeTimeout = setTimeout("));
	assert.ok(probe.includes("clearTimeout(probeTimeout)"));
	assert.ok(!probe.includes(".unref()"), "the 15-second probe deadline must stay referenced while async work is pending");
	for (const check of ["publicIpv4Tcp443", "publicIpv4Tcp80Blocked", "udp443Blocked", "directTcpDnsBlocked", "directUdpDnsBlocked", "privateIpv4Blocked", "metadataIpv4Blocked", "dockerGatewayBlocked", "hostIpv4Blocked", "ipv6Disabled", "ipv6Unassigned", "ipv6NoDefaultRoute", "ipv6EgressBlocked"]) {
		assert.ok(probe.includes(check), "missing probe " + check);
	}
});

test("failed egress probe prints only a sanitized phase/check receipt before failure cleanup", () => {
	const source = readFileSync(candidateScript, "utf8");
	const report = readFileSync(probeReportScript, "utf8");
	assert.ok(source.includes('docker exec "$backend_id" node -e "$probe_code" "$policy_gateway" "$host_ips_json" > "$egress_probe_report" 2>/dev/null'));
	const diagnosticAt = source.indexOf("probe_diagnostic=$(python3 \"$EGRESS_REPORT_SCRIPT\"");
	const failureAt = source.indexOf("printf 'OMNIROUTE_EGRESS_RUNTIME_PROBE=FAIL phase=%s diagnostic=%s\\n'", diagnosticAt);
	const failAt = source.indexOf("fail 'egress_runtime_probe_failed'", failureAt);
	assert.ok(diagnosticAt >= 0 && failureAt > diagnosticAt && failAt > failureAt);
	assert.ok(report.includes('"DOCKER_EXEC"'));
	assert.ok(report.includes('"NODE_LAUNCH"'));
	assert.ok(report.includes('"NODE_EXECUTION"'));
	assert.ok(!source.includes('cat "$egress_probe_report"'));
	assert.ok(!source.includes('docker exec "$backend_id" node -e "$probe_code" "$policy_gateway" "$host_ips_json" > "$egress_probe_report" ||'));
});

test("runtime counter snapshots capture command status separately and report only a fixed failure phase", () => {
	const source = readFileSync(candidateScript, "utf8");
	const report = readFileSync(probeReportScript, "utf8");
	assert.ok(source.includes('probe_counters_before=$(python3 "$POLICY_SCRIPT" counters'));
	assert.ok(source.includes('probe_counters_after=$(python3 "$POLICY_SCRIPT" counters'));
	assert.ok(source.includes('probe_counters_after_exit=$?'));
	assert.ok(source.includes('--after-exit-code "$probe_counters_after_exit"'));
	assert.ok(source.includes('phase=COUNTERS_BEFORE_COMMAND'));
	assert.ok(source.includes('COUNTER_RESULT_INVALID'));
	assert.ok(source.includes("fail 'egress_runtime_counters_not_proven'"));
	assert.ok(!/"\$\(python3 "\$POLICY_SCRIPT" counters/u.test(source), "counter command substitution must not be nested in validator arguments");
	assert.ok(report.includes("COUNTERS_AFTER_COMMAND_FAILED"));
	assert.ok(report.includes("COUNTERS_BEFORE_JSON_INVALID"));
	assert.ok(report.includes("COUNTERS_AFTER_JSON_INVALID"));
	assert.ok(report.includes("COUNTER_DELTAS_INSUFFICIENT"));
});

test("backend resume is exact-ID-only and pre-attests immutable image, hardening and edge namespace before start", () => {
	const source = readFileSync(candidateScript, "utf8");
	const helper = readFileSync(backendAttestScript, "utf8");
	assert.ok(source.includes("--resume-backend-container-id"));
	assert.ok(source.includes("resume_backend_container_id_required") === false);
	assert.ok(source.includes('[[ "$existing_backend_id" == "$resume_backend_container_id" ]]'));
	assert.ok(source.includes('backend_id=$resume_backend_container_id'));
	assert.ok(helper.includes('row.get("Id") == expected_id'));
	assert.ok(helper.includes('row.get("Image") == expected_image_id'));
	assert.ok(helper.includes('host.get("NetworkMode") == f"container:{edge_id}"'));
	assert.ok(helper.includes('host.get("CapDrop") == ["ALL"]'));
	assert.ok(helper.includes('host.get("CapAdd") in (None, [])'));
	const backendStart = source.indexOf('docker start "$backend_id"');
	const backendPreAttest = source.lastIndexOf('"$BACKEND_ATTEST_SCRIPT"', backendStart);
	assert.ok(backendPreAttest >= 0 && backendPreAttest < backendStart);
	assert.ok(source.slice(backendPreAttest, backendStart).includes('--phase pre-start'));
	const authUpgradeCreate = source.indexOf('if (( backend_api_key_upgrade == 1 )); then\n\t# The legacy container');
	const normalResume = source.indexOf('elif [[ -n "$resume_backend_container_id" ]]; then', authUpgradeCreate);
	const backendAttest = source.indexOf("if (( egress_candidate == 1 )); then\n\tdocker inspect --format '{{json .}}' \"$backend_id\"", normalResume);
	assert.ok(authUpgradeCreate >= 0 && normalResume > authUpgradeCreate && backendAttest > normalResume);
	const backendPath = source.slice(authUpgradeCreate, backendAttest);
	assert.equal((backendPath.match(/backend_id=\$\(docker create --name "\$backend_container_name"/gu) || []).length, 2, "exactly one explicit auth-upgrade create site and one fresh-candidate create site");
	const resumePath = source.slice(normalResume, source.indexOf("else\n\tbackend_id=$(docker create", normalResume));
	assert.ok(resumePath.length > 0 && !resumePath.includes("docker create"), "resume path must not create a duplicate backend");
	assert.equal((source.match(/docker start "\$backend_id"/gu) || []).length, 1, "backend is started once by exact ID");
	assert.ok(!/docker (?:rm|container\s+rm)\b/u.test(source));
});

test("authenticated backend resume uses exact existing IDs and preserves the legacy container", () => {
	const source = readFileSync(candidateScript, "utf8");
	assert.ok(source.includes("--resume-auth-backend-container-id"));
	assert.ok(source.includes("resume_auth_backend_requires_exact_network_edge_and_legacy_backend_ids"));
	assert.ok(source.includes('[[ "$existing_auth_backend_id" == "$resume_auth_backend_container_id" ]]'));
	assert.ok(source.includes('backend_id=$resume_auth_backend_container_id'));
	assert.match(source, /if auth != expected_auth: raise ValueError\n\s*# backend\.env intentionally remains the preserved legacy source file;[\s\S]*?auth_mode = "enforced"/u,
		"the validated sidecar changes the effective auth mode consumed by resume");
	assert.match(source, /EXISTING_CONFIG_CHECK=PASS\\ auth_mode=enforced\) backend_auth_mode='enforced'/u,
		"the effective enforced receipt must reach the existing resume branch without the upgrade flag");
	assert.ok(source.includes("--expected-auth-mode legacy"), "the old backend is re-attested as legacy and preserved");
	assert.ok(source.includes('--label-value "$backend_label_value" --phase pre-start'));
	const resumeBranchAt = source.indexOf('elif [[ -n "$resume_auth_backend_container_id" ]]; then', source.indexOf('if (( backend_api_key_upgrade == 1 )); then\n\t# The legacy container'));
	const resumeBranchEnd = source.indexOf('\nelif [[ -n "$resume_backend_container_id" ]]; then', resumeBranchAt);
	const startAt = source.indexOf('docker start "$backend_id"', resumeBranchEnd);
	assert.ok(resumeBranchAt >= 0 && resumeBranchEnd > resumeBranchAt && startAt > resumeBranchEnd);
	assert.doesNotMatch(source.slice(resumeBranchAt, resumeBranchEnd), /docker create/u, "resuming the auth backend must never create a duplicate");
	assert.doesNotMatch(source, /docker (?:rm|container\s+rm)\b/u, "preserved Docker objects are never removed automatically");
	const existingBackendIdentityAt = source.indexOf('existing_backend_id=$(docker container inspect');
	const upgradeGuardAt = source.indexOf('if (( backend_api_key_upgrade == 1 )); then', existingBackendIdentityAt);
	const upgradeNameCheckAt = source.indexOf("auth_upgrade_backend_name_already_exists_preserved", upgradeGuardAt);
	const authCreateAt = source.indexOf('backend_id=$(docker create --name "$backend_container_name"', upgradeGuardAt);
	assert.ok(existingBackendIdentityAt >= 0 && upgradeGuardAt > existingBackendIdentityAt && upgradeNameCheckAt > upgradeGuardAt && authCreateAt > upgradeNameCheckAt,
		"repeating the one-time upgrade refuses an existing auth backend instead of duplicating it");
});

test("authenticated candidate completion keeps all runtime gates after backend resume", () => {
	const source = readFileSync(candidateScript, "utf8");
	const resumed = source.indexOf('elif [[ -n "$resume_auth_backend_container_id" ]]; then', source.indexOf('if (( backend_api_key_upgrade == 1 )); then\n\t# The legacy container'));
	const prestart = source.indexOf("--phase pre-start", resumed);
	const backendStart = source.indexOf('docker start "$backend_id"', prestart);
	const poststart = source.indexOf("--phase post-start", backendStart);
	const egress = source.indexOf("egress_runtime_counters_not_proven", poststart);
	const health = source.indexOf("wait_status 200", poststart);
	const unauthorized = source.indexOf('[[ "$unauth_status" == 401 ]]', health);
	const wrongBearer = source.indexOf('[[ "$wrong_status" == 401 ]]', unauthorized);
	const models = source.indexOf("authenticated_models_endpoint_failed", wrongBearer);
	const finalBackend = source.indexOf("egress_candidate_final_backend_attestation_failed", models);
	const complete = source.indexOf("completed=1", finalBackend);
	assert.ok(resumed >= 0 && prestart > resumed && backendStart > prestart && poststart > backendStart);
	assert.ok(egress > poststart && health > poststart && unauthorized > health && wrongBearer > unauthorized);
	assert.ok(models > wrongBearer && finalBackend > models && complete > finalBackend,
		"a successful resume still requires egress, TLS health, auth rejection, real catalog, final identity/auth attestations and completion");
	assert.ok(source.includes('backend_id=$resume_auth_backend_container_id'));
	const resumeBranchEnd = source.indexOf('\nelif [[ -n "$resume_backend_container_id" ]]; then', resumed);
	assert.ok(resumeBranchEnd > resumed);
	assert.doesNotMatch(source.slice(resumed, resumeBranchEnd), /docker create/u);
});

test("final candidate security gate reuses immutable-ID attestators after authenticated catalog validation", () => {
	const source = readFileSync(candidateScript, "utf8");
	const models = source.indexOf('[[ "$models_report_exit" -eq 0 ]] || fail \'authenticated_models_endpoint_failed\'');
	const finalEdge = source.indexOf('docker inspect --format \'{{json .}}\' "$edge_id" | python3 "$EDGE_ATTEST_SCRIPT"', models);
	const finalBackend = source.indexOf('docker inspect --format \'{{json .}}\' "$backend_id" | python3 "$BACKEND_ATTEST_SCRIPT"', finalEdge);
	const complete = source.indexOf('completed=1', finalBackend);
	assert.ok(models >= 0 && finalEdge > models && finalBackend > finalEdge && complete > finalBackend,
		"catalog and the two final security attestations must precede candidate completion");
	assert.match(source.slice(finalEdge, finalBackend), /--expected-id "\$edge_id"[\s\S]*--phase post-start/u);
	assert.match(source.slice(finalBackend, complete), /--expected-id "\$backend_id"[\s\S]*--expected-auth-mode enforced --expected-api-key-sha256 "\$backend_api_key_sha256"/u);
	assert.doesNotMatch(source, /egress_candidate_security_mismatch/u, "do not keep a divergent generic duplicate validator");
	assert.doesNotMatch(source, /e\.get\("CapAdd"\)!=\["NET_BIND_SERVICE"\]/u, "use the canonical edge attestor's capability spelling handling");
	assert.ok(source.includes("egress_candidate_final_edge_attestation_failed"));
	assert.ok(source.includes("egress_candidate_final_backend_attestation_failed"));
});

test("egress edge startup attests the exact created ID before start and the assigned endpoint immediately after", () => {
	const source = readFileSync(candidateScript, "utf8");
	assert.ok(source.includes("--resume-edge-container-id"));
	assert.ok(source.includes('edge_id=$resume_edge_container_id'));
	const resumeStart = source.indexOf('if [[ -n "$resume_edge_container_id" ]]; then', source.indexOf("edge_label='phi.omniroute.candidate=true'"));
	const createAt = source.indexOf('edge_id=$(docker create --name "$EDGE_NAME"', resumeStart);
	const resumeElse = source.indexOf("else\n\tedge_id=$(docker create", resumeStart);
	assert.ok(resumeStart >= 0 && resumeElse > resumeStart);
	assert.ok(createAt < 0 || createAt >= resumeElse, "resume branch must not create a duplicate edge");
	const startAt = source.indexOf('docker start "$edge_id"');
	const preAttestAt = source.lastIndexOf('"$EDGE_ATTEST_SCRIPT"', startAt);
	const prePolicyAt = source.lastIndexOf('verify --network-id "$network_id" --daemon-id "$daemon_id" --expect-empty', startAt);
	assert.ok(preAttestAt >= 0 && prePolicyAt > preAttestAt);
	assert.ok(source.slice(preAttestAt, startAt).includes('--phase pre-start'));
	assert.ok(!source.slice(preAttestAt, startAt).includes('--expected-endpoint-id'));
	const postAttestAt = source.indexOf('"$EDGE_ATTEST_SCRIPT"', startAt);
	const postPolicyAt = source.indexOf('facts --network-id "$network_id" --daemon-id "$daemon_id" --expected-endpoint-id "$edge_id"', startAt);
	const backendCreateAt = source.indexOf('backend_id=$(docker create', startAt);
	assert.ok(postAttestAt > startAt && postPolicyAt > postAttestAt && backendCreateAt > postPolicyAt);
	assert.ok(source.slice(postAttestAt, postPolicyAt).includes('--phase post-start'));
	const betweenStartAndAttestation = source.slice(startAt, postAttestAt);
	assert.equal((betweenStartAndAttestation.match(/^\s*docker (?:create|exec|start|stop)\b/gmu) || []).length, 1, "no backend or other Docker mutation may precede immediate edge inspection");
	assert.ok(betweenStartAndAttestation.includes('docker start "$edge_id" >/dev/null || fail \'edge_start_failed\''));
	assert.ok(betweenStartAndAttestation.includes('docker inspect --format \'{{json .}}\' "$edge_id"'));
	assert.ok(!/docker (?:rm|container\s+rm)\b/u.test(source));
	assert.ok(source.includes('edge_started=1\ndocker start "$edge_id"'));
});

test("resume mode attests the exact existing candidate network and policy before any new Docker mutation", () => {
	const source = readFileSync(candidateScript, "utf8");
	assert.ok(source.includes("--resume-egress-network-id"));
	assert.ok(source.includes("resume_egress_network_id_required"));
	assert.ok(source.includes("network_id=$(docker network inspect --format '{{.Id}}' \"$NETWORK\" 2>/dev/null)"));
	assert.ok(source.includes('[[ "$network_id" == "$resume_egress_network_id" ]]'));
	assert.ok(source.includes("existing_candidate_policy_or_network_not_attested_preserved"));
	assert.ok(source.includes("existing_candidate_policy_changed_preserved"));
	const preflightStart = source.indexOf("# Pre-attest an existing candidate network");
	const preflightEnd = source.indexOf("# Reuse only the already-present edge image", preflightStart);
	assert.ok(preflightStart >= 0 && preflightEnd > preflightStart);
	const preflight = source.slice(preflightStart, preflightEnd);
	assert.ok(preflight.includes('POLICY_SCRIPT" preflight-input --network-id "$network_id"'));
	assert.ok(preflight.includes("LEGACY_VERIFIED"));
	assert.ok(source.indexOf("# Pre-attest an existing candidate network") < source.indexOf("validate_caddyfile\n"));
	const resumeBranchStart = source.indexOf('if [[ -n "$resume_egress_network_id" ]]; then', source.indexOf("validate_caddyfile\n"));
	const resumeBranchEnd = source.indexOf("else\n\t\t# A new bridge", resumeBranchStart);
	assert.ok(resumeBranchStart >= 0 && resumeBranchEnd > resumeBranchStart);
	const resumeBranch = source.slice(resumeBranchStart, resumeBranchEnd);
	assert.ok(resumeBranch.includes('POLICY_SCRIPT" preflight-input'));
	assert.ok(!resumeBranch.includes("docker network create"));
	assert.ok(!resumeBranch.includes('POLICY_SCRIPT" apply'));
	const resumePolicyStart = source.indexOf('elif (( egress_candidate == 1 )); then\n\t# A resumed network may have the exact legacy INPUT policy.', resumeBranchEnd);
	const resumePolicyEnd = source.indexOf("\nelse\n\tnetwork_facts=", resumePolicyStart);
	assert.ok(resumePolicyStart >= 0 && resumePolicyEnd > resumePolicyStart);
	const resumePolicy = source.slice(resumePolicyStart, resumePolicyEnd);
	assert.ok(resumePolicy.includes('POLICY_SCRIPT" preflight-input --network-id "$network_id" --daemon-id "$daemon_id" --expect-empty'));
	assert.ok(resumePolicy.includes("LEGACY_VERIFIED"), "a fully attested legacy policy must reach the explicit migration gate");
	assert.ok(!resumePolicy.includes('POLICY_SCRIPT" verify --network-id "$network_id" --daemon-id "$daemon_id" --expect-empty'), "do not require the migrated policy before migration runs");
	assert.ok(!resumePolicy.includes('POLICY_SCRIPT" apply'), "resume must never reapply/duplicate firewall policy");
	const preStartAttest = source.indexOf("--phase pre-start", source.indexOf('docker inspect --format \'{{json .}}\' "$edge_id"'));
	const migrateAt = source.indexOf('POLICY_SCRIPT" migrate-input --network-id "$network_id" --daemon-id "$daemon_id" --expect-empty', preStartAttest);
	const verifyAt = source.indexOf('POLICY_SCRIPT" verify --network-id "$network_id" --daemon-id "$daemon_id" --expect-empty', migrateAt);
	const startAt = source.indexOf('docker start "$edge_id"', verifyAt);
	assert.ok(preStartAttest >= 0 && migrateAt > preStartAttest && verifyAt > migrateAt && startAt > verifyAt);
	const policy = readFileSync(policyScript, "utf8");
	assert.ok(policy.includes("input_policy_migration_preflight_unrecognized"));
	assert.ok(policy.includes("input_migration_postverify_failed_state_preserved"));
});

test("firewall/runtime script preserves TLS, bearer, backend isolation, and manual recovery boundaries", () => {
	const policy = readFileSync(policyScript, "utf8");
	const source = readFileSync(candidateScript, "utf8");
	const probe = readFileSync(probeScript, "utf8");
	assert.ok(policy.includes('EXPECTED_DOCKER_SERVER = "29.8.1"'));
	assert.ok(policy.includes(".FirewallBackend.Driver"));
	assert.ok(policy.includes("rollback_refused_candidate_network_still_exists"));
	assert.ok(policy.includes('"delete", "table", "inet"'));
	assert.ok(policy.includes("DOCKER-USER"));
	assert.ok(policy.includes("hook forward priority -10"));
	assert.ok(policy.includes('oifname "{egress_interface}"'));
	assert.ok(policy.includes('" -o", egress_interface, "-p", "tcp"') || policy.includes('"-o", egress_interface, "-p", "tcp"'));
	assert.ok(probe.includes('tcp("1.1.1.1", 443)'));
	assert.ok(probe.includes('tcp("1.1.1.1", 80)'));
	assert.ok(probe.includes('udpNoReply("1.1.1.1", 443)'));
	assert.ok(probe.includes('tcp("10.0.0.1", 443)'));
	assert.ok(probe.includes('tcp("169.254.169.254", 80)'));
	for (const check of ["wait_status 200", "unauth_status", "wrong_status", "PARTIAL_STATE_PRESERVED"]) {
		assert.ok(source.includes(check), "missing candidate gate " + check);
	}
	for (const check of ["allowed_tcp443", "blocked_udp443", "blocked_special", "blocked_host_input", "blocked_host_original"]) {
		assert.ok(policy.includes(check) || readFileSync(path.join(root, "scripts/omniroute-egress-probe-report.py"), "utf8").includes(check), "missing required runtime counter " + check);
	}
	assert.ok(source.includes("--cap-drop ALL --cap-add NET_BIND_SERVICE --security-opt no-new-privileges"));
	const backendCreate = source.slice(source.indexOf("backend_id=$(docker create"), source.indexOf("# Start the backend"));
	assert.ok(backendCreate.includes("--cap-drop ALL --security-opt no-new-privileges"));
	assert.ok(!backendCreate.includes("--cap-add"));
	assert.ok(!backendCreate.includes("--publish"));
	assert.ok(!/docker (?:rm|network rm)\b/u.test(source));
	assert.ok(!/["'](?:systemctl|iptables-save)["']/u.test(policy));
	assert.ok(!/["']nft["']\s*,\s*["']-f["']\s*,\s*["']\/etc/u.test(policy));
});
