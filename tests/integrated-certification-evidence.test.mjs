import test from 'node:test';
import assert from 'node:assert/strict';
import { createOwnedProcessGraphEvidence, fixedScopeBaselineEvidence, mainSuiteEvidence } from '../lib/phi-certification-evidence.mjs';

const owner = { jobAttested: true, jobEmptyVerified: true, pipesDrained: true,
  residualOwnedProcesses: 0, primaryExitCode: 0, timedOut: false,
  progress: { started: true, ended: true, completed: 491, failed: 0, invalid: false, stalled: false } };

test('integrated main suite requires exact corpus and native ownership evidence', () => {
  const ordinals = Array.from({ length: 491 }, (_, index) => `ok ${index + 1} - fixture`).join('\n');
  const windows = { status: 0, stdout: `${ordinals}\n# tests 491\n# pass 479\n# fail 0\n# skipped 12\n`, receipt: owner };
  assert.equal(mainSuiteEvidence(windows, 'win32').status, 'PASS');
  assert.equal(mainSuiteEvidence({ ...windows, receipt: undefined }, 'win32').status, 'FAIL');
  assert.equal(mainSuiteEvidence({ ...windows, receipt: { ...owner, jobEmptyVerified: null } }, 'win32').status, 'FAIL');
  assert.equal(mainSuiteEvidence({ ...windows, receipt: { ...owner, pipesDrained: false } }, 'win32').status, 'FAIL');
  assert.equal(mainSuiteEvidence({ ...windows, receipt: { ...owner, progress: null } }, 'win32').status, 'FAIL');
  assert.equal(mainSuiteEvidence({ ...windows, stdout: windows.stdout.replace('491', '490') }, 'win32').status, 'FAIL');
  assert.equal(mainSuiteEvidence({ ...windows, status: 124, error: { code: 'ETIMEDOUT' } }, 'win32').status, 'FAIL');
  assert.equal(mainSuiteEvidence({ status: 0, stdout: `${ordinals}\n# tests 491\n# pass 168\n# fail 0\n# skipped 323\n` }, 'linux').status, 'PASS');
});

test('fixed-scope baseline never converts missing ownership or active scopes to PASS', () => {
  const value = { scope: 'FIXED_NATIVE_SCOPES_ONLY', status: 'PASS', scanned: 0, active: 0,
    stale: 0, quarantined: 0, processKills: 0, cleanupPerformed: false };
  const clear = { status: 0, stdout: JSON.stringify(value), receipt: owner };
  assert.equal(fixedScopeBaselineEvidence(clear).status, 'PASS');
  assert.equal(fixedScopeBaselineEvidence({ ...clear, receipt: undefined }).status, 'FAIL');
  assert.equal(fixedScopeBaselineEvidence({ ...clear, receipt: { ...owner, residualOwnedProcesses: null } }).status, 'FAIL');
  assert.equal(fixedScopeBaselineEvidence({ ...clear, stdout: JSON.stringify({ ...value, active: 1 }) }).status, 'FAIL');
  assert.equal(fixedScopeBaselineEvidence({ ...clear, stdout: 'not-json' }).status, 'UNKNOWN');
});

test('ordinary CREATE ownership graph requires exact jobs, closed Pi child and drained pipes', () => {
  const executions = ['EDIT', 'LSP_READ_ONLY', 'LSP_READ_ONLY', 'TEST'].map(profile => ({ profile,
    jobAttested: true, jobEmptyVerified: true, cleanup: 'PASS', exitCode: 0 }));
  const input = { childExitStatus: 0, childAlive: false, stdoutDrained: true, stderrDrained: true, executions };
  assert.equal(createOwnedProcessGraphEvidence(input).ownedResidualProcesses, 0);
  assert.equal(createOwnedProcessGraphEvidence({ ...input, childAlive: null }).ownedResidualProcesses, null);
  assert.equal(createOwnedProcessGraphEvidence({ ...input, stderrDrained: false }).status, 'UNKNOWN');
  assert.equal(createOwnedProcessGraphEvidence({ ...input, executions: executions.slice(1) }).status, 'UNKNOWN');
  assert.equal(createOwnedProcessGraphEvidence({ ...input, executions: executions.map((row, i) => i === 1 ? { ...row, jobEmptyVerified: null } : row) }).status, 'UNKNOWN');
});
