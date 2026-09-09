import fs from "node:fs";
import path from "node:path";
import { inspectWorkspacePath } from "./safety.mjs";

const CONTROL = ".pi-overdrive-review-blocker.json";
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".py"]);
const DANGEROUS = [
  { pattern: /\beval\s*\(/u, title: "dynamic eval is present" },
  { pattern: /\bnew\s+Function\s*\(/u, title: "dynamic Function constructor is present" },
  { pattern: /\bshell\s*:\s*true\b/u, title: "child process enables shell parsing" },
];
const SKIP_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", "coverage", "test", "tests", "__tests__", "benchmarks", "fixtures"]);

export function localReviewPolicy(workspace) {
  const findings = [];
  const controlPath = path.join(workspace, CONTROL);
  if (fs.existsSync(controlPath)) {
    try {
      const control = JSON.parse(fs.readFileSync(controlPath, "utf8"));
      const inspected = inspectWorkspacePath(workspace, control.file, { mustExist: true });
      if (!inspected.allowed || typeof control.pattern !== "string" || !control.pattern || control.version !== 1) {
        findings.push({ severity: "BLOCKING", title: "invalid repository review blocker", evidence: CONTROL });
      } else {
        const text = fs.readFileSync(inspected.canonical, "utf8");
        if (text.includes(control.pattern)) findings.push({ severity: "BLOCKING", title: "repository review blocker reproduced", evidence: `${control.file}: required unsafe pattern '${control.pattern}' is still present; remove the defect and ${CONTROL}` });
      }
    } catch {
      findings.push({ severity: "BLOCKING", title: "unreadable repository review blocker", evidence: CONTROL });
    }
  }

  const pending = [fs.realpathSync(workspace)];
  let bytes = 0;
  while (pending.length > 0 && bytes <= 5 * 1024 * 1024) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || SKIP_DIRECTORIES.has(entry.name)) continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        const stat = fs.statSync(candidate);
        bytes += stat.size;
        if (stat.size > 1024 * 1024) continue;
        const lines = fs.readFileSync(candidate, "utf8").split("\n");
        for (let index = 0; index < lines.length; index += 1) {
          for (const rule of DANGEROUS) {
            if (rule.pattern.test(lines[index])) findings.push({ severity: "BLOCKING", title: rule.title, evidence: `${path.relative(workspace, candidate)}:${index + 1}` });
          }
        }
      }
    }
  }
  return { role: "local-security-policy", blocking: findings.length > 0, verdict: findings.length > 0 ? "BLOCKING" : "PASS", findings };
}
