#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const sources = ['bin', 'branding', 'platform', 'bootstrap'].flatMap((directory) => fs.readdirSync(path.join(root, directory), { recursive: true }).filter((file) => file.endsWith('.mjs')).map((file) => path.join(root, directory, file)));
sources.push(...['phi-config', 'phi-runtime', 'phi-doctor', 'phi-backup', 'phi-ui', 'phi-validation-evidence', 'phi-clone-cleanup', 'phi-worker-authority'].map((name) => path.join(root, 'lib', `${name}.mjs`)));
sources.push(path.join(root, 'lib', 'phi-worker-draft.mjs'));
sources.push(path.join(root, 'scripts', 'build-windows-process.mjs'));
sources.push(path.join(root, 'scripts', 'phi-worker-pi-smoke.mjs'));
for (const file of sources) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit', shell: false });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const tests = fs.readdirSync(path.join(root, 'tests')).filter((file) => file.startsWith('phi-') && file.endsWith('.test.mjs')).sort().map((file) => path.join(root, 'tests', file));
if (!tests.length) throw new Error('Phi tests missing');
if (process.argv.slice(2).some(arg => arg !== '--owned-validation')) throw new Error('PHI_CHECK_USAGE');
const result = spawnSync(process.execPath, ['--test', ...(process.argv.includes('--owned-validation') ? ['--test-concurrency=1'] : []), ...tests], { cwd: root, stdio: 'inherit', shell: false });
process.exitCode = result.status ?? 1;
