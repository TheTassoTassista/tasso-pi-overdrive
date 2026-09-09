#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseJsonlRecords } from "../lib/jsonl-audit.mjs";

const rootIndex = process.argv.indexOf("--root");
const root = path.resolve(rootIndex >= 0 ? process.argv[rootIndex + 1] : path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "pi-overdrive", "traces"));
const forbidden = new Set(["prompt", "args", "output", "url", "command", "content", "text"]);
const secret = /(?:-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:sk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{12,})/u;
const files = fs.existsSync(root) ? fs.readdirSync(root).filter((name) => name.endsWith(".jsonl")).map((name) => path.join(root, name)) : [];
let rows = 0;
let truncatedTails = 0;
let malformedRecords = 0;
let insecureFiles = 0;
let forbiddenFields = 0;
let secretLikeValues = 0;
for (const file of files) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) insecureFiles += 1;
  const parsed = parseJsonlRecords(fs.readFileSync(file, "utf8"));
  rows += parsed.records.length;
  truncatedTails += Number(parsed.truncatedTail);
  malformedRecords += parsed.errors.length;
  for (const row of parsed.records) {
    const serialized = JSON.stringify(row);
    if (secret.test(serialized)) secretLikeValues += 1;
    const pending = [row];
    while (pending.length > 0) {
      const value = pending.pop();
      if (!value || typeof value !== "object") continue;
      for (const [key, nested] of Object.entries(value)) {
        if (forbidden.has(key.toLowerCase())) forbiddenFields += 1;
        if (nested && typeof nested === "object") pending.push(nested);
      }
    }
  }
}
const status = malformedRecords === 0 && insecureFiles === 0 && forbiddenFields === 0 && secretLikeValues === 0 ? "PASS" : "FAIL";
process.stdout.write(`${JSON.stringify({ status, root, files: files.length, rows, truncatedTails, malformedRecords, insecureFiles, forbiddenFields, secretLikeValues }, null, 2)}\n`);
process.exit(status === "PASS" ? 0 : 1);
