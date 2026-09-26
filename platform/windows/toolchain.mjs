import { spawnSync } from 'node:child_process';

// Read-only identity probe. Fixed code, no interpolated paths/user commands,
// no filesystem contents, credential access or persistent policy changes.
const identityProbe = `[Console]::Out.WriteLine((@{edition=$PSVersionTable.PSEdition;major=$PSVersionTable.PSVersion.Major;x64=[Environment]::Is64BitProcess;policy=(Get-ExecutionPolicy).ToString();language=$ExecutionContext.SessionState.LanguageMode.ToString();compilerPresent=(Test-Path -LiteralPath (Join-Path ([Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()) 'csc.exe'));systemDesktop=($PSHOME -eq (Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell/v1.0'))}|ConvertTo-Json -Compress))`;
export function windowsBuildEnvironment() {
  if (process.platform !== 'win32') return { status: 'NOT_NATIVE_WINDOWS' };
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', identityProbe], { encoding: 'utf8', shell: false, windowsHide: true, timeout: 5000, maxBuffer: 16384 });
  if (result.status !== 0) return { status: 'PROBE_FAILED', exitCode: Number.isInteger(result.status) ? result.status : null };
  try {
    const record = JSON.parse(result.stdout.replace(/\0/gu, '').replace(/^\uFEFF/u, '').trim());
    const select = (key, values) => values.includes(record[key]) ? record[key] : 'UNKNOWN';
    return { status: 'IDENTITY_ONLY', edition: select('edition', ['Desktop', 'Core']), major: [5, 7].includes(record.major) ? record.major : null, x64: record.x64 === true, policy: select('policy', ['Restricted', 'AllSigned', 'RemoteSigned', 'Unrestricted', 'Bypass', 'Undefined']), language: select('language', ['FullLanguage', 'ConstrainedLanguage', 'RestrictedLanguage', 'NoLanguage']), compilerPresent: record.compilerPresent === true, systemDesktop: record.systemDesktop === true };
  } catch { return { status: 'PROBE_FORMAT_INVALID' }; }
}
