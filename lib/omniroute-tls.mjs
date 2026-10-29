import { constants, fstatSync, lstatSync, openSync, readFileSync, closeSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const OMNIROUTE_TLS_ORIGIN = "https://127.0.0.1:20129";
export const OMNIROUTE_TLS_CA_FILE = process.platform === "win32"
	? path.win32.join(process.env.ProgramData || "C:\\ProgramData", "Phi", "OmniRouteCandidate", "ca.crt")
	: "/etc/phi-omniroute-candidate/ca.crt";

const MAX_CA_BYTES = 64 * 1024;
const DENIED_WINDOWS_WRITE = 0x10000000 | 0x40000000 | 0x00000002 | 0x00000004 | 0x00000010 | 0x00000040 | 0x00000100 | 0x00010000 | 0x00040000 | 0x00080000;

function assertSafeLinuxPath(filePath) {
	const expected = path.resolve("/etc/phi-omniroute-candidate/ca.crt");
	if (path.resolve(filePath) !== expected) throw new Error("OMNIROUTE_TLS_TRUST_PATH_UNTRUSTED");
	const segments = ["/", "/etc", "/etc/phi-omniroute-candidate"];
	for (const directory of segments) {
		const stat = lstatSync(directory, { bigint: true });
		if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0n || (stat.mode & 0o022n) !== 0n) {
			throw new Error("OMNIROUTE_TLS_TRUST_ANCESTOR_UNTRUSTED");
		}
	}
}

const WINDOWS_ACL_PROBE = String.raw`
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $env:ProgramData 'Phi\OmniRouteCandidate'))
$paths = @($env:ProgramData, (Join-Path $env:ProgramData 'Phi'), $root, (Join-Path $root 'ca.crt'))
$items = @()
foreach ($p in $paths) {
  $i = Get-Item -Force -LiteralPath $p
  $a = Get-Acl -LiteralPath $p
  $ownerSid = (New-Object Security.Principal.NTAccount($a.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value
  $rules = @($a.Access | ForEach-Object {
    $sid = $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    [pscustomobject]@{ sid=$sid; allow=($_.AccessControlType.ToString() -eq 'Allow'); rights=[long]$_.FileSystemRights; inherited=$_.IsInherited }
  })
  $items += [pscustomobject]@{ path=$i.FullName; reparse=(($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0); directory=$i.PSIsContainer; ownerSid=$ownerSid; rules=$rules }
}
ConvertTo-Json -InputObject @($items) -Compress -Depth 5
`;

function assertSafeWindowsPath(filePath) {
	const expected = path.win32.join(process.env.ProgramData || "C:\\ProgramData", "Phi", "OmniRouteCandidate", "ca.crt");
	if (path.win32.resolve(filePath).toLowerCase() !== path.win32.resolve(expected).toLowerCase()) {
		throw new Error("OMNIROUTE_TLS_TRUST_PATH_UNTRUSTED");
	}
	const probe = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_ACL_PROBE], {
		encoding: "utf8", timeout: 5000, windowsHide: true, maxBuffer: 64 * 1024,
	});
	if (probe.error || probe.status !== 0) throw new Error("OMNIROUTE_TLS_TRUST_ACL_UNKNOWN");
	let rows;
	try { rows = JSON.parse(probe.stdout); } catch { throw new Error("OMNIROUTE_TLS_TRUST_ACL_UNKNOWN"); }
	if (!Array.isArray(rows) || rows.length !== 4) throw new Error("OMNIROUTE_TLS_TRUST_ACL_UNKNOWN");
	for (let index = 0; index < rows.length; index += 1) {
		const row = rows[index];
		if (row.reparse || Boolean(row.directory) !== (index < 3)) throw new Error("OMNIROUTE_TLS_TRUST_PATH_UNTRUSTED");
		if (!new Set(["S-1-5-18", "S-1-5-32-544"]).has(row.ownerSid)) throw new Error("OMNIROUTE_TLS_TRUST_OWNER_UNTRUSTED");
		if (!Array.isArray(row.rules) || row.rules.some((rule) => !rule.allow || (rule.sid !== "S-1-5-18" && rule.sid !== "S-1-5-32-544" && (Number(rule.rights) & DENIED_WINDOWS_WRITE) !== 0))) {
			throw new Error("OMNIROUTE_TLS_TRUST_ACL_UNTRUSTED");
		}
	}
}

export function loadProtectedOmniRouteCa(filePath = OMNIROUTE_TLS_CA_FILE, platform = process.platform) {
	if (platform === "linux") assertSafeLinuxPath(filePath);
	else if (platform === "win32") assertSafeWindowsPath(filePath);
	else throw new Error("OMNIROUTE_TLS_TRUST_PLATFORM_UNSUPPORTED");

	let descriptor;
	try {
		const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
		descriptor = openSync(filePath, flags);
		const before = fstatSync(descriptor, { bigint: true });
		if (!before.isFile() || (platform === "linux" && before.uid !== 0n) || before.size < 1n || before.size > BigInt(MAX_CA_BYTES) || (before.mode & 0o022n) !== 0n) {
			throw new Error("OMNIROUTE_TLS_TRUST_FILE_UNTRUSTED");
		}
		const named = lstatSync(filePath, { bigint: true });
		if (named.isSymbolicLink() || named.dev !== before.dev || named.ino !== before.ino) throw new Error("OMNIROUTE_TLS_TRUST_FILE_REPLACED");
		const ca = readFileSync(descriptor);
		const after = fstatSync(descriptor, { bigint: true });
		const namedAfter = lstatSync(filePath, { bigint: true });
		if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || namedAfter.isSymbolicLink() || namedAfter.dev !== before.dev || namedAfter.ino !== before.ino) {
			throw new Error("OMNIROUTE_TLS_TRUST_FILE_REPLACED");
		}
		return ca;
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function findPiRuntime() {
	const roots = [
		process.env.PI_PACKAGE_ROOT,
		process.env.PHI_PI_ROOT,
		path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", "@earendil-works", "pi-coding-agent"),
		path.resolve(path.dirname(process.execPath), "node_modules", "@earendil-works", "pi-coding-agent"),
	].filter(Boolean);
	for (const root of roots) {
		try {
			const packageJson = path.join(root, "package.json");
			const metadata = JSON.parse(readFileSync(packageJson, "utf8"));
			if (metadata.name === "@earendil-works/pi-coding-agent") return { root, require: createRequire(packageJson) };
		} catch {}
	}
	throw new Error("OMNIROUTE_TLS_UNDICI_RUNTIME_UNAVAILABLE");
}

function piRequire() {
	return findPiRuntime().require;
}

/** Load Pi's own OpenAI-compatible adapter from its installed runtime. */
export function loadPiOpenAiCompletionsStreamSimple() {
	const runtime = findPiRuntime();
	const packageRoots = [
		path.join(runtime.root, "node_modules", "@earendil-works", "pi-ai"),
		path.resolve(runtime.root, "..", "pi-ai"),
	];
	for (const packageRoot of packageRoots) {
		try {
			const packageJson = path.join(packageRoot, "package.json");
			const metadata = JSON.parse(readFileSync(packageJson, "utf8"));
			const exportedAdapter = metadata.exports?.["./api/*"]?.import;
			if (metadata.name !== "@earendil-works/pi-ai" || typeof exportedAdapter !== "string" || !exportedAdapter.includes("*")) continue;
			const relativeAdapter = exportedAdapter.replaceAll("*", "openai-completions");
			const adapterPath = path.resolve(packageRoot, relativeAdapter);
			if (!adapterPath.startsWith(`${path.resolve(packageRoot)}${path.sep}`)) continue;
			const adapter = runtime.require(adapterPath);
			if (typeof adapter.streamSimple === "function") return adapter.streamSimple;
		} catch {}
	}
	throw new Error("OMNIROUTE_PI_OPENAI_ADAPTER_UNAVAILABLE");
}

function disposeOnBodyEnd(response, dispose) {
	if (!response.body) {
		void dispose();
		return response;
	}
	const reader = response.body.getReader();
	let disposed = false;
	const finish = async () => {
		if (disposed) return;
		disposed = true;
		await dispose();
	};
	const body = new ReadableStream({
		async pull(controller) {
			try {
				const result = await reader.read();
				if (result.done) {
					controller.close();
					await finish();
				} else controller.enqueue(result.value);
			} catch (error) {
				controller.error(error);
				await finish();
			}
		},
		async cancel(reason) {
			try { await reader.cancel(reason); } finally { await finish(); }
		},
	});
	return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export function createOmniRouteSecureFetch({
	expectedOrigin = OMNIROUTE_TLS_ORIGIN,
	loadCa = loadProtectedOmniRouteCa,
	Agent,
	fetchImpl,
} = {}) {
	return async (input, init = {}) => {
		const rawUrl = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
		let url;
		try { url = new URL(rawUrl); } catch { throw new Error("OMNIROUTE_TLS_URL_INVALID"); }
		if (url.protocol !== "https:" || url.origin !== expectedOrigin || url.pathname !== "/v1/chat/completions" || url.username || url.password || url.hash) {
			throw new Error("OMNIROUTE_TLS_ENDPOINT_REJECTED");
		}
		const method = String(init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
		if (method !== "POST") throw new Error("OMNIROUTE_TLS_METHOD_REJECTED");
		const ca = loadCa();
		const undici = Agent && fetchImpl ? null : piRequire()("undici");
		const AgentClass = Agent ?? undici.Agent;
		const fetcher = fetchImpl ?? undici.fetch;
		const dispatcher = new AgentClass({ connect: { ca, rejectUnauthorized: true }, pipelining: 0, keepAliveTimeout: 1000, keepAliveMaxTimeout: 1000 });
		let closed = false;
		const close = async () => {
			if (closed) return;
			closed = true;
			await dispatcher.close();
		};
		try {
			const response = await fetcher(input, { ...init, method, dispatcher, redirect: "error" });
			return disposeOnBodyEnd(response, close);
		} catch (error) {
			await close();
			throw error;
		}
	};
}

export function createOmniRouteStream(streamSimple, transportOptions) {
	const fetch = createOmniRouteSecureFetch(transportOptions);
	return (model, context, options) => streamSimple(model, context, { ...options, fetch });
}
