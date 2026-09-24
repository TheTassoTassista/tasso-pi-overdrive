import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DAP_ADAPTER_CAPABILITIES, DapEngine, DapEngineError, readDapPolicy, validateDapPolicy } from "../lib/dap-engine.mjs";

const basePolicy = readDapPolicy();
const testPolicy = validateDapPolicy({
  ...basePolicy,
  startupTimeoutMs: 1000,
  requestTimeoutMs: 500,
  idleTimeoutMs: 10_000,
  shutdownGraceMs: 100,
  maxMessageBytes: 64 * 1024,
  maxOutputBytes: 16 * 1024,
  maxStderrBytes: 4096,
  maxArguments: 8,
  maxArgumentChars: 256,
  maxProgramBytes: 1024 * 1024,
  maxSourceBytes: 1024 * 1024,
  maxBreakpoints: 4,
  maxStackFrames: 8,
  maxVariables: 4,
  maxValueChars: 64,
});

function encode(message) {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

function drainMessages(state, chunk, handler) {
  state.buffer = Buffer.concat([state.buffer, Buffer.from(chunk)]);
  for (;;) {
    const headerEnd = state.buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const match = state.buffer.subarray(0, headerEnd).toString("ascii").match(/Content-Length:\s*(\d+)/iu);
    if (!match) throw new Error("fake adapter framing error");
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (state.buffer.length < start + length) return;
    const message = JSON.parse(state.buffer.subarray(start, start + length).toString("utf8"));
    state.buffer = state.buffer.subarray(start + length);
    handler(message);
  }
}

class FakeAdapter extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.pid = undefined;
    this.sequence = 100;
    this.launchRequest = undefined;
    this.reverseDenied = false;
    const input = { buffer: Buffer.alloc(0) };
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        try { drainMessages(input, chunk, (message) => this.#handle(message)); callback(); }
        catch (error) { callback(error); }
      },
    });
  }

  #send(message) { this.stdout.write(encode({ seq: ++this.sequence, ...message })); }
  #response(request, body = {}) { this.#send({ type: "response", request_seq: request.seq, command: request.command, success: true, body }); }
  #event(event, body = {}) { this.#send({ type: "event", event, body }); }

  #handle(message) {
    if (message.type === "response" && message.command === "runInTerminal") {
      this.reverseDenied = message.success === false;
      return;
    }
    if (message.type !== "request") return;
    if (message.command === "initialize") {
      if (this.options.crashOnInitialize) { this.kill(); return; }
      this.#response(message, { supportsConfigurationDoneRequest: true });
      this.#send({ type: "request", command: "runInTerminal", arguments: { cwd: "/workspace", args: ["escape"] } });
      if (this.options.malformedAfterInitialize) this.stdout.write("Content-Length: 999999999\r\n\r\n{}");
      return;
    }
    if (message.command === "launch") {
      this.launchRequest = message;
      this.#event("initialized");
      this.#event("output", { category: "stderr", output: `FATAL retained-before-tail\n${"x".repeat(24 * 1024)}` });
      return;
    }
    if (message.command === "setBreakpoints") {
      this.#response(message, { breakpoints: message.arguments.breakpoints.map((entry) => ({ verified: true, line: entry.line })) });
      return;
    }
    if (message.command === "configurationDone") {
      this.#response(message);
      this.#response(this.launchRequest);
      this.#event("stopped", { reason: "entry", threadId: 7 });
      return;
    }
    if (message.command === "continue" || message.command === "next") {
      if (this.options.hangContinue && message.command === "continue") return;
      this.#response(message, { allThreadsContinued: true });
      this.#event("continued", { threadId: 7, allThreadsContinued: true });
      this.#event("stopped", { reason: message.command === "next" ? "step" : "breakpoint", threadId: 7 });
      return;
    }
    if (message.command === "stackTrace") {
      this.#response(message, { totalFrames: 1, stackFrames: [{ id: 11, name: "helper", source: { path: "/workspace/source.c" }, line: 3, column: 1 }] });
      return;
    }
    if (message.command === "scopes") {
      this.#response(message, { scopes: [{ name: "Locals", variablesReference: 21, expensive: false, namedVariables: 2 }] });
      return;
    }
    if (message.command === "variables") {
      this.#response(message, { variables: Array.from({ length: 8 }, (_, index) => ({ name: `v${index}`, value: "z".repeat(100), type: "int", variablesReference: 0 })) });
      return;
    }
    if (message.command === "disconnect") {
      this.#response(message);
      this.#event("terminated");
      return;
    }
    this.#send({ type: "response", request_seq: message.seq, command: message.command, success: false, message: "unsupported" });
  }

  kill() {
    if (this.exitCode !== null) return true;
    this.exitCode = 0;
    this.stdin.end();
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit("exit", 0, null));
    return true;
  }
}

function fixture(t, adapterOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dap-test-"));
  const program = path.join(root, "fixture");
  fs.writeFileSync(program, "fake executable\n", { mode: 0o700 });
  fs.writeFileSync(path.join(root, "source.c"), "int main(void) { return 0; }\n", { mode: 0o600 });
  let spawned = 0;
  let child;
  const engine = new DapEngine({
    cwd: root,
    policy: testPolicy,
    attestAdapter: () => ({ path: "/usr/bin/gdb", digest: testPolicy.adapter.binarySha256 }),
    spawnAdapter: () => { spawned += 1; child = new FakeAdapter(adapterOptions); return child; },
  });
  t.after(async () => { await engine.terminate("TEST_CLEANUP"); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, engine, get spawned() { return spawned; }, get child() { return child; } };
}

test("lazy single-session engine completes the bounded DAP workflow and denies reverse execution", async (t) => {
  const item = fixture(t);
  assert.equal(item.engine.status().state, "IDLE");
  assert.equal(item.spawned, 0);

  const launched = await item.engine.execute({ action: "launch", program: "fixture", args: ["safe"] });
  assert.equal(launched.state, "CONFIGURING");
  assert.equal(launched.sandboxed, true);
  assert.equal(launched.network, false);
  assert.equal(launched.workspaceReadOnly, true);
  assert.equal(item.spawned, 1);
  assert.equal(item.child.reverseDenied, true);
  assert.equal(item.child.launchRequest.arguments.program, "/workspace/fixture");

  const breakpoints = await item.engine.execute({ action: "set_breakpoint", file: "source.c", line: 3 });
  assert.deepEqual(breakpoints.breakpoints, [{ line: 3, verified: true, message: undefined }]);
  assert.equal((await item.engine.execute({ action: "continue" })).state, "STOPPED");
  const stack = await item.engine.execute({ action: "stack_trace", levels: 4 });
  assert.deepEqual(stack.frames[0], { id: 11, name: "helper", source: "source.c", line: 3, column: 1 });
  const scopes = await item.engine.execute({ action: "scopes", frameId: 11 });
  assert.equal(scopes.scopes[0].variablesReference, 21);
  const variables = await item.engine.execute({ action: "variables", variablesReference: 21, count: 4 });
  assert.equal(variables.variables.length, 4);
  assert.equal(variables.variables[0].value.length, testPolicy.maxValueChars);
  assert.equal(variables.truncated, true);
  const output = await item.engine.execute({ action: "output" });
  assert.equal(output.truncated, true);
  assert.match(output.output, /FATAL retained-before-tail/u);
  assert.match(output.output, /Earlier debug output omitted/u);
  assert.equal((await item.engine.execute({ action: "step_over" })).state, "STOPPED");
  const terminated = await item.engine.execute({ action: "terminate" });
  assert.equal(terminated.cleanupReason, "EXPLICIT");
  assert.equal(item.engine.status().state, "IDLE");
  assert.equal(item.engine.status().stats.reverseRequestsDenied, 1);
  assert.equal(item.engine.status().stats.cleanups, 1);
});

test("path, input, adapter and one-session boundaries fail closed before widening authority", async (t) => {
  const item = fixture(t);
  const outside = path.join(path.dirname(item.root), "outside-dap-program");
  fs.writeFileSync(outside, "outside\n", { mode: 0o700 });
  fs.symlinkSync(outside, path.join(item.root, "linked"));
  fs.linkSync(path.join(item.root, "fixture"), path.join(item.root, "hardlinked"));
  t.after(() => fs.rmSync(outside, { force: true }));

  await assert.rejects(item.engine.execute({ action: "launch", program: outside }), /DAP_PROGRAM_INVALID/u);
  await assert.rejects(item.engine.execute({ action: "launch", program: "linked" }), /DAP_PROGRAM_INVALID/u);
  await assert.rejects(item.engine.execute({ action: "launch", program: "hardlinked" }), /DAP_PROGRAM_INVALID/u);
  await assert.rejects(item.engine.execute({ action: "launch", program: "fixture", adapter: "other" }), /DAP_INPUT_INVALID/u);
  assert.equal(item.spawned, 0);
  fs.unlinkSync(path.join(item.root, "hardlinked"));
  await item.engine.execute({ action: "launch", program: "fixture" });
  await assert.rejects(item.engine.execute({ action: "launch", program: "fixture" }), /DAP_SESSION_ALREADY_ACTIVE/u);
  assert.equal(item.engine.status().state, "IDLE", "a rejected overlapping launch must clean the active adapter");
  await item.engine.execute({ action: "launch", program: "fixture" });
  await assert.rejects(item.engine.execute({ action: "variables", variablesReference: 1 }), /DAP_SESSION_STATE_INVALID/u);
  assert.equal(item.engine.status().state, "IDLE", "failed state action must clean the active adapter");
});

test("request timeout and malformed protocol terminate the adapter without a reusable ambiguous session", async (t) => {
  const hanging = fixture(t, { hangContinue: true });
  await hanging.engine.execute({ action: "launch", program: "fixture" });
  await hanging.engine.execute({ action: "continue" });
  await assert.rejects(hanging.engine.execute({ action: "continue", timeoutMs: 100 }), /DAP_REQUEST_TIMEOUT/u);
  assert.equal(hanging.engine.status().state, "IDLE");
  assert.equal(hanging.engine.status().stats.timeouts, 1);
  assert.equal(hanging.engine.status().stats.cleanups, 1);

  const malformed = fixture(t, { malformedAfterInitialize: true });
  await assert.rejects(malformed.engine.execute({ action: "launch", program: "fixture" }), /DAP_PROTOCOL_INVALID|DAP_ADAPTER_NOT_RUNNING/u);
  assert.equal(malformed.engine.status().state, "IDLE");
  assert.equal(malformed.engine.status().stats.cleanups, 1);
});

test("adapter crash and partial startup failure leave no reusable session", async (t) => {
  const crashed = fixture(t, { crashOnInitialize: true });
  await assert.rejects(crashed.engine.execute({ action: "launch", program: "fixture" }), /DAP_ADAPTER_EXITED|DAP_ADAPTER_NOT_RUNNING/u);
  assert.equal(crashed.engine.status().state, "IDLE");
  assert.equal(crashed.engine.status().stats.cleanups, 1);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dap-spawn-fail-"));
  fs.writeFileSync(path.join(root, "fixture.py"), "print(42)\n", { mode: 0o600 });
  const engine = new DapEngine({ cwd: root, policy: testPolicy, attestAdapter: () => ({ digest: "attested" }), spawnAdapter: () => { throw new Error("startup failed"); } });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(engine.execute({ action: "launch", program: "fixture.py" }), /DAP_ENGINE_FAILED/u);
  assert.equal(engine.status().state, "IDLE");
});

test("debugpy module digest mismatch denies launch before any adapter process is spawned", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dap-digest-"));
  fs.writeFileSync(path.join(root, "fixture.py"), "print(42)\n", { mode: 0o600 });
  let spawned = 0;
  const policy = validateDapPolicy({ ...testPolicy, secondaryAdapters: [{ ...testPolicy.secondaryAdapters[0], moduleSha256: "0".repeat(64) }] });
  const engine = new DapEngine({ cwd: root, policy, spawnAdapter: () => { spawned++; throw new Error("must not spawn"); } });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(engine.execute({ action: "launch", program: "fixture.py" }), /DAP_ADAPTER_DIGEST_MISMATCH/u);
  assert.equal(spawned, 0);
  assert.equal(engine.status().state, "IDLE");
});

test("program replacement during the configuration window is detected before execution resumes", async (t) => {
  const item = fixture(t);
  await item.engine.execute({ action: "launch", program: "fixture" });
  const replacement = path.join(item.root, "replacement");
  fs.writeFileSync(replacement, "different executable\n", { mode: 0o700 });
  fs.renameSync(replacement, path.join(item.root, "fixture"));
  await assert.rejects(item.engine.execute({ action: "continue" }), /DAP_PROGRAM_CHANGED/u);
  assert.equal(item.engine.status().state, "IDLE");
  assert.equal(item.engine.status().stats.cleanups, 1);
});

test("DAP policy rejects extra adapters, unsafe arguments and unbounded controls", () => {
  assert.throws(() => validateDapPolicy({ ...basePolicy, adapter: { ...basePolicy.adapter, id: "lldb" } }), DapEngineError);
  assert.throws(() => validateDapPolicy({ ...basePolicy, adapter: { ...basePolicy.adapter, arguments: ["-i", "dap"] } }), /DAP_POLICY_ADAPTER_ARGUMENTS_INVALID/u);
  assert.throws(() => validateDapPolicy({ ...basePolicy, secondaryAdapters: [{ ...basePolicy.secondaryAdapters[0], moduleVersion: "latest" }] }), /DAP_POLICY_SECONDARY_ADAPTER_INVALID/u);
  assert.throws(() => validateDapPolicy({ ...basePolicy, secondaryAdapters: [{ ...basePolicy.secondaryAdapters[0], binaryPath: "/usr/bin/python3" }] }), /DAP_POLICY_SECONDARY_ADAPTER_INVALID/u);
  assert.throws(() => validateDapPolicy({ ...basePolicy, secondaryAdapters: [] }), /DAP_POLICY_SECONDARY_ADAPTER_INVALID/u);
  assert.equal(DAP_ADAPTER_CAPABILITIES.debugpy.attach, false);
  assert.equal(DAP_ADAPTER_CAPABILITIES.debugpy.evaluate, false);
  assert.equal(DAP_ADAPTER_CAPABILITIES.debugpy.customRequest, false);
  assert.equal(DAP_ADAPTER_CAPABILITIES.debugpy.remoteTarget, false);
  assert.throws(() => validateDapPolicy({ ...basePolicy, maxVariables: 1000 }), /DAP_POLICY_VARIABLE_LIMIT_INVALID/u);
  assert.throws(() => validateDapPolicy({ ...basePolicy, unknown: true }), /DAP_POLICY_UNKNOWN_FIELD/u);
});

test("controller resolves Python to the reviewed profile and never accepts model-supplied adapter authority", async (t) => {
  const item = fixture(t);
  fs.writeFileSync(path.join(item.root, "fixture.py"), "value = 42\n", { mode: 0o600 });
  await assert.rejects(item.engine.execute({ action: "launch", program: "fixture.py", adapter: "debugpy" }), /DAP_INPUT_INVALID/u);
  await assert.rejects(item.engine.execute({ action: "attach", pid: 1 }), /DAP_INPUT_INVALID/u);
  await assert.rejects(item.engine.execute({ action: "launch", program: "fixture.py", request: "attach" }), /DAP_INPUT_INVALID/u);
  await assert.rejects(item.engine.execute({ action: "launch", program: "fixture.py", host: "0.0.0.0" }), /DAP_INPUT_INVALID/u);
  await assert.rejects(item.engine.execute({ action: "launch", program: "fixture.py", command: "evaluate" }), /DAP_INPUT_INVALID/u);
  const summary = await item.engine.execute({ action: "launch", program: "fixture.py" });
  assert.equal(summary.adapter, "debugpy");
  assert.equal(item.child.launchRequest.arguments.type, "python");
  assert.equal(item.child.launchRequest.arguments.program, "/workspace/fixture.py");
  assert.equal(item.child.launchRequest.arguments.console, "internalConsole");
  assert.equal(item.child.launchRequest.arguments.subProcess, false);
  assert.equal(item.spawned, 1);
});

test("real pinned GDB runs a C fixture inside the read-only networkless sandbox", { timeout: 45_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dap-real-"));
  const source = path.join(root, "fixture.c");
  const program = path.join(root, "fixture");
  fs.writeFileSync(source, [
    "#include <stdio.h>",
    "#include <stdlib.h>",
    "int helper(int value) {",
    "  int next = value + 1;",
    "  return next;",
    "}",
    "int main(void) {",
    "  int result = helper(41);",
    "  if (getenv(\"PI_OVERDRIVE_DAP_SECRET_PROBE\") != NULL) return 91;",
    "  FILE *forbidden = fopen(\"/workspace/forbidden-write\", \"w\");",
    "  if (forbidden != NULL) { fclose(forbidden); return 90; }",
    "  printf(\"result=%d\\n\", result);",
    "  return result == 42 ? 0 : 1;",
    "}",
    "",
  ].join("\n"), { mode: 0o600 });
  const compiled = spawnSync("cc", ["-g", "-O0", "-fno-omit-frame-pointer", `-fdebug-prefix-map=${root}=/workspace`, "-o", program, source], { encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stderr);
  const priorSecret = process.env.PI_OVERDRIVE_DAP_SECRET_PROBE;
  process.env.PI_OVERDRIVE_DAP_SECRET_PROBE = "must-not-reach-debuggee";
  const engine = new DapEngine({ cwd: root });
  t.after(async () => { await engine.terminate("TEST_CLEANUP"); fs.rmSync(root, { recursive: true, force: true }); });
  t.after(() => { if (priorSecret === undefined) delete process.env.PI_OVERDRIVE_DAP_SECRET_PROBE; else process.env.PI_OVERDRIVE_DAP_SECRET_PROBE = priorSecret; });

  const launched = await engine.execute({ action: "launch", program: "fixture" });
  assert.equal(launched.state, "CONFIGURING");
  const breakpoint = await engine.execute({ action: "set_breakpoint", file: "fixture.c", line: 4 });
  assert.equal(breakpoint.breakpoints[0].line, 4);
  assert.equal(typeof breakpoint.breakpoints[0].verified, "boolean", "pre-launch GDB may honestly report a pending breakpoint");
  assert.equal((await engine.execute({ action: "continue" })).state, "STOPPED", "configurationDone must stop at main");
  assert.equal((await engine.execute({ action: "continue" })).state, "STOPPED", "second continue must reach helper breakpoint");
  const stack = await engine.execute({ action: "stack_trace", levels: 8 });
  assert.equal(stack.frames.some((frame) => frame.name.includes("helper") && frame.source === "fixture.c" && frame.line === 4), true);
  const scopes = await engine.execute({ action: "scopes", frameId: stack.frames[0].id });
  assert.equal(scopes.scopes.some((scope) => scope.variablesReference > 0), true);
  const exited = await engine.execute({ action: "continue" });
  assert.equal(exited.state, "EXITED");
  assert.equal(exited.exitCode, 0, "debuggee must see neither ambient secret nor writable workspace");
  assert.equal(fs.existsSync(path.join(root, "forbidden-write")), false);
  const terminated = await engine.execute({ action: "terminate" });
  assert.equal(terminated.sandboxed, true);
  assert.equal(terminated.network, false);
  assert.equal(terminated.workspaceReadOnly, true);
  assert.equal(engine.status().state, "IDLE");
});

test("real project-owned debugpy runs Python breakpoints and bounded inspection inside Bubblewrap", { timeout: 60_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-debugpy-real-"));
  fs.writeFileSync(path.join(root, "fixture.py"), [
    "import os", "import socket", "def helper(value):", "    next_value = value + 1", "    return next_value",
    "result = helper(41)",
    "if os.getenv('PI_OVERDRIVE_DAP_SECRET_PROBE'): raise RuntimeError('ambient secret inherited')",
    "try:", "    open('/workspace/forbidden-write', 'w').close()", "    raise RuntimeError('workspace write permitted')",
    "except OSError: pass",
    "try:", "    with socket.socket() as probe:", "        if probe.connect_ex(('1.1.1.1', 9)) == 0: raise RuntimeError('external network permitted')",
    "except OSError: pass",
    "print(f'result={result}')", "if result != 42: raise RuntimeError('wrong result')", "",
  ].join("\n"), { mode: 0o600 });
  const priorSecret = process.env.PI_OVERDRIVE_DAP_SECRET_PROBE;
  process.env.PI_OVERDRIVE_DAP_SECRET_PROBE = "must-not-reach-debuggee";
  const engine = new DapEngine({ cwd: root });
  t.after(async () => { await engine.terminate("TEST_CLEANUP"); fs.rmSync(root, { recursive: true, force: true }); });
  t.after(() => { if (priorSecret === undefined) delete process.env.PI_OVERDRIVE_DAP_SECRET_PROBE; else process.env.PI_OVERDRIVE_DAP_SECRET_PROBE = priorSecret; });

  const launched = await engine.execute({ action: "launch", program: "fixture.py" });
  assert.equal(launched.adapter, "debugpy");
  assert.equal(launched.adapterVersion, "1.8.22");
  assert.equal(launched.sandboxed, true);
  assert.equal(launched.network, false);
  assert.equal(launched.workspaceReadOnly, true);
  const breakpoint = await engine.execute({ action: "set_breakpoint", file: "fixture.py", line: 4 });
  assert.equal(breakpoint.breakpoints[0].verified, true);
  assert.equal((await engine.execute({ action: "continue" })).state, "STOPPED");
  assert.equal((await engine.execute({ action: "continue" })).stopReason, "breakpoint");
  const stack = await engine.execute({ action: "stack_trace", levels: 8 });
  assert.equal(stack.frames.some((frame) => frame.name === "helper" && frame.source === "fixture.py" && frame.line === 4), true);
  const scopes = await engine.execute({ action: "scopes", frameId: stack.frames[0].id });
  const locals = scopes.scopes.find((scope) => scope.name === "Locals");
  assert.ok(locals?.variablesReference > 0);
  const variables = await engine.execute({ action: "variables", variablesReference: locals.variablesReference, count: 4 });
  assert.equal(variables.variables.some((variable) => variable.name === "value" && variable.value.includes("41")), true);
  assert.equal(variables.variables.every((variable) => variable.value.length <= basePolicy.maxValueChars), true);
  assert.equal((await engine.execute({ action: "step_over" })).stopReason, "step");
  const exited = await engine.execute({ action: "continue" });
  assert.equal(exited.state, "EXITED");
  assert.equal(exited.exitCode, 0);
  assert.equal(fs.existsSync(path.join(root, "forbidden-write")), false);
  const output = await engine.execute({ action: "output" });
  assert.match(output.output, /result=42/u);
  assert.doesNotMatch(output.output, /must-not-reach-debuggee/u);
  const terminated = await engine.execute({ action: "terminate" });
  assert.equal(terminated.adapterExited, true);
  assert.equal(engine.status().state, "IDLE");
});

test("real debugpy reports debuggee failure and removes its owned sandbox process", { timeout: 45_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-debugpy-crash-"));
  fs.writeFileSync(path.join(root, "fixture.py"), "raise SystemExit(7)\n", { mode: 0o600 });
  const engine = new DapEngine({ cwd: root });
  t.after(async () => { await engine.terminate("TEST_CLEANUP"); fs.rmSync(root, { recursive: true, force: true }); });
  await engine.execute({ action: "launch", program: "fixture.py" });
  assert.equal((await engine.execute({ action: "continue" })).state, "STOPPED");
  const exited = await engine.execute({ action: "continue" });
  assert.equal(exited.state, "EXITED");
  assert.equal(exited.exitCode, 7);
  await engine.execute({ action: "terminate" });
  const processes = spawnSync("ps", ["-eo", "args="], { encoding: "utf8" }).stdout;
  assert.equal(processes.includes(root), false);
  assert.equal(engine.status().state, "IDLE");
});
