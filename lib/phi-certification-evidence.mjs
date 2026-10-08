// Evidence-only classifiers for the one-shot integrated gate. Unknown never passes.
import { tapRuntimeEvidence } from './phi-validation-evidence.mjs';

export function mainSuiteEvidence(result, platform) {
  const windows = platform === 'win32';
  const summary = Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(key => {
    const match = new RegExp(`^# ${key} (\\d+)$`, 'mu').exec(result?.stdout ?? '');
    return [key, match ? Number(match[1]) : null];
  }));
  const receipt = result?.receipt;
  const tap = tapRuntimeEvidence(result?.stdout ?? '');
  const owner = receipt ? { jobAttested: receipt.jobAttested, jobEmptyVerified: receipt.jobEmptyVerified,
    pipesDrained: receipt.pipesDrained, residualOwnedProcesses: receipt.residualOwnedProcesses,
    timedOut: receipt.timedOut, exitCode: receipt.primaryExitCode,
    progress: receipt.progress ? { started: receipt.progress.started, ended: receipt.progress.ended,
      completed: receipt.progress.completed, failed: receipt.progress.failed,
      invalid: receipt.progress.invalid, stalled: receipt.progress.stalled } : null } : null;
  const pass = result?.status === 0 && !result.error && summary.tests === 491 &&
    summary.pass === (windows ? 479 : 168) && summary.fail === 0 &&
    summary.skipped === (windows ? 12 : 323) && tap.completed === 491 && tap.contiguous && (!windows ||
      owner?.jobAttested === true && owner.jobEmptyVerified === true &&
      owner.pipesDrained === true && owner.residualOwnedProcesses === 0 && owner.exitCode === 0 &&
      owner.progress?.started === true && owner.progress.ended === true &&
      owner.progress.completed === 491 && owner.progress.failed === 0 &&
      owner.progress.invalid === false && owner.progress.stalled === false);
  return { phase: windows ? 'WINDOWS_MAIN' : 'UBUNTU_REGRESSION', status: pass ? 'PASS' : 'FAIL',
    tests: summary, completedOrdinals: tap.completed, owner };
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

export function createOwnedProcessGraphEvidence({ childExitStatus, childAlive, stdoutDrained, stderrDrained, executions }) {
  const rows = Array.isArray(executions) ? executions : [];
  const expected = ['EDIT', 'LSP_READ_ONLY', 'LSP_READ_ONLY', 'TEST'];
  const actual = rows.map(row => row?.profile).sort();
  const jobsEmpty = rows.length === expected.length && JSON.stringify(actual) === JSON.stringify(expected) &&
    rows.every(row => row.jobAttested === true && row.jobEmptyVerified === true &&
      row.cleanup === 'PASS' && row.exitCode === 0);
  const pipesDrained = stdoutDrained === true && stderrDrained === true;
  const closed = childExitStatus === 0 && childAlive === false;
  const complete = jobsEmpty && pipesDrained && closed;
  return { status: complete ? 'PASS' : 'UNKNOWN', childClosed: closed, jobsEmpty: jobsEmpty ? true : null,
    pipesDrained, ownedResidualProcesses: complete ? 0 : null,
    graph: complete ? 'PI_CHILD_AND_FOUR_BROKER_JOBS' : 'INCOMPLETE' };
}
