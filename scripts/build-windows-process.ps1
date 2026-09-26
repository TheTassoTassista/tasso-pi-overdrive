[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitProcess) { throw 'PHI_WINDOWS_BUILD_PLATFORM_UNSUPPORTED' }
$PhiSourceRoot = Split-Path -Parent $PSScriptRoot
$PhiNode = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
& $PhiNode.Source (Join-Path $PhiSourceRoot 'scripts/build-windows-process.mjs')
if ($LASTEXITCODE -ne 0) { throw 'PHI_WINDOWS_BUILD_STATE_INVALID' }
Write-Host 'Phi trusted Windows process backend built from tracked source. NOT a sandbox; autonomous engine remains blocked.'
