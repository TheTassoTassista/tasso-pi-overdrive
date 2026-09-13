#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSecondBrainConfig } from "../lib/memory-config.mjs";
import { ensurePrivateDirectory } from "../lib/memory-security.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateRoot = path.join(packageRoot, "vault-template", "SecondBrain");
const config = readSecondBrainConfig();

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

ensurePrivateDirectory(config.root);
installTree(templateRoot, config.vaultRoot);
process.stdout.write(`Second Brain storage ready.\nVault: ${config.vaultRoot}\nBackends remain lazy and optional; no service or model call was made.\n`);
