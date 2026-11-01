#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { localDirectories, platformAdapter } from '../platform/index.mjs';
import { inspectLocalPath, readLocalJson, writeLocalText, writeLocalJson } from '../platform/shared/filesystem.mjs';
import { readPhiConfig } from '../lib/phi-config.mjs';
import { phiDoctor } from '../lib/phi-doctor.mjs';
import { PRODUCT } from '../branding/terminal.mjs';

const source = path.resolve(import.meta.dirname, '..');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

export function wrapperContent(platform, node, entry) {
  if ([node, entry].some((value) => /[\x00-\x1f]/u.test(value))) throw new Error('PHI_WRAPPER_PATH_INVALID');
  if (platform === 'linux') return `#!/bin/sh\n# Phi managed launcher v1\nexec ${quote(node)} ${quote(entry)} "$@"\n`;
  if (platform === 'win32') {
    if ([node, entry].some((value) => /[%!"^&|<>]/u.test(value))) throw new Error('PHI_WRAPPER_PATH_INVALID');
    return `@echo off\r\nrem Phi managed launcher v1\r\n"${node}" "${entry}" %*\r\nexit /b %errorlevel%\r\n`;
  }
  throw new Error('PHI_PLATFORM_UNSUPPORTED');
}

// Keep the launcher bound to one managed selector, never a mutable checkout path.
// The installer verifies the release and receipt before this content is installed.
export function versionedWrapperContent(platform, node, prefix) {
  if (!path.isAbsolute(prefix) || fs.realpathSync(prefix) !== prefix) throw new Error('PHI_VERSIONED_PREFIX_UNTRUSTED');
  const active = path.join(prefix, 'active');
  const info = fs.lstatSync(active);
  if (!info.isSymbolicLink() || !/^releases\/[0-9a-f]{40}$/u.test(fs.readlinkSync(active))) {
    throw new Error('PHI_VERSIONED_REFERENCE_UNTRUSTED');
  }
  return wrapperContent(platform, node, path.join(active, 'bin', 'phi.mjs'));
}

export async function bootstrapFoundation({ plan = false, root = source, dirs = localDirectories(), env = process.env } = {}) {
  const adapter = platformAdapter();
  const target = path.join(dirs.bin, adapter.id === 'win32' ? 'phi.cmd' : 'phi');
  const entry = path.join(fs.realpathSync(root), 'bin', 'phi.mjs');
  const content = wrapperContent(adapter.id, process.execPath, entry);
  const manifestFile = path.join(dirs.config, 'launcher.json');
  if (plan) return { version: 1, status: 'PLAN', platform: adapter.id, source: fs.realpathSync(root), phiVersion: PRODUCT.version, piVersion: PRODUCT.piVersion, launcher: target, writes: 0, modelCalls: 0, engineReady: adapter.sandbox.autonomousReady, scope: 'foundation only; full portable engine installation is not yet implemented' };
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || major === 22 && minor < 19) throw new Error('PHI_NODE_UNSUPPORTED');
  // Preflight EVERY managed target before the first write. Never clobber an
  // unrelated phi command and never alter the legacy pi command or auth.
  const manifest = readLocalJson(manifestFile, null);
  const present = inspectLocalPath(target).exists;
  if (present) {
    const current = fs.readFileSync(target, 'utf8');
    if (current !== content && (!manifest || manifest.version !== 1 || manifest.target !== target || manifest.sha256 !== hash(current))) throw new Error('PHI_LAUNCHER_CONFLICT');
  }
  const preferences = readPhiConfig(dirs);
  for (const directory of [dirs.bin, dirs.config, dirs.state]) inspectLocalPath(directory, { directory: true });
  for (const directory of [dirs.bin, dirs.config, dirs.state]) {
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    inspectLocalPath(directory, { directory: true });
  }
  if (adapter.id === 'linux' && (fs.lstatSync(dirs.config).mode & 0o077) !== 0) throw new Error('PHI_CONFIG_PERMISSIONS_DENIED');
  if (!present || fs.readFileSync(target, 'utf8') !== content) writeLocalText(target, content, 0o700);
  if (!fs.existsSync(path.join(dirs.config, 'preferences.json'))) writeLocalJson(path.join(dirs.config, 'preferences.json'), preferences);
  writeLocalJson(manifestFile, { version: 1, product: PRODUCT.name, source: fs.realpathSync(root), target, node: process.execPath, sha256: hash(content) });
  const report = await phiDoctor({ source: root, dirs, env, probeServices: false });
  return { version: 1, status: 'FOUNDATION_INSTALLED', platform: adapter.id, launcher: target, source: fs.realpathSync(root), modelCalls: 0, doctorStatus: report.status, engineReady: adapter.sandbox.autonomousReady && !report.checks.some((row) => ['Pi runtime', 'Package configuration', 'Model default', 'Sandbox'].includes(row.capability) && row.status === 'FAIL'), notes: ['Existing pi command, auth, routing and memory state untouched', 'Put the user-local launcher directory on PATH if necessary', 'No Pi runtime, package or optional service installed by foundation mode'] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((arg) => !['--plan', '--foundation'].includes(arg)) || !args.length) { console.error('usage: node bootstrap/core.mjs --plan | --foundation'); process.exitCode = 2; }
  else bootstrapFoundation({ plan: args.includes('--plan') }).then((report) => console.log(JSON.stringify(report, null, 2))).catch(() => { console.error('Phi bootstrap FAILED: unsafe/conflicting local target or missing prerequisite; no credentials inspected'); process.exitCode = 1; });
}
