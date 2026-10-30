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

test("OmniRoute egress policy planners reject unsafe metadata and generate focused deny-by-default rules", () => {
	const result = spawnSync("python3", [path.join(root, "tests", "test_omniroute_egress_policy.py")], { encoding: "utf8", timeout: 10000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
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
	assert.ok(helperDigest);
	assert.ok(probeDigest);
	assert.ok(probeReportDigest);
	assert.ok(edgeAttestDigest);
	assert.ok(backendAttestDigest);
	assert.equal(createHash("sha256").update(readFileSync(policyScript)).digest("hex"), helperDigest);
	assert.equal(createHash("sha256").update(readFileSync(probeScript)).digest("hex"), probeDigest);
	assert.equal(createHash("sha256").update(readFileSync(probeReportScript)).digest("hex"), probeReportDigest);
	assert.equal(createHash("sha256").update(readFileSync(edgeAttestScript)).digest("hex"), edgeAttestDigest);
	assert.equal(createHash("sha256").update(readFileSync(backendAttestScript)).digest("hex"), backendAttestDigest);
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
	const resumeBranchStart = source.lastIndexOf('if [[ -n "$resume_backend_container_id" ]]; then');
	const resumeBranchEnd = source.indexOf("else\n\tbackend_id=$(docker create", resumeBranchStart);
	assert.ok(resumeBranchStart >= 0 && resumeBranchEnd > resumeBranchStart);
	assert.ok(!source.slice(resumeBranchStart, resumeBranchEnd).includes("docker create"));
	const backendPath = source.slice(resumeBranchStart, source.indexOf("if (( egress_candidate == 1 )); then\n\tdocker inspect --format '{{json .}}' \"$backend_id\"", resumeBranchStart));
	assert.equal((backendPath.match(/docker create --name "\$BACKEND_NAME"/gu) || []).length, 1, "fresh path has one create site and resume path has none");
	assert.equal((source.match(/docker start "\$backend_id"/gu) || []).length, 1, "backend is started once by exact ID");
	assert.ok(!/docker (?:rm|container\s+rm)\b/u.test(source));
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
	assert.ok(preflight.includes('POLICY_SCRIPT" verify --network-id "$network_id"'));
	assert.ok(source.indexOf("# Pre-attest an existing candidate network") < source.indexOf("validate_caddyfile\n"));
	const resumeBranchStart = source.indexOf('if [[ -n "$resume_egress_network_id" ]]; then', source.indexOf("validate_caddyfile\n"));
	const resumeBranchEnd = source.indexOf("else\n\t\t# A new bridge", resumeBranchStart);
	assert.ok(resumeBranchStart >= 0 && resumeBranchEnd > resumeBranchStart);
	const resumeBranch = source.slice(resumeBranchStart, resumeBranchEnd);
	assert.ok(resumeBranch.includes('POLICY_SCRIPT" verify'));
	assert.ok(!resumeBranch.includes("docker network create"));
	assert.ok(!resumeBranch.includes('POLICY_SCRIPT" apply'));
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
	for (const check of ["allowed_tcp443", "blocked_udp443", "blocked_special", "blocked_host_input", "blocked_host_original", "wait_status 200", "unauth_status", "wrong_status", "PARTIAL_STATE_PRESERVED"]) {
		assert.ok(source.includes(check), "missing candidate gate " + check);
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
