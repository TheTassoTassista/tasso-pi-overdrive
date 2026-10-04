import test from 'node:test';
import assert from 'node:assert/strict';
import { validationFailureEvidence, validationExceptionEvidence } from '../lib/phi-validation-evidence.mjs';
const failure = { operation: 'NT_OPEN', access: '00110080', share: 1, options: '00200060', nativeStatus: 'c0000043', nativeError: 32, objectIdentity: `${'a'.repeat(16)}:${'b'.repeat(32)}`, leafDigest: 'c'.repeat(64) };
test('pre-receipt controller exceptions preserve fixed phase/code without private exception context', () => {
  for (const [phase, code] of [['RESOLVE_COMMAND', 'PHI_VALIDATION_COMMAND_UNAVAILABLE'], ['HELPER_VALIDATION', 'PHI_NATIVE_PROCESS_BUILD_INVALID'], ['SUPERVISOR_SPAWN', 'ENOENT'], ['RECEIPT_PARSE', 'PHI_VALIDATION_RECEIPT_MISSING'], ['RECEIPT_VALIDATE', 'PHI_VALIDATION_RECEIPT_INVALID']]) {
    const row = validationExceptionEvidence({ validationPhase: phase, message: code.startsWith('PHI_') ? code : 'PRIVATE_CONTEXT', code, path: 'PRIVATE_PATH', stack: 'PRIVATE_STACK' });
    assert.deepEqual(row, { phase, code, ownership: 'UNVERIFIED' });
    assert.doesNotMatch(JSON.stringify(row), /PRIVATE/u);
  }
  assert.deepEqual(validationExceptionEvidence({ validationPhase: 'PRIVATE', message: 'PHI_PRIVATE_VALUE' }), { phase: 'UNKNOWN', code: 'UNKNOWN', ownership: 'UNVERIFIED' });
});
test('native operation evidence preserves actual rights/status/identity but no resource names', () => {
  const result = validationFailureEvidence('foundation-tests', { stderr: `PHI_FILESYSTEM_FAILURE:${JSON.stringify(failure)}\nprivate-path private-content` });
  assert.deepEqual(result.filesystemFailures, [failure]);
  assert.doesNotMatch(JSON.stringify(result), /private-path|private-content/u);
});
test('native operation evidence rejects malformed, private, coercible or unknown metadata', () => {
  for (const value of [{ ...failure, path: 'private' }, { ...failure, operation: 'private' }, { ...failure, access: 12345678 }, { ...failure, share: 8 }, { ...failure, nativeError: -1 }, { ...failure, objectIdentity: 'private' }, { ...failure, leafDigest: 'private' }, null]) {
    assert.equal(validationFailureEvidence('foundation-tests', { stderr: `PHI_FILESYSTEM_FAILURE:${JSON.stringify(value)}` }).filesystemFailures, undefined);
  }
  assert.equal(validationFailureEvidence('foundation-tests', { stderr: 'PHI_FILESYSTEM_FAILURE:{private malformed}' }).filesystemFailures, undefined);
});
test('native operation evidence is limited to four validated records', () => {
  const result = validationFailureEvidence('foundation-tests', { stderr: Array.from({ length: 8 }, () => `PHI_FILESYSTEM_FAILURE:${JSON.stringify(failure)}`).join('\n') });
  assert.deepEqual(result.filesystemFailures, Array(4).fill(failure));
});
test('nested native test receipts preserve the failing API through clone redaction', () => {
  const result = validationFailureEvidence('foundation-tests', { stdout: `error: |-\n  ${JSON.stringify({ filesystemFailures: [failure], privateContent: 'DO_NOT_ECHO' })}` });
  assert.deepEqual(result.filesystemFailures, [failure]);
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_ECHO|privateContent/u);
});
test('native failure preserves bounded Win32 error numbers without raw context', () => {
  const result = validationFailureEvidence('foundation-tests', { stderr: 'PHI_APPCONTAINER_FAILED:32 private-file PHI_NATIVE_PROCESS_FAILED:5:CREATE PHI_APPCONTAINER_FAILED:99999 secret' });
  assert.deepEqual(result.nativeErrorNumbers, [32, 5]);
  assert.doesNotMatch(JSON.stringify(result), /private-file|secret|99999/u);
});
test('filesystem diagnostics publish bounded fixed-code error numbers only', () => {
  const row = validationFailureEvidence('foundation-tests', { stderr: 'PHI_FILESYSTEM_NATIVE_OTHER PHI_FILESYSTEM_NATIVE_ERROR:87 private-target PHI_FILESYSTEM_NATIVE_ERROR:12345 PHI_FILESYSTEM_NATIVE_ERROR:99999 PHI_USER_ERROR:6' });
  assert.deepEqual(row.nativeErrorNumbers, [87, 12345]);
  assert.deepEqual(row.diagnosticCodes, ['PHI_FILESYSTEM_NATIVE_OTHER', 'PHI_FILESYSTEM_NATIVE_ERROR']);
  assert.doesNotMatch(JSON.stringify(row), /private-target|99999|USER_ERROR/u);
});
test('clean-room failure receipt identifies its stage/codes/counts without leaking output', () => {
  const evidence = validationFailureEvidence('foundation-tests', { status: 1, stdout: 'not ok 12 - secret-fixture-value\n# tests 47\n# pass 39\n# fail 1', stderr: 'private-path secret-fixture-value error CS1234 PHI_NATIVE_PROCESS_FAILED PHI_USER_PRIVATE_SECRET_VALUE PHI_WINDOWS_BUILD_SECRET_VALUE private contents' });
  assert.deepEqual(evidence, { failureStage: 'foundation-tests', exitCode: 1, timedOut: false, diagnosticCodes: ['CS1234', 'PHI_NATIVE_PROCESS_FAILED'], testCounts: { total: 47, passed: 39, failed: 1 }, failedTestNumbers: [12] });
  assert.doesNotMatch(JSON.stringify(evidence), /private|secret-fixture-value|PRIVATE_SECRET/u);
});
test('timed-out clone foundation suite retains only bounded serial TAP ordinals', () => {
  const row = validationFailureEvidence('foundation-tests', { status: 124, error: { code: 'ETIMEDOUT' },
    stdout: '# Subtest: private-secret-one\nok 1 - private-secret-one\n# Subtest: private-secret-two\nok 2 - private-secret-two\n# Subtest: private-secret-three\n' });
  assert.deepEqual(row.tapProgress, { completed: 2, lastCompleted: 2, started: 3,
    stdoutBytes: Buffer.byteLength('# Subtest: private-secret-one\nok 1 - private-secret-one\n# Subtest: private-secret-two\nok 2 - private-secret-two\n# Subtest: private-secret-three\n') });
  assert.doesNotMatch(JSON.stringify(row), /private-secret/u);
  assert.equal(validationFailureEvidence('foundation-tests', { status: 0, stdout: 'ok 1 - safe\n' }).tapProgress, undefined);
});
test('clone timeout failure stage survives redaction as a fixed code only', () => {
  const row = validationFailureEvidence('foundation-tests', { status: 1, stdout: '# PHI_CLONE_TIMEOUT_DELETE_DENIAL private-path\n# fail 1' });
  assert.deepEqual(row.diagnosticCodes, ['PHI_CLONE_TIMEOUT_DELETE_DENIAL']);
  assert.doesNotMatch(JSON.stringify(row), /private-path/u);
  assert.deepEqual(validationFailureEvidence('foundation-tests', { stdout: '# PHI_CLONE_TIMEOUT_PRIVATE' }).diagnosticCodes, []);
});
test('sequential recovery control failure retains only fixed diagnostic stages', () => {
  const row = validationFailureEvidence('foundation-tests', { status: 1, stdout:
    '# PHI_RECOVERY_PENDING_CONTROL_NATIVE_DIAGNOSTIC_INVALID private-path\nnot ok 1 - private-case\n# tests 13\n# pass 12\n# fail 1' });
  assert.deepEqual(row.diagnosticCodes, ['PHI_RECOVERY_PENDING_CONTROL_NATIVE_DIAGNOSTIC_INVALID']);
  assert.deepEqual(row.failedTestNumbers, [1]);
  assert.doesNotMatch(JSON.stringify(row), /private-path|private-case/u);
});
test('failure metadata fails closed for unknown stages and records timeout without private errors', () => {
  const evidence = validationFailureEvidence('user-private-stage', { status: null, error: { code: 'ETIMEDOUT', message: 'private' } });
  assert.equal(evidence.failureStage, 'UNKNOWN'); assert.equal(evidence.exitCode, null); assert.equal(evidence.timedOut, true);
  assert.doesNotMatch(JSON.stringify(evidence), /private/u);
});
test('reproduced pinned runtime timeout identifies the real stage and only fixed npm progress metadata', () => {
  const row = validationFailureEvidence('pinned-lsp-runtime', { status: 124, error: { code: 'ETIMEDOUT', message: 'PRIVATE_ERROR' }, stderr: [
    'npm verbose cli PRIVATE_NODE PRIVATE_NPM', 'npm verbose title npm ci --prefix PRIVATE_PATH',
    'npm silly fetch manifest PRIVATE_PACKAGE', 'npm silly fetch manifest PRIVATE_PACKAGE',
    'npm http fetch GET 200 https://PRIVATE_URL/?token=PRIVATE_TOKEN (cache hit)',
    'npm http fetch GET 200 https://PRIVATE_URL (cache miss)', 'npm silly tarball no local data for PRIVATE_PACKAGE',
    'npm silly reify moves PRIVATE_PATH', 'npm error code ECONNRESET', 'npm error code PRIVATE_CODE',
  ].join('\n') });
  assert.equal(row.failureStage, 'pinned-lsp-runtime'); assert.equal(row.timedOut, true); assert.equal(row.exitCode, 124);
  assert.deepEqual(row.packageInstall, { cliStarted: true, ciRecognized: true, manifestRequests: 2, httpResponses: 2,
    cacheHitResponses: 1, cacheMissResponses: 1, tarballCacheMisses: 1, reifyRecords: 1, codes: ['ECONNRESET'] });
  assert.doesNotMatch(JSON.stringify(row), /PRIVATE|https:|token=/u);
});
test('npm diagnostic data is absent outside the fixed install stage and deduplicates/bounds known codes', () => {
  const stderr = Array(20).fill('npm error code ENOTCACHED\nnpm error code PRIVATE_CODE').join('\n');
  assert.equal(validationFailureEvidence('foundation-tests', { stderr }).packageInstall, undefined);
  assert.deepEqual(validationFailureEvidence('pinned-lsp-runtime', { stderr }).packageInstall.codes, ['ENOTCACHED']);
  assert.equal(validationFailureEvidence('pinned-lsp-runtime').packageInstall.cliStarted, false);
});
test('native PowerShell policy failure is reduced to a fixed code, never its path or command', () => {
  const evidence = validationFailureEvidence('windows-process-build', { status: 1, stderr: 'private-script-path cannot be loaded because running scripts is disabled on this system private-command' });
  assert.deepEqual(evidence.diagnosticCodes, ['PHI_BUILD_SCRIPT_POLICY_BLOCKED']);
  assert.doesNotMatch(JSON.stringify(evidence), /private/u);
});
test('Desktop PowerShell pipe encodings preserve fixed diagnostics without publishing decoded text', () => {
  const error = 'PHI_WINDOWS_BUILD_COMPILER_MISSING private-path';
  const evidence = validationFailureEvidence('windows-process-build', { status: 1, stderr: [...error].join('\0') });
  assert.deepEqual(evidence.diagnosticCodes, ['PHI_WINDOWS_BUILD_COMPILER_MISSING']);
  assert.doesNotMatch(JSON.stringify(evidence), /private/u);
  assert.deepEqual(validationFailureEvidence('windows-process-build', { status: 1, stderr: 'PHI_x005F_WINDOWS_BUILD_x005F_COMPILER_MISSING' }).diagnosticCodes, ['PHI_WINDOWS_BUILD_COMPILER_MISSING']);
});
