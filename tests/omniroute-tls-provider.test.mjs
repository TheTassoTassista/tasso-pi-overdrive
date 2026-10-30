import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
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
	assert.doesNotMatch(source, /from "@earendil-works\/pi-ai\/api\/openai-completions"/u);
	assert.match(source, /loadPiOpenAiCompletionsStreamSimple\(\)/u);
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
	const caddyValidation = script.slice(script.indexOf("if docker run --rm --pull=never"), script.indexOf("--entrypoint caddy \"$CADDY_IMAGE\" validate"));
	const edgeCreate = script.slice(script.indexOf('edge_id=$(docker create'), script.indexOf('# The namespace-sharing target'));
	assert.match(caddyValidation, /--cap-drop ALL --cap-add NET_BIND_SERVICE --security-opt no-new-privileges/u);
	assert.match(edgeCreate, /--cap-drop ALL --cap-add NET_BIND_SERVICE --security-opt no-new-privileges/u);
	assert.match(script, /--mount "type=bind,src=\$ROOT\/tls\.key,dst=\/etc\/caddy\/tls\.key,readonly"/u);
	assert.match(script, /chmod 0600 "\$ROOT\/tls\.key"/u);
	assert.match(script, /\[\[ "\$unauth_status" == 401 \]\]/u);
	assert.match(script, /\[\[ "\$wrong_status" == 401 \]\]/u);
	assert.doesNotMatch(script, /docker (?:rm|network rm)\b/u);
	assert.doesNotMatch(script, /docker pull "\$OMNI_IMAGE"/u);
	const backendCreate = script.slice(script.indexOf("backend_id=$(docker create"), script.indexOf("# Start the backend"));
	assert.match(backendCreate, /--cap-drop ALL --security-opt no-new-privileges/u);
	assert.doesNotMatch(backendCreate, /--cap-add\b/u);
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
	assert.doesNotMatch(caddyfile, /header_up\s+-Authorization/u, "Caddy passes the validated Bearer to OmniRoute for API-key validation");
	assert.match(script, /cmp -s <\(printf '%s(?:\\n|\n)' "\$known_bad_caddy"\) "\$ROOT\/Caddyfile"/u);
	assert.match(script, /existing_caddyfile_unrecognized_preserved/u);
	assert.match(script, /existing_proxy_token_unreadable_preserved/u);
	assert.match(script, /--resume-existing/u);
	assert.match(script, /resume_protected_host_config_missing_no_new_credentials_requested/u);
	assert.match(script, /"INITIAL_PASSWORD"/u);
	assert.match(script, /sanitized diagnostic follows/u);
	assert.match(script, /Diagnostic omitted because redaction could not be guaranteed/u);
	assert.doesNotMatch(script, /docker (?:rm|network rm)\b/u);
	assert.match(script, /REQUIRE_API_KEY=true\\nOMNIROUTE_API_KEY=%s/u, "backend requires a real OmniRoute API key, not only the Caddy check");
	assert.match(script, /"\$initial_password" "\$proxy_token" "\$BACKEND_PORT"/u, "management password is not reused as the backend API key");
	assert.match(script, /--backend-api-key-upgrade/u);
	assert.match(script, /phi-omniroute-egress-backend-auth-v1/u);
	assert.match(script, /--expected-auth-mode enforced --expected-api-key-sha256/u);
	assert.match(script, /legacy_backend_id.*PRESERVED/u);
	assert.match(script, /elif \[\[ "\$backend_auth_mode" == legacy \]\]; then\n\s*fail 'catalog_and_inference_api_key_enforcement_required'/u);
	assert.doesNotMatch(script, /docker (?:rm|container rm)\b/u);
});

test("candidate TLS health poll retains bounded curl status and timing metrics without response or token", () => {
	const source = readFileSync(new URL("../scripts/omniroute-docker-candidate.sh", import.meta.url), "utf8");
	const waitFunction = source.match(/^wait_status\(\) \{[\s\S]*?^\}/mu)?.[0];
	assert.ok(waitFunction);
	const fixture = `ROOT=/unused; HOST_PORT=20129; proxy_token=fixture-secret
curl() { printf '%s' "$FAKE_WRITEOUT"; return "$FAKE_EXIT"; }
sleep() { SECONDS=$((SECONDS + 1)); }
${waitFunction}
	if wait_status 200; then printf 'RESULT=PASS\\n'; else printf 'RESULT=FAIL exit=%s writeout=%s\\n' "$tls_last_exit" "$tls_last_writeout"; fi`;
	for (const [writeout, exitCode, expected] of [
		["200|0.010000|0.020000|0.030000|0.040000", "0", "RESULT=PASS"],
		["503|0.010000|0.020000|0.030000|3.000000", "0", "RESULT=FAIL exit=0 writeout=503|0.010000|0.020000|0.030000|3.000000"],
		["000|0.000000|0.000000|0.000000|3.000000", "60", "RESULT=FAIL exit=60 writeout=000|0.000000|0.000000|0.000000|3.000000"],
		["200|0.010000|0.020000|0.030000|3.000000", "28", "RESULT=FAIL exit=28 writeout=200|0.010000|0.020000|0.030000|3.000000"],
	]) {
		const result = spawnSync("bash", ["-c", fixture], { encoding: "utf8", env: { ...process.env, FAKE_WRITEOUT: writeout, FAKE_EXIT: exitCode }, timeout: 5000 });
		assert.equal(result.status, 0);
		assert.equal(result.stdout, `${expected}\n`);
		assert.equal(result.stderr, "");
		assert.doesNotMatch(result.stdout + result.stderr, /fixture-secret/u);
	}
	assert.match(source, /NetworkSettings\.Ports/u);
	assert.ok(source.indexOf("tls_runtime_port_snapshot=") < source.indexOf("wait_status 200"));
	assert.match(source, /rejectUnauthorized:true/u);
	assert.doesNotMatch(source, /rejectUnauthorized\s*:\s*false/u);
	assert.match(source, /docker exec "\$backend_id" node -e/u);
	const healthReport = readFileSync(new URL("../scripts/omniroute-tls-health-report.py", import.meta.url), "utf8");
	assert.match(healthReport, /host_input_drop=/u);
});

test("candidate reports sanitized models transport and schema state after authenticated health", () => {
	const source = readFileSync(new URL("../scripts/omniroute-docker-candidate.sh", import.meta.url), "utf8");
	const helper = readFileSync(new URL("../scripts/omniroute-tls-health-report.py", import.meta.url), "utf8");
	const health = source.indexOf("if ! wait_status 200");
	const unauth = source.indexOf('[[ "$unauth_status" == 401 ]]');
	const wrongBearer = source.indexOf('[[ "$wrong_status" == 401 ]]');
	const models = source.indexOf("models_file=$(mktemp)");
	assert.ok(health >= 0 && health < unauth && unauth < wrongBearer && wrongBearer < models,
		"authenticated /healthz and both auth-negative checks precede GET /v1/models");
	const modelBlock = source.slice(models, source.indexOf("# Confirm server-side and Docker topology", models));
	assert.match(modelBlock, /if models_writeout=\$\(curl[\s\S]*--max-filesize 4194304/u);
	assert.match(modelBlock, /if models_writeout=\$\(curl[\s\S]*then\n\s*models_curl_exit=0\nelse\n\s*models_curl_exit=\$\?/u);
	assert.match(modelBlock, /--write-out '%\{http_code\}\|%\{time_connect\}\|%\{time_appconnect\}\|%\{time_starttransfer\}\|%\{time_total\}'/u);
	assert.match(modelBlock, /models \\\n\s*--curl-exit "\$models_curl_exit" --curl-output "\$models_writeout" --body-file "\$models_file"/u);
	assert.match(modelBlock, /printf '%s\\n' "\$models_report"/u);
	assert.match(modelBlock, /\[\[ "\$models_report_exit" -eq 0 \]\] \|\| fail 'authenticated_models_endpoint_failed'/u);
	assert.doesNotMatch(modelBlock, /printf[^\n]*(?:proxy_token|models_file)/u);
	assert.ok(helper.includes('value.get("object") != "list"'));
	assert.ok(helper.includes('not isinstance(value.get("data"), list)'));
	assert.ok(helper.includes('models_state == "PRESENT"'));
	assert.ok(helper.includes('f"http_status={probe.http_status} json={json_state} schema={schema_state} "'));
	assert.match(helper, /O_NOFOLLOW/u);
});

test("candidate attests edge_ip before a health timeout can invoke failure diagnostics", () => {
	const source = readFileSync(new URL("../scripts/omniroute-docker-candidate.sh", import.meta.url), "utf8");
	assert.match(source, /^edge_ip=''$/mu, "set -u must not expose an unbound diagnostic variable");
	const postStartAttestation = source.indexOf("--phase post-start");
	const edgeIpAttestation = source.indexOf("attest_edge_address || fail 'edge_attested_ipv4_unavailable'");
	const healthTimeout = source.indexOf("if ! wait_status 200");
	const diagnosticInvocation = source.indexOf("diagnose_tls_health_failure\n\tfail 'authenticated_tls_health_timeout'", healthTimeout);
	assert.ok(postStartAttestation >= 0 && postStartAttestation < edgeIpAttestation);
	assert.ok(edgeIpAttestation >= 0 && edgeIpAttestation < healthTimeout);
	assert.ok(healthTimeout < diagnosticInvocation && edgeIpAttestation < diagnosticInvocation, "the timeout diagnostic consumes only the earlier attested value");
	const addressAttestor = source.match(/^attest_edge_address\(\) \{[\s\S]*?^\}/mu)?.[0];
	assert.ok(addressAttestor);
	assert.match(addressAttestor, /docker inspect --format .*\.Id.*\.NetworkSettings\.Networks.*"\$edge_id"/u);
	assert.match(addressAttestor, /docker network inspect --format .*\.Id.*\.IPAM\.Config.*"\$network_id"/u);
	assert.match(addressAttestor, /--expected-edge-id "\$edge_id" --expected-network-id "\$network_id" --network-name "\$NETWORK"/u);
	assert.match(addressAttestor, /--expected-subnet "\$policy_subnet"/u);
	const diagnostic = source.match(/^diagnose_tls_health_failure\(\) \{[\s\S]*?^\}/mu)?.[0];
	assert.ok(diagnostic);
	assert.ok(diagnostic.indexOf("if ! attest_edge_address") < diagnostic.indexOf('--edge-address "$edge_ip"'));
	assert.match(diagnostic, /if \[\[ -n "\$edge_ip" \]\]; then/u);
});

test("candidate in-namespace Caddy diagnostic verifies CA without forwarding bearer and rejects a substituted edge", async (t) => {
	const source = readFileSync(new URL("../scripts/omniroute-docker-candidate.sh", import.meta.url), "utf8");
	const sourceProbeCode = source.match(/local edge_tls_probe_code='([^']*)'/u)?.[1];
	assert.ok(sourceProbeCode, "direct edge TLS diagnostic must remain testable as a bounded Node probe");
	const valid = makeCertificate(t);
	let requests = 0;
	const edge = await listen((request, response) => {
		requests++;
		assert.equal(request.headers.authorization, undefined);
		response.writeHead(401, { "content-type": "text/plain" });
		response.end("response body must not be reported");
	}, valid);
	t.after(() => new Promise((resolve) => edge.server.close(resolve)));
	const probeCode = sourceProbeCode.replace("port:8443", `port:${new URL(edge.origin).port}`);
	const runProbe = (ca) => new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["-e", probeCode], { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
		child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
		child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
		child.once("error", reject);
		child.once("close", (code) => { clearTimeout(timer); resolve({ status: code, stdout, stderr }); });
		child.stdin.end(JSON.stringify({ ca: ca.toString("utf8") }));
	});
	const trusted = await runProbe(valid.cert);
	assert.equal(trusted.status, 0);
	const trustedResult = JSON.parse(trusted.stdout);
	assert.deepEqual({ phase: trustedResult.phase, status: trustedResult.status, errorCode: trustedResult.errorCode }, { phase: "http", status: 401, errorCode: null }, `probe=${trusted.stdout} requests=${requests}`);
	assert.equal(requests, 1);
	assert.doesNotMatch(trusted.stdout, /fixture-only-token|response body/u);
	const substituted = makeCertificate(t);
	const rejected = await runProbe(substituted.cert);
	assert.equal(rejected.status, 0);
	const rejectedResult = JSON.parse(rejected.stdout);
	assert.equal(rejectedResult.phase, "tls");
	assert.equal(rejectedResult.status, null);
	assert.match(rejectedResult.errorCode, /CERT|VERIFY|SIGNATURE/u);
	assert.equal(requests, 1, "untrusted edge must be rejected before HTTP authorization is sent");
	assert.doesNotMatch(rejected.stdout, /fixture-only-token|response body/u);
	assert.match(sourceProbeCode, /rejectUnauthorized:true/u);
	assert.doesNotMatch(sourceProbeCode, /rejectUnauthorized\s*:\s*false/u);
});
