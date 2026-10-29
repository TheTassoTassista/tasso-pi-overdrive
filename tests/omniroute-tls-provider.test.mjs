import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createOmniRouteSecureFetch, createOmniRouteStream, OMNIROUTE_TLS_ORIGIN } from "../lib/omniroute-tls.mjs";

const runtimeRoots = [
	process.env.PI_PACKAGE_ROOT,
	process.env.PHI_PI_ROOT,
	path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", "@earendil-works", "pi-coding-agent"),
	path.resolve(path.dirname(process.execPath), "node_modules", "@earendil-works", "pi-coding-agent"),
].filter(Boolean);
const piRoot = runtimeRoots.find((candidate) => {
	try { return JSON.parse(readFileSync(path.join(candidate, "package.json"), "utf8")).name === "@earendil-works/pi-coding-agent"; } catch { return false; }
});
const piAiRoot = piRoot && path.join(piRoot, "node_modules", "@earendil-works", "pi-ai", "dist");
const piAiAvailable = Boolean(piAiRoot);

async function loadPiApi() {
	assert.ok(piAiRoot, "installed Pi runtime with @earendil-works/pi-ai is required");
	const [{ streamSimple }, { normalizeContext }] = await Promise.all([
		import(pathToFileURL(path.join(piAiRoot, "api", "openai-completions.js")).href),
		import(pathToFileURL(path.join(piAiRoot, "utils", "transcript.js")).href),
	]);
	const { Agent } = await import(pathToFileURL(path.join(piRoot, "node_modules", "undici", "index.js")).href);
	return { streamSimple, normalizeContext, Agent };
}

function makeCertificate(t) {
	const dir = mkdtempSync(path.join(os.tmpdir(), "phi-omniroute-tls-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const keyPath = path.join(dir, "test-only-key.pem");
	const certPath = path.join(dir, "test-only-cert.pem");
	execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-addext", "basicConstraints=critical,CA:TRUE", "-keyout", keyPath, "-out", certPath], { stdio: "ignore" });
	return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

async function listen(handler, cert) {
	const server = https.createServer(cert, handler);
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	return { server, origin: `https://127.0.0.1:${address.port}` };
}

function modelAt(origin) {
	return {
		id: "fixture/local", name: "OmniRoute TLS fixture", api: "openai-completions", provider: "omniroute",
		baseUrl: `${origin}/v1`, reasoning: false, input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 4096,
		compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsTools: true },
	};
}

function completionChunk(delta, finishReason = null) {
	return `data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: "fixture/local", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}

async function collect(stream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}

test("Pi OpenAI-compatible adapter reaches only verified HTTPS, forwards bearer auth, and consumes SSE", { skip: !piAiAvailable }, async (t) => {
	const { streamSimple, normalizeContext, Agent } = await loadPiApi();
	const cert = makeCertificate(t);
	let received;
	const fixture = await listen((request, response) => {
		const chunks = [];
		request.on("data", (chunk) => chunks.push(chunk));
		request.on("end", () => {
			received = { url: request.url, auth: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
			response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			response.end(completionChunk({ role: "assistant", content: "verified stream" }) + completionChunk({}, "stop") + "data: [DONE]\n\n");
		});
	}, cert);
	t.after(() => new Promise((resolve) => fixture.server.close(resolve)));
	const secureStream = createOmniRouteStream(streamSimple, { expectedOrigin: fixture.origin, loadCa: () => cert.cert, Agent });
	const context = normalizeContext({ messages: [{ role: "user", content: "private fixture prompt", timestamp: Date.now() }] });
	const events = await collect(secureStream(modelAt(fixture.origin), context, { apiKey: "fixture-only-token" }));
	assert.ok(received, `Pi adapter did not issue request; events=${JSON.stringify(events.map((event) => event.type === "error" ? { type: event.type, reason: event.reason, message: event.error.errorMessage } : { type: event.type }))}`);
	assert.equal(received.url, "/v1/chat/completions");
	assert.equal(received.auth, "Bearer fixture-only-token");
	assert.ok(JSON.stringify(received.body).includes("private fixture prompt"));
	assert.ok(events.some((event) => event.type === "text_delta" && event.delta === "verified stream"));
	assert.equal(events.at(-1)?.type, "done");
});

test("a substituted TLS listener is rejected before it receives an HTTP request or bearer token", { skip: !piAiAvailable }, async (t) => {
	const { streamSimple, normalizeContext, Agent } = await loadPiApi();
	const trusted = makeCertificate(t);
	const attacker = makeCertificate(t);
	let requests = 0;
	const fixture = await listen((_request, response) => { requests += 1; response.end("unexpected"); }, attacker);
	t.after(() => new Promise((resolve) => fixture.server.close(resolve)));
	const secureStream = createOmniRouteStream(streamSimple, { expectedOrigin: fixture.origin, loadCa: () => trusted.cert, Agent });
	const context = normalizeContext({ messages: [{ role: "user", content: "must-not-leak-to-replacement", timestamp: Date.now() }] });
	const events = await collect(secureStream(modelAt(fixture.origin), context, { apiKey: "fixture-only-token" }));
	assert.equal(requests, 0, "TLS verification must fail before HTTP headers/body are sent");
	assert.ok(events.some((event) => event.type === "error"));
});

test("the authenticated HTTPS endpoint rejects missing and incorrect bearer tokens", { skip: !piAiAvailable }, async (t) => {
	const cert = makeCertificate(t);
	const expected = "fixture-caddy-token-0123456789abcdef";
	const fixture = await listen((request, response) => {
		if (request.headers.authorization !== `Bearer ${expected}`) {
			response.writeHead(401, { "content-type": "application/json" });
			response.end('{"error":"unauthorized"}');
			return;
		}
		response.writeHead(200, { "content-type": "application/json" });
		response.end('{"data":[]}');
	}, cert);
	t.after(() => new Promise((resolve) => fixture.server.close(resolve)));
	const secureFetch = createOmniRouteSecureFetch({ expectedOrigin: fixture.origin, loadCa: () => cert.cert, Agent: (await loadPiApi()).Agent });
	const makeRequest = (authorization) => secureFetch(`${fixture.origin}/v1/chat/completions`, {
		method: "POST",
		headers: authorization ? { authorization } : {},
		body: "{}",
	});
	assert.equal((await makeRequest(undefined)).status, 401);
	assert.equal((await makeRequest("Bearer wrong-fixture-token")).status, 401);
	assert.equal((await makeRequest(`Bearer ${expected}`)).status, 200);
});

test("the provider transport rejects non-loopback, non-HTTPS, redirects-by-policy, and wrong API paths before fetch", async () => {
	let calls = 0;
	const fetch = createOmniRouteSecureFetch({ expectedOrigin: OMNIROUTE_TLS_ORIGIN, loadCa: () => Buffer.from("fixture"), Agent: class {}, fetchImpl: async () => { calls += 1; return new Response(); } });
	for (const url of [
		"http://127.0.0.1:20129/v1/chat/completions",
		"https://example.invalid/v1/chat/completions",
		"https://127.0.0.1:20129/api/health",
		"https://user@127.0.0.1:20129/v1/chat/completions",
	]) await assert.rejects(fetch(url, { method: "POST" }), /OMNIROUTE_TLS_ENDPOINT_REJECTED/u);
	await assert.rejects(fetch(`${OMNIROUTE_TLS_ORIGIN}/v1/chat/completions`, { method: "GET" }), /OMNIROUTE_TLS_METHOD_REJECTED/u);
	assert.equal(calls, 0);
});

test("Pi cancellation aborts the HTTPS request and its response stream", { skip: !piAiAvailable }, async (t) => {
	const { streamSimple, normalizeContext, Agent } = await loadPiApi();
	const cert = makeCertificate(t);
	let requestAborted = false;
	let responseClosed = false;
	const fixture = await listen((request, response) => {
		request.on("aborted", () => { requestAborted = true; });
		request.on("end", () => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write(completionChunk({ role: "assistant", content: "first chunk" }));
			response.on("close", () => { responseClosed = true; });
		});
		request.resume();
	}, cert);
	t.after(() => new Promise((resolve) => fixture.server.close(resolve)));
	const secureStream = createOmniRouteStream(streamSimple, { expectedOrigin: fixture.origin, loadCa: () => cert.cert, Agent });
	const controller = new AbortController();
	const stream = secureStream(modelAt(fixture.origin), normalizeContext({ messages: [{ role: "user", content: "cancel fixture", timestamp: Date.now() }] }), { apiKey: "fixture-only-token", signal: controller.signal });
	const iterator = stream[Symbol.asyncIterator]();
	let sawText = false;
	for (let index = 0; index < 12 && !sawText; index += 1) {
		const next = await Promise.race([iterator.next(), new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 3000))]);
		assert.equal(next.timeout, undefined, "stream should reach its first text event");
		sawText = next.value?.type === "text_delta";
	}
	assert.ok(sawText);
	controller.abort();
	const remaining = [];
	for await (const event of { [Symbol.asyncIterator]: () => iterator }) remaining.push(event);
	assert.ok(remaining.some((event) => event.type === "error" && event.reason === "aborted"));
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.ok(responseClosed, "server observes the cancelled streaming connection close");
});

test("streamed Pi tool calls remain handled by Pi's built-in OpenAI-compatible adapter", { skip: !piAiAvailable }, async (t) => {
	const { streamSimple, normalizeContext, Agent } = await loadPiApi();
	const cert = makeCertificate(t);
	let body;
	const fixture = await listen((request, response) => {
		const chunks = [];
		request.on("data", (chunk) => chunks.push(chunk));
		request.on("end", () => {
			body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(completionChunk({ tool_calls: [{ index: 0, id: "call-fixture", type: "function", function: { name: "lookup", arguments: JSON.stringify({ term: "local" }) } }] }) + completionChunk({}, "tool_calls") + "data: [DONE]\n\n");
		});
	}, cert);
	t.after(() => new Promise((resolve) => fixture.server.close(resolve)));
	const tools = [{ name: "lookup", description: "Fixture lookup", parameters: { type: "object", properties: { term: { type: "string" } }, required: ["term"], additionalProperties: false } }];
	const context = normalizeContext({ messages: [{ role: "user", content: "lookup local", timestamp: Date.now() }], tools });
	const secureStream = createOmniRouteStream(streamSimple, { expectedOrigin: fixture.origin, loadCa: () => cert.cert, Agent });
	const events = await collect(secureStream(modelAt(fixture.origin), context, { apiKey: "fixture-only-token" }));
	assert.ok(Array.isArray(body.tools) && body.tools.some((tool) => tool.function?.name === "lookup"));
	assert.ok(events.some((event) => event.type === "toolcall_end" && event.toolCall.name === "lookup"));
});

test("the production route remains opt-in and does not rewrite the configured default", async () => {
	const policy = JSON.parse(readFileSync(new URL("../config/optional-services.json", import.meta.url), "utf8"));
	const settings = JSON.parse(readFileSync(new URL("../config/settings-patch.json", import.meta.url), "utf8"));
	assert.equal(policy.omniroute, "deferred");
	assert.equal(settings.defaultModel, "gpt-6-sol");
	const source = readFileSync(new URL("../extensions/omniroute.ts", import.meta.url), "utf8");
	assert.match(source, /import \{ streamSimple \} from "@earendil-works\/pi-ai\/api\/openai-completions"/u);
	assert.match(source, /createOmniRouteStream\(streamSimple\)/u);
	assert.match(source, /apiKey: "\$OMNIROUTER_API_KEY"/u);
});

test("the operator candidate is digest-pinned, internal, TLS-key protected, and non-destructive", async () => {
	const script = readFileSync(new URL("../scripts/omniroute-docker-candidate.sh", import.meta.url), "utf8");
	assert.match(script, /diegosouzapw\/omniroute@\$\{OMNI_DIGEST\}/u);
	assert.match(script, /085c57adf499a8aaa9f35ccde95c0df9c11bd9ecd18d6c9edbf3b68b8079ba9d/u);
	assert.match(script, /caddy@sha256:eb4d35b7452d1ab6171fbdbe8d9275b2301dad6dad92115d91e19fb9b24d510f/u);
	assert.match(script, /docker network create --driver bridge --internal/u);
	assert.match(script, /--publish "127\.0\.0\.1:\$\{HOST_PORT\}:8443\/tcp"/u);
	assert.match(script, /--network "container:\$\{edge_id\}"/u);
	assert.ok(script.indexOf('docker start "$edge_id"') < script.indexOf('backend_id=$(docker create'), "the network-namespace owner must run before the backend joins it");
	assert.match(script, /--entrypoint caddy "\$CADDY_IMAGE" validate/u);
	assert.match(script, /--entrypoint caddy "\$CADDY_IMAGE" run/u);
	assert.match(script, /--mount "type=bind,src=\$ROOT\/tls\.key,dst=\/etc\/caddy\/tls\.key,readonly"/u);
	assert.match(script, /chmod 0600 "\$ROOT\/tls\.key"/u);
	assert.match(script, /\[\[ "\$unauth_status" == 401 \]\]/u);
	assert.match(script, /\[\[ "\$wrong_status" == 401 \]\]/u);
	assert.doesNotMatch(script, /docker (?:rm|network rm)\b/u);
	assert.doesNotMatch(script, /docker pull "\$OMNI_IMAGE"/u);
	const backendCreate = script.slice(script.indexOf("backend_id=$(docker create"), script.indexOf("# Start the backend"));
	assert.doesNotMatch(backendCreate, /--publish/u);
});

test("candidate Caddyfile generation emits a valid unescaped matcher and recovery only accepts the known prior typo", () => {
	const scriptPath = new URL("../scripts/omniroute-docker-candidate.sh", import.meta.url);
	const script = readFileSync(scriptPath, "utf8");
	const caddyfile = execFileSync("bash", [scriptPath.pathname, "--render-caddyfile", "20128"], { encoding: "utf8" });
	assert.match(caddyfile, /^\t@unauthorized not header Authorization "Bearer \{\$OMNIROUTE_PROXY_TOKEN\}"$/mu);
	assert.doesNotMatch(caddyfile, /\\@unauthorized/u);
	const knownBrokenCaddyfile = execFileSync("bash", ["-c", 'expected="$1"; known_bad=${expected/@unauthorized/\\\\@unauthorized}; printf "%s" "$known_bad"', "fixture", caddyfile], { encoding: "utf8" });
	assert.equal(knownBrokenCaddyfile, caddyfile.replace("@unauthorized", "\\@unauthorized"));
	assert.match(caddyfile, /^\trespond @unauthorized "unauthorized" 401$/mu);
	assert.match(caddyfile, /^\treverse_proxy 127\.0\.0\.1:20128$/mu);
	assert.match(script, /cmp -s <\(printf '%s' "\$known_bad_caddy"\) "\$ROOT\/Caddyfile"/u);
	assert.match(script, /existing_caddyfile_unrecognized_preserved/u);
	assert.match(script, /existing_proxy_token_unreadable_preserved/u);
	assert.match(script, /--resume-existing/u);
	assert.match(script, /resume_protected_host_config_missing_no_new_credentials_requested/u);
	assert.match(script, /"INITIAL_PASSWORD"/u);
	assert.match(script, /sanitized diagnostic follows/u);
	assert.match(script, /Diagnostic omitted because redaction could not be guaranteed/u);
	assert.doesNotMatch(script, /docker (?:rm|network rm)\b/u);
});
