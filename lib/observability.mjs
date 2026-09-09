import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isInside } from "./safety.mjs";

const SECRET = /(?:Bearer\s+\S+|(?:sk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{8,}|(?:password|token|api[_-]?key)\s*[:=]\s*\S+)/giu;
const FILE_PATTERN = /(?:\.log$|\.xml$|\.tap$|test-results?\.json$|junit.*\.xml$|browser-console.*\.txt$|network-failures.*\.txt$|ci.*\.log$)/iu;

function redact(text) {
  return text.replace(SECRET, "[REDACTED]");
}

export function collectProjectObservability(cwdCandidate) {
  const cwd = fs.realpathSync(cwdCandidate);
  const files = [];
  const pending = [cwd];
  while (pending.length > 0 && files.length < 100) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || [".git", "node_modules", "dist", "build"].includes(entry.name)) continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory() && path.relative(cwd, candidate).split(path.sep).length <= 4) pending.push(candidate);
      else if (entry.isFile() && FILE_PATTERN.test(entry.name) && isInside(cwd, candidate)) files.push(candidate);
    }
  }
  const sources = files.map((file) => {
    const buffer = fs.readFileSync(file).subarray(0, 256 * 1024);
    const text = redact(buffer.toString("utf8"));
    const lines = text.split("\n");
    const critical = lines.filter((line) => /\b(?:ERROR|FATAL|FAIL(?:ED|URE)?|panic|exception)\b/iu.test(line));
    const warnings = lines.filter((line) => /\bWARN(?:ING)?\b/iu.test(line));
    return {
      path: path.relative(cwd, file), bytesRead: buffer.length, lines: lines.length,
      criticalCount: critical.length, warningCount: warnings.length,
      criticalTail: critical.slice(-10).map((line) => line.slice(0, 500)),
      digest: createHash("sha256").update(buffer).digest("hex"),
    };
  });
  const gitHead = spawnSync("git", ["-C", cwd, "rev-parse", "--verify", "HEAD"], { encoding: "utf8" });
  const gitStatus = spawnSync("git", ["-C", cwd, "status", "--porcelain"], { encoding: "utf8" });
  return {
    collectedAt: new Date().toISOString(), cwd,
    git: { head: gitHead.status === 0 ? gitHead.stdout.trim() : null, changedPaths: gitStatus.status === 0 ? gitStatus.stdout.trim().split("\n").filter(Boolean).length : null },
    totals: { sources: sources.length, critical: sources.reduce((sum, source) => sum + source.criticalCount, 0), warnings: sources.reduce((sum, source) => sum + source.warningCount, 0), bytesRead: sources.reduce((sum, source) => sum + source.bytesRead, 0) },
    sources,
  };
}
