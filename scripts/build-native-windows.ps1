<#
.SYNOPSIS
  Build one Windows MSVC target and create a target-named bundle.

The script expects a private absolute Cargo target directory. Cross-target
builds are staged without execution; native target jobs run both C smoke tests.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc", "i686-pc-windows-msvc")]
  [string] $Target,

  [Parameter(Mandatory = $true)]
  [string] $OutputRoot,

  [Parameter(Mandatory = $true)]
  [string] $Version,

  [int] $AbiVersion = 1,
  [string] $CargoTargetDir = $env:CARGO_TARGET_DIR
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\")).Path

if (-not [IO.Path]::IsPathRooted($OutputRoot) -or
    [string]::IsNullOrWhiteSpace($CargoTargetDir) -or
    -not [IO.Path]::IsPathRooted($CargoTargetDir)) {
  throw "OutputRoot and CargoTargetDir must be absolute paths"
}

New-Item -ItemType Directory -Force -Path $OutputRoot, $CargoTargetDir | Out-Null
$env:CARGO_TARGET_DIR = $CargoTargetDir
$BuildDir = Join-Path $CargoTargetDir "$Target\release"
$BaseName = "htmltrust_canonicalization_ffi"
$Dynamic = Join-Path $BuildDir "$BaseName.dll"
$Static = Join-Path $BuildDir "$BaseName.lib"
$Import = Join-Path $BuildDir "$BaseName.dll.lib"
$Header = Join-Path $Root "ffi\include\htmltrust_canonicalization.h"

function Get-NativeMsvcHostArchitecture {
  if ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() -eq "Arm64") {
    return "arm64"
  }
  return "x64"
}

function Initialize-MsvcEnvironment([string] $Architecture) {
  $VsWhereCandidates = @()
  $VsWhereCommand = Get-Command vswhere.exe -ErrorAction SilentlyContinue
  if ($null -ne $VsWhereCommand) {
    $VsWhereCandidates += $VsWhereCommand.Source
  }
  if (-not [string]::IsNullOrEmpty(${env:ProgramFiles(x86)})) {
    $VsWhereCandidates += (Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe")
  }
  $VsWhere = $VsWhereCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if ($null -eq $VsWhere) { return $false }

  $RequiredComponent = if ($Architecture -eq "arm64") {
    "Microsoft.VisualStudio.Component.VC.Tools.ARM64"
  }
  else {
    "Microsoft.VisualStudio.Component.VC.Tools.x86.x64"
  }
  $Install = (& $VsWhere -latest -products * -requires $RequiredComponent -property installationPath | Select-Object -First 1)
  if ([string]::IsNullOrWhiteSpace($Install)) { return $false }
  $VsDevCmd = Join-Path $Install "Common7\Tools\VsDevCmd.bat"
  if (-not (Test-Path -LiteralPath $VsDevCmd)) { return $false }

  $HostArchitecture = Get-NativeMsvcHostArchitecture
  $Command = "`"$VsDevCmd`" -arch=$Architecture -host_arch=$HostArchitecture >nul && set"
  $Environment = & cmd.exe /d /s /c $Command
  if ($LASTEXITCODE -ne 0) { return $false }
  foreach ($Line in $Environment) {
    if ($Line -match "^([^=]+)=(.*)$") {
      Set-Item -Path "Env:$($Matches[1])" -Value $Matches[2]
    }
  }
  return $true
}

$MsvcArchitecture = if ($Target -eq "i686-pc-windows-msvc") { "x86" } elseif ($Target -eq "aarch64-pc-windows-msvc") { "arm64" } else { "x64" }
$MsvcInitialized = Initialize-MsvcEnvironment $MsvcArchitecture
if (-not $MsvcInitialized -and $env:VSCMD_ARG_TGT_ARCH -ne $MsvcArchitecture) {
  throw "Windows builds require the $MsvcArchitecture MSVC environment (VsDevCmd -arch=$MsvcArchitecture)"
}

Write-Host ">> Building $Target"
Push-Location (Join-Path $Root "ffi")
try {
  & cargo build --locked --release --target $Target
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
finally {
  Pop-Location
}

foreach ($Path in @($Dynamic, $Static, $Import, $Header)) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Required artifact is missing: $Path"
  }
}

$HostArchitecture = if ((Get-NativeMsvcHostArchitecture) -eq "arm64") { "aarch64" } else { "x86_64" }
$HostTarget = "$HostArchitecture-pc-windows-msvc"
$Compiler = Get-Command cl.exe -ErrorAction SilentlyContinue
$RunnableOnX64 = $Target -eq "i686-pc-windows-msvc" -and $HostArchitecture -eq "x86_64"
if ($Target -eq $HostTarget -or $RunnableOnX64) {
  if ($null -eq $Compiler) {
    throw "Native smoke tests require cl.exe in PATH"
  }

  $SmokeRoot = Join-Path $OutputRoot ".smoke-$Target"
  if (Test-Path -LiteralPath $SmokeRoot) {
    Remove-Item -LiteralPath $SmokeRoot -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $SmokeRoot | Out-Null
  $SmokeSource = Join-Path $Root "ffi\tests\header_smoke.c"
  $Include = Join-Path $Root "ffi\include"

  Write-Host ">> Dynamic C header smoke test ($Target)"
  & $Compiler.Source /nologo /std:c11 /W4 /WX /I$Include $SmokeSource `
    /link /LIBPATH:$BuildDir $Import /OUT:$(Join-Path $SmokeRoot "header-smoke.exe")
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  $OldPath = $env:PATH
  try {
    $env:PATH = "$BuildDir;$OldPath"
    & (Join-Path $SmokeRoot "header-smoke.exe")
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
  finally {
    $env:PATH = $OldPath
  }

  Write-Host ">> Static C header smoke test ($Target)"
  & $Compiler.Source /nologo /std:c11 /W4 /WX /I$Include $SmokeSource $Static `
    /link bcrypt.lib advapi32.lib userenv.lib ws2_32.lib ntdll.lib `
    /OUT:$(Join-Path $SmokeRoot "header-smoke-static.exe")
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & (Join-Path $SmokeRoot "header-smoke-static.exe")
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$Name = "htmltrust-canonicalization-ffi-v$Version-abi$AbiVersion-$Target"
$Helper = Join-Path $Root "scripts\artifact_bundle.py"
$Python = Get-Command python.exe -ErrorAction SilentlyContinue
$PythonArgs = @()
if ($null -eq $Python) {
  $Python = Get-Command py.exe -ErrorAction SilentlyContinue
  $PythonArgs = @("-3")
}
if ($null -eq $Python) { throw "Python 3 is required for manifest/archive creation" }

& $Python.Source @PythonArgs $Helper `
  --root $Root `
  --output-root $OutputRoot `
  --name $Name `
  --version $Version `
  --abi-version $AbiVersion `
  --target $Target `
  --format zip `
  --dynamic $Dynamic `
  --static $Static `
  --import $Import `
  --header $Header
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Wrote $(Join-Path $OutputRoot "$Name.zip")"
