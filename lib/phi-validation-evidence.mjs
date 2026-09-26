const stages = new Set(['git-source', 'source-dependencies', 'windows-process-build', 'foundation-bootstrap', 'doctor', 'foundation-tests', 'brand-smoke']);
const knownCodes = new Set(['PHI_NATIVE_PROCESS_FAILED', 'PHI_NATIVE_PROCESS_INVALID_OR_CLEANUP_FAILED', 'PHI_NATIVE_PROCESS_BUILD_REQUIRED', 'PHI_NATIVE_PROCESS_BUILD_INVALID', 'PHI_NATIVE_PROCESS_CANCELLED', 'PHI_NATIVE_PROCESS_OUTPUT_LIMIT', 'PHI_NATIVE_PROCESS_SPAWN_FAILED', 'PSSecurityException']);
// Failure diagnostics are metadata only. Never emit command arguments/output,
// test names (which could embed user values), paths, stacks or environment.
export function validationFailureEvidence(stage, result = {}) {
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const codes = [...new Set(output.match(/\b(?:CS\d{4}|PHI_[A-Z_]+|PSSecurityException)\b/gu) ?? [])].filter((code) => /^CS\d{4}$/u.test(code) || knownCodes.has(code)).slice(0, 8);
  if (/running scripts is disabled|cannot be loaded because|UnauthorizedAccess.*build-windows-process|build-windows-process.*UnauthorizedAccess/su.test(output)) codes.push('PHI_BUILD_SCRIPT_POLICY_BLOCKED');
  const number = (label) => { const value = new RegExp(`^# ${label} (\\d+)$`, 'mu').exec(output); return value ? Number(value[1]) : null; };
  return { failureStage: stages.has(stage) ? stage : 'UNKNOWN', exitCode: Number.isInteger(result.status) ? result.status : null, timedOut: result.error?.code === 'ETIMEDOUT', diagnosticCodes: codes, testCounts: { total: number('tests'), passed: number('pass'), failed: number('fail') }, failedTestNumbers: [...output.matchAll(/^not ok (\d+)\b/gmu)].map((match) => Number(match[1])).slice(0, 16) };
}
