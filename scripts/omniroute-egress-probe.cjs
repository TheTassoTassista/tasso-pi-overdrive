"use strict";

// Host-local, non-inference egress probes run inside the candidate namespace.
// Only boolean evidence is emitted; no host address list or response data is
// printed. The host firewall counters are checked separately by the caller.
const fs = require("node:fs");
const dns = require("node:dns/promises");
const net = require("node:net");
const dgram = require("node:dgram");

let phase = "INPUT_VALIDATION";
// Keep the absolute deadline referenced while async DNS/network work is
// pending; clear it on normal settlement so successful probes exit promptly.
const probeTimeout = setTimeout(() => {
	process.stdout.write(`${JSON.stringify({ probeStatus: "FAIL", phase })}\n`, () => process.exit(2));
}, 15000);

function ipv6DefaultRoutePresent(contents) {
	const zero = "0".repeat(32);
	let present = false;
	for (const line of contents.split(/\n/)) {
		if (!line.trim()) continue;
		const fields = line.trim().split(/\s+/);
		// /proc/net/ipv6_route: destination, prefix length, source,
		// source prefix length, next hop, metric, refcnt, use, flags, device.
		if (fields.length !== 10 || !/^[0-9a-fA-F]{32}$/.test(fields[0]) ||
			!/^[0-9a-fA-F]{2}$/.test(fields[1]) || !/^[0-9a-fA-F]{32}$/.test(fields[2]) ||
			!/^[0-9a-fA-F]{2}$/.test(fields[3]) || !/^[0-9a-fA-F]{32}$/.test(fields[4]) ||
			fields.slice(5, 9).some((field) => !/^[0-9a-fA-F]{8}$/.test(field)) ||
			parseInt(fields[1], 16) > 128 || parseInt(fields[3], 16) > 128) {
			throw new Error("malformed_ipv6_route");
		}
		// Linux RTF_REJECT (0x200) includes the kernel's ::/0 lo
		// unreachable sentinel; it cannot provide outbound routing.
		const rejected = (parseInt(fields[8], 16) & 0x200) !== 0;
		if (fields[0] === zero && fields[1].toLowerCase() === "00" && !rejected) present = true;
	}
	return present;
}

function tcp(host, port, timeoutMs = 1400) {
	return new Promise((resolve) => {
		let socket;
		let done = false;
		const finish = (connected) => {
			if (done) return;
			done = true;
			socket?.destroy();
			resolve(connected);
		};
		try {
			socket = net.createConnection({ host, port, timeout: timeoutMs });
			socket.once("connect", () => finish(true));
			socket.once("timeout", () => finish(false));
			socket.once("error", () => finish(false));
		} catch {
			finish(false);
		}
	});
}

function udpNoReply(host, port) {
	return new Promise((resolve) => {
		const socket = dgram.createSocket("udp4");
		const timer = setTimeout(() => {
			socket.close();
			resolve(true);
		}, 700);
		socket.once("error", () => {
			clearTimeout(timer);
			socket.close();
			resolve(false);
		});
		socket.once("message", () => {
			clearTimeout(timer);
			socket.close();
			resolve(false);
		});
		socket.send(Buffer.from("phi-egress-probe"), port, host, (error) => {
			if (error) {
				clearTimeout(timer);
				socket.close();
				resolve(false);
			}
		});
	});
}

async function main() {
	const gateway = process.argv[1];
	let hosts;
	try {
		hosts = JSON.parse(process.argv[2]);
	} catch {
		throw new Error("input");
	}
	if (!net.isIPv4(gateway) || !Array.isArray(hosts) || hosts.length === 0 || hosts.length > 64 || hosts.some((host) => !net.isIPv4(host))) {
		throw new Error("input");
	}

	phase = "RESOLVER_CONFIG_READ";
	const resolvers = fs.readFileSync("/etc/resolv.conf", "utf8")
		.split(/\n/)
		.filter((line) => /^\s*nameserver\s/.test(line))
		.map((line) => line.trim().split(/\s+/)[1]);
	if (resolvers.length !== 1 || resolvers[0] !== "127.0.0.11") throw new Error();

	phase = "DNS_RESOLUTION";
	const dnsAnswers = await dns.resolve4("example.com");
	if (!dnsAnswers.length) throw new Error();

	phase = "PUBLIC_NETWORK_PROBES";
	const [public443, public80, udp443, directTcp53, directUdp53, private443, metadata80, gateway443] = await Promise.all([
		tcp("1.1.1.1", 443),
		tcp("1.1.1.1", 80),
		udpNoReply("1.1.1.1", 443),
		tcp("1.1.1.1", 53),
		udpNoReply("1.1.1.1", 53),
		tcp("10.0.0.1", 443),
		tcp("169.254.169.254", 80),
		tcp(gateway, 443),
	]);
	const hostReachable = (await Promise.all(hosts.map((address) => tcp(address, 443)))).some(Boolean);

	phase = "SYSCTL_READ";
	const ipv6Disabled = fs.readFileSync("/proc/sys/net/ipv6/conf/all/disable_ipv6", "utf8").trim() === "1"
		&& fs.readFileSync("/proc/sys/net/ipv6/conf/default/disable_ipv6", "utf8").trim() === "1";

	phase = "IPV6_PROBES";
	const ipv6AddressesPresent = fs.readFileSync("/proc/net/if_inet6", "utf8").trim().length > 0;
	const defaultRoutePresent = ipv6DefaultRoutePresent(fs.readFileSync("/proc/net/ipv6_route", "utf8"));
	const ipv6Reachable = await tcp("2606:4700:4700::1111", 443);
	const report = {
		dnsViaDockerResolver: true,
		publicIpv4Tcp443: public443,
		publicIpv4Tcp80Blocked: !public80,
		udp443Blocked: udp443,
		directTcpDnsBlocked: !directTcp53,
		directUdpDnsBlocked: directUdp53,
		privateIpv4Blocked: !private443,
		metadataIpv4Blocked: !metadata80,
		dockerGatewayBlocked: !gateway443,
		hostIpv4Blocked: !hostReachable,
		ipv6Disabled,
		ipv6Unassigned: !ipv6AddressesPresent,
		ipv6NoDefaultRoute: !defaultRoutePresent,
		ipv6EgressBlocked: !ipv6Reachable,
	};
	phase = "REPORT_SERIALIZATION";
	const allPassed = Object.values(report).every((value) => value === true);
	console.log(JSON.stringify({ probeStatus: allPassed ? "PASS" : "FAIL", phase: allPassed ? "COMPLETE" : "POLICY_CHECKS", checks: report }));
	if (!allPassed) process.exitCode = 2;
}

main().then(() => clearTimeout(probeTimeout)).catch(() => {
	clearTimeout(probeTimeout);
	console.log(JSON.stringify({ probeStatus: "FAIL", phase }));
	process.exitCode = 2;
});
