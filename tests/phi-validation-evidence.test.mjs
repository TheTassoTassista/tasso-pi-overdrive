import test from 'node:test';
import assert from 'node:assert/strict';
import { validationFailureEvidence } from '../lib/phi-validation-evidence.mjs';
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
test('failure metadata fails closed for unknown stages and records timeout without private errors', () => {
  const evidence = validationFailureEvidence('user-private-stage', { status: null, error: { code: 'ETIMEDOUT', message: 'private' } });
  assert.equal(evidence.failureStage, 'UNKNOWN'); assert.equal(evidence.exitCode, null); assert.equal(evidence.timedOut, true);
  assert.doesNotMatch(JSON.stringify(evidence), /private/u);
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
