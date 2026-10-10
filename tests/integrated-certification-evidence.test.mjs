import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createOwnedProcessGraphEvidence, fixedScopeBaselineEvidence, mainSuiteEvidence } from '../lib/phi-certification-evidence.mjs';

test('integrated Windows certification runs all four ordinary operations in order with ownership baselines', () => {
  const workflow = readFileSync(new URL('../.github/workflows/phi-foundation.yml', import.meta.url), 'utf8');
  const integrated = workflow.split('  integrated-windows:\n')[1]?.split('  ordinary-create-finalization-diagnostic:\n')[0];
  assert.ok(integrated);
  let previous = -1;
  for (const [operation, flag, version] of [
    ['CREATE', '', 'V6'], ['MODIFY', ' --modify', 'V2'],
    ['DELETE', ' --delete', 'V3'], ['RENAME', ' --rename', 'V4'],
  ]) {
    const name = `- name: Ordinary Pi secure workflow ${operation} ${version} and protected receipt readback`;
    const start = integrated.indexOf(name);
    const command = integrated.indexOf(`node scripts/phi-bounded-workflow-pi-smoke.mjs${flag}\n`, start);
    const baseline = integrated.indexOf(`- name: Post-${operation} fixed-scope ownership baseline`, command);
    assert.ok(start > previous && command > start && baseline > command, `${operation} must execute and clean up in order`);
    previous = baseline;
  }
  assert.match(integrated, /- name: Final fixed-scope ownership baseline even after failure\n\s+if: always\(\)/u);
});

const owner = { jobAttested: true, jobEmptyVerified: true, pipesDrained: true,
  residualOwnedProcesses: 0, primaryExitCode: 0, timedOut: false,
  progress: { started: true, ended: true, completed: 500, failed: 0, invalid: false, stalled: false } };

test('integrated main suite requires exact corpus and native ownership evidence', () => {
  const ordinals = Array.from({ length: 500 }, (_, index) => `ok ${index + 1} - fixture`).join('\n');
  const windows = { status: 0, stdout: `${ordinals}\n# tests 500\n# pass 488\n# fail 0\n# skipped 12\n`, receipt: owner };
  assert.equal(mainSuiteEvidence(windows, 'win32').status, 'PASS');
  assert.equal(mainSuiteEvidence({ ...windows, receipt: undefined }, 'win32').status, 'FAIL');
  assert.equal(mainSuiteEvidence({ ...windows, receipt: { ...owner, jobEmptyVerified: null } }, 'win32').status, 'FAIL');
  assert.equal(mainSuiteEvidence({ ...windows, receipt: { ...owner, pipesDrained: false } }, 'win32').status, 'FAIL');
  assert.equal(mainSuiteEvidence({ ...windows, receipt: { ...owner, progress: null } }, 'win32').status, 'FAIL');
  assert.equal(mainSuiteEvidence({ ...windows, stdout: windows.stdout.replace('500', '499') }, 'win32').status, 'FAIL');
  assert.equal(mainSuiteEvidence({ ...windows, status: 124, error: { code: 'ETIMEDOUT' } }, 'win32').status, 'FAIL');
  assert.equal(mainSuiteEvidence({ status: 0, stdout: `${ordinals}\n# tests 500\n# pass 169\n# fail 0\n# skipped 331\n` }, 'linux').status, 'PASS');
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

const createRoles = [
  { profile: 'EDIT', operation: 'safe-exec', role: 'worker' },
  { profile: 'LSP_READ_ONLY', operation: 'lsp', role: 'worker' },
  { profile: 'TEST', operation: 'verification', role: 'tester' },
].map((value, index) => ({ ...value, scopeDigest: String(index + 1).repeat(64), targetStarted: true,
  jobAttested: true, jobEmptyVerified: true, brokerHelperClosed: true, brokerPipesDrained: true,
  cleanup: 'PASS', exitCode: 0, securityFailure: null, timedOut: false }));
const createStages = [
  { stage: 'WORKER_STARTED' }, { stage: 'WORKER_RESULT', result: 'COMPLETED' }, { stage: 'WORKER_REVOKED' },
  { stage: 'NATIVE_RESULT_OBSERVED', published: true }, { stage: 'PHYSICAL_POSTVERIFY_COMPLETE', grantConsumed: true },
];
const createInput = { childIdentity: { kind: 'windows-process-creation', version: 1, pid: 123, creationTime: 'a'.repeat(16) },
  childExitStatus: 0, childAlive: false, stdoutDrained: true, stderrDrained: true,
  executions: createRoles, stages: createStages, baseline: { status: 'PASS', active: 0, stale: 0, quarantined: 0,
    owner: { jobAttested: true, jobEmptyVerified: true, pipesDrained: true, residualOwnedProcesses: 0 } } };
const graph = input => createOwnedProcessGraphEvidence({ ...createInput, ...input });

test('ordinary CREATE graph attests exact three Job roles, in-process Worker and synchronous publisher', () => {
  const clean = graph({});
  assert.equal(clean.status, 'PASS');
  assert.equal(clean.reason, 'GRAPH_COMPLETE');
  assert.equal(clean.ownedResidualProcesses, 0);
  assert.equal(clean.jobsEmpty, true);
  assert.deepEqual(clean.roles.map(role => role.id), ['PI_ROOT', 'WORKER_SESSION', 'SYNCHRONOUS_PUBLISHER',
    'WORKER_EDIT', 'WORKER_SEMANTIC_NAV', 'TESTER_VERIFICATION']);
  assert.equal(clean.roles.every(role => role.terminal !== 'UNVERIFIED'), true);
  assert.equal(graph({ childAlive: true }).reason, 'EXPECTED_NODE_STILL_LIVE');
  assert.equal(graph({ childIdentity: null }).reason, 'EXPECTED_NODE_IDENTITY_UNKNOWN');
  assert.equal(graph({ childAlive: 'dead' }).reason, 'EXPECTED_NODE_IDENTITY_UNKNOWN');
  assert.equal(graph({ executions: createRoles.slice(1) }).reason, 'CHILD_NOT_REGISTERED');
  assert.equal(graph({ executions: [...createRoles, { ...createRoles[0], scopeDigest: 'f'.repeat(64) }] }).reasons.includes('UNEXPECTED_OWNED_NODE'), true);
  assert.equal(graph({ executions: createRoles.map((row, i) => i === 1 ? { ...row, scopeDigest: null } : row) }).reason, 'OWNERSHIP_RECORD_MISSING');
  assert.equal(graph({ executions: createRoles.map((row, i) => i === 1 ? { ...row, scopeDigest: createRoles[0].scopeDigest } : row) }).reason, 'UNEXPECTED_OWNED_NODE');
  assert.equal(graph({ stages: createStages.slice(1) }).reason, 'OWNERSHIP_RECORD_MISSING');
  assert.equal(graph({ stages: createStages.slice(0, -1) }).reason, 'OWNERSHIP_RECORD_MISSING');
  assert.equal(graph({ baseline: { status: 'FAIL' } }).reason, 'BASELINE_MISMATCH');
  assert.equal(graph({ baseline: { status: 'PASS' } }).reason, 'BASELINE_MISMATCH');
  const change = (index, key, value) => createRoles.map((row, i) => i === index ? { ...row, [key]: value } : row);
  assert.equal(graph({ executions: change(0, 'jobAttested', null) }).reason, 'JOB_MEMBERSHIP_UNKNOWN');
  assert.equal(graph({ executions: change(0, 'jobEmptyVerified', false) }).reason, 'JOB_NOT_EMPTY');
  assert.equal(graph({ executions: change(0, 'jobEmptyVerified', null) }).reason, 'JOB_MEMBERSHIP_UNKNOWN');
  assert.equal(graph({ executions: change(1, 'brokerPipesDrained', null) }).reason, 'PIPE_STATE_UNKNOWN');
  assert.equal(graph({ executions: change(1, 'brokerPipesDrained', false) }).reason, 'PIPE_NOT_DRAINED');
  assert.equal(graph({ stderrDrained: null }).reason, 'PIPE_STATE_UNKNOWN');
  assert.equal(graph({ stderrDrained: false }).reason, 'PIPE_NOT_DRAINED');
  assert.equal(graph({ executions: change(2, 'exitCode', null) }).reason, 'CHILD_EXIT_UNKNOWN');
  assert.equal(graph({ executions: change(2, 'brokerHelperClosed', null) }).reason, 'CHILD_EXIT_UNKNOWN');
  assert.equal(graph({ childExitStatus: null }).reason, 'CHILD_EXIT_UNKNOWN');
  assert.equal(graph({ childExitStatus: 2 }).reason, 'CHILD_EXIT_NONZERO');
  assert.equal(graph({ executions: change(0, 'cleanup', 'NOT_PASS') }).reason, 'OWNED_CLEANUP_FAILED');
  assert.equal(graph({ executions: change(0, 'targetStarted', null) }).reason, 'JOB_MEMBERSHIP_UNKNOWN');
  assert.equal(graph({ executions: null }).reason, 'ATTESTATION_UNAVAILABLE');
  assert.equal(graph({ childIdentity: { get pid() { throw new Error('fixture'); } } }).reason, 'VERIFIER_INTERNAL_ERROR');
  for (const input of [{ childAlive: null }, { executions: [] }, { baseline: null }]) {
    const result = graph(input);
    assert.notEqual(result.status, 'PASS');
    assert.notEqual(result.reason, 'UNKNOWN');
    assert.equal(result.ownedResidualProcesses, null);
  }
});
