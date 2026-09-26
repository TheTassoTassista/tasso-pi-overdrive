#!/usr/bin/env node
// Native focused ordering proof only; never a replacement for check:phi.
import { spawnSync } from 'node:child_process';
import { validationFailureEvidence } from '../lib/phi-validation-evidence.mjs';
if (process.platform !== 'win32') throw new Error('PHI_NATIVE_WINDOWS_REQUIRED');
const patterns = ['^native recovery pending-directory-control:', '^native recovery pending-directory-release:', '^native LPAC worker timeout failure with nested tree:', ...['clean', 'pid-reuse', 'corrupt', 'unknown-field', 'oversized', 'open-sharing-control', 'delete-pending-control', 'sharing-release', 'pending-release', 'sharing-cascade'].map((name) => `^native recovery ${name}:`)];
const runs = [...patterns.map((pattern) => ({ mode: 'INDIVIDUAL', pattern, required: 1 })), { mode: 'SEQUENTIAL', pattern: patterns.join('|'), required: patterns.length }];
let failed = false;
for (const { mode, pattern, required } of runs) {
  const result = spawnSync(process.execPath, ['--test', `--test-name-pattern=${pattern}`, 'tests/phi-windows-confinement.test.mjs'], { cwd: new URL('..', import.meta.url), shell: false, windowsHide: true, encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024 });
  const evidence = validationFailureEvidence('foundation-tests', result);
  const passed = result.status === 0 && evidence.testCounts.passed === required && evidence.testCounts.failed === 0;
  console.log(JSON.stringify({ mode, pattern, required, status: passed ? 'PASS' : 'FAIL', ...evidence }));
  failed ||= !passed;
}
process.exitCode = failed ? 1 : 0;
