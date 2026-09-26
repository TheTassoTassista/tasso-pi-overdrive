import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const packageRoot = path.resolve(import.meta.dirname, "..");
const launcher = path.join(packageRoot, "scripts", "pi-launcher.sh");
const installer = path.join(packageRoot, "scripts", "install-pi-launcher.sh");

function executable(file, source) {
  writeFileSync(file, `#!/usr/bin/env bash\nset -euo pipefail\n${source}\n`);
  chmodSync(file, 0o700);
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "pi-launcher-"));
  const bin = path.join(root, "bin");
  const state = path.join(root, "state");
  const calls = path.join(root, "calls");
  mkdirSync(bin);
  mkdirSync(calls);
  executable(path.join(bin, "curl"), `
url=\${!#}
if [[ \"$url\" == *20128* && -f \"$PI_TEST_ROOT/omni-ready\" ]]; then exit 0; fi
if [[ \"$url\" == *8888* && -f \"$PI_TEST_ROOT/searx-ready\" ]]; then exit 0; fi
exit 22`);
  executable(path.join(bin, "flock"), "/usr/bin/flock \"$@\"");
  executable(path.join(bin, "omniroute"), `
printf '%s\\n' \"$*\" >> \"$PI_TEST_ROOT/calls/omniroute\"
touch \"$PI_TEST_ROOT/omni-ready\"`);
  executable(path.join(bin, "sudo"), `
printf '%s\\n' \"$*\" >> \"$PI_TEST_ROOT/calls/sudo\"
touch \"$PI_TEST_ROOT/searx-ready\"`);
  executable(path.join(bin, "docker"), "exit 99");
  executable(path.join(bin, "xdg-open"), "printf '%s\\n' \"$*\" >> \"$PI_TEST_ROOT/calls/browser\"");
  executable(path.join(bin, "pi-overdrive-memory-services"), "printf '%s\\n' \"$*\" >> \"$PI_TEST_ROOT/calls/memory\"");
  executable(path.join(bin, "pi-real"), `
printf '%s\\n' \"$*\" >> \"$PI_TEST_ROOT/calls/pi\"
if [[ \"\${1:-}\" == --hold ]]; then /usr/bin/sleep 2; fi`);
  const env = {
    ...process.env,
    HOME: root,
    XDG_STATE_HOME: state,
    PI_TEST_ROOT: root,
    PI_OVERDRIVE_LAUNCHER_TEST_MODE: "1",
    PI_OVERDRIVE_LAUNCHER_TEST_BIN_DIR: bin,
    PI_OVERDRIVE_TEST_REAL_PI: path.join(bin, "pi-real"),
    PI_OVERDRIVE_TEST_WAIT_ATTEMPTS: "8",
    PI_OVERDRIVE_TEST_WAIT_INTERVAL: "0.01",
  };
  return { root, calls, env };
}

async function waitForDashboardCalls(setup, expected) {
  const file = path.join(setup.calls, 'browser');
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (existsSync(file) && readFileSync(file, 'utf8').split('\n').filter(Boolean).length === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`dashboard mock did not durably record ${expected} calls within the bounded wait`);
}

test("launcher starts each service once, uses true headless mode, and execs real Pi", async () => {
  const setup = fixture();
  try {
    for (let run = 0; run < 2; run += 1) {
      const result = spawnSync(launcher, ["--version"], { env: setup.env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }
    assert.equal(readFileSync(path.join(setup.calls, "omniroute"), "utf8"), "--headless\n");
    assert.equal(readFileSync(path.join(setup.calls, "sudo"), "utf8"), `-n ${path.join(setup.root, "bin", "docker")} start pi-overdrive-searxng\n`);
    assert.equal(readFileSync(path.join(setup.calls, "pi"), "utf8"), "--version\n--version\n");
    // Dashboard launch intentionally runs in the background. Pi exit cannot
    // certify that the mock has already written its independent receipt.
    await waitForDashboardCalls(setup, 2);
    assert.equal(readFileSync(path.join(setup.calls, "browser"), "utf8"), "http://127.0.0.1:20128\nhttp://127.0.0.1:20128\n");
    assert.equal(readFileSync(path.join(setup.calls, "memory"), "utf8"), "start\nstart\n");
  } finally {
    rmSync(setup.root, { recursive: true, force: true });
  }
});

test("launcher dashboard evidence waits for actual asynchronous completion, not Pi exit", async () => {
  const setup = fixture();
  try {
    executable(path.join(setup.root, 'bin', 'xdg-open'), '/usr/bin/sleep 0.15\nprintf "%s\\n" "$*" >> "$PI_TEST_ROOT/calls/browser"');
    const result = spawnSync(launcher, ['--version'], { env: setup.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    await waitForDashboardCalls(setup, 1);
    assert.equal(readFileSync(path.join(setup.calls, 'browser'), 'utf8'), 'http://127.0.0.1:20128\n');
    assert.equal(readFileSync(path.join(setup.calls, 'pi'), 'utf8'), '--version\n');
  } finally { rmSync(setup.root, { recursive: true, force: true }); }
});

test("launcher fails closed and never runs Pi when OmniRoute stays unhealthy", () => {
  const setup = fixture();
  try {
    executable(path.join(setup.root, "bin", "omniroute"), "printf '%s\\n' \"$*\" >> \"$PI_TEST_ROOT/calls/omniroute\"");
    const result = spawnSync(launcher, [], { env: setup.env, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /did not become healthy/u);
    assert.throws(() => readFileSync(path.join(setup.calls, "pi"), "utf8"));
    assert.throws(() => readFileSync(path.join(setup.calls, "sudo"), "utf8"));
  } finally {
    rmSync(setup.root, { recursive: true, force: true });
  }
});

test("startup lock is released before the long-running real Pi process", async () => {
  const setup = fixture();
  try {
    const first = spawn(launcher, ["--hold"], { env: setup.env, stdio: "ignore" });
    for (let attempt = 0; attempt < 100 && !existsSync(path.join(setup.root, "searx-ready")); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const second = spawnSync(launcher, ["--version"], { env: setup.env, encoding: "utf8", timeout: 1_000 });
    assert.equal(second.status, 0, second.error?.message ?? second.stderr);
    await new Promise((resolve) => first.once("exit", resolve));
  } finally {
    rmSync(setup.root, { recursive: true, force: true });
  }
});

test("launcher keeps Pi usable when local Second Brain startup fails", () => {
  const setup = fixture();
  try {
    executable(path.join(setup.root, "bin", "pi-overdrive-memory-services"), "exit 1");
    const result = spawnSync(launcher, ["--version"], { env: setup.env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /Second Brain is degraded/u);
    assert.equal(readFileSync(path.join(setup.calls, "pi"), "utf8"), "--version\n");
  } finally {
    rmSync(setup.root, { recursive: true, force: true });
  }
});

test("installer is idempotent and preserves one pre-existing Fish function backup", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-launcher-install-"));
  try {
    const fishDir = path.join(root, "fish");
    const launcherDir = path.join(root, "local-bin");
    mkdirSync(fishDir, { recursive: true });
    writeFileSync(path.join(fishDir, "pi.fish"), "function pi\n  command pi $argv\nend\n");
    const env = { ...process.env, HOME: root, PI_OVERDRIVE_FISH_FUNCTION_DIR: fishDir, PI_OVERDRIVE_LAUNCHER_DIR: launcherDir };
    for (let run = 0; run < 2; run += 1) {
      const result = spawnSync(installer, ["--install"], { env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }
    const check = spawnSync(installer, ["--check"], { env, encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr);
    assert.match(readFileSync(path.join(fishDir, "pi.fish"), "utf8"), /Managed by tasso-pi-overdrive/u);
    assert.equal(existsSync(path.join(launcherDir, "pi-overdrive-memory-services")), true);
    assert.equal(readFileSync(path.join(fishDir, "pi.fish.pre-overdrive"), "utf8"), "function pi\n  command pi $argv\nend\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
