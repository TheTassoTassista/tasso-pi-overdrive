const stages = new Set(['git-source', 'source-dependencies', 'windows-process-build', 'foundation-bootstrap', 'doctor', 'foundation-tests', 'brand-smoke']);
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
for (const phase of ['NONE', 'SETUP', 'DENIAL_CONTROL', 'RETRY_CONTROL']) knownCodes.add(`PHI_RECOVERY_MAPPING_${phase}_FAILED`);
for (const suffix of ['DACL_FAILED', 'LABEL_FAILED']) knownCodes.add(`PHI_ACL_${suffix}`);
// Failure diagnostics are metadata only. Never emit command arguments/output,
// test names (which could embed user values), paths, stacks or environment.
export function validationFailureEvidence(stage, result = {}) {
  // Desktop PowerShell can emit NUL-interleaved UTF-16 / CLIXML in pipes.
  // Normalize for fixed-code recognition only; never return the decoded text.
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.replace(/\0/gu, '').replace(/_x([0-9a-f]{4})_/giu, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  const codes = [...new Set(output.match(/\b(?:CS\d{4}|PHI_[A-Z_]+|PSSecurityException)\b/gu) ?? [])].filter((code) => /^CS\d{4}$/u.test(code) || knownCodes.has(code)).slice(0, 8);
  if (/running scripts is disabled|cannot be loaded because|UnauthorizedAccess.*build-windows-process|build-windows-process.*UnauthorizedAccess/su.test(output)) codes.push('PHI_BUILD_SCRIPT_POLICY_BLOCKED');
  const number = (label) => { const value = new RegExp(`^# ${label} (\\d+)$`, 'mu').exec(output); return value ? Number(value[1]) : null; };
  const nativeErrorNumbers = [...new Set([...output.matchAll(/\b(?:PHI_APPCONTAINER_FAILED|PHI_NATIVE_PROCESS_FAILED|PHI_FILESYSTEM_NATIVE_ERROR):(\d{1,5})(?=[:\s]|$)/gu)].map((match) => Number(match[1])))].filter((code) => code <= 65535).slice(0, 8);
  const filesystemFailures = [];
  for (const match of output.matchAll(/PHI_FILESYSTEM_FAILURE:(\{[^\r\n]{1,1024}\})/gu)) {
    try {
      const value = JSON.parse(match[1]);
      const keys = ['operation', 'access', 'share', 'options', 'nativeStatus', 'nativeError', 'objectIdentity', 'leafDigest'];
      if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)) || !['ROOT_OPEN', 'NT_OPEN', 'ENUMERATE', 'DISPOSITION'].includes(value.operation) || !['access', 'options', 'nativeStatus'].every((key) => typeof value[key] === 'string' && /^[0-9a-f]{8}$/u.test(value[key])) || !Number.isInteger(value.share) || value.share < 0 || value.share > 7 || !Number.isInteger(value.nativeError) || value.nativeError < 0 || value.nativeError > 65535 || typeof value.objectIdentity !== 'string' || !/^(?:unavailable|[0-9a-f]{16}:[0-9a-f]{32})$/u.test(value.objectIdentity) || typeof value.leafDigest !== 'string' || !/^(?:|[0-9a-f]{64})$/u.test(value.leafDigest)) continue;
      filesystemFailures.push(value);
      if (filesystemFailures.length === 4) break;
    } catch { }
  }
  return { failureStage: stages.has(stage) ? stage : 'UNKNOWN', exitCode: Number.isInteger(result.status) ? result.status : null, timedOut: result.error?.code === 'ETIMEDOUT', diagnosticCodes: codes, ...(nativeErrorNumbers.length ? { nativeErrorNumbers } : {}), ...(filesystemFailures.length ? { filesystemFailures } : {}), testCounts: { total: number('tests'), passed: number('pass'), failed: number('fail') }, failedTestNumbers: [...output.matchAll(/^not ok (\d+)\b/gmu)].map((match) => Number(match[1])).slice(0, 16) };
}
