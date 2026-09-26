import test from 'node:test';
import assert from 'node:assert/strict';
import { validationFailureEvidence } from '../lib/phi-validation-evidence.mjs';
test('clean-room failure receipt identifies its stage/codes/counts without leaking output', () => {
  const evidence = validationFailureEvidence('foundation-tests', { status: 1, stdout: 'not ok 12 - secret-fixture-value\n# tests 47\n# pass 39\n# fail 1', stderr: 'private-path secret-fixture-value error CS1234 PHI_NATIVE_PROCESS_FAILED PHI_USER_PRIVATE_SECRET_VALUE private contents' });
  assert.deepEqual(evidence, { failureStage: 'foundation-tests', exitCode: 1, timedOut: false, diagnosticCodes: ['CS1234', 'PHI_NATIVE_PROCESS_FAILED'], testCounts: { total: 47, passed: 39, failed: 1 }, failedTestNumbers: [12] });
  assert.doesNotMatch(JSON.stringify(evidence), /private|secret-fixture-value|PRIVATE_SECRET/u);
});
test('failure metadata fails closed for unknown stages and records timeout without private errors', () => {
  const evidence = validationFailureEvidence('user-private-stage', { status: null, error: { code: 'ETIMEDOUT', message: 'private' } });
  assert.equal(evidence.failureStage, 'UNKNOWN'); assert.equal(evidence.exitCode, null); assert.equal(evidence.timedOut, true);
  assert.doesNotMatch(JSON.stringify(evidence), /private/u);
});
