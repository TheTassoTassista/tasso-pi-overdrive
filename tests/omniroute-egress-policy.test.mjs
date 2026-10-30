import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const policyScript = path.join(root, "scripts", "omniroute-egress-policy.py");
const candidateScript = path.join(root, "scripts", "omniroute-docker-candidate.sh");
const probeScript = path.join(root, "scripts", "omniroute-egress-probe.cjs");

test("OmniRoute egress policy planners reject unsafe metadata and generate focused deny-by-default rules", () => {
	const result = spawnSync("python3", [path.join(root, "tests", "test_omniroute_egress_policy.py")], { encoding: "utf8", timeout: 10000 });
	assert.equal(result.error, undefined, result.error?.message);
	assert.equal(result.status, 0, result.stdout + "\n" + result.stderr);
});

test("candidate installs its network policy before endpoint creation and restricts the allowlist to the attested uplink", () => {
	const source = readFileSync(candidateScript, "utf8");
	const probe = readFileSync(probeScript, "utf8");
	const helperDigest = source.match(/POLICY_SCRIPT_SHA256='([a-f0-9]{64})'/u)?.[1];
	const probeDigest = source.match(/EGRESS_PROBE_SHA256='([a-f0-9]{64})'/u)?.[1];
	assert.ok(helperDigest);
	assert.ok(probeDigest);
	assert.equal(createHash("sha256").update(readFileSync(policyScript)).digest("hex"), helperDigest);
	assert.equal(createHash("sha256").update(readFileSync(probeScript)).digest("hex"), probeDigest);
	const networkStart = source.indexOf("if (( egress_candidate == 1 )); then\n\t# The new bridge");
	const networkEnd = source.indexOf("edge_label='phi.omniroute.candidate=true'", networkStart);
	assert.ok(networkStart >= 0 && networkEnd > networkStart);
	const egressNetwork = source.slice(networkStart, networkEnd);
	assert.ok(egressNetwork.includes("docker network create --driver bridge --ipv6=false"));
	assert.ok(egressNetwork.indexOf("network create --driver bridge --ipv6=false") < egressNetwork.indexOf("network create --driver bridge --internal"));
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
	for (const check of ["publicIpv4Tcp443", "publicIpv4Tcp80Blocked", "udp443Blocked", "directTcpDnsBlocked", "directUdpDnsBlocked", "privateIpv4Blocked", "metadataIpv4Blocked", "dockerGatewayBlocked", "hostIpv4Blocked", "ipv6Disabled", "ipv6Unassigned", "ipv6NoDefaultRoute", "ipv6EgressBlocked"]) {
		assert.ok(probe.includes(check), "missing probe " + check);
	}
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
	assert.ok(!/systemctl|iptables-save|nft -f \/etc/u.test(policy));
});
