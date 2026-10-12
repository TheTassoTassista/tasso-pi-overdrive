// Evidence-only classifiers for the one-shot integrated gate. Unknown never passes.
import { PHI_TEST_CORPUS, tapRuntimeEvidence } from './phi-validation-evidence.mjs';
import { parseProcessIdentity } from './process-identity.mjs';

const FAILURE_CATEGORIES = new Set(['TEST_CODE_FAILURE', 'SUBTEST_FAILURE', 'CANCELLED_BY_PARENT',
  'TEST_TIMEOUT', 'TEST_FAILURE_UNKNOWN']);

// Never publish TAP titles, assertions, stacks, stderr, paths or fixture data.
// Reporter-owned test IDs are hashes of the source-owned relative file and name.
export function failureLedgerEvidence(output, expected, suiteExit) {
  const incomplete = observed => ({ status: 'FAILURE_LEDGER_INCOMPLETE', expected, observed, entries: [] });
  if (!Number.isSafeInteger(expected) || expected < 0 || expected > PHI_TEST_CORPUS.total) return incomplete(0);
  const tapFailures = [...output.matchAll(/^not ok (\d+)(?=\s|$)/gmu)].map(match => Number(match[1]));
  const rows = [];
  for (const line of output.split(/\r?\n/u)) {
    if (!line.startsWith('# PHI_RUNTIME ')) continue;
    let value;
    try { value = JSON.parse(line.slice(14)); } catch { return incomplete(rows.length); }
    if (value.kind !== 'completion' || value.failed !== true) continue;
    const failure = value.failure;
    if (!Number.isSafeInteger(value.ordinal) || value.ordinal < 1 || value.ordinal > PHI_TEST_CORPUS.total ||
      !failure || Object.keys(failure).length !== 4 ||
      typeof failure.testId !== 'string' || !/^[0-9a-f]{64}$/u.test(failure.testId) ||
      typeof failure.sourceFile !== 'string' || !/^tests\/phi-[^/]+\.test\.mjs$/u.test(failure.sourceFile) ||
      !FAILURE_CATEGORIES.has(failure.category) || !['ASSERTION', 'UNKNOWN'].includes(failure.assertionCategory))
      return incomplete(rows.length);
    rows.push({ ordinal: value.ordinal, testId: failure.testId, sourceFile: failure.sourceFile, result: 'FAIL',
      category: failure.category, assertionCategory: failure.assertionCategory,
      suiteExitCategory: suiteExit === 0 ? 'ZERO_EXIT_WITH_FAILURE' : 'NONZERO_SUITE_EXIT' });
  }
  if (expected === 0) return tapFailures.length === 0 && rows.length === 0 ?
    { status: 'NONE', expected: 0, observed: 0, entries: [] } : incomplete(rows.length);
  const uniqueOrdinals = new Set(rows.map(row => row.ordinal));
  const uniqueIds = new Set(rows.map(row => row.testId));
  if (rows.length !== expected || tapFailures.length !== expected ||
    uniqueOrdinals.size !== expected || uniqueIds.size !== expected ||
    rows.some((row, index) => row.ordinal !== tapFailures[index])) return incomplete(rows.length);
  return { status: 'COMPLETE', expected, observed: rows.length, entries: rows };
}

export function mainSuiteEvidence(result, platform) {
  const windows = platform === 'win32';
  const summary = Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(key => {
    const match = new RegExp(`^# ${key} (\\d+)$`, 'mu').exec(result?.stdout ?? '');
    return [key, match ? Number(match[1]) : null];
  }));
  const receipt = result?.receipt;
  const tap = tapRuntimeEvidence(result?.stdout ?? '');
  const failureLedger = failureLedgerEvidence(result?.stdout ?? '', summary.fail, result?.status);
  const owner = receipt ? { jobAttested: receipt.jobAttested, jobEmptyVerified: receipt.jobEmptyVerified,
    pipesDrained: receipt.pipesDrained, residualOwnedProcesses: receipt.residualOwnedProcesses,
    timedOut: receipt.timedOut, exitCode: receipt.primaryExitCode,
    progress: receipt.progress ? { started: receipt.progress.started, ended: receipt.progress.ended,
      completed: receipt.progress.completed, failed: receipt.progress.failed,
      invalid: receipt.progress.invalid, stalled: receipt.progress.stalled } : null } : null;
  const pass = result?.status === 0 && !result.error && failureLedger.status === 'NONE' &&
    summary.tests === PHI_TEST_CORPUS.total && summary.pass === (windows ? PHI_TEST_CORPUS.windowsPassed : PHI_TEST_CORPUS.linuxPassed) && summary.fail === 0 &&
    summary.skipped === (windows ? PHI_TEST_CORPUS.windowsSkipped : PHI_TEST_CORPUS.linuxSkipped) &&
    tap.completed === PHI_TEST_CORPUS.total && tap.contiguous && (!windows ||
      owner?.jobAttested === true && owner.jobEmptyVerified === true &&
      owner.pipesDrained === true && owner.residualOwnedProcesses === 0 && owner.exitCode === 0 &&
      owner.progress?.started === true && owner.progress.ended === true &&
      owner.progress.completed === PHI_TEST_CORPUS.total && owner.progress.failed === 0 &&
      owner.progress.invalid === false && owner.progress.stalled === false);
  return { phase: windows ? 'WINDOWS_MAIN' : 'UBUNTU_REGRESSION', status: pass ? 'PASS' : 'FAIL',
    tests: summary, completedOrdinals: tap.completed, owner, failureLedger };
}

export function fixedScopeBaselineEvidence(result) {
  let value;
  try { value = JSON.parse(result?.stdout ?? ''); }
  catch { return { phase: 'OWNED_SCOPE_BASELINE', status: 'UNKNOWN' }; }
  const owner = result?.receipt;
  const clear = result.status === 0 && !result.error && owner?.jobAttested === true &&
    owner.jobEmptyVerified === true && owner.pipesDrained === true && owner.residualOwnedProcesses === 0 &&
    value.scope === 'FIXED_NATIVE_SCOPES_ONLY' && value.status === 'PASS' &&
    ['scanned', 'active', 'stale', 'quarantined', 'processKills'].every(key => value[key] === 0) &&
    value.cleanupPerformed === false;
  return { phase: 'OWNED_SCOPE_BASELINE', status: clear ? 'PASS' : 'FAIL',
    fixedScopes: clear ? 0 : null, active: Number.isSafeInteger(value.active) ? value.active : null,
    stale: Number.isSafeInteger(value.stale) ? value.stale : null,
    quarantined: Number.isSafeInteger(value.quarantined) ? value.quarantined : null,
    owner: owner ? { jobAttested: owner.jobAttested, jobEmptyVerified: owner.jobEmptyVerified,
      pipesDrained: owner.pipesDrained, residualOwnedProcesses: owner.residualOwnedProcesses } : null };
}

// This is the exact, code-owned ordinary CREATE fixture graph. The foreground
// Worker is a child Pi session in the root process, not a second OS process.
// EDIT creates a .txt file, so no JSON on-write LSP call occurs. The fixture
// explicitly requests one JSON semantic_nav and one verification command.
const CREATE_BROKER_ROLES = Object.freeze([
  Object.freeze({ id: 'WORKER_EDIT', profile: 'EDIT', operation: 'safe-exec', role: 'worker' }),
  Object.freeze({ id: 'WORKER_SEMANTIC_NAV', profile: 'LSP_READ_ONLY', operation: 'lsp', role: 'worker' }),
  Object.freeze({ id: 'TESTER_VERIFICATION', profile: 'TEST', operation: 'verification', role: 'tester' }),
]);
// E1 repairs a .js source file and verifies it. It does not request semantic_nav
// or trigger the JSON on-write LSP hook; all actually launched jobs remain mandatory.
const SOURCE_REPAIR_BROKER_ROLES = Object.freeze([CREATE_BROKER_ROLES[0], CREATE_BROKER_ROLES[2]]);
const DENIED_HOST_WRITE_BROKER_ROLES = Object.freeze([
  Object.freeze({ ...CREATE_BROKER_ROLES[0], id: 'WORKER_DENIED_HOST_WRITE' }),
]);

export function createOwnedProcessGraphEvidence(input) {
  const issues = [], roles = [];
  const note = (reason, status = 'UNKNOWN') => { if (!issues.some(issue => issue.reason === reason)) issues.push({ reason, status }); };
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) note('ATTESTATION_UNAVAILABLE');
    const graphKind = input?.graphKind ?? 'ORDINARY_CREATE';
    const deniedHostWrite = graphKind === 'E2_HOST_WRITE_DENIED';
    const expectedBrokerRoles = graphKind === 'ORDINARY_CREATE' ? CREATE_BROKER_ROLES :
      graphKind === 'E1_SOURCE_REPAIR_NO_LSP' ? SOURCE_REPAIR_BROKER_ROLES :
        deniedHostWrite ? DENIED_HOST_WRITE_BROKER_ROLES : null;
    if (!expectedBrokerRoles) note('GRAPH_KIND_INVALID', 'FAIL');
    const childIdentity = parseProcessIdentity(input?.childIdentity, 'win32');
    const alive = input?.childAlive;
    const exit = input?.childExitStatus;
    const rootPipes = input?.stdoutDrained === true && input?.stderrDrained === true;
    if (!childIdentity || typeof alive !== 'boolean') note('EXPECTED_NODE_IDENTITY_UNKNOWN');
    else if (alive === true) note('EXPECTED_NODE_STILL_LIVE', 'FAIL');
    if (exit === null || exit === undefined || exit === 'TIMEOUT') note('CHILD_EXIT_UNKNOWN');
    else if (exit !== 0) note('CHILD_EXIT_NONZERO', 'FAIL');
    if (input?.stdoutDrained === false || input?.stderrDrained === false) note('PIPE_NOT_DRAINED', 'FAIL');
    else if (!rootPipes) note('PIPE_STATE_UNKNOWN');
    roles.push({ id: 'PI_ROOT', identity: childIdentity ? 'NATIVE_PID_GENERATION' : 'UNKNOWN', job: 'NOT_JOB_GOVERNED',
      exit: exit === 0 && alive === false ? 'EXIT_ZERO_AND_NOT_LIVE' : 'UNVERIFIED',
      pipe: rootPipes ? 'DRAINED' : 'UNVERIFIED', terminal: exit === 0 && alive === false && rootPipes ? 'CLOSED' : 'UNVERIFIED' });

    const stages = input?.stages;
    if (!Array.isArray(stages)) note('ATTESTATION_UNAVAILABLE');
    const stageIndex = name => Array.isArray(stages) ? stages.findIndex(row => row?.stage === name) : -1;
    const workerStarted = stageIndex('WORKER_STARTED');
    const workerResult = stageIndex('WORKER_RESULT');
    const workerRevoked = stageIndex('WORKER_REVOKED');
    if (deniedHostWrite && (stageIndex('WORKER_RESERVED') < 0 || stageIndex('WORKER_RESERVED') >= workerStarted))
      note('OWNERSHIP_RECORD_MISSING');
    const workerClosed = workerStarted >= 0 && workerResult > workerStarted && workerRevoked > workerResult &&
      stages[workerResult]?.result === 'COMPLETED';
    if (!workerClosed) note('OWNERSHIP_RECORD_MISSING');
    roles.push({ id: 'WORKER_SESSION', identity: 'SHARED_PI_ROOT_PROCESS', job: 'NOT_SEPARATE_PROCESS',
      exit: workerClosed ? 'IN_PROCESS_RESULT_AND_REVOCATION' : 'UNVERIFIED', pipe: 'NO_PIPE_EXPECTED',
      terminal: workerClosed ? 'REVOKED' : 'UNVERIFIED' });

    const nativeResult = stageIndex('NATIVE_RESULT_OBSERVED');
    const postverify = stageIndex('PHYSICAL_POSTVERIFY_COMPLETE');
    const publisherDone = !deniedHostWrite && nativeResult >= 0 && postverify > nativeResult &&
      stages[nativeResult]?.published === true && stages[postverify]?.grantConsumed === true;
    const publisherAbsent = deniedHostWrite && ['CREATE_INTENT_AND_V6_READY', 'OPERATION_INTENT_READY', 'NATIVE_PUBLICATION_CALL_ENTERED',
      'NATIVE_RESULT_OBSERVED', 'PHYSICAL_POSTVERIFY_COMPLETE'].every(name => stageIndex(name) < 0);
    if (deniedHostWrite ? !publisherAbsent : !publisherDone) note(deniedHostWrite ? 'UNEXPECTED_PUBLICATION' : 'OWNERSHIP_RECORD_MISSING', deniedHostWrite ? 'FAIL' : 'UNKNOWN');
    roles.push({ id: 'SYNCHRONOUS_PUBLISHER', identity: 'NO_PERSISTENT_PID_COMPARISON', job: 'NOT_JOB_GOVERNED',
      exit: deniedHostWrite && publisherAbsent ? 'NOT_STARTED' : publisherDone ? 'VALIDATED_NATIVE_RESULT_RETURNED' : 'UNVERIFIED',
      pipe: deniedHostWrite && publisherAbsent ? 'NO_PIPE_EXPECTED' : publisherDone ? 'SYNCHRONOUS_STDIO_RETURNED' : 'UNVERIFIED',
      terminal: deniedHostWrite && publisherAbsent ? 'NOT_STARTED' : publisherDone ? 'CLOSED' : 'UNVERIFIED' });

    const rows = input?.executions;
    if (!Array.isArray(rows)) note('ATTESTATION_UNAVAILABLE');
    else if (rows.length === 0) note('OWNERSHIP_RECORD_MISSING', deniedHostWrite ? 'FAIL' : 'UNKNOWN');
    const assigned = new Set(), digests = new Set();
    for (const expected of expectedBrokerRoles ?? []) {
      const matching = Array.isArray(rows) ? rows.map((row, index) => ({ row, index })).filter(({ row }) =>
        row?.profile === expected.profile && row.operation === expected.operation && row.role === expected.role) : [];
      if (matching.length !== 1) note(matching.length === 0 ? 'CHILD_NOT_REGISTERED' : 'UNEXPECTED_OWNED_NODE',
        matching.length || deniedHostWrite ? 'FAIL' : 'UNKNOWN');
      const selected = matching[0];
      if (selected) assigned.add(selected.index);
      const row = selected?.row;
      if (row) {
        if (typeof row.scopeDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(row.scopeDigest)) note('OWNERSHIP_RECORD_MISSING');
        else if (digests.has(row.scopeDigest)) note('UNEXPECTED_OWNED_NODE', 'FAIL');
        else digests.add(row.scopeDigest);
        if (row.targetStarted !== true || row.jobAttested !== true) note('JOB_MEMBERSHIP_UNKNOWN');
        if (row.jobEmptyVerified === false) note('JOB_NOT_EMPTY', 'FAIL');
        else if (row.jobEmptyVerified !== true) note('JOB_MEMBERSHIP_UNKNOWN');
        if (row.brokerPipesDrained === false) note('PIPE_NOT_DRAINED', 'FAIL');
        else if (row.brokerPipesDrained !== true) note('PIPE_STATE_UNKNOWN');
        if (row.brokerHelperClosed !== true || row.exitCode === null || row.exitCode === undefined) note('CHILD_EXIT_UNKNOWN');
        else if (row.exitCode !== (deniedHostWrite ? 73 : 0)) note(deniedHostWrite ? 'CHILD_EXIT_UNEXPECTED' : 'CHILD_EXIT_NONZERO', 'FAIL');
        if (row.cleanup !== 'PASS' || row.securityFailure !== null || row.timedOut !== false) note('OWNED_CLEANUP_FAILED', 'FAIL');
      }
      const roleComplete = row?.targetStarted === true && row.jobAttested === true && row.jobEmptyVerified === true &&
        row.brokerHelperClosed === true && row.brokerPipesDrained === true && row.exitCode === (deniedHostWrite ? 73 : 0) &&
        row.cleanup === 'PASS' && row.securityFailure === null && row.timedOut === false &&
        typeof row.scopeDigest === 'string' && /^[0-9a-f]{64}$/u.test(row.scopeDigest);
      roles.push({ id: expected.id, identity: row ? 'JOB_GOVERNED_NO_PERSISTENT_PID_COMPARISON' : 'UNKNOWN',
        job: row?.jobEmptyVerified === true && row.jobAttested === true ? 'ATTESTED_EMPTY' : 'UNVERIFIED',
        exit: row?.brokerHelperClosed === true && row.exitCode === (deniedHostWrite ? 73 : 0) ? deniedHostWrite ? 'EXPECTED_DENIAL_EXIT_73' : 'EXIT_ZERO' : 'UNVERIFIED',
        pipe: row?.brokerPipesDrained === true ? 'DRAINED' : 'UNVERIFIED',
        terminal: roleComplete ? 'CLOSED' : 'UNVERIFIED' });
    }
    if (Array.isArray(rows) && (rows.length > (expectedBrokerRoles?.length ?? 0) || rows.some((_, index) => !assigned.has(index)))) note('UNEXPECTED_OWNED_NODE', 'FAIL');
    const baseline = input?.baseline;
    const baselineComplete = baseline?.status === 'PASS' && baseline.active === 0 && baseline.stale === 0 &&
      baseline.quarantined === 0 && baseline.owner?.jobAttested === true && baseline.owner.jobEmptyVerified === true &&
      baseline.owner.pipesDrained === true && baseline.owner.residualOwnedProcesses === 0;
    if (!baselineComplete) note('BASELINE_MISMATCH', baseline?.status === 'FAIL' ? 'FAIL' : 'UNKNOWN');
    const status = issues.length === 0 ? 'PASS' : issues.some(issue => issue.status === 'FAIL') ? 'FAIL' : 'UNKNOWN';
    const brokerRoles = roles.filter(role => expectedBrokerRoles?.some(expected => expected.id === role.id));
    return { status, reason: issues[0]?.reason ?? 'GRAPH_COMPLETE', reasons: issues.map(issue => issue.reason),
      childClosed: exit === 0 && alive === false,
      jobsEmpty: expectedBrokerRoles && brokerRoles.length === expectedBrokerRoles.length && brokerRoles.every(role => role.job === 'ATTESTED_EMPTY') ? true : null,
      pipesDrained: Boolean(rootPipes && expectedBrokerRoles && brokerRoles.length === expectedBrokerRoles.length && brokerRoles.every(role => role.pipe === 'DRAINED')),
      ownedResidualProcesses: status === 'PASS' ? 0 : null,
      graph: deniedHostWrite ? 'PI_ROOT_WORKER_SESSION_ONE_DENIED_BROKER_JOB_NO_PUBLISHER' :
        graphKind === 'E1_SOURCE_REPAIR_NO_LSP' ? 'PI_ROOT_WORKER_SESSION_TWO_BROKER_JOBS_SYNCHRONOUS_PUBLISHER' :
        'PI_ROOT_WORKER_SESSION_THREE_BROKER_JOBS_SYNCHRONOUS_PUBLISHER', roles };
  } catch {
    return { status: 'UNKNOWN', reason: 'VERIFIER_INTERNAL_ERROR', reasons: ['VERIFIER_INTERNAL_ERROR'],
      childClosed: false, jobsEmpty: null, pipesDrained: false, ownedResidualProcesses: null,
      graph: 'PI_ROOT_WORKER_SESSION_THREE_BROKER_JOBS_SYNCHRONOUS_PUBLISHER', roles: [] };
  }
}
