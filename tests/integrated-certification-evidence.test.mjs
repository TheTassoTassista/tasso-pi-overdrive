import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createOwnedProcessGraphEvidence, fixedScopeBaselineEvidence, mainSuiteEvidence } from '../lib/phi-certification-evidence.mjs';
import { PHI_TEST_CORPUS } from '../lib/phi-validation-evidence.mjs';

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
  const e4Linux = workflow.split('  campaign3-e4-ubuntu:\n')[1]?.split('  campaign3-e4-windows:\n')[0];
  const e4Windows = workflow.split('  campaign3-e4-windows:\n')[1]?.split('  corrupt-journal-ready-diagnostic:\n')[0];
  assert.ok(e4Linux && e4Windows, 'E4 must use dedicated same-candidate jobs, not the D-18 replay');
  assert.match(e4Linux, /ref: \$\{\{ inputs\.certified_sha \}\}/u);
  assert.match(e4Linux, /node scripts\/phi-owned-main-suite\.mjs/u);
  assert.match(e4Windows, /needs: campaign3-e4-ubuntu/u);
  assert.match(e4Windows, /ref: \$\{\{ inputs\.certified_sha \}\}/u);
  let e4Previous = e4Windows.indexOf('Full Windows main corpus and bounded failure ledger');
  assert.ok(e4Previous >= 0);
  for (const [role, command] of [['E1', 'node scripts/phi-bounded-workflow-pi-smoke.mjs --e1'],
    ['E2', 'node scripts/phi-bounded-workflow-pi-smoke.mjs --e2'],
    ['E3', 'node scripts/phi-d-wide-pi-smoke.mjs --autonomy-crash-v2']]) {
    const step = e4Windows.indexOf(command, e4Previous);
    const baseline = e4Windows.indexOf(`Post-${role} fixed-scope ownership baseline`, step);
    assert.ok(step > e4Previous && baseline > step, `${role} must run and clean up in E4 order`);
    e4Previous = baseline;
  }
  assert.match(e4Windows, /- name: Final fixed-scope ownership baseline even after failure\n\s+if: always\(\)/u);
});

test('E4 image namespace feasibility is non-certifying and cannot launch the default or E4 jobs', () => {
  const workflow = readFileSync(new URL('../.github/workflows/phi-foundation.yml', import.meta.url), 'utf8');
  const diagnostic = workflow.split('  e4-image-feasibility:\n')[1]?.split('  integrated-ubuntu:\n')[0];
  const ordinary = workflow.split('  native-foundation:\n')[1];
  assert.ok(diagnostic && ordinary);
  assert.match(diagnostic, /inputs\['e4-image-feasibility-only'\] && !inputs\['campaign3-e4-certification'\]/u);
  assert.match(diagnostic, /docker run --rm --network none --read-only --cap-drop ALL/u);
  assert.match(diagnostic, /--security-opt no-new-privileges:true/u);
  assert.doesNotMatch(diagnostic, /npm run check|phi-owned-main-suite|provider|preflight/iu);
  assert.match(ordinary.split('\n')[0], /!inputs\['e4-image-feasibility-only'\]/u);
});

const owner = { jobAttested: true, jobEmptyVerified: true, pipesDrained: true,
  residualOwnedProcesses: 0, primaryExitCode: 0, timedOut: false,
  progress: { started: true, ended: true, completed: 503, failed: 0, invalid: false, stalled: false } };

test('integrated main suite requires exact corpus and native ownership evidence', () => {
  assert.deepEqual(PHI_TEST_CORPUS, { total: 503, windowsPassed: 491, windowsSkipped: 12,
    linuxPassed: 172, linuxSkipped: 331 });
  const ordinals = Array.from({ length: 503 }, (_, index) => `ok ${index + 1} - fixture`).join('\n');
  const windows = { status: 0, stdout: `${ordinals}\n# tests 503\n# pass 491\n# fail 0\n# skipped 12\n`, receipt: owner };
  assert.equal(mainSuiteEvidence(windows, 'win32').status, 'PASS');
  assert.equal(mainSuiteEvidence({ ...windows, receipt: undefined }, 'win32').status, 'FAIL');
  assert.equal(mainSuiteEvidence({ ...windows, receipt: { ...owner, jobEmptyVerified: null } }, 'win32').status, 'FAIL');
  assert.equal(mainSuiteEvidence({ ...windows, receipt: { ...owner, pipesDrained: false } }, 'win32').status, 'FAIL');
  assert.equal(mainSuiteEvidence({ ...windows, receipt: { ...owner, progress: null } }, 'win32').status, 'FAIL');
  assert.equal(mainSuiteEvidence({ ...windows, stdout: windows.stdout.replace('503', '502') }, 'win32').status, 'FAIL');
  assert.equal(mainSuiteEvidence({ ...windows, stdout: windows.stdout.replace('# pass 491', '# pass 488') }, 'win32').status, 'FAIL');
  assert.equal(mainSuiteEvidence({ ...windows, status: 124, error: { code: 'ETIMEDOUT' } }, 'win32').status, 'FAIL');
  assert.equal(mainSuiteEvidence({ status: 0, stdout: `${ordinals}\n# tests 503\n# pass 172\n# fail 0\n# skipped 331\n` }, 'linux').status, 'PASS');
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

test('E1 source-repair graph requires exactly its EDIT and TEST jobs without inventing an LSP job', () => {
  const e1 = input => graph({ graphKind: 'E1_SOURCE_REPAIR_NO_LSP', executions: [createRoles[0], createRoles[2]], ...input });
  const clean = e1({});
  assert.equal(clean.status, 'PASS');
  assert.equal(clean.jobsEmpty, true);
  assert.equal(clean.pipesDrained, true);
  assert.equal(clean.ownedResidualProcesses, 0);
  assert.deepEqual(clean.roles.map(role => role.id), ['PI_ROOT', 'WORKER_SESSION', 'SYNCHRONOUS_PUBLISHER',
    'WORKER_EDIT', 'TESTER_VERIFICATION']);
  assert.equal(graph({ graphKind: 'ORDINARY_CREATE', executions: [createRoles[0], createRoles[2]] }).reason, 'CHILD_NOT_REGISTERED');
  assert.equal(e1({ executions: [createRoles[0]] }).reason, 'CHILD_NOT_REGISTERED');
  assert.equal(e1({ executions: [createRoles[2]] }).reason, 'CHILD_NOT_REGISTERED');
  assert.equal(e1({ executions: createRoles }).reason, 'UNEXPECTED_OWNED_NODE');
  assert.equal(e1({ executions: [createRoles[0], { ...createRoles[2], jobEmptyVerified: false }] }).reason, 'JOB_NOT_EMPTY');
  assert.equal(graph({ graphKind: 'UNKNOWN_GRAPH', executions: [createRoles[0], createRoles[2]] }).status, 'FAIL');
});

test('E2 denied host write graph requires one denied EDIT Job, revoked Worker and no publisher', () => {
  const deniedJob = { ...createRoles[0], exitCode: 73 };
  const stages = [{ stage: 'WORKER_RESERVED' }, ...createStages.slice(0, 3)];
  const e2 = input => graph({ graphKind: 'E2_HOST_WRITE_DENIED', executions: [deniedJob], stages, ...input });
  const clean = e2({});
  assert.equal(clean.status, 'PASS');
  assert.equal(clean.jobsEmpty, true);
  assert.equal(clean.pipesDrained, true);
  assert.equal(clean.ownedResidualProcesses, 0);
  assert.equal(clean.roles.find(role => role.id === 'SYNCHRONOUS_PUBLISHER')?.terminal, 'NOT_STARTED');
  assert.equal(clean.roles.find(role => role.id === 'WORKER_DENIED_HOST_WRITE')?.exit, 'EXPECTED_DENIAL_EXIT_73');
  assert.equal(e2({ executions: [] }).status, 'FAIL');
  assert.equal(e2({ executions: [deniedJob, createRoles[2]] }).reason, 'UNEXPECTED_OWNED_NODE');
  assert.equal(e2({ executions: [{ ...deniedJob, exitCode: 0 }] }).reason, 'CHILD_EXIT_UNEXPECTED');
  assert.equal(e2({ executions: [{ ...deniedJob, jobEmptyVerified: false }] }).reason, 'JOB_NOT_EMPTY');
  assert.equal(e2({ executions: [{ ...deniedJob, brokerPipesDrained: false }] }).reason, 'PIPE_NOT_DRAINED');
  assert.equal(e2({ stages: [...stages, { stage: 'OPERATION_INTENT_READY' }] }).reason, 'UNEXPECTED_PUBLICATION');
  assert.equal(e2({ stages: [...stages, { stage: 'CREATE_INTENT_AND_V6_READY' }] }).reason, 'UNEXPECTED_PUBLICATION');
  assert.equal(e2({ stages: [...stages, ...createStages.slice(3)] }).reason, 'UNEXPECTED_PUBLICATION');
  assert.equal(e2({ stages: stages.slice(0, 2) }).reason, 'OWNERSHIP_RECORD_MISSING');
  assert.equal(e2({ stages: createStages.slice(0, 3) }).reason, 'OWNERSHIP_RECORD_MISSING');
  assert.equal(e2({ baseline: { ...createInput.baseline, owner: { ...createInput.baseline.owner, residualOwnedProcesses: 1 } } }).reason, 'BASELINE_MISMATCH');
  assert.notEqual(graph({ graphKind: 'E1_SOURCE_REPAIR_NO_LSP', executions: [deniedJob, createRoles[2]] }).status, 'PASS');
  assert.notEqual(graph({ graphKind: 'ORDINARY_CREATE', executions: [deniedJob, createRoles[1], createRoles[2]] }).status, 'PASS');
});

test('E2 native focus runs the normal Pi denial path with an always-on cleanup baseline', () => {
  const workflow = readFileSync(new URL('../.github/workflows/phi-foundation.yml', import.meta.url), 'utf8');
  const e2 = workflow.split('\n  campaign3-e2-focused:\n')[1]?.split('\n  corrupt-journal-ready-diagnostic:\n')[0];
  assert.ok(e2);
  assert.match(e2, /node --test tests\/integrated-certification-evidence\.test\.mjs/u);
  assert.match(e2, /node scripts\/phi-bounded-workflow-pi-smoke\.mjs --e2/u);
  assert.match(e2, /- name: Final fixed-scope ownership baseline even after failure\n\s+if: always\(\)/u);
  assert.match(workflow, /!inputs\['campaign3-e1-focused'\] && !inputs\['campaign3-e2-focused'\]/u);
});
