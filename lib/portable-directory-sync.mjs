import fs from "node:fs";

// Node's POSIX directory fsync cannot be expressed through its Windows directory
// handle. File contents are still fsynced before namespace publication. This is
// process-crash ordering, not a power-loss durability certificate on Windows.
export function syncDirectory(directory, { platform = process.platform, filesystem = fs } = {}) {
  if (platform === "win32") return "UNSUPPORTED_ON_WINDOWS";
  let descriptor;
  try {
    descriptor = filesystem.openSync(directory, filesystem.constants.O_RDONLY | (filesystem.constants.O_DIRECTORY ?? 0));
    filesystem.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) filesystem.closeSync(descriptor);
  }
  return "SYNCED";
}
