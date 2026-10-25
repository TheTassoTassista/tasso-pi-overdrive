import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("./fixtures/omniroute-namespace-bridge/", import.meta.url);
const unit = (name) => readFileSync(new URL(name, root), "utf8");

test("probe socket is private, filesystem-backed, and socket-activated", () => {
  const socket = unit("phi-bridge-probe.socket");
  assert.match(socket, /^ListenStream=%t\/phi-bridge-probe\/proxy\.sock$/m);
  assert.match(socket, /^SocketMode=0600$/m);
  assert.match(socket, /^DirectoryMode=0700$/m);
  assert.match(socket, /^Accept=no$/m);
  assert.match(socket, /^Service=phi-bridge-proxy\.service$/m);
  assert.doesNotMatch(socket, /^ListenStream=\d/m);
});

test("proxy joins the private backend namespace and uses only the official binary", () => {
  const proxy = unit("phi-bridge-proxy.service");
  const backend = unit("phi-bridge-backend.service");
  assert.match(proxy, /^Requires=phi-bridge-backend\.service$/m);
  assert.match(proxy, /^After=phi-bridge-backend\.service$/m);
  assert.match(proxy, /^JoinsNamespaceOf=phi-bridge-backend\.service$/m);
  assert.match(proxy, /^ExecStart=\/usr\/lib\/systemd\/systemd-socket-proxyd 127\.0\.0\.1:20128$/m);
  for (const service of [proxy, backend]) {
    assert.match(service, /^PrivateNetwork=yes$/m);
    assert.match(service, /^PrivateTmp=yes$/m);
    assert.match(service, /^NoNewPrivileges=yes$/m);
    assert.match(service, /^Restart=no$/m);
  }
  assert.doesNotMatch(backend, /\/opt\/phi\/omniroute|credential|api.key/i);
});

test("probe response is explicit and does not execute a provider request", () => {
  const fixture = unit("fixture.py");
  assert.match(fixture, /self\.path != "\/__phi_bridge_probe"/);
  assert.match(fixture, /"fixture": "phi-namespace-bridge-v1"/);
  assert.match(fixture, /ThreadingHTTPServer\(\("127\.0\.0\.1", 20128\)/);
  assert.doesNotMatch(fixture, /urllib|requests|httpx|subprocess|socket\.connect/);
});
