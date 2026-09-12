import fs from "node:fs";
import { constants } from "node:fs";
import { lstat, open, opendir, unlink } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_TRACE_RETENTION_DAYS = 30;
export const MAX_RETENTION_ENTRIES = 4096;

const KNOWN_ROOTS = Object.freeze([
  { name: "traces", accepts: (name) => name.endsWith(".jsonl") },
  { name: "mcp-traces", accepts: (name) => name.endsWith(".jsonl") },
  { name: "launcher", accepts: (name) => /^omniroute-\d{8}\.log$/u.test(name) },
]);

export function resolveRetentionDays(value) {
  if (value === undefined || value === null || value === "") {
    return { valid: true, days: DEFAULT_TRACE_RETENTION_DAYS, source: "default" };
  }
  if (!/^[0-9]+$/u.test(String(value))) return { valid: false, days: null, source: "invalid" };
  const days = Number(value);
  if (!Number.isSafeInteger(days) || days < 1 || days > 3650) return { valid: false, days: null, source: "invalid" };
  return { valid: true, days, source: "configured" };
}

async function realOwnedDirectory(candidate) {
  try {
    const metadata = await lstat(candidate);
    return metadata.isDirectory() && !metadata.isSymbolicLink() && metadata.uid === process.getuid();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function inspectCandidate(file) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const descriptor = await handle.stat();
    if (!descriptor.isFile() || descriptor.nlink !== 1 || descriptor.uid !== process.getuid()) return undefined;
    const pathname = await lstat(file);
    if (!pathname.isFile() || pathname.isSymbolicLink()) return undefined;
    if (pathname.dev !== descriptor.dev || pathname.ino !== descriptor.ino || pathname.nlink !== 1 || pathname.uid !== process.getuid()) return undefined;
    return descriptor;
  } catch (error) {
    if (["ENOENT", "ELOOP"].includes(error?.code)) return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function pruneKnownTraceLogs(options = {}) {
  const stateHome = path.resolve(options.stateHome ?? process.env.XDG_STATE_HOME ?? path.join(process.env.HOME ?? "", ".local", "state"));
  const retention = resolveRetentionDays(options.days);
  const apply = options.apply !== false;
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const maxEntries = Number.isSafeInteger(options.maxEntries) && options.maxEntries > 0
    ? Math.min(options.maxEntries, MAX_RETENTION_ENTRIES)
    : MAX_RETENTION_ENTRIES;
  const summary = { status: "PASS", days: retention.days, apply, scanned: 0, eligible: 0, removed: 0, skipped: 0, capped: false };
  if (!retention.valid) return { ...summary, status: "SKIPPED_INVALID_CONFIG" };
  if (!(await realOwnedDirectory(stateHome))) return { ...summary, status: "SKIPPED_STATE_ROOT" };

  const overdriveRoot = path.join(stateHome, "pi-overdrive");
  if (!(await realOwnedDirectory(overdriveRoot))) return { ...summary, status: "SKIPPED_OVERDRIVE_ROOT" };
  const cutoffMs = nowMs - retention.days * 24 * 60 * 60 * 1000;

  for (const definition of KNOWN_ROOTS) {
    const directory = path.join(overdriveRoot, definition.name);
    if (!(await realOwnedDirectory(directory))) {
      summary.skipped += 1;
      continue;
    }
    const stream = await opendir(directory);
    try {
      for await (const entry of stream) {
        if (summary.scanned >= maxEntries) {
          summary.capped = true;
          break;
        }
        summary.scanned += 1;
        if (!entry.isFile() || !definition.accepts(entry.name)) {
          summary.skipped += 1;
          continue;
        }
        const file = path.join(directory, entry.name);
        const metadata = await inspectCandidate(file);
        if (!metadata || metadata.mtimeMs >= cutoffMs) {
          summary.skipped += 1;
          continue;
        }
        summary.eligible += 1;
        if (apply) {
          await unlink(file);
          summary.removed += 1;
        }
      }
    } finally {
      await stream.close().catch((error) => {
        if (error?.code !== "ERR_DIR_CLOSED") throw error;
      });
    }
    if (summary.capped) break;
  }
  return summary;
}
