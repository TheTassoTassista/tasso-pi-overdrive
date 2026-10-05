const stages = new Set(['git-source', 'source-dependencies', 'pinned-lsp-runtime', 'windows-process-build', 'foundation-bootstrap', 'doctor', 'foundation-tests', 'test206', 'post-test-recovery', 'brand-smoke']);
const test206Stages = new Set(['BEGIN', 'FIXTURE_SETUP', 'PUBLISHER_START', 'PUBLISHER_INPUT', 'PUBLISHER_READY_WAIT',
  'PUBLISHER_READY_TIMEOUT', 'PUBLISHER_READY_MISSING', 'PUBLISHER_READY_OVERSIZE', 'PUBLISHER_READY_PARSE',
  'LIVE_OWNER_INSPECT', 'KILL', 'FRESH_READER_START', 'FRESH_READER_EXIT', 'FRESH_READER_CONTRACT',
  'PHYSICAL_STATE', 'PRE_STARTUP_SNAPSHOT', 'FIRST_NORMAL_PHI_STARTUP', 'SECOND_NORMAL_PHI_STARTUP',
  'STARTUP_RECEIPT_CONTRACT', 'STARTUP_SIDE_EFFECTS', 'DUPLICATE_TERMINAL_DENIAL', 'QUARANTINE_IDENTITY',
  'TERMINAL_JOURNAL_STATE', 'COMPLETE', 'UNKNOWN']);
export function test206DiagnosticEvidence(output) {
  const markers = [...output.matchAll(/^\s*# PHI_TEST206_DIAGNOSTIC (\{[^\r\n]{1,1024}\})$/gmu)];
  if (markers.length !== 1) return null;
  let row; try { row = JSON.parse(markers[0][1]); } catch { return null; }
  const keys = ['nativeExit', 'nativeTimeout', 'lastStage', 'failureStage', 'failureHresult', 'elapsedMs',
    'fixtureCleanup', 'publisherGone', 'readerGone', 'firstStartupGone', 'secondStartupGone'];
  if (!row || Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key)) ||
    row.nativeExit !== null && (!Number.isInteger(row.nativeExit) || row.nativeExit < 0 || row.nativeExit > 255) ||
    typeof row.nativeTimeout !== 'boolean' || !test206Stages.has(row.lastStage) ||
    row.failureStage !== null && !test206Stages.has(row.failureStage) ||
    row.failureHresult !== null && !/^[0-9a-f]{8}$/u.test(row.failureHresult) ||
    row.elapsedMs !== null && (!Number.isSafeInteger(row.elapsedMs) || row.elapsedMs < 0) ||
    keys.slice(6).some(key => row[key] !== null && typeof row[key] !== 'boolean')) return null;
  return Object.fromEntries(keys.map(key => [key, row[key]]));
}
export function runtimeObservations(output) {
  const rows = [];
  for (const line of output.split(/\r?\n/u)) {
    if (!line.startsWith('# PHI_RUNTIME ')) continue;
    let row; try { row = JSON.parse(line.slice(14)); } catch { throw new Error('PHI_RUNTIME_DIAGNOSTIC_INVALID'); }
    if (!['start', 'completion', 'end'].includes(row.kind) || !Number.isSafeInteger(row.elapsedMs) || row.elapsedMs < 0 ||
      typeof row.utc !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(row.utc) || rows.length >= 1024 ||
      row.elapsedMs < (rows.at(-1)?.elapsedMs ?? 0)) throw new Error('PHI_RUNTIME_DIAGNOSTIC_INVALID');
    const safe = { kind: row.kind, elapsedMs: row.elapsedMs, utc: row.utc };
    if (row.kind === 'completion') {
      if (!Number.isSafeInteger(row.ordinal) || row.ordinal < 1 || typeof row.failed !== 'boolean' ||
        !Number.isFinite(row.durationMs) || row.durationMs < 0) throw new Error('PHI_RUNTIME_DIAGNOSTIC_INVALID');
      Object.assign(safe, { ordinal: row.ordinal, durationMs: row.durationMs, failed: row.failed });
    }
    rows.push(safe);
  }
  const completed = rows.filter(row => row.kind === 'completion');
  let longest = { elapsedMs: 0, afterOrdinal: 0, nextObservedOrdinal: null };
  let previous = rows.find(row => row.kind === 'start')?.elapsedMs ?? 0, ordinal = 0;
  for (const row of rows.filter(row => row.kind !== 'start')) {
    const gap = row.elapsedMs - previous;
    if (gap > longest.elapsedMs) longest = { elapsedMs: gap, afterOrdinal: ordinal, nextObservedOrdinal: row.ordinal ?? null };
    previous = row.elapsedMs; ordinal = row.ordinal ?? ordinal;
  }
  return { rows, completed: completed.length, contiguous: completed.every((row, index) => row.ordinal === index + 1),
    longestObservedCompletionGap: longest, longestTests: [...completed].sort((a, b) => b.durationMs - a.durationMs).slice(0, 10),
    limitation: 'REPORTER_DELIVERY_MAY_BE_BUFFERED; ACTIVE_TEST_DURING_GAP_UNKNOWN' };
}
// TAP names and output can contain private fixture data. Expose only numeric
// top-level completion metadata; buffered TAP has no wall-clock event times.
export function tapRuntimeEvidence(output) {
  const lines = output.split(/\r?\n/u), progressEvents = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^ok (\d+)(?=\s|$)/u.exec(lines[i]);
    if (!match) continue;
    const ordinal = Number(match[1]);
    const duration = lines.slice(i + 1, i + 5).map(line => /^\s+duration_ms: (\d+(?:\.\d+)?)$/u.exec(line)?.[1]).find(Boolean);
    progressEvents.push({ ordinal, durationMs: duration === undefined ? null : Number(duration) });
  }
  const measured = progressEvents.map(row => row.durationMs).filter(Number.isFinite);
  return { completed: progressEvents.length, lastCompleted: progressEvents.at(-1)?.ordinal ?? null,
    contiguous: progressEvents.every((row, index) => row.ordinal === index + 1), progressEvents,
    longestCaseDurationMs: measured.length ? Math.max(...measured) : null,
    longestObservedCompletionGapMs: null, completionGapReason: 'TAP_OUTPUT_HAS_NO_WALL_CLOCK_COMPLETION_TIMESTAMPS' };
}
// The Windows clean-room certification is a fixed corpus. A zero exit code is
// insufficient: require its footer, every numeric ordinal, reporter lifecycle,
// and the independent native Job observation before crediting completion.
export function cloneFoundationGate(result, { native = false } = {}) {
  const output = result.stdout ?? '';
  const count = label => Number(new RegExp(`^# ${label} (\\d+)$`, 'mu').exec(output)?.[1] ?? -1);
  const counts = { total: count('tests'), passed: count('pass'), failed: count('fail'), skipped: count('skipped') };
  const tap = tapRuntimeEvidence(output);
  let observed = null;
  try { observed = runtimeObservations(output); } catch { /* invalid progress fails closed below */ }
  const progress = result.receipt?.progress;
  const reporterComplete = observed !== null && observed.rows[0]?.kind === 'start' && observed.rows.at(-1)?.kind === 'end' &&
    observed.completed === 491 && observed.contiguous && observed.rows.filter(row => row.kind === 'start').length === 1 &&
    observed.rows.filter(row => row.kind === 'end').length === 1 && !observed.rows.some(row => row.failed);
  const nativeComplete = !native || progress?.scope === 'FIXED_SUITE_PROGRESS_ONLY' && progress.started === true && progress.ended === true &&
    progress.completed === 491 && progress.failed === 0 && progress.invalid === false && progress.stalled === false &&
    progress.longestObservedGapMs < 150000 && result.receipt.timedOut === false && result.receipt.jobEmptyVerified === true &&
    result.receipt.pipesDrained === true && result.receipt.residualOwnedProcesses === 0 &&
    result.receipt.stallTimedOut === false && result.receipt.outerTimedOut === false;
  const complete = counts.total === 491 && counts.passed === 479 && counts.failed === 0 && counts.skipped === 12 &&
    tap.completed === 491 && tap.contiguous && reporterComplete && nativeComplete && result.status === 0 && !result.error;
  const classification = counts.failed > 0 || /^not ok \d+\b/mu.test(output) || progress?.failed > 0 ? 'TEST_FAILURE' :
    result.receipt?.stallTimedOut || progress?.stalled || progress?.longestObservedGapMs >= 150000 ? 'STALL_TIMEOUT' :
    result.receipt?.outerTimedOut ? 'OUTER_RUNTIME_LIMIT' :
    complete ? 'SUCCESS' : 'INCOMPLETE_SUITE';
  return { classification, gateA: complete ? 'PENDING_CLEANUP' : 'FAIL', gateB: classification === 'STALL_TIMEOUT' ? 'FAIL' :
    reporterComplete && nativeComplete ? 'PASS' : 'UNPROVEN', counts,
    completedOrdinals: tap.completed, reporterOrdinals: observed?.completed ?? null,
    nativeOrdinals: progress?.completed ?? null, longestObservedCompletionGapMs: observed?.longestObservedCompletionGap.elapsedMs ?? null,
    longestNativeObservedGapMs: progress?.longestObservedGapMs ?? null,
    stallThresholdMs: progress?.stallThresholdMs ?? null };
}
export function finalizeCloneFoundationGate(gate, primaryStatus, cleanup, { native = false, runtimeRecorded = false } = {}) {
  if (!gate) return null;
  const cleanupComplete = cleanup?.status === 'PASS' && cleanup.directoryRemoved === true &&
    (!native || cleanup.residualOwnedProcesses === 0 && cleanup.processOwnership === 'NATIVE_JOB_HANDLES');
  gate.gateA = gate.classification === 'SUCCESS' && primaryStatus === 'PASS_FOUNDATION_ONLY' && cleanupComplete ? 'PASS' : 'FAIL';
  return { gateA: gate.gateA, gateB: gate.gateB, gateC: runtimeRecorded ? 'RUNTIME_RECORDED' : 'NOT_REACHED' };
}
const npmCodes = new Set(['ENOTCACHED', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'EPERM', 'EACCES', 'ENOENT', 'EBUSY', 'ERESOLVE', 'EINTEGRITY', 'EUSAGE', 'ELOCKVERIFY']);
function packageInstallEvidence(output) {
  // Fixed booleans/counters/codes only, never npm URLs, package names, paths,
  // argv, credentials, arbitrary timer labels or raw verbose output.
  const count = pattern => Math.min([...output.matchAll(pattern)].length, 65535);
  return {
    cliStarted: /\bnpm (?:verbose|verb) cli\b/u.test(output), ciRecognized: /\bnpm (?:verbose|verb) title npm ci\b/u.test(output),
    manifestRequests: count(/\bnpm (?:silly|sill) fetch manifest\b/gu), httpResponses: count(/\bnpm http fetch\b/gu),
    cacheHitResponses: count(/\(cache (?:hit|revalidated)\)/gu), cacheMissResponses: count(/\(cache miss\)/gu),
    tarballCacheMisses: count(/\bnpm (?:silly|sill) tarball no local data\b/gu), reifyRecords: count(/\bnpm (?:silly|sill) reify\b/gu),
    codes: [...new Set([...output.matchAll(/\bnpm (?:ERR!|error) code ([A-Z][A-Z0-9_]{0,40})\b/gu)].map(match => match[1]))].filter(code => npmCodes.has(code)).slice(0, 8),
  };
}
const knownCodes = new Set(['PHI_NATIVE_PROCESS_FAILED', 'PHI_NATIVE_PROCESS_INVALID_OR_CLEANUP_FAILED', 'PHI_NATIVE_PROCESS_BUILD_REQUIRED', 'PHI_NATIVE_PROCESS_BUILD_INVALID', 'PHI_NATIVE_PROCESS_CANCELLED', 'PHI_NATIVE_PROCESS_OUTPUT_LIMIT', 'PHI_NATIVE_PROCESS_SPAWN_FAILED', 'PSSecurityException']);
for (const suffix of ['PLATFORM_UNSUPPORTED', 'UNSAFE_PATH', 'COMPILER_MISSING', 'STATE_INVALID', 'IDENTITY_MISMATCH', 'COMPILE_FAILED', 'ABI_FAILED']) knownCodes.add(`PHI_WINDOWS_BUILD_${suffix}`);
for (const suffix of ['FAILED', 'PROBE_FAILED', 'PROFILE_FAILED', 'CLEANUP_FAILED', 'PROFILE_CLEANUP_FAILED', 'FILES_CLEANUP_FAILED', 'REGISTRY_CLEANUP_FAILED', 'JUNCTION_CLEANUP_FAILED', 'TOKEN_REJECTED', 'CONTROL_FAILED']) knownCodes.add(`PHI_APPCONTAINER_${suffix}`);
for (const suffix of ['ENTERED', 'REGISTRY_CHECKED', 'FILES_CHECKED', 'NETWORK_WAIT', 'CHILD_SPAWN_FAILED']) knownCodes.add(`PHI_CONFINEMENT_${suffix}`);
knownCodes.add('PHI_NATIVE_PROCESS_CLEANUP_UNATTESTED');
for (const suffix of ['UNSAFE_STATE', 'JOURNAL_FAILED', 'INJECTED_BEFORE_CLEANUP', 'INJECTED_CLEANUP_EXCEPTION']) knownCodes.add(`PHI_RECOVERY_${suffix}`);
for (const phase of ['ROOT_BASE', 'REGISTRY_BASE', 'RECEIPT', 'FILES', 'REGISTRY', 'PROFILE', 'COMMIT']) knownCodes.add(`PHI_RECOVERY_${phase}_FAILED`);
for (const phase of ['ROOT_BASE', 'PASS', 'RECEIPT']) knownCodes.add(`PHI_RECOVERY_BEGIN_${phase}_FAILED`);
for (const suffix of ['SELFTEST_FAILED', 'SELFTEST_CLEANUP_FAILED']) knownCodes.add(`PHI_RECOVERY_${suffix}`);
for (const suffix of ['SELFTEST_FAILED', 'CLEANUP_FAILED']) knownCodes.add(`PHI_ANCHORED_FILE_${suffix}`);
for (const suffix of ['OBJECT_REJECTED', 'SHARING_VIOLATION', 'ACCESS_DENIED', 'DIRECTORY_NOT_EMPTY', 'NATIVE_OTHER']) knownCodes.add(`PHI_FILESYSTEM_${suffix}`);
knownCodes.add('PHI_FILESYSTEM_NATIVE_ERROR');
knownCodes.add('PHI_FILESYSTEM_HANDLE_DISPOSITION_FAILED');
knownCodes.add('PHI_FILESYSTEM_FAILURE');
knownCodes.add('PHI_RECOVERY_STARTUP');
for (const suffix of ['NATIVE_FAILED', 'RECEIPT_INVALID', 'NATIVE_DIAGNOSTIC_INVALID', 'STATUS_FAILED', 'RESIDUAL_QUARANTINE'])
  knownCodes.add(`PHI_RECOVERY_PENDING_CONTROL_${suffix}`);
for (const stage of ['WAIT_READY', 'READY_CONTENT', 'DELETE_DENIAL', 'JOB_RECEIPT', 'OWNED_CLEANUP', 'AGGREGATION']) knownCodes.add(`PHI_CLONE_TIMEOUT_${stage}`);
for (const phase of ['NONE', 'SETUP', 'DENIAL_CONTROL', 'RETRY_CONTROL']) knownCodes.add(`PHI_RECOVERY_MAPPING_${phase}_FAILED`);
for (const suffix of ['DACL_FAILED', 'LABEL_FAILED']) knownCodes.add(`PHI_ACL_${suffix}`);
for (const suffix of ['COMMAND_UNAVAILABLE', 'RECEIPT_MISSING', 'RECEIPT_INVALID']) knownCodes.add(`PHI_VALIDATION_${suffix}`);
export function validationExceptionEvidence(error) {
  const phase = ['RESOLVE_COMMAND', 'HELPER_VALIDATION', 'SUPERVISOR_SPAWN', 'RECEIPT_PARSE', 'RECEIPT_VALIDATE'].includes(error?.validationPhase) ? error.validationPhase : 'UNKNOWN';
  const code = knownCodes.has(error?.message) ? error.message : ['ENOENT', 'EACCES', 'EPERM', 'ETIMEDOUT', 'EBUSY'].includes(error?.code) ? error.code : 'UNKNOWN';
  return { phase, code, ownership: 'UNVERIFIED' };
}
// Failure diagnostics are metadata only. Never emit command arguments/output,
// test names (which could embed user values), paths, stacks or environment.
export function validationFailureEvidence(stage, result = {}) {
  // Desktop PowerShell can emit NUL-interleaved UTF-16 / CLIXML in pipes.
  // Normalize for fixed-code recognition only; never return the decoded text.
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.replace(/\0/gu, '').replace(/_x([0-9a-f]{4})_/giu, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  const codes = [...new Set(output.match(/\b(?:CS\d{4}|PHI_[A-Z_]+|PSSecurityException)\b/gu) ?? [])].filter((code) => /^CS\d{4}$/u.test(code) || knownCodes.has(code)).slice(0, 8);
  if (/running scripts is disabled|cannot be loaded because|UnauthorizedAccess.*build-windows-process|build-windows-process.*UnauthorizedAccess/su.test(output)) codes.push('PHI_BUILD_SCRIPT_POLICY_BLOCKED');
  const number = (label) => { const value = new RegExp(`^# ${label} (\\d+)$`, 'mu').exec(output); return value ? Number(value[1]) : null; };
  // A timed-out serial TAP suite has no final # tests/# pass footer. Preserve
  // only bounded ordinal progress; subtest names may contain private values.
  const tapProgress = stage === 'foundation-tests' && result.error?.code === 'ETIMEDOUT' ? (() => {
    const completed = [...output.matchAll(/^ok (\d+)(?=\s|$)/gmu)].map(match => Number(match[1])).filter(Number.isSafeInteger);
    const started = [...output.matchAll(/^# Subtest: /gmu)].length;
    return { completed: Math.min(completed.length, 65535), lastCompleted: completed.at(-1) ?? null,
      started: Math.min(started, 65535), stdoutBytes: Math.min(Buffer.byteLength(result.stdout ?? ''), 6 * 1024 * 1024) };
  })() : undefined;
  const nativeErrorNumbers = [...new Set([...output.matchAll(/\b(?:PHI_APPCONTAINER_FAILED|PHI_NATIVE_PROCESS_FAILED|PHI_FILESYSTEM_NATIVE_ERROR):(\d{1,5})(?=[:\s]|$)/gu)].map((match) => Number(match[1])))].filter((code) => code <= 65535).slice(0, 8);
  const filesystemFailures = [];
  // Nested test/clone receipts already serialize this same safe record into
  // filesystemFailures arrays, without repeating the native tag. Recognize
  // flat records in either representation, then require the exact safe schema.
  for (const match of output.matchAll(/(\{[^{}\r\n]{1,1024}\})/gu)) {
    try {
      const value = JSON.parse(match[1]);
      const keys = ['operation', 'access', 'share', 'options', 'nativeStatus', 'nativeError', 'objectIdentity', 'leafDigest'];
      if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)) || !['ROOT_OPEN', 'NT_OPEN', 'ENUMERATE', 'DISPOSITION'].includes(value.operation) || !['access', 'options', 'nativeStatus'].every((key) => typeof value[key] === 'string' && /^[0-9a-f]{8}$/u.test(value[key])) || !Number.isInteger(value.share) || value.share < 0 || value.share > 7 || !Number.isInteger(value.nativeError) || value.nativeError < 0 || value.nativeError > 65535 || typeof value.objectIdentity !== 'string' || !/^(?:unavailable|[0-9a-f]{16}:[0-9a-f]{32})$/u.test(value.objectIdentity) || typeof value.leafDigest !== 'string' || !/^(?:|[0-9a-f]{64})$/u.test(value.leafDigest)) continue;
      filesystemFailures.push(value);
      if (filesystemFailures.length === 4) break;
    } catch { }
  }
  const test206Diagnostic = stage === 'test206' ? test206DiagnosticEvidence(result.stdout ?? '') : null;
  return { failureStage: stages.has(stage) ? stage : 'UNKNOWN', exitCode: Number.isInteger(result.status) ? result.status : null, timedOut: result.error?.code === 'ETIMEDOUT', diagnosticCodes: codes, ...(stage === 'pinned-lsp-runtime' ? { packageInstall: packageInstallEvidence(output) } : {}), ...(test206Diagnostic ? { test206Diagnostic } : {}), ...(tapProgress ? { tapProgress } : {}), ...(nativeErrorNumbers.length ? { nativeErrorNumbers } : {}), ...(filesystemFailures.length ? { filesystemFailures } : {}), testCounts: { total: number('tests'), passed: number('pass'), failed: number('fail') }, failedTestNumbers: [...output.matchAll(/^not ok (\d+)\b/gmu)].map((match) => Number(match[1])).slice(0, 16) };
}
