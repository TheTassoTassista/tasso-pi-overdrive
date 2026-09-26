[CmdletBinding()]
param([switch]$Plan)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Phi Windows bootstrap requires native Windows, not WSL.' }
if ($PSVersionTable.PSVersion -lt [Version]'5.1') { throw 'PowerShell 5.1 or newer is required.' }
if ([Environment]::OSVersion.Version.Major -lt 10) { throw 'Windows 10 / Server 2016 or newer is required.' }
$PhiRoot = Split-Path -Parent $PSScriptRoot
$PhiNode = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $PhiNode) { throw 'Install supported Node >=22.19 from nodejs.org and Git for Windows. No admin or system installer is run by Phi.' }
& $PhiNode.Source -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a<22||(a===22&&b<19)?1:0)'
if ($LASTEXITCODE -ne 0) { throw 'Node >=22.19 is required.' }
$PhiMode = if ($Plan) { '--plan' } else { '--foundation' }
& $PhiNode.Source (Join-Path $PhiRoot 'bootstrap/core.mjs') $PhiMode
if ($LASTEXITCODE -ne 0) { throw 'Phi foundation bootstrap failed.' }
if (-not $Plan) {
  Write-Warning 'Only the portable Phi foundation is installed. Native sandbox/process parity is pending; the coding engine remains fail-closed.'
  Write-Host 'Use the reported phi.cmd path, or add its directory to your user PATH. No persistent PATH or credential changes were made.'
}
