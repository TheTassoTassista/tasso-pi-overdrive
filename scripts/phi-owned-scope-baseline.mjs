#!/usr/bin/env node
// Read-only fixed-scope ownership baseline; no broad process enumeration or recovery mutation.
import path from 'node:path';
import { ownedWindowsHelper } from '../platform/windows/process.mjs';
import { runValidationCommand } from '../platform/windows/validation-process.mjs';
import { fixedScopeBaselineEvidence } from '../lib/phi-certification-evidence.mjs';

if (process.platform !== 'win32' || process.argv.length !== 2) throw new Error('PHI_OWNED_SCOPE_BASELINE_USAGE');
const root = path.resolve(import.meta.dirname, '..');
let report = { phase: 'OWNED_SCOPE_BASELINE', status: 'UNKNOWN' };
try {
  const result = await runValidationCommand(ownedWindowsHelper(), ['--scope-recovery-status'], { cwd: root });
  report = fixedScopeBaselineEvidence(result);
} catch {
  report = { phase: 'OWNED_SCOPE_BASELINE', status: 'UNKNOWN' };
}
console.log(JSON.stringify(report));
if (report.status !== 'PASS') process.exitCode = 1;
