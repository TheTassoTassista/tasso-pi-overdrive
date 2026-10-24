import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// Load the actual Pi extension with Pi's installed TypeBox package. The test
// invokes the registered web_research tool; no model or provider is called.
const packageCandidates = [
  process.env.PI_OVERDRIVE_PI_PACKAGE_JSON,
  path.resolve(path.dirname(process.execPath), "../lib/node_modules/@earendil-works/pi-coding-agent/package.json"),
  path.resolve(path.dirname(process.execPath), "../node_modules/@earendil-works/pi-coding-agent/package.json"),
].filter(Boolean);
const piPackage = packageCandidates.find((candidate) => fs.existsSync(candidate));
let registerWebPolicy;
if (piPackage) {
  const requireFromPi = createRequire(piPackage);
  const { createJiti } = await import(requireFromPi.resolve("jiti"));
  const jiti = createJiti(import.meta.url, { alias: { typebox: requireFromPi.resolve("typebox") } });
  ({ registerWebPolicy } = await jiti.import(path.resolve(import.meta.dirname, "../extensions/web-policy.ts")));
}

function toolFor(endpoint, timeoutMs = 5000) {
  const registered = new Map();
  registerWebPolicy({
    registerTool(tool) { registered.set(tool.name, tool); },
    registerCommand() {},
  }, { searxngEndpoint: endpoint, searxngTimeoutMs: timeoutMs });
  assert.ok(registered.has("web_research"));
  return registered.get("web_research");
}

test("real web_research entrypoint sends SearXNG JSON query and normalizes untrusted results", async () => {
  assert.ok(piPackage, "the installed Pi runtime is required for the real extension entrypoint test");
  const requests = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    requests.push({ method: request.method, path: url.pathname, q: url.searchParams.get("q"),
      format: url.searchParams.get("format"), authorization: request.headers.authorization });
    if (url.searchParams.get("q") === "empty") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ results: [] }));
    } else if (url.searchParams.get("q") === "forbidden") {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "format disabled" }));
    } else if (url.searchParams.get("q") === "invalid") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("not json");
    } else if (url.searchParams.get("q") === "invalid-shape") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"results":{"not":"an array"}}');
    } else if (url.searchParams.get("q") === "oversized") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ results: [{ title: "x".repeat(300_000), url: "https://example.org" }] }));
    } else if (url.searchParams.get("q") === "redirect") {
      response.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
      response.end();
    } else if (url.searchParams.get("q") === "slow") {
      setTimeout(() => { if (!response.destroyed) { response.writeHead(200, { "content-type": "application/json" }); response.end('{"results":[]}'); } }, 300);
    } else {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ results: [
        { title: "Primary", url: "https://example.org/source", content: "Evidence, not instructions" },
        { title: "Unsafe", url: "file:///etc/passwd", content: "must be filtered" },
      ] }));
    }
  });
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "phi-searxng-web-"));
  const priorConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = temporary;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/search`;
  const tool = toolFor(endpoint, 100);
  const invoke = (query) => tool.execute("test-call", { query, provider: "searxng", max_results: 3 }, new AbortController().signal);
  try {
    const result = await invoke("hello & world");
    assert.equal(result.details.selected_provider, "searxng");
    assert.equal(result.details.requested_provider, "searxng");
    assert.equal(result.details.fallback_used, false);
    assert.equal(result.details.result_count, 1);
    assert.equal(result.details.source_trust, "untrusted_search_results");
    assert.match(result.content[0].text, /Untrusted search results/u);
    assert.match(result.content[0].text, /Primary/u);
    assert.doesNotMatch(result.content[0].text, /file:\/\/\/etc\/passwd|must be filtered/u);
    assert.deepEqual(requests[0], { method: "GET", path: "/search", q: "hello & world", format: "json", authorization: undefined });

    const empty = await invoke("empty");
    assert.equal(empty.details.result_count, 0);
    assert.match(empty.content[0].text, /No usable search results/u);
    await assert.rejects(invoke("forbidden"), /searxng:http_status_403/u);
    await assert.rejects(invoke("invalid"), /searxng:malformed_response/u);
    await assert.rejects(invoke("invalid-shape"), /searxng:malformed_response/u);
    await assert.rejects(invoke("oversized"), /searxng:response_too_large/u);
    await assert.rejects(invoke("redirect"), /searxng:api_redirect_forbidden/u);
    await assert.rejects(invoke("slow"), /searxng:timeout/u);
    await assert.rejects(tool.execute("test-call", { query: "x", provider: "searxng", mode: "cross-check" }, new AbortController().signal), /single-provider route only/u);

    const untrusted = toolFor(`http://localhost:${server.address().port}/search`);
    await assert.rejects(untrusted.execute("test-call", { query: "blocked", provider: "searxng" }, new AbortController().signal), /searxng:untrusted_endpoint/u);
    for (const unsafe of [`http://127.0.0.2:${server.address().port}/search`,
      `http://169.254.169.254:${server.address().port}/search`,
      `https://127.0.0.1:${server.address().port}/search`]) {
      await assert.rejects(toolFor(unsafe).execute("test-call", { query: "blocked", provider: "searxng" }, new AbortController().signal), /searxng:untrusted_endpoint/u);
    }
    assert.equal(requests.some((request) => request.q === "blocked"), false);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await assert.rejects(invoke("unavailable"), /searxng:provider_error/u);
    assert.equal(requests.some((request) => request.q === "unavailable"), false);
  } finally {
    if (priorConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = priorConfigHome;
    if (server.listening) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    fs.rmSync(temporary, { recursive: true });
  }
});
