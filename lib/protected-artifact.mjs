import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ownedWindowsHelper } from "../platform/windows/process.mjs";

function nativeProtectedArtifact(operation, target) {
  const result = spawnSync(ownedWindowsHelper(), ["--protected-artifact"], {
    shell: false, windowsHide: true, encoding: "utf8", timeout: 15000, maxBuffer: 8192,
    input: JSON.stringify({ operation, path: path.resolve(target) }),
  });
  if (result.status === 0 && result.stdout?.trim() === "PROTECTED_ARTIFACT_PASS") return;
  if (operation.startsWith("create-exclusive-") && result.status === 71 && fs.existsSync(target)) {
    const error = new Error("protected artifact already exists"); error.code = "EEXIST"; throw error;
  }
  throw new Error("protected artifact security could not be verified");
}

export function ensureProtectedDirectory(directory, { exclusive = false } = {}) {
  if (process.platform === "win32") {
    nativeProtectedArtifact(exclusive ? "create-exclusive-directory" : "ensure-directory", directory);
    return;
  }
  fs.mkdirSync(directory, { recursive: !exclusive, mode: 0o700 });
  if (!exclusive) fs.chmodSync(directory, 0o700);
}

export function createProtectedFile(file) {
  if (process.platform !== "win32") throw new Error("native protected file creation is Windows-only");
  nativeProtectedArtifact("create-exclusive-file", file);
}

export function assertProtectedArtifact(target, kind, message) {
  if (kind !== "file" && kind !== "directory") throw new Error("invalid protected artifact kind");
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || (kind === "file" ? !stat.isFile() : !stat.isDirectory())) throw new Error(message);
  if (process.platform === "win32") nativeProtectedArtifact(`validate-${kind}`, target);
  else if ((stat.mode & 0o077) !== 0) throw new Error(message);
  return stat;
}
