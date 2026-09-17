import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PersistentEvalEngine,
  spawnPersistentEvalKernel,
  validateEvalPolicy,
} from "../lib/persistent-eval.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const crashFixture = path.join(root, "tests", "fixtures", "eval-crash-kernel.mjs");
const sandboxScript = path.join(root, "scripts", "sandbox-run.sh");
const policy = JSON.parse(fs.readFileSync(path.join(root, "config", "eval-engine.json"), "utf8"));

function temporaryEvalRoots() {
  return new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("pi-overdrive-eval-")));
}

test("eval policy pins both runtimes and rejects widened authority", () => {
  const checked = validateEvalPolicy(policy);
  assert.equal(checked.runtimes.python.binaryPath, "/usr/bin/python3.14");
  assert.equal(checked.runtimes.javascript.binaryPath, "/usr/bin/node");
  assert.equal(checked.runtimes.javascript.typescriptCompiler.version, "6.0.3");
  assert.equal(checked.processLimiter.binaryPath, "/usr/bin/prlimit");
  assert.ok(checked.maxExecutionTimeoutMs <= 15_000);
  assert.ok(checked.maxOutputBytes <= 256 * 1024);
  assert.throws(() => validateEvalPolicy({ ...policy, hostFilesystem: true }), /EVAL_POLICY_UNKNOWN_FIELD/u);
  const widened = structuredClone(policy);
  widened.runtimes.javascript.arguments.push("--experimental-network-inspection");
  assert.throws(() => validateEvalPolicy(widened), /EVAL_POLICY_RUNTIME_INVALID/u);
});

test("minimal sandbox omits owner-local runtimes and saturates the pinned Node process budget", () => {
  const probe = spawnSync(sandboxScript, [
    "--minimal-runtime", "--workspace-read-only", root, "--cwd", ".", "--",
    policy.processLimiter.binaryPath, ...policy.processLimiter.arguments,
    policy.runtimes.javascript.binaryPath, ...policy.runtimes.javascript.arguments,
    "-e", "const fs=require('node:fs');const p=require('node:child_process').spawnSync('/usr/bin/id');console.log(JSON.stringify({tools:fs.existsSync('/opt/pi-overdrive-tools'),pi:fs.existsSync('/opt/pi-runtime'),spawn:p.error?.code??p.status}))",
  ], { encoding: "utf8", timeout: 10_000 });
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout.trim()), { tools: false, pi: false, spawn: "EAGAIN" });
});

test("Python state persists while imports, files, subprocesses, network, and ambient secrets stay unavailable", async () => {
  const engine = new PersistentEvalEngine({ cwd: root });
  try {
    const first = await engine.execute("python", { action: "execute", code: "x = [20, 22]\nsum(x)" });
    const second = await engine.execute("python", { action: "execute", code: "x[0] + x[1]" });
    assert.equal(first.value, "42");
    assert.equal(second.value, "42");
    assert.equal(first.session.kernelId, second.session.kernelId);
    for (const code of ["open('/home/tasso/.ssh/id_ed25519').read()", "__import__('os').environ", "__import__('subprocess').run(['id'])", "__import__('socket').socket()"] ) {
      const denied = await engine.execute("python", { action: "execute", code });
      assert.equal(denied.status, "ERROR", code);
      assert.match(denied.error, /(?:NameError|PermissionError):/u);
    }
    const indirect = await engine.execute("python", { action: "execute", code: [
      "loader = next(item for item in object.__subclasses__() if item.__name__ == 'BuiltinImporter')",
      "posix = loader.load_module('posix')",
      "indirect = {}",
      "try:",
      "    indirect['spawn'] = posix.system('id')",
      "except BaseException as error:",
      "    indirect['spawn'] = type(error).__name__",
      "try:",
      `    descriptor = posix.open(${JSON.stringify(path.join(root, "package.json"))}, 0)`,
      "    indirect['host'] = posix.read(descriptor, 20)",
      "except BaseException as error:",
      "    indirect['host'] = type(error).__name__",
      "indirect",
    ].join("\n") });
    assert.match(indirect.value, /'spawn': -1/u);
    assert.match(indirect.value, /'host': 'FileNotFoundError'/u);
    const large = await engine.execute("python", { action: "execute", code: "print('X' * 400000)" });
    assert.equal(large.status, "PASS");
    assert.equal(large.outputTruncated, true);
    assert.ok(large.outputBytes <= policy.maxOutputBytes);
  } finally {
    await engine.terminateAll("TEST_CLEANUP");
  }
});

test("JavaScript and TypeScript share bounded state without process, require, fetch, or string code generation", async () => {
  const engine = new PersistentEvalEngine({ cwd: root });
  try {
    const first = await engine.execute("javascript", { action: "execute", code: "let base = 40; base" });
    const second = await engine.execute("javascript", { action: "execute", code: "base + 2" });
    const typed = await engine.execute("javascript", { action: "execute", dialect: "typescript", code: "const typed: number = base + 3; typed" });
    assert.equal(first.value, "40");
    assert.equal(second.value, "42");
    assert.equal(typed.status, "PASS");
    assert.equal(typed.value, "43");
    assert.equal(first.session.kernelId, typed.session.kernelId);
    const globals = await engine.execute("javascript", { action: "execute", code: "[typeof process, typeof require, typeof fetch, typeof Buffer].join(',')" });
    assert.equal(globals.value, "undefined,undefined,undefined,undefined");
    const constructor = await engine.execute("javascript", { action: "execute", code: "Function('return process')()" });
    assert.equal(constructor.status, "ERROR");
    assert.match(constructor.error, /EvalError/u);
    const subprocess = await engine.execute("javascript", { action: "execute", code: "this.constructor.constructor('return process')().binding('spawn_sync').spawn({file:'/usr/bin/id',args:['id'],envPairs:[],stdio:[{type:'ignore'},{type:'pipe',readable:true,writable:false},{type:'pipe',readable:true,writable:false}]})" });
    assert.equal(subprocess.status, "ERROR");
  } finally {
    await engine.terminateAll("TEST_CLEANUP");
  }
});

test("unrelated engine sessions never inherit retained state", async () => {
  const first = new PersistentEvalEngine({ cwd: root });
  const second = new PersistentEvalEngine({ cwd: root });
  try {
    await first.execute("python", { action: "execute", code: "session_only = 17" });
    const isolated = await second.execute("python", { action: "execute", code: "session_only" });
    assert.equal(isolated.status, "ERROR");
    assert.equal(isolated.errorType, "NameError");
  } finally {
    await first.terminateAll("TEST_CLEANUP");
    await second.terminateAll("TEST_CLEANUP");
  }
});

test("timeout kills state, next execute starts clean, and cleanup leaves no private roots", async () => {
  const before = temporaryEvalRoots();
  const engine = new PersistentEvalEngine({ cwd: root });
  try {
    await engine.execute("python", { action: "execute", code: "before_timeout = 9" });
    await assert.rejects(() => engine.execute("python", { action: "execute", code: "while True:\n    pass", timeoutMs: 100 }), /EVAL_TIMEOUT/u);
    const recovered = await engine.execute("python", { action: "execute", code: "globals().get('before_timeout', 'clean')" });
    assert.equal(recovered.value, "'clean'");
    assert.equal(recovered.session.stats.starts, 2);
    assert.equal(recovered.session.stats.timeouts, 1);
  } finally {
    await engine.terminateAll("TEST_CLEANUP");
  }
  const after = temporaryEvalRoots();
  assert.deepEqual([...after].filter((name) => !before.has(name)), []);
});

test("unexpected kernel exit fails soft and the same engine restarts without Pi", async () => {
  let launches = 0;
  const engine = new PersistentEvalEngine({
    cwd: root,
    spawnKernel: (options) => {
      launches += 1;
      if (launches === 1) return spawn(process.execPath, [crashFixture], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
      return spawnPersistentEvalKernel(options);
    },
  });
  try {
    await assert.rejects(() => engine.execute("python", { action: "execute", code: "21 * 2" }), /EVAL_KERNEL_EXITED/u);
    const recovered = await engine.execute("python", { action: "execute", code: "21 * 2" });
    assert.equal(recovered.value, "42");
    assert.equal(launches, 2);
    assert.equal(recovered.session.stats.crashes, 1);
  } finally {
    await engine.terminateAll("TEST_CLEANUP");
  }
});
