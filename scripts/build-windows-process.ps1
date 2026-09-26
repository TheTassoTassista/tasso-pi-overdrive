[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitProcess) { throw 'Phi native process build requires x64 native Windows.' }
$PhiSourceRoot = Split-Path -Parent $PSScriptRoot
$PhiNativeSource = Join-Path $PhiSourceRoot 'platform/windows/native/OwnedProcess.cs'
$PhiBuildRoot = Join-Path $PhiSourceRoot '.phi-cache/windows/process'
foreach ($PhiDirectory in @($PhiSourceRoot, (Join-Path $PhiSourceRoot '.phi-cache'), (Join-Path $PhiSourceRoot '.phi-cache/windows'), $PhiBuildRoot)) {
  if (Test-Path -LiteralPath $PhiDirectory) {
    $PhiItem = Get-Item -LiteralPath $PhiDirectory -Force
    if (($PhiItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not $PhiItem.PSIsContainer) { throw 'Phi build directory is unsafe.' }
  } else { New-Item -ItemType Directory -Path $PhiDirectory | Out-Null }
}
$PhiCompiler = Join-Path ([Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()) 'csc.exe'
if (-not (Test-Path -LiteralPath $PhiCompiler -PathType Leaf)) { throw 'Use Windows PowerShell 5.1 with the system .NET Framework compiler; Phi does not download a compiler.' }
$PhiBinary = Join-Path $PhiBuildRoot 'phi-owned-process.exe'
$PhiManifestPath = Join-Path $PhiBuildRoot 'manifest.json'
if (Test-Path -LiteralPath $PhiBinary) {
  if (-not (Test-Path -LiteralPath $PhiManifestPath -PathType Leaf)) { throw 'Existing build has no manifest; refusing overwrite.' }
  $PhiExisting = Get-Content -Raw -LiteralPath $PhiManifestPath | ConvertFrom-Json
  if ($PhiExisting.schemaVersion -ne 1 -or $PhiExisting.abi -ne 1 -or $PhiExisting.sourceSha256 -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $PhiNativeSource).Hash.ToLowerInvariant() -or $PhiExisting.binarySha256 -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $PhiBinary).Hash.ToLowerInvariant()) { throw 'Existing build identity differs; use a fresh checkout, not an implicit overwrite.' }
  Write-Host 'Phi native process build already matches the tracked source.'
  exit 0
}
if (Test-Path -LiteralPath $PhiManifestPath) { throw 'Manifest without build; refusing inconsistent state.' }
& $PhiCompiler '/nologo' '/target:exe' '/platform:x64' '/optimize+' '/reference:System.Web.Extensions.dll' "/out:$PhiBinary" $PhiNativeSource
if ($LASTEXITCODE -ne 0) { throw 'Phi native process compilation failed.' }
& $PhiBinary '--version'
if ($LASTEXITCODE -ne 0) { throw 'Phi native process ABI check failed.' }
$PhiManifest = @{ schemaVersion = 1; abi = 1; sourceSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $PhiNativeSource).Hash.ToLowerInvariant(); binarySha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $PhiBinary).Hash.ToLowerInvariant() }
$PhiManifest | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath $PhiManifestPath
Write-Host 'Phi trusted Windows process backend built from tracked source. NOT a sandbox; autonomous engine remains blocked.'
