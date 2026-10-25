import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = path.join(repo, "scripts/sandbox-run.sh");

function sandboxProbe(workspace, state, profile, command, socket) {
  return spawnSync(sandbox, ["--runtime-state", state, "--browser-profile", profile,
    "--port", "43123", "--database", "phi_bridge_probe", "--schema", "phi_bridge_probe",
    workspace, "--", ...command, socket], {
    encoding: "utf8", timeout: 15000,
  });
}

test("Bubblewrap blocks arbitrary tool children from a host Unix socket, but same-UID host clients remain possible", {
  skip: process.platform !== "linux" || process.env.PI_OVERDRIVE_SKIP_BWRAP === "1" || process.env.PI_OVERDRIVE_IN_SANDBOX === "1",
}, async () => {
  const base = mkdtempSync(path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), "phi-bridge-boundary-"));
  const workspace = path.join(base, "workspace");
  const state = path.join(base, "state");
  const profile = path.join(base, "browser");
  const socket = path.join(base, "bridge.sock");
  mkdirSync(workspace);
  mkdirSync(state);
  mkdirSync(profile);
  symlinkSync(socket, path.join(workspace, "bridge-link"));
  const server = net.createServer((client) => client.end("fixture-only"));
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
    chmodSync(socket, 0o600);
    const original = lstatSync(socket, { bigint: true });
    // A separate same-UID host process can connect: mode/UID are not Phi-only authority.
    const host = spawnSync("python3", ["-c", "import socket,sys;s=socket.socket(socket.AF_UNIX);s.connect(sys.argv[1]);s.close()", socket], { timeout: 5000 });
    assert.equal(host.status, 0);

    const connect = sandboxProbe(workspace, state, profile, ["python3", "-c", "import socket,sys;s=socket.socket(socket.AF_UNIX);s.connect(sys.argv[1])"], socket);
    assert.notEqual(connect.status, 0);
    const shellChild = sandboxProbe(workspace, state, profile, ["/usr/bin/sh", "-c", "python3 -c 'import socket,sys;s=socket.socket(socket.AF_UNIX);s.connect(sys.argv[1])' \"$1\"", "sh"], socket);
    assert.notEqual(shellChild.status, 0);
    const replace = sandboxProbe(workspace, state, profile, ["python3", "-c", "import os,sys;os.unlink(sys.argv[1])"], socket);
    assert.notEqual(replace.status, 0);
    const create = sandboxProbe(workspace, state, profile, ["python3", "-c", "import socket,sys;s=socket.socket(socket.AF_UNIX);s.bind(sys.argv[1])"], socket);
    assert.notEqual(create.status, 0);
    const linked = sandboxProbe(workspace, state, profile, ["python3", "-c", "import socket,sys;s=socket.socket(socket.AF_UNIX);s.connect('/workspace/bridge-link')"], socket);
    assert.notEqual(linked.status, 0);
    const after = lstatSync(socket, { bigint: true });
    assert.equal(after.dev, original.dev);
    assert.equal(after.ino, original.ino);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(base, { recursive: true, force: true });
  }
});

test("Node's built-in HTTP client can use a Unix socket, without proving Pi provider integration", async () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "phi-bridge-http-"));
  const socket = path.join(base, "probe.sock");
  const server = http.createServer((_request, response) => response.end("fixture-only"));
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
    chmodSync(socket, 0o600);
    const body = await new Promise((resolve, reject) => {
      http.get({ socketPath: socket, path: "/probe", timeout: 2000 }, (response) => {
        let text = "";
        response.on("data", (chunk) => { text += chunk; });
        response.on("end", () => resolve(text));
      }).on("error", reject);
    });
    assert.equal(body, "fixture-only");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(base, { recursive: true, force: true });
  }
});

test("a separate same-UID process can replace a user-owned socket pathname", { skip: process.platform !== "linux" }, async () => {
  const base = mkdtempSync(path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), "phi-bridge-replace-"));
  const socket = path.join(base, "probe.sock");
  const server = net.createServer((client) => client.end());
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
    chmodSync(socket, 0o600);
    const original = lstatSync(socket, { bigint: true });
    const replace = spawnSync("python3", ["-c", "import os,socket,sys; os.unlink(sys.argv[1]); s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); os.chmod(sys.argv[1],0o600); s.close()", socket], { timeout: 5000 });
    assert.equal(replace.status, 0);
    const after = lstatSync(socket, { bigint: true });
    assert.notEqual(after.ino, original.ino);
    assert.equal(Number(after.mode & 0o777n), 0o600);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(base, { recursive: true, force: true });
  }
});
