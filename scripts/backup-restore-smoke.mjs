#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const restoreScript = path.join(packageRoot, "scripts", "restore-backup.mjs");
const originalBackup = process.env.PI_OVERDRIVE_ORIGINAL_BACKUP || path.join(os.homedir(), "Documents", "Codex", "pi-overdrive-backups", "20260907-140520");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-restore-"));
const agent = path.join(root, "agent");
const config = path.join(root, "config");
const results = [];
const check = (name, condition, detail) => results.push({ name, status: condition ? "PASS" : "FAIL", detail });
const sha = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

try {
  execFileSync(process.execPath, [restoreScript, "--check", originalBackup], { encoding: "utf8" });
  fs.mkdirSync(path.join(agent, "extensions", "subagent"), { recursive: true });
  fs.mkdirSync(path.join(agent, "observability"), { recursive: true });
  fs.mkdirSync(path.join(config, "pi-agent-browser-native"), { recursive: true });
  const overdriveFiles = [
    path.join(agent, "pi-fff.json"),
    path.join(agent, "lsp.json"),
    path.join(agent, "extensions", "subagent", "config.json"),
    path.join(agent, "observability", "settings"),
    path.join(agent, "tasso-pi-overdrive-install.json"),
    path.join(config, "pi-agent-browser-native", "config.json"),
  ];
  fs.writeFileSync(path.join(agent, "settings.json"), "{\"overdrive\":true}\n");
  overdriveFiles.forEach((file) => fs.writeFileSync(file, "overdrive\n"));
  const env = { ...process.env, PI_CODING_AGENT_DIR: agent, PI_CONFIG_DIR: config };
  execFileSync(process.execPath, [restoreScript, originalBackup], { env, encoding: "utf8" });
  const backedSettings = path.join(originalBackup, "pi-original", "agent", "settings.json");
  check("pre-overdrive-settings-restored-byte-for-byte", sha(path.join(agent, "settings.json")) === sha(backedSettings), sha(path.join(agent, "settings.json")));
  check("overdrive-only-config-removed", overdriveFiles.every((file) => !fs.existsSync(file)), overdriveFiles.filter((file) => fs.existsSync(file)));
  check("restore-target-confined-to-fixture", fs.existsSync(path.join(agent, "settings.json")) && agent.startsWith(root), root);
} catch (error) {
  check("backup-restore-harness", false, error instanceof Error ? error.message : String(error));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

const status = results.length >= 3 && results.every((item) => item.status === "PASS") ? "PASS" : "FAIL";
process.stdout.write(`${JSON.stringify({ status, backup: originalBackup, results }, null, 2)}\n`);
process.exit(status === "PASS" ? 0 : 1);
