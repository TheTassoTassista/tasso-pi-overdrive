import fs from "node:fs";
import path from "node:path";
import { inspectWorkspacePath, isAlwaysProtectedWritePath } from "./safety.mjs";

export function createWorkspaceFile(cwd, candidate, content) {
  if (typeof content !== "string" || Buffer.byteLength(content) > 524288) throw new Error("CREATE_FILE_CONTENT_INVALID");
  if (isAlwaysProtectedWritePath(candidate)) throw new Error("CREATE_FILE_PROTECTED_PATH");
  const target = inspectWorkspacePath(cwd, candidate, { mustExist: false, forWrite: true });
  if (!target.allowed || target.exists || isAlwaysProtectedWritePath(target.canonical)) throw new Error("CREATE_FILE_TARGET_DENIED");
  const parent = path.dirname(target.lexical);
  const original = fs.lstatSync(parent);
  if (!original.isDirectory() || original.isSymbolicLink() || fs.realpathSync(parent) !== parent) throw new Error("CREATE_FILE_PARENT_DENIED");
  let fd;
  try {
    fd = fs.openSync(target.lexical, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    const current = fs.lstatSync(parent);
    if (current.dev !== original.dev || current.ino !== original.ino) throw new Error("CREATE_FILE_PARENT_CHANGED");
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    const stat = fs.fstatSync(fd);
    return { status: "CREATED", bytes: stat.size, mode: stat.mode & 0o777 };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
