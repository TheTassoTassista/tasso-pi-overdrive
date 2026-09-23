import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";
import { BrowserEngine, validateBrowserPng } from "../lib/browser-engine.mjs";
import { cleanupRuntimeResources, createRuntimeWorktree } from "../lib/runtime-isolation.mjs";
import { inspectProcessIdentity } from "../lib/process-identity.mjs";

function hostChromiumPid(networkNamespace, chromiumIdentity) {
  const candidates = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      if (fs.readlinkSync(`/proc/${entry}/ns/net`) !== networkNamespace) continue;
      const status = fs.readFileSync(`/proc/${entry}/status`, "utf8");
      const nested = status.match(/^NSpid:\s+([\d\s]+)$/mu)?.[1]?.trim().split(/\s+/u);
      candidates.push({ pid: Number(entry), nested, exe: path.basename(fs.readlinkSync(`/proc/${entry}/exe`)) });
      if (Number(nested?.at(-1)) !== chromiumIdentity.pid) continue;
      if (path.basename(fs.readlinkSync(`/proc/${entry}/exe`)) !== "chrome") continue;
      const identity = inspectProcessIdentity({ pid: Number(entry), bootId: fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), startTicks: chromiumIdentity.startTicks });
      if (identity.alive) return Number(entry);
    } catch {}
  }
  throw new Error(`exact isolated Chromium host PID was not found: ${JSON.stringify({ networkNamespace, chromiumIdentity, candidates })}`);
}

test("controller accepts only complete CRC-valid bounded PNG captures", () => {
  const valid = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9zL/8AAAAASUVORK5CYII=", "base64");
  valid.writeUInt32BE(crc32(valid.subarray(37, 52)), 52);
  assert.equal(validateBrowserPng(valid), true);
  const corrupt = Buffer.from(valid);
  corrupt[30] ^= 1;
  assert.equal(validateBrowserPng(corrupt), false);
  assert.equal(validateBrowserPng(Buffer.concat([valid, Buffer.from("extra")])), false);
  assert.equal(validateBrowserPng(Buffer.from("not a PNG")), false);
});

test("allocated browser remains lazy, rejects wrong owner and unsafe input, then fails closed on runner crash", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-browser-engine-"));
  const repo = path.join(root, "repo");
  const runtimeRoot = path.join(root, "runtime");
  const worktreeRoot = path.join(root, "worktrees");
  const previousRuntime = process.env.PI_OVERDRIVE_RUNTIME_ROOT;
  const previousWorktree = process.env.PI_OVERDRIVE_WORKTREE_ROOT;
  let allocation;
  let engine;
  try {
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, "index.html"), "<!doctype html><title>Crash fixture</title><button id=ok>Okay</button>\n");
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["-C", repo, "config", "user.name", "Browser Test"]);
    execFileSync("git", ["-C", repo, "config", "user.email", "browser@invalid"]);
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "commit", "-qm", "fixture"]);
    allocation = await createRuntimeWorktree(repo, { stateRoot: runtimeRoot, shareRoot: worktreeRoot });
    process.env.PI_OVERDRIVE_RUNTIME_ROOT = runtimeRoot;
    process.env.PI_OVERDRIVE_WORKTREE_ROOT = worktreeRoot;
    engine = new BrowserEngine({ cwd: allocation.worktree, ownerSession: "owner-one" });
    assert.equal(engine.status().state, "ALLOCATED");
    assert.equal(engine.child, undefined);
    const call = (tail, extra = {}) => ({ args: ["--session", allocation.browserSession, ...tail], ...extra });
    await assert.rejects(engine.execute(call(["eval", "1"]), "owner-one"), /BROWSER_ENGINE_POLICY_/u);
    await assert.rejects(engine.execute(call(["snapshot", "-i"]), "owner-one"), /BROWSER_ENGINE_OPEN_REQUIRED/u);
    await assert.rejects(engine.execute(call(["--profile", allocation.browserProfile, "open", `http:\/\/127.0.0.1:${allocation.port}\/`], { sessionMode: "fresh" }), "wrong-owner"), /BROWSER_ENGINE_OWNER_REJECTED/u);
    assert.equal(engine.child, undefined, "unsafe input and wrong owner must not start Bubblewrap");
    const opened = await engine.execute(call(["--profile", allocation.browserProfile, "open", `http:\/\/127.0.0.1:${allocation.port}\/`], { sessionMode: "fresh" }), "owner-one");
    assert.equal(opened.state, "ACTIVE");
    assert.notEqual(opened.networkNamespace, fs.readlinkSync("/proc/self/ns/net"));
    const snap = await engine.execute(call(["snapshot", "-i"]), "owner-one");
    assert.equal(snap.networkNamespace, opened.networkNamespace);
    assert.match(snap.text, /button "Okay"/u);
    assert.equal(snap.runnerIdentity.pid, opened.runnerIdentity.pid);
    engine.kill();
    await new Promise((resolve) => { if (engine.child.exitCode !== null) resolve(); else engine.child.once("exit", resolve); });
    assert.equal(engine.state, "FAILED");
    assert.equal(inspectProcessIdentity(opened.runnerIdentity).alive, false);
    await assert.rejects(engine.execute(call(["snapshot", "-i"]), "owner-one"), /BROWSER_ENGINE_STATE_REJECTED/u);
  } finally {
    if (engine) await engine.terminate();
    if (allocation) cleanupRuntimeResources(allocation.allocationId, { stateRoot: runtimeRoot, shareRoot: worktreeRoot });
    if (previousRuntime === undefined) delete process.env.PI_OVERDRIVE_RUNTIME_ROOT; else process.env.PI_OVERDRIVE_RUNTIME_ROOT = previousRuntime;
    if (previousWorktree === undefined) delete process.env.PI_OVERDRIVE_WORKTREE_ROOT; else process.env.PI_OVERDRIVE_WORKTREE_ROOT = previousWorktree;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("exact close, timeout, and Chromium crash each tear down only their owned namespace", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-browser-lifecycle-"));
  const repo = path.join(root, "repo");
  const options = { stateRoot: path.join(root, "runtime"), shareRoot: path.join(root, "worktrees") };
  const previousRuntime = process.env.PI_OVERDRIVE_RUNTIME_ROOT;
  const previousWorktree = process.env.PI_OVERDRIVE_WORKTREE_ROOT;
  const allocations = [];
  const engines = [];
  try {
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, "index.html"), "<!doctype html><title>Lifecycle fixture</title><p>READY</p>\n");
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["-C", repo, "config", "user.name", "Browser Test"]);
    execFileSync("git", ["-C", repo, "config", "user.email", "browser@invalid"]);
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "commit", "-qm", "fixture"]);
    process.env.PI_OVERDRIVE_RUNTIME_ROOT = options.stateRoot;
    process.env.PI_OVERDRIVE_WORKTREE_ROOT = options.shareRoot;
    for (const mode of ["close", "timeout", "chromium-crash"]) {
      const allocation = await createRuntimeWorktree(repo, options);
      allocations.push(allocation);
      const engine = new BrowserEngine({ cwd: allocation.worktree, ownerSession: `owner-${mode}` });
      engines.push(engine);
      const call = (tail, extra = {}) => ({ args: ["--session", allocation.browserSession, ...tail], ...extra });
      const opened = await engine.execute(call(["--profile", allocation.browserProfile, "open", `http://127.0.0.1:${allocation.port}/`], { sessionMode: "fresh" }), `owner-${mode}`);
      if (mode === "close") {
        const result = await engine.execute(call(["close"]), "owner-close");
        assert.equal(result.state, "CLOSED");
        await assert.rejects(engine.execute(call(["close"]), "owner-close"), /BROWSER_ENGINE_STATE_REJECTED/u);
      } else if (mode === "timeout") {
        await assert.rejects(engine.execute(call(["wait", "--text", "NEVER_APPEARS_4af8d7"], { timeoutMs: 100 }), "owner-timeout"), /BROWSER_ENGINE_RUNNER_FAILED|runner timeout/u);
        assert.equal(engine.state, "FAILED");
      } else {
        const hostPid = hostChromiumPid(opened.networkNamespace, opened.chromiumIdentity);
        process.kill(hostPid, "SIGKILL");
        await assert.rejects(engine.execute(call(["snapshot", "-i"]), "owner-chromium-crash"), /BROWSER_ENGINE_RUNNER_FAILED|BROWSER_ENGINE_CHROMIUM_IDENTITY_REJECTED/u);
        assert.equal(engine.state, "FAILED");
      }
      await new Promise((resolve) => { if (engine.child.exitCode !== null) resolve(); else engine.child.once("exit", resolve); });
      assert.equal(inspectProcessIdentity(opened.runnerIdentity).alive, false);
      assert.equal(fs.existsSync(path.join(allocation.stateDir, "browser-fixture.html")), false);
    }
  } finally {
    for (const engine of engines) await engine.terminate();
    for (const allocation of allocations) cleanupRuntimeResources(allocation.allocationId, options);
    if (previousRuntime === undefined) delete process.env.PI_OVERDRIVE_RUNTIME_ROOT; else process.env.PI_OVERDRIVE_RUNTIME_ROOT = previousRuntime;
    if (previousWorktree === undefined) delete process.env.PI_OVERDRIVE_WORKTREE_ROOT; else process.env.PI_OVERDRIVE_WORKTREE_ROOT = previousWorktree;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("missing fixture fails before Bubblewrap startup and a removed allocation cannot be reused", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-browser-partial-start-"));
  const repo = path.join(root, "repo");
  const options = { stateRoot: path.join(root, "runtime"), shareRoot: path.join(root, "worktrees") };
  const previousRuntime = process.env.PI_OVERDRIVE_RUNTIME_ROOT;
  const previousWorktree = process.env.PI_OVERDRIVE_WORKTREE_ROOT;
  let allocation;
  try {
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, "index.html"), "<!doctype html><title>Partial start</title>\n");
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["-C", repo, "config", "user.name", "Browser Test"]);
    execFileSync("git", ["-C", repo, "config", "user.email", "browser@invalid"]);
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "commit", "-qm", "fixture"]);
    allocation = await createRuntimeWorktree(repo, options);
    process.env.PI_OVERDRIVE_RUNTIME_ROOT = options.stateRoot;
    process.env.PI_OVERDRIVE_WORKTREE_ROOT = options.shareRoot;
    const engine = new BrowserEngine({ cwd: allocation.worktree, ownerSession: "partial-owner" });
    fs.unlinkSync(path.join(allocation.worktree, "index.html"));
    const open = { args: ["--session", allocation.browserSession, "--profile", allocation.browserProfile, "open", `http://127.0.0.1:${allocation.port}/`], sessionMode: "fresh" };
    await assert.rejects(engine.execute(open, "partial-owner"), /ENOENT/u);
    assert.equal(engine.state, "FAILED");
    assert.equal(engine.child, undefined);
    assert.equal(fs.existsSync(path.join(allocation.stateDir, "browser-fixture.html")), false);
    cleanupRuntimeResources(allocation.allocationId, options);
    await assert.rejects(engine.execute(open, "partial-owner"), /BROWSER_ENGINE_ALLOCATION_REJECTED/u);
    allocation = undefined;
    allocation = await createRuntimeWorktree(repo, options);
    const missingSandbox = new BrowserEngine({ cwd: allocation.worktree, ownerSession: "missing-bwrap-owner" });
    missingSandbox.spawnSandbox = () => spawn("/nonexistent/pi-browser-bwrap", [], { stdio: ["pipe", "pipe", "pipe"] });
    const secondOpen = { args: ["--session", allocation.browserSession, "--profile", allocation.browserProfile, "open", `http://127.0.0.1:${allocation.port}/`], sessionMode: "fresh" };
    await assert.rejects(missingSandbox.execute(secondOpen, "missing-bwrap-owner"), /ENOENT/u);
    assert.equal(missingSandbox.state, "FAILED");
    assert.equal(fs.existsSync(path.join(allocation.stateDir, "browser-fixture.html")), false);
  } finally {
    if (allocation) cleanupRuntimeResources(allocation.allocationId, options);
    if (previousRuntime === undefined) delete process.env.PI_OVERDRIVE_RUNTIME_ROOT; else process.env.PI_OVERDRIVE_RUNTIME_ROOT = previousRuntime;
    if (previousWorktree === undefined) delete process.env.PI_OVERDRIVE_WORKTREE_ROOT; else process.env.PI_OVERDRIVE_WORKTREE_ROOT = previousWorktree;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
