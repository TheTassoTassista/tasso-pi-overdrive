#!/usr/bin/env node
// Certification-only completeness check for the existing serial Phi suite.
// On Windows the native Job is the same owner used by the clean-room clone.
import path from 'node:path';
import { runValidationCommand, validationCommandTimeout } from '../platform/windows/validation-process.mjs';
import { mainSuiteEvidence } from '../lib/phi-certification-evidence.mjs';

if (!['win32', 'linux'].includes(process.platform) || process.argv.length !== 2) throw new Error('PHI_OWNED_MAIN_SUITE_USAGE');
const root = path.resolve(import.meta.dirname, '..');
const command = process.execPath;
const args = [path.join(root, 'scripts', 'phi-check.mjs'), '--owned-validation'];
let report = { phase: process.platform === 'win32' ? 'WINDOWS_MAIN' : 'UBUNTU_REGRESSION', status: 'FAIL', tests: null, owner: null };
try {
  const result = await runValidationCommand(command, args, {
    cwd: root, timeoutMs: validationCommandTimeout(command, args, root),
    env: process.platform === 'win32' ? { ...process.env, PHI_CLONE_RUNTIME_OBSERVATION: '1' } : process.env,
  });
  report = mainSuiteEvidence(result, process.platform);
} catch {
  report.failure = 'OWNERSHIP_UNVERIFIED';
}
console.log(JSON.stringify(report));
if (report.status !== 'PASS') process.exitCode = 1;
