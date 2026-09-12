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

async function openOwnedDirectory(candidate) {
  let handle;
  try {
    handle = await open(candidate, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | constants.O_NOFOLLOW);
    const descriptor = await handle.stat();
    const pathname = await lstat(candidate);
    if (!descriptor.isDirectory() || descriptor.uid !== process.getuid() || !pathname.isDirectory() || pathname.isSymbolicLink() || pathname.uid !== process.getuid() || pathname.dev !== descriptor.dev || pathname.ino !== descriptor.ino) {
      await handle.close();
      return undefined;
    }
    return { handle, descriptor, anchoredPath: `/proc/self/fd/${handle.fd}` };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (["ENOENT", "ELOOP", "ENOTDIR"].includes(error?.code)) return undefined;
    throw error;
  }
}

async function inspectCandidate(file) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const descriptor = await handle.stat();
    if (!descriptor.isFile() || descriptor.nlink !== 1 || descriptor.uid !== process.getuid()) {
      await handle.close();
      return undefined;
    }
    const pathname = await lstat(file);
    if (!pathname.isFile() || pathname.isSymbolicLink() || pathname.dev !== descriptor.dev || pathname.ino !== descriptor.ino || pathname.nlink !== 1 || pathname.uid !== process.getuid()) {
      await handle.close();
      return undefined;
    }
    return { handle, descriptor };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (["ENOENT", "ELOOP"].includes(error?.code)) return undefined;
    throw error;
  }
}

async function stillMatchesPath(file, descriptor) {
  try {
    const pathname = await lstat(file);
    return pathname.isFile() && !pathname.isSymbolicLink() && pathname.dev === descriptor.dev && pathname.ino === descriptor.ino && pathname.nlink === 1 && pathname.uid === process.getuid();
  } catch (error) {
    if (["ENOENT", "ELOOP"].includes(error?.code)) return false;
    throw error;
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
  const stateRoot = await openOwnedDirectory(stateHome);
  if (!stateRoot) return { ...summary, status: "SKIPPED_STATE_ROOT" };
  let overdriveRoot;
  try {
    overdriveRoot = await openOwnedDirectory(path.join(stateRoot.anchoredPath, "pi-overdrive"));
    if (!overdriveRoot) return { ...summary, status: "SKIPPED_OVERDRIVE_ROOT" };
    const cutoffMs = nowMs - retention.days * 24 * 60 * 60 * 1000;

    for (const definition of KNOWN_ROOTS) {
      const displayDirectory = path.join(stateHome, "pi-overdrive", definition.name);
      const directory = await openOwnedDirectory(path.join(overdriveRoot.anchoredPath, definition.name));
      if (!directory) {
        summary.skipped += 1;
        continue;
      }
      let stream;
      try {
        stream = await opendir(directory.anchoredPath);
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
          const file = path.join(directory.anchoredPath, entry.name);
          const inspected = await inspectCandidate(file);
          if (!inspected) {
            summary.skipped += 1;
            continue;
          }
          if (inspected.descriptor.mtimeMs >= cutoffMs) {
            await inspected.handle.close();
            summary.skipped += 1;
            continue;
          }
          try {
            if (!(await stillMatchesPath(file, inspected.descriptor))) {
              summary.skipped += 1;
              continue;
            }
            summary.eligible += 1;
            if (apply) {
              if (typeof options.beforeUnlink === "function") await options.beforeUnlink(path.join(displayDirectory, entry.name));
              await unlink(file);
              const after = await inspected.handle.stat();
              if (after.dev !== inspected.descriptor.dev || after.ino !== inspected.descriptor.ino || after.nlink !== 0) {
                throw new Error("trace file identity changed during retention unlink");
              }
              summary.removed += 1;
            }
          } finally {
            await inspected.handle.close();
          }
        }
      } finally {
        await stream?.close().catch((error) => {
          if (error?.code !== "ERR_DIR_CLOSED") throw error;
        });
        await directory.handle.close();
      }
      if (summary.capped) break;
    }
    return summary;
  } finally {
    await overdriveRoot?.handle.close().catch(() => undefined);
    await stateRoot.handle.close();
  }
}
