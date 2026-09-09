#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmSync, unlinkSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isInside } from "../lib/safety.mjs";

const args = process.argv.slice(2);
const backupArg = args.find((value) => !value.startsWith("--"));
const dryRun = args.includes("--check");
if (!backupArg || args.some((value) => value.startsWith("--") && value !== "--check")) {
  process.stderr.write("usage: restore-backup.mjs [--check] BACKUP_DIRECTORY\n");
  process.exit(2);
}

const backup = realpathSync(backupArg);
const agentDir = path.resolve(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"));
const configRoot = path.resolve(process.env.PI_CONFIG_DIR || path.join(os.homedir(), ".pi", "config"));
const targets = [
  ["pi-original/agent/settings.json", path.join(agentDir, "settings.json"), true],
  ["pi-original/agent/pi-fff.json", path.join(agentDir, "pi-fff.json"), false],
  ["pi-original/agent/lsp.json", path.join(agentDir, "lsp.json"), false],
  ["pi-original/agent/extensions/subagent/config.json", path.join(agentDir, "extensions", "subagent", "config.json"), false],
  ["pi-original/agent/observability/settings", path.join(agentDir, "observability", "settings"), false],
  ["pi-original/agent/tasso-pi-overdrive-install.json", path.join(agentDir, "tasso-pi-overdrive-install.json"), false],
  ["pi-original/config/pi-agent-browser-native/config.json", path.join(configRoot, "pi-agent-browser-native", "config.json"), false],
];

for (const [relative, , required] of targets) {
  const source = path.join(backup, relative);
  if (existsSync(source)) {
    const stat = lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`backup entry is not a regular file: ${relative}`);
    if (!isInside(backup, realpathSync(source))) throw new Error(`backup entry escapes backup root: ${relative}`);
  } else if (required) {
    throw new Error(`backup is not a pre-Overdrive configuration backup: missing ${relative}`);
  }
}

if (dryRun) {
  process.stdout.write(`Backup validation: PASS (${backup})\n`);
  process.exit(0);
}

mkdirSync(agentDir, { recursive: true, mode: 0o700 });
mkdirSync(configRoot, { recursive: true, mode: 0o700 });
const allowedRoots = [realpathSync(agentDir), realpathSync(configRoot)];

function copyRegularAtomic(source, destination) {
  const before = lstatSync(source);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`restore source changed type: ${source}`);
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const parent = realpathSync(path.dirname(destination));
  if (!allowedRoots.some((root) => isInside(root, parent))) throw new Error(`restore destination parent escaped configured roots: ${destination}`);
  const temporary = path.join(parent, `.${path.basename(destination)}.${process.pid}.${randomBytes(6).toString("hex")}.restore.tmp`);
  let input;
  let output;
  try {
    input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(input);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error(`restore source changed during validation: ${source}`);
    output = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, before.mode & 0o777 || 0o600);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const bytes = readSync(input, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      let offset = 0;
      while (offset < bytes) offset += writeSync(output, buffer, offset, bytes - offset);
    }
    fsyncSync(output);
    closeSync(input);
    input = undefined;
    closeSync(output);
    output = undefined;
    chmodSync(temporary, before.mode & 0o777 || 0o600);
    renameSync(temporary, destination);
    const directory = openSync(parent, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch (error) {
    if (input !== undefined) try { closeSync(input); } catch {}
    if (output !== undefined) try { closeSync(output); } catch {}
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}

const restored = [];
const removed = [];
for (const [relative, destination] of targets) {
  const source = path.join(backup, relative);
  if (!existsSync(source)) {
    if (existsSync(destination) || (() => { try { return lstatSync(destination).isSymbolicLink(); } catch { return false; } })()) {
      rmSync(destination, { force: true });
      removed.push(destination);
    }
    continue;
  }
  copyRegularAtomic(source, destination);
  restored.push(destination);
}
process.stdout.write(`${JSON.stringify({ status: "PASS", backup, restored, removed }, null, 2)}\n`);
