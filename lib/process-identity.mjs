import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { ownedWindowsHelper } from "../platform/windows/process.mjs";

const WINDOWS_GENERATION = /^[0-9a-f]{16}$/u;

function nativeWindowsQuery(pid) {
  const result = spawnSync(ownedWindowsHelper(), ["--process-identity", String(pid)], {
    shell: false, windowsHide: true, encoding: "utf8", timeout: 15000, maxBuffer: 8192,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") throw new Error("native process identity unavailable");
  const value = JSON.parse(result.stdout);
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(",") !== "alive,creationTime,pid,version" ||
      value.version !== 1 || value.pid !== pid || typeof value.alive !== "boolean" ||
      (value.alive ? !WINDOWS_GENERATION.test(value.creationTime ?? "") : value.creationTime !== null && !WINDOWS_GENERATION.test(value.creationTime ?? ""))) {
    throw new Error("native process identity malformed");
  }
  return value;
}

export function parseProcessIdentity(identity, platform = process.platform) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity) || !Number.isSafeInteger(identity.pid) || identity.pid <= 0) return null;
  if (identity.kind === "windows-process-creation" && identity.version === 1 && WINDOWS_GENERATION.test(identity.creationTime ?? "") && platform === "win32") {
    return { kind: "windows-process-creation", version: 1, pid: identity.pid, creationTime: identity.creationTime };
  }
  if ((identity.kind === "linux-proc" && identity.version === 1 || !Object.hasOwn(identity, "kind") && !Object.hasOwn(identity, "version")) &&
      platform === "linux" && typeof identity.bootId === "string" && identity.bootId.length > 0 && /^\d+$/u.test(identity.startTicks ?? "")) {
    return { kind: "linux-proc", version: 1, pid: identity.pid, bootId: identity.bootId, startTicks: identity.startTicks };
  }
  return null;
}

function readBootId(procRoot = "/proc") {
  return fs.readFileSync(`${procRoot}/sys/kernel/random/boot_id`, "utf8").trim();
}

function readStartTicks(pid, procRoot = "/proc") {
  const stat = fs.readFileSync(`${procRoot}/${pid}/stat`, "utf8");
  const close = stat.lastIndexOf(")");
  if (close < 0) throw new Error("malformed proc stat");
  const fields = stat.slice(close + 1).trim().split(/\s+/u);
  const startTicks = fields[19];
  if (!/^\d+$/u.test(startTicks ?? "")) throw new Error("proc start time is unavailable");
  return startTicks;
}

export function captureProcessIdentity(pid = process.pid, options = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid process id");
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const queried = (options.windowsQuery ?? nativeWindowsQuery)(pid);
    if (!queried?.alive || queried.pid !== pid || !WINDOWS_GENERATION.test(queried.creationTime ?? "")) throw new Error("native process generation unavailable");
    return { kind: "windows-process-creation", version: 1, pid, creationTime: queried.creationTime };
  }
  if (platform !== "linux") throw new Error("process identity platform unsupported");
  const procRoot = options.procRoot ?? "/proc";
  return {
    kind: "linux-proc", version: 1,
    pid,
    bootId: readBootId(procRoot),
    startTicks: readStartTicks(pid, procRoot),
  };
}

export function inspectProcessIdentity(identity, options = {}) {
  const platform = options.platform ?? process.platform;
  const parsed = parseProcessIdentity(identity, platform);
  if (!parsed) return { alive: null, reason: "invalid-or-unsupported-process-identity" };
  if (platform === "win32") {
    try {
      const queried = (options.windowsQuery ?? nativeWindowsQuery)(parsed.pid);
      if (queried.pid !== parsed.pid || typeof queried.alive !== "boolean" ||
          (queried.alive && !WINDOWS_GENERATION.test(queried.creationTime ?? "")) ||
          (queried.creationTime !== null && !WINDOWS_GENERATION.test(queried.creationTime ?? ""))) return { alive: null, reason: "process-identity-unreadable" };
      if (!queried.alive) return { alive: false, reason: "process-not-running" };
      if (queried.creationTime !== parsed.creationTime) return { alive: false, reason: "pid-reused" };
      return { alive: true, reason: "matching-live-process" };
    } catch { return { alive: null, reason: "process-identity-unreadable" }; }
  }
  const procRoot = options.procRoot ?? "/proc";
  try {
    if (readBootId(procRoot) !== parsed.bootId) return { alive: false, reason: "different-host-boot" };
    if (readStartTicks(parsed.pid, procRoot) !== parsed.startTicks) return { alive: false, reason: "pid-reused" };
    if (procRoot === "/proc") {
      try { process.kill(parsed.pid, 0); }
      catch (error) {
        if (error?.code !== "EPERM") return { alive: false, reason: "process-not-running" };
      }
    }
    return { alive: true, reason: "matching-live-process" };
  } catch (error) {
    return { alive: false, reason: error?.code === "ENOENT" ? "process-not-running" : "process-identity-unreadable" };
  }
}
