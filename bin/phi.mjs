#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PRODUCT, THEMES, renderSplash, themeName } from '../branding/terminal.mjs';
import { requireAutonomousBackend, localDirectories } from '../platform/index.mjs';
import { readLocalJson } from '../platform/shared/filesystem.mjs';
import { pinFreshSessionDefault } from '../lib/phi-initial-model.mjs';
import { launchEngine, runOwnedEngine } from '../platform/shared/process.mjs';
import { readPhiConfig, setPhiTheme } from '../lib/phi-config.mjs';
import { phiDoctor } from '../lib/phi-doctor.mjs';
import { discoverPiRuntime } from '../lib/phi-runtime.mjs';
import { runWindowsStartupRecovery } from '../platform/windows/startup-recovery.mjs';
import { entersInteractiveLinuxRepl, prepareOptionalServices, optionalStartupWarnings } from '../lib/phi-optional-startup.mjs';

async function main(args) {
  if (args[0] === '--version') { console.log(`Phi ${PRODUCT.version} (Pi ${PRODUCT.piVersion})`); return; }
  if (args[0] === '--help') { console.log('Phi — intelligent coding system\n\nphi [--theme NAME] [Pi arguments]\nphi doctor [--json]\nphi verify\nphi theme list|set NAME\nphi splash [--compact] [--theme NAME]\nphi backup\nphi restore BACKUP [--apply]\n\nLinux engine available; Windows engine fails closed pending native sandbox.'); return; }
  if (args[0] === 'backup' || args[0] === 'restore') {
    const { createPhiBackup, restorePhiBackup } = await import('../lib/phi-backup.mjs');
    if (args[0] === 'backup' && args.length === 1) console.log(JSON.stringify(createPhiBackup(), null, 2));
    else if (args[0] === 'restore' && args.length >= 2 && args.length <= 3 && (!args[2] || args[2] === '--apply')) console.log(JSON.stringify(restorePhiBackup(args[1], { apply: args[2] === '--apply' }), null, 2));
    else throw new Error('PHI_USAGE: phi backup | phi restore BACKUP --apply');
    return;
  }
  if (args[0] === 'verify' && args.length === 1) {
    process.exitCode = await runOwnedEngine(process.execPath, [fileURLToPath(new URL('../scripts/phi-check.mjs', import.meta.url))]);
    return;
  }
  if (args[0] === 'theme') {
    if (args[1] === 'list' && args.length === 2) { console.log(Object.keys(THEMES).join('\n')); return; }
    if (args[1] === 'set' && args.length === 3) { console.log(`Phi theme: ${setPhiTheme(args[2]).theme}`); return; }
    throw new Error('PHI_USAGE: phi theme list | phi theme set NAME');
  }
  if (args[0] === 'doctor') {
    if (args.slice(1).some((item) => item !== '--json')) throw new Error('PHI_USAGE: phi doctor [--json]');
    const report = await phiDoctor();
    console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : `Phi Doctor — ${report.status}\n${report.checks.map((row) => `${row.status.padEnd(13)} ${row.capability}: ${row.detail}`).join('\n')}`);
    process.exitCode = report.status === 'FAIL' ? 1 : 0;
    return;
  }
  let theme = readPhiConfig().theme;
  if (args[0] === '--theme') { theme = themeName(args[1]); args = args.slice(2); }
  if (args[0] === 'splash') {
    const rest = args.slice(1);
    const selected = rest.indexOf('--theme');
    if (selected >= 0) { theme = themeName(rest[selected + 1]); rest.splice(selected, 2); }
    if (rest.some((item) => item !== '--compact')) throw new Error('PHI_USAGE: phi splash [--compact] [--theme NAME]');
    process.stdout.write(renderSplash({ theme, compact: rest.includes('--compact') }));
    return;
  }
  if (process.platform === 'win32') {
    let recovery;
    try { recovery = runWindowsStartupRecovery({ cwd: process.cwd() }); }
    catch {
      process.stderr.write('PHI_STARTUP_RECOVERY {"version":1,"scope":"PHI_WINDOWS_STARTUP_RECOVERY_ONLY_NOT_PUBLICATION","status":"UNKNOWN_FAIL_SAFE","reason":"DISCOVERY_OR_RECOVERY_UNCONFIRMED","journalMutations":null,"projectMutations":null,"projectPublished":false,"externalRequests":0}\n');
      throw new Error('PHI_STARTUP_RECOVERY_UNCONFIRMED');
    }
    process.stderr.write(`PHI_STARTUP_RECOVERY ${JSON.stringify(recovery)}\n`);
    if (recovery.status === 'BLOCKED') throw new Error('PHI_STARTUP_RECOVERY_BLOCKED');
  }
  requireAutonomousBackend();
  const report = await phiDoctor({ probeServices: false });
  // Existing proven Linux engine and settings are reused, not rewritten. No
  // optional service/browser start and no paid call happens before Pi itself.
  for (const name of ['Pi runtime', 'Package configuration', 'Model default', 'Sandbox']) {
    if (!report.checks.some((row) => row.capability === name && row.status === 'PASS')) throw new Error(`PHI_STARTUP_BLOCKED: ${name}; run phi doctor`);
  }
  const runtime = discoverPiRuntime();
  if (process.platform === 'linux' && process.stdin.isTTY && process.stdout.isTTY) {
    try {
      const { parseArgs } = await import(pathToFileURL(path.join(runtime.root, 'dist', 'cli', 'args.js')).href);
      if (entersInteractiveLinuxRepl(args, parseArgs(args))) {
        const optional = prepareOptionalServices({ root: fileURLToPath(new URL('..', import.meta.url)) });
        for (const warning of optionalStartupWarnings(optional)) process.stderr.write(`${warning}\n`);
      }
    } catch {
      process.stderr.write('Phi optional startup: classification unavailable; services not started.\n');
    }
  }
  const selectedArgs = pinFreshSessionDefault(args, readLocalJson(path.join(localDirectories().agent, 'settings.json')));
  const piArgs = process.stdin.isTTY && process.stdout.isTTY && theme === 'midnight-violet' && !selectedArgs.some((arg) => ['--theme', '--use-theme', '--no-themes'].includes(arg))
    ? [runtime.entry, '--theme', fileURLToPath(new URL('../themes/midnight-violet.json', import.meta.url)), '--use-theme', 'midnight-violet', ...selectedArgs]
    : [runtime.entry, ...selectedArgs];
  await launchEngine(runtime.node, piArgs, { ...process.env, PI_SKIP_VERSION_CHECK: '1', PHI_LAUNCH: '1', PHI_THEME: theme });
}

main(process.argv.slice(2)).catch((error) => {
  const known = /^PHI_[A-Z_]+(?:: [A-Za-z0-9 ;:.,/_-]+)?$/u.test(error.message ?? '');
  process.stderr.write(`${known ? error.message : 'PHI_LOCAL_FAILURE: details suppressed; inspect local prerequisites safely'}\n`);
  process.exitCode = 1;
});
