#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSecondBrainConfig } from "../lib/memory-config.mjs";
import { ensurePrivateDirectory } from "../lib/memory-security.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateRoot = path.join(packageRoot, "vault-template", "SecondBrain");
const config = readSecondBrainConfig();

const checkOnly = process.argv.slice(2).length === 1 && process.argv[2] === '--check';
if (process.argv.slice(2).length && !checkOnly) {
  process.stderr.write('usage: setup-second-brain.mjs [--check]\n');
  process.exit(2);
}

function checkPrivateTree(source, destination) {
  const expected = fs.lstatSync(source);
  const actual = fs.lstatSync(destination);
  if (expected.isSymbolicLink() || actual.isSymbolicLink() || actual.uid !== process.getuid()) throw new Error('vault_identity_invalid');
  if (expected.isDirectory()) {
    if (!actual.isDirectory() || (actual.mode & 0o077) !== 0) throw new Error('vault_directory_unsafe');
    for (const entry of fs.readdirSync(source)) checkPrivateTree(path.join(source, entry), path.join(destination, entry));
  } else if (!expected.isFile() || !actual.isFile() || (actual.mode & 0o077) !== 0) throw new Error('vault_file_unsafe');
}

function installTree(source, destination) {
  const sourceStat = fs.lstatSync(source);
  if (sourceStat.isSymbolicLink()) throw new Error("vault_template_symlink_rejected");
  if (sourceStat.isDirectory()) {
    ensurePrivateDirectory(destination);
    for (const entry of fs.readdirSync(source)) installTree(path.join(source, entry), path.join(destination, entry));
    return;
  }
  if (!sourceStat.isFile()) throw new Error("vault_template_entry_invalid");
  if (fs.existsSync(destination)) {
    const destinationStat = fs.lstatSync(destination);
    if (!destinationStat.isFile() || destinationStat.isSymbolicLink()) throw new Error("vault_destination_unsafe");
    return;
  }
  const descriptor = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(descriptor, fs.readFileSync(source)); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

if (checkOnly) {
  if (fs.realpathSync(config.root) !== path.resolve(config.root) || fs.realpathSync(config.vaultRoot) !== path.resolve(config.vaultRoot)) throw new Error('vault_path_unsafe');
  const rootStat = fs.lstatSync(config.root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== process.getuid() || (rootStat.mode & 0o077) !== 0) throw new Error('vault_root_unsafe');
  checkPrivateTree(templateRoot, config.vaultRoot);
  process.stdout.write('Second Brain storage check: PASS (read-only).\n');
} else {
  ensurePrivateDirectory(config.root);
  installTree(templateRoot, config.vaultRoot);
  process.stdout.write(`Second Brain storage ready.\nVault: ${config.vaultRoot}\nBackends remain lazy and optional; no service or model call was made.\n`);
}
