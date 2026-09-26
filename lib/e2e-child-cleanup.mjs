import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Upstream --no-session children use private temporary roots outside our fixture.
// Delete only roots bound by BOTH an immutable role run ID and the fixture cwd.
export function cleanupE2EChildSessions(receipt, tempRoot = os.tmpdir()) {
  const ids = new Set((receipt.delegationAttempts ?? []).map(a => a.runId).filter(id => /^[0-9a-f-]{36}$/iu.test(id ?? "")));
  const cwd = receipt.allocation?.worktree;
  if (typeof cwd !== "string" || !path.isAbsolute(cwd) || cwd === path.parse(cwd).root) throw new Error("invalid E2E worktree identity");
  const root = fs.realpathSync(tempRoot);
  const removed = [];
  const unsafe = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!/^pi-subagent-session-[A-Za-z0-9]{6}$/u.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = path.join(root, entry.name);
    const children = fs.readdirSync(directory);
    if (!children.some(id => ids.has(id))) continue;
    const before = fs.lstatSync(directory);
    let valid = before.uid === process.getuid() && (before.mode & 0o077) === 0 && children.every(id => ids.has(id));
    for (const id of children) {
      if (!valid) break;
      const session = path.join(directory, id, "run-0", "session.jsonl");
      let fd;
      try {
        if (fs.realpathSync(session) !== session) throw new Error("symlinked session");
        fd = fs.openSync(session, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1) throw new Error("unsafe session");
        const buffer = Buffer.alloc(8192);
        const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
        const header = JSON.parse(buffer.subarray(0, count).toString("utf8").split("\n")[0]);
        valid = header.type === "session" && header.cwd === cwd;
      } catch { valid = false; }
      finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    const after = fs.lstatSync(directory);
    valid &&= before.ino === after.ino && before.dev === after.dev && fs.realpathSync(directory) === directory;
    if (!valid) { unsafe.push(entry.name); continue; }
    fs.rmSync(directory, { recursive: true });
    removed.push(entry.name);
  }
  return { status: unsafe.length === 0 ? "PASS" : "FAIL", removedDirectories: removed.length, unsafeDirectories: unsafe, removedRoots: removed };
}
