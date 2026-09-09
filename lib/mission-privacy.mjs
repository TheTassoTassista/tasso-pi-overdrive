import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isInside } from "./safety.mjs";

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);
const SECRET_TEXT = /(?:-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:sk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{8,}|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password)\s*[:=]\s*[^\s,;]+)/giu;
const SECRET_KEYS = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret|token)$/iu;

function jsonFiles(root) {
  const result = [];
  if (!fs.existsSync(root)) return result;
  const pending = [fs.realpathSync(root)];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && entry.name.endsWith(".json") && isInside(root, candidate)) result.push(candidate);
    }
  }
  return result;
}

export function redactMissionValue(value, key = "") {
  if (SECRET_KEYS.test(key)) return "[REDACTED]";
  if (typeof value === "string") return value.replace(SECRET_TEXT, "[REDACTED]");
  if (Array.isArray(value)) return value.map((item) => redactMissionValue(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([nestedKey, item]) => [nestedKey, redactMissionValue(item, nestedKey)]));
  return value;
}

function writePrivate(file, value) {
  const temp = `${file}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
  } catch (error) {
    if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {}
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}

export function auditMissionStore(root) {
  const files = jsonFiles(root);
  let terminal = 0;
  let nonTerminal = 0;
  let insecureFiles = 0;
  let secretLikeValues = 0;
  for (const file of files) {
    const stat = fs.lstatSync(file);
    if ((stat.mode & 0o077) !== 0) insecureFiles += 1;
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      if (TERMINAL.has(value.status)) terminal += 1;
      else nonTerminal += 1;
      const before = JSON.stringify(value);
      if (JSON.stringify(redactMissionValue(value)) !== before) secretLikeValues += 1;
    } catch { nonTerminal += 1; }
  }
  return { files: files.length, terminal, nonTerminal, insecureFiles, secretLikeValues };
}

export function maintainMissionStore(root, options = {}) {
  const canonicalRoot = fs.realpathSync(root);
  const retainTerminal = options.retainTerminal ?? 25;
  const redact = options.redact !== false;
  const terminal = [];
  let redactedFiles = 0;
  for (const file of jsonFiles(canonicalRoot)) {
    const stat = fs.lstatSync(file);
    fs.chmodSync(file, 0o600);
    let value;
    try { value = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
    if (TERMINAL.has(value.status)) {
      const parsedUpdated = Date.parse(value.updatedAt ?? value.createdAt ?? "");
      terminal.push({ file, updated: Number.isNaN(parsedUpdated) ? stat.mtimeMs : parsedUpdated });
    }
    if (redact) {
      const cleaned = redactMissionValue(value);
      if (JSON.stringify(cleaned) !== JSON.stringify(value)) {
        writePrivate(file, cleaned);
        redactedFiles += 1;
      }
    }
  }
  terminal.sort((left, right) => right.updated - left.updated);
  let pruned = 0;
  for (const entry of terminal.slice(retainTerminal)) {
    if (!isInside(canonicalRoot, entry.file)) throw new Error("retention target escaped mission root");
    fs.unlinkSync(entry.file);
    pruned += 1;
  }
  return { redactedFiles, pruned, retainedTerminal: Math.min(terminal.length, retainTerminal) };
}
