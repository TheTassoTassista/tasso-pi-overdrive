import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fetchPublicText, isPublicAddress, requestPublicJson } from "../lib/safe-web-fetch.mjs";

test("bounded web fetch pins resolution, handles redirects, sanitizes HTML, and rejects unsafe/malformed responses", async () => {
  const server = http.createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/final" });
      response.end();
    } else if (request.url === "/final") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<title>Fixture</title><script>SECRET_SCRIPT</script><p>Safe body</p>");
    } else if (request.url === "/large") {
      response.writeHead(200, { "content-type": "text/plain", "content-length": "4096" });
      response.end("x".repeat(4096));
    } else if (request.url === "/binary") {
      response.writeHead(200, { "content-type": "image/png" });
      response.end("not really an image");
    } else if (request.url === "/loop") {
      response.writeHead(302, { location: "/loop" });
      response.end();
    } else if (request.url === "/slow") {
      setTimeout(() => { response.writeHead(200, { "content-type": "text/plain" }); response.end("late"); }, 300);
    } else if (request.url === "/malformed") {
      request.socket.destroy();
    } else if (request.url === "/json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    } else if (request.url === "/json-redirect") {
      response.writeHead(302, { location: "/json" });
      response.end();
    } else if (request.url === "/malformed-json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("not-json");
    } else {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("missing");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const resolver = async () => ({ address: "127.0.0.1", family: 4 });
  const target = (pathname) => `http://fixture.invalid:${port}${pathname}`;
  try {
    const fetched = await fetchPublicText(target("/redirect"), { resolver, maxRedirects: 2 });
    assert.equal(fetched.details.redirects, 1);
    assert.match(fetched.text, /Safe body/u);
    assert.doesNotMatch(fetched.text, /SECRET_SCRIPT/u);
    await assert.rejects(fetchPublicText(target("/large"), { resolver, maxBytes: 1024 }), /response_too_large/u);
    await assert.rejects(fetchPublicText(target("/binary"), { resolver }), /unsupported_content_type/u);
    await assert.rejects(fetchPublicText(target("/loop"), { resolver, maxRedirects: 1 }), /redirect_limit/u);
    await assert.rejects(fetchPublicText(target("/slow"), { resolver, timeoutMs: 100 }), /request_timeout/u);
    await assert.rejects(fetchPublicText(target("/malformed"), { resolver }), /network_error|malformed_response/u);
    assert.deepEqual(await requestPublicJson(target("/json"), { resolver }), { ok: true });
    await assert.rejects(requestPublicJson(target("/json-redirect"), { resolver }), /api_redirect_forbidden/u);
    await assert.rejects(requestPublicJson(target("/malformed-json"), { resolver }), /malformed_response/u);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  await assert.rejects(fetchPublicText("file:///etc/passwd"), /unsupported_scheme/u);
  await assert.rejects(fetchPublicText("not a url"), /invalid_url/u);
  await assert.rejects(fetchPublicText("http://127.0.0.1/"), /private_address/u);
  assert.equal(isPublicAddress("127.0.0.1"), false);
  assert.equal(isPublicAddress("169.254.169.254"), false);
  assert.equal(isPublicAddress("10.0.0.1"), false);
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("::1"), false);
  assert.equal(isPublicAddress("::ffff:7f00:1"), false);
  assert.equal(isPublicAddress("64:ff9b::7f00:1"), false);
  assert.equal(isPublicAddress("2002:7f00:1::"), false);
});
