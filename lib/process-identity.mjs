import fs from "node:fs";

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
  const procRoot = options.procRoot ?? "/proc";
  return {
    pid,
    bootId: readBootId(procRoot),
    startTicks: readStartTicks(pid, procRoot),
  };
}

export function inspectProcessIdentity(identity, options = {}) {
  if (!identity || !Number.isSafeInteger(identity.pid) || identity.pid <= 0 || typeof identity.bootId !== "string" || !/^\d+$/u.test(identity.startTicks ?? "")) {
    return { alive: false, reason: "invalid-process-identity" };
  }
  const procRoot = options.procRoot ?? "/proc";
  try {
    if (readBootId(procRoot) !== identity.bootId) return { alive: false, reason: "different-host-boot" };
    if (readStartTicks(identity.pid, procRoot) !== identity.startTicks) return { alive: false, reason: "pid-reused" };
    if (procRoot === "/proc") {
      try { process.kill(identity.pid, 0); }
      catch (error) {
        if (error?.code !== "EPERM") return { alive: false, reason: "process-not-running" };
      }
    }
    return { alive: true, reason: "matching-live-process" };
  } catch (error) {
    return { alive: false, reason: error?.code === "ENOENT" ? "process-not-running" : "process-identity-unreadable" };
  }
}
