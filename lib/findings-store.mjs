import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const FINDING_CATEGORIES = Object.freeze(["missing_documentation", "missing_tool", "missing_test", "missing_skill", "missing_observability", "missing_guardrail", "missing_reference", "ambiguous_spec", "context_pollution", "wrong_model_tier", "workflow_failure"]);
const SECRET = /(?:Bearer\s+\S+|(?:sk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{8,}|(?:password|token|api[_-]?key)\s*[:=]\s*\S+)/giu;

function clean(text, max) { return String(text).replace(SECRET, "[REDACTED]").slice(0, max); }

export function appendFinding(input, options = {}) {
  if (!FINDING_CATEGORIES.includes(input.category)) throw new Error("unsupported finding category");
  if (!String(input.summary ?? "").trim()) throw new Error("finding summary is required");
  const root = path.resolve(options.root ?? process.env.PI_OVERDRIVE_FINDINGS_ROOT ?? path.join(os.homedir(), ".local", "state", "pi-overdrive", "findings"));
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  const file = path.join(root, "findings.jsonl");
  const record = {
    version: 1, recordedAt: new Date().toISOString(), category: input.category,
    summary: clean(input.summary, 1000), source: clean(input.source ?? "manual", 100),
    evidenceDigest: input.evidence ? createHash("sha256").update(String(input.evidence)).digest("hex") : null,
  };
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
  if (lines.length > 500) {
    const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(temp, `${lines.slice(-500).join("\n")}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, file);
  }
  return record;
}
