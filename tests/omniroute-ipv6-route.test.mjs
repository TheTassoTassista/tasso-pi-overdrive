import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const probePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/omniroute-egress-probe.cjs");
const source = readFileSync(probePath, "utf8");
const entry = source.lastIndexOf("main().then(() => clearTimeout(probeTimeout))");
assert.ok(entry > 0);
const context = { require, console, process, setTimeout: () => ({}), module: { exports: {} } };
vm.runInNewContext(source.slice(0, entry) + "module.exports = ipv6DefaultRoutePresent;", context, { filename: probePath });
const hasDefault = context.module.exports;
const candidate = readFileSync(path.resolve(path.dirname(probePath), "omniroute-docker-candidate.sh"), "utf8");
const routeChecks = [...candidate.matchAll(/route_json=\$\(docker exec "\$backend_id" node -e '([\s\S]*?)'\)/g)].map((match) => match[1]);
assert.equal(routeChecks.length, 2);

const zero = "0".repeat(32);
const one = "0".repeat(31) + "1";
function row(destination, prefix, flags = "00000001") {
	return [destination, prefix, zero, "00", zero, "00000000", "00000001", "00000000", flags, "eth0"].join(" ");
}

test("a usable ::/0 is present across whitespace", () => {
	assert.equal(hasDefault(` \t${row(zero, "00")}  \n`), true);
	assert.equal(hasDefault(row(zero, "00", "00000000")), true); // unknown flags fail conservative
});

test("::/128 and nondefault prefixes are not default routes", () => {
	assert.equal(hasDefault([row(zero, "80"), row(one, "80"), row("fe80" + "0".repeat(28), "40")].join("\n")), false);
});

test("kernel reject ::/0 sentinel is not usable egress", () => {
	// Exact lo row observed in this host's read-only /proc/net/ipv6_route.
	const reject = "00000000000000000000000000000000 00 00000000000000000000000000000000 00 00000000000000000000000000000000 ffffffff 00000001 00000000 00200200       lo";
	assert.equal(hasDefault(reject), false);
	assert.equal(hasDefault(reject + "\n" + row(zero, "00")), true);
});

test("malformed rows fail closed even after a usable default", () => {
	for (const bad of ["garbage", row(zero, "zz"), row(zero, "81"), row(zero, "00").replace("00000001", "bad"), row(zero, "00") + " extra"]) {
		assert.throws(() => hasDefault(bad));
		assert.throws(() => hasDefault(row(zero, "00") + "\n" + bad));
	}
});

test("empty route table has no default", () => {
	assert.equal(hasDefault(" \n\t"), false);
});

test("both candidate route gates agree on rejected, usable and malformed IPv6 routes", () => {
	for (const code of routeChecks) {
		for (const [table, expected] of [
			[row(zero, "00", "00200200"), false],
			[row(zero, "80"), false],
			[row(zero, "00"), true],
		]) {
			let output = "";
			vm.runInNewContext(code, {
				require: () => ({ readFileSync: (file) => file === "/proc/net/route" ? "Iface Destination Gateway Flags RefCnt Use Metric Mask\neth0 00000000 00000000 0001 0 0 0 00000000\n" : table }),
				process: { stdout: { write: (value) => { output += value; } }, exitCode: 0, exit: () => { throw new Error("fail closed"); } },
			});
			assert.equal(JSON.parse(output).ipv6Default, expected);
		}
		assert.throws(() => vm.runInNewContext(code, {
			require: () => ({ readFileSync: (file) => file === "/proc/net/route" ? "" : "malformed" }),
			process: { stdout: { write: () => {} }, exit: () => { throw new Error("fail closed"); } },
		}));
	}
});
