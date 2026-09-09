#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-bootstrap-"));
const testHome = path.join(root, "home");
const agentDir = path.join(testHome, ".pi", "agent");
const stateDir = path.join(root, "state");
const configDir = path.join(root, "config");
const backupDir = path.join(root, "backups");
const results = [];
const check = (name, condition, detail) => results.push({ name, status: condition ? "PASS" : "FAIL", detail });

function run(args) {
  return spawnSync(path.join(packageRoot, "scripts", "bootstrap.sh"), args, {
    cwd: packageRoot,
    env: { ...process.env, HOME: testHome, PI_CODING_AGENT_DIR: agentDir, XDG_STATE_HOME: stateDir, XDG_CONFIG_HOME: configDir, PI_OVERDRIVE_BACKUP_ROOT: backupDir },
    encoding: "utf8",
    timeout: 20 * 60 * 1000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

try {
  fs.mkdirSync(testHome, { recursive: true, mode: 0o700 });
  const install = run(["--skip-browser"]);
  check("clean-home-bootstrap-exit", install.status === 0, `${install.stdout ?? ""}\n${install.stderr ?? ""}`.slice(-5000));
  const validate = install.status === 0 ? run(["--check-only", "--skip-browser"]) : { status: null, stdout: "", stderr: "install failed" };
  check("clean-home-check-only-exit", validate.status === 0, `${validate.stdout ?? ""}\n${validate.stderr ?? ""}`.slice(-5000));
  const settingsFile = path.join(agentDir, "settings.json");
  const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, "utf8")) : {};
  const packages = (settings.packages ?? []).map((entry) => typeof entry === "string" ? entry : entry.source);
  const expected = JSON.parse(fs.readFileSync(path.join(packageRoot, "config", "packages.json"), "utf8")).selected;
  check("bootstrap-exact-package-set", expected.every((source) => packages.includes(source)) && packages.includes(packageRoot), packages);
  const serialized = JSON.stringify(settings);
  const legacyTaskMarker = ["files", "pasted", "by", "the", "user"].join("-");
  const attachmentMarker = [".codex", "attachments"].join("/");
  check("bootstrap-no-dated-codex-reference", !serialized.includes(legacyTaskMarker) && !serialized.includes(attachmentMarker), packages);
  check("bootstrap-does-not-create-auth", !fs.existsSync(path.join(agentDir, "auth.json")), "authentication is external and untouched");
  const webConfigFile = path.join(configDir, "rpiv-web-tools", "config.json");
  const webConfig = fs.existsSync(webConfigFile) ? JSON.parse(fs.readFileSync(webConfigFile, "utf8")) : {};
  check("bootstrap-installs-secret-free-web-routing", webConfig.provider === "brave" && webConfig.overdriveRouting?.secondaryProvider === "perplexity" && !Object.hasOwn(webConfig, "apiKeys"), webConfig);
  const toolRoot = path.join(testHome, ".local", "share", "pi-overdrive", "lsp-node", "node_modules");
  const lspRoot = path.join(packageRoot, "runtime", "lsp", "node_modules");
  check("bootstrap-pinned-tools-present", fs.existsSync(path.join(toolRoot, "@ast-grep", "cli")) && ["typescript", "pyright", "@vtsls/language-server"].every((name) => fs.existsSync(path.join(lspRoot, name))), { toolRoot, lspRoot });
  const backups = fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [];
  check("bootstrap-created-private-backup", backups.length === 1 && (fs.statSync(path.join(backupDir, backups[0])).mode & 0o077) === 0, backups);
} catch (error) {
  check("bootstrap-runtime-harness", false, error instanceof Error ? error.message : String(error));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

const status = results.length >= 8 && results.every((item) => item.status === "PASS") ? "PASS" : "FAIL";
process.stdout.write(`${JSON.stringify({ status, packageRoot, results }, null, 2)}\n`);
process.exit(status === "PASS" ? 0 : 1);
