#!/usr/bin/env node
import { PRODUCT, THEMES, renderSplash, terminalCapabilities, themeName } from '../branding/terminal.mjs';
import { requireAutonomousBackend } from '../platform/index.mjs';
import { runOwnedEngine } from '../platform/shared/process.mjs';
import { readPhiConfig, setPhiTheme } from '../lib/phi-config.mjs';
import { phiDoctor, doctorStartupState } from '../lib/phi-doctor.mjs';
import { discoverPiRuntime } from '../lib/phi-runtime.mjs';

async function main(args) {
  if (args[0] === '--version') { console.log(`Phi ${PRODUCT.version} (Pi ${PRODUCT.piVersion})`); return; }
  if (args[0] === '--help') { console.log('Phi — intelligent coding system\n\nphi [--theme NAME] [Pi arguments]\nphi doctor [--json]\nphi theme list|set NAME\nphi splash [--compact] [--theme NAME]\n\nLinux engine available; Windows engine fails closed pending native sandbox.'); return; }
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
  requireAutonomousBackend();
  const report = await phiDoctor({ probeServices: false });
  // Existing proven Linux engine and settings are reused, not rewritten. No
  // optional service/browser start and no paid call happens before Pi itself.
  for (const name of ['Pi runtime', 'Package configuration', 'GPT default', 'Sandbox']) {
    if (!report.checks.some((row) => row.capability === name && row.status === 'PASS')) throw new Error(`PHI_STARTUP_BLOCKED: ${name}; run phi doctor`);
  }
  const protocol = args.includes('--mode') || args.includes('--print') || args.includes('-p') || args.includes('--list-models') || args.includes('--list-tools');
  if (process.stdout.isTTY && !protocol) process.stdout.write(renderSplash({ theme, state: doctorStartupState(report) }));
  const runtime = discoverPiRuntime();
  process.exitCode = await runOwnedEngine(runtime.node, [runtime.entry, ...args]);
}

main(process.argv.slice(2)).catch((error) => {
  const known = /^PHI_[A-Z_]+(?:: [A-Za-z0-9 ;:.,/_-]+)?$/u.test(error.message ?? '');
  process.stderr.write(`${known ? error.message : 'PHI_LOCAL_FAILURE: details suppressed; inspect local prerequisites safely'}\n`);
  process.exitCode = 1;
});
