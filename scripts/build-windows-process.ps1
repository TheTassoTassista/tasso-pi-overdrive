[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitProcess) { throw 'PHI_WINDOWS_BUILD_PLATFORM_UNSUPPORTED' }
$PhiSourceRoot = Split-Path -Parent $PSScriptRoot
$PhiNativeSource = Join-Path $PhiSourceRoot 'platform/windows/native/OwnedProcess.cs'
$PhiBuildRoot = Join-Path $PhiSourceRoot '.phi-cache/windows/process'
foreach ($PhiDirectory in @($PhiSourceRoot, (Join-Path $PhiSourceRoot '.phi-cache'), (Join-Path $PhiSourceRoot '.phi-cache/windows'), $PhiBuildRoot)) {
  if (Test-Path -LiteralPath $PhiDirectory) {
    $PhiItem = Get-Item -LiteralPath $PhiDirectory -Force
    if (($PhiItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not $PhiItem.PSIsContainer) { throw 'PHI_WINDOWS_BUILD_UNSAFE_PATH' }
  } else { New-Item -ItemType Directory -Path $PhiDirectory | Out-Null }
}
$PhiCompiler = Join-Path ([Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()) 'csc.exe'
if (-not (Test-Path -LiteralPath $PhiCompiler -PathType Leaf)) { throw 'PHI_WINDOWS_BUILD_COMPILER_MISSING' }
$PhiBinary = Join-Path $PhiBuildRoot 'phi-owned-process.exe'
$PhiManifestPath = Join-Path $PhiBuildRoot 'manifest.json'
if (Test-Path -LiteralPath $PhiBinary) {
  if (-not (Test-Path -LiteralPath $PhiManifestPath -PathType Leaf)) { throw 'PHI_WINDOWS_BUILD_STATE_INVALID' }
  $PhiExisting = Get-Content -Raw -LiteralPath $PhiManifestPath | ConvertFrom-Json
  if ($PhiExisting.schemaVersion -ne 1 -or $PhiExisting.abi -ne 1 -or $PhiExisting.sourceSha256 -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $PhiNativeSource).Hash.ToLowerInvariant() -or $PhiExisting.binarySha256 -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $PhiBinary).Hash.ToLowerInvariant()) { throw 'PHI_WINDOWS_BUILD_IDENTITY_MISMATCH' }
  Write-Host 'Phi native process build already matches the tracked source.'
  exit 0
}
if (Test-Path -LiteralPath $PhiManifestPath) { throw 'PHI_WINDOWS_BUILD_STATE_INVALID' }
& $PhiCompiler '/nologo' '/target:exe' '/platform:x64' '/optimize+' '/reference:System.Web.Extensions.dll' "/out:$PhiBinary" $PhiNativeSource
if ($LASTEXITCODE -ne 0) { throw 'PHI_WINDOWS_BUILD_COMPILE_FAILED' }
& $PhiBinary '--version'
if ($LASTEXITCODE -ne 0) { throw 'PHI_WINDOWS_BUILD_ABI_FAILED' }
$PhiManifest = @{ schemaVersion = 1; abi = 1; sourceSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $PhiNativeSource).Hash.ToLowerInvariant(); binarySha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $PhiBinary).Hash.ToLowerInvariant() }
$PhiManifest | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath $PhiManifestPath
Write-Host 'Phi trusted Windows process backend built from tracked source. NOT a sandbox; autonomous engine remains blocked.'
