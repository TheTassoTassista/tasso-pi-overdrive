const stages = new Set(['git-source', 'source-dependencies', 'windows-process-build', 'foundation-bootstrap', 'doctor', 'foundation-tests', 'brand-smoke']);
const knownCodes = new Set(['PHI_NATIVE_PROCESS_FAILED', 'PHI_NATIVE_PROCESS_INVALID_OR_CLEANUP_FAILED', 'PHI_NATIVE_PROCESS_BUILD_REQUIRED', 'PHI_NATIVE_PROCESS_BUILD_INVALID', 'PHI_NATIVE_PROCESS_CANCELLED', 'PHI_NATIVE_PROCESS_OUTPUT_LIMIT', 'PHI_NATIVE_PROCESS_SPAWN_FAILED', 'PSSecurityException']);
for (const suffix of ['PLATFORM_UNSUPPORTED', 'UNSAFE_PATH', 'COMPILER_MISSING', 'STATE_INVALID', 'IDENTITY_MISMATCH', 'COMPILE_FAILED', 'ABI_FAILED']) knownCodes.add(`PHI_WINDOWS_BUILD_${suffix}`);
for (const suffix of ['FAILED', 'PROBE_FAILED', 'PROFILE_FAILED', 'CLEANUP_FAILED', 'TOKEN_REJECTED', 'CONTROL_FAILED']) knownCodes.add(`PHI_APPCONTAINER_${suffix}`);
knownCodes.add('PHI_NATIVE_PROCESS_CLEANUP_UNATTESTED');
// Failure diagnostics are metadata only. Never emit command arguments/output,
// test names (which could embed user values), paths, stacks or environment.
export function validationFailureEvidence(stage, result = {}) {
  // Desktop PowerShell can emit NUL-interleaved UTF-16 / CLIXML in pipes.
  // Normalize for fixed-code recognition only; never return the decoded text.
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.replace(/\0/gu, '').replace(/_x([0-9a-f]{4})_/giu, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  const codes = [...new Set(output.match(/\b(?:CS\d{4}|PHI_[A-Z_]+|PSSecurityException)\b/gu) ?? [])].filter((code) => /^CS\d{4}$/u.test(code) || knownCodes.has(code)).slice(0, 8);
  if (/running scripts is disabled|cannot be loaded because|UnauthorizedAccess.*build-windows-process|build-windows-process.*UnauthorizedAccess/su.test(output)) codes.push('PHI_BUILD_SCRIPT_POLICY_BLOCKED');
  const number = (label) => { const value = new RegExp(`^# ${label} (\\d+)$`, 'mu').exec(output); return value ? Number(value[1]) : null; };
  return { failureStage: stages.has(stage) ? stage : 'UNKNOWN', exitCode: Number.isInteger(result.status) ? result.status : null, timedOut: result.error?.code === 'ETIMEDOUT', diagnosticCodes: codes, testCounts: { total: number('tests'), passed: number('pass'), failed: number('fail') }, failedTestNumbers: [...output.matchAll(/^not ok (\d+)\b/gmu)].map((match) => Number(match[1])).slice(0, 16) };
}
