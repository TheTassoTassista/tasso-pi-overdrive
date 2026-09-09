#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { auditMissionStore, maintainMissionStore } from "../lib/mission-privacy.mjs";

const apply = process.argv.includes("--apply");
const rootIndex = process.argv.indexOf("--root");
const retainIndex = process.argv.indexOf("--retain");
const root = path.resolve(rootIndex >= 0 ? process.argv[rootIndex + 1] : path.join(os.homedir(), ".pi", "agent", "missions"));
const retainTerminal = retainIndex >= 0 ? Number.parseInt(process.argv[retainIndex + 1], 10) : 25;
if (!Number.isInteger(retainTerminal) || retainTerminal < 1) {
  process.stderr.write("--retain must be a positive integer\n");
  process.exit(2);
}
const before = auditMissionStore(root);
if (!apply) {
  process.stdout.write(`${JSON.stringify({ mode: "audit-only", root, policy: { retainTerminal, redactDetectedSecrets: true, ownerOnly: true }, before })}\n`);
} else {
  const changes = maintainMissionStore(root, { retainTerminal, redact: true });
  const after = auditMissionStore(root);
  process.stdout.write(`${JSON.stringify({ mode: "applied", root, before, changes, after })}\n`);
}
