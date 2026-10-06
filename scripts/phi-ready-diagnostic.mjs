#!/usr/bin/env node
// Bounded native Windows test-209 diagnosis; never a clone or certification gate.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const mode = process.env.PHI_READY_DIAGNOSTIC_MODE;
if (!['isolated', 'ordered-prefix'].includes(mode) || process.platform !== 'win32')
  throw new Error('PHI_READY_DIAGNOSTIC_MODE_INVALID');
const root = path.resolve(import.meta.dirname, '..');
const target = 'phi-mixed-journal.test.mjs';
const all = fs.readdirSync(path.join(root, 'tests')).filter(file => file.startsWith('phi-') && file.endsWith('.test.mjs')).sort();
const index = all.indexOf(target);
if (index < 0) throw new Error('PHI_READY_DIAGNOSTIC_TARGET_MISSING');
const tests = mode === 'isolated' ? [target] : all.slice(0, index + 1);
const args = ['--test', '--test-concurrency=1',
  ...(mode === 'isolated' ? ['--test-name-pattern=^V5 publisher death gives bounded ordinary Phi startup disposition: corrupt-journal$'] : []),
  ...tests.map(file => path.join(root, 'tests', file))];
console.log(JSON.stringify({ control: 'PHI_TEST209_NON_CERTIFYING_DIAGNOSTIC', mode,
  testFiles: tests.length, clone: false, piSmoke: false, ordinaryCreate: false }));
const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', shell: false });
process.exitCode = result.status ?? 1;
