$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$uproject = Join-Path $root 'UE\HiveTest\HiveTest.uproject'

if (-not (Test-Path -LiteralPath $uproject)) {
  Write-Host "Missing: $uproject"
  exit 1
}

$engineRoot = $env:UE_ENGINE_ROOT
if ([string]::IsNullOrWhiteSpace($engineRoot)) {
  Write-Host "Missing UE_ENGINE_ROOT. Set it to the Unreal Engine root directory."
  Write-Host '  setx UE_ENGINE_ROOT "C:\Path\To\UE_5.5"'
  exit 1
}

$candidates = @(
  $engineRoot
)

$resolvedEngineRoot = $null
foreach ($candidate in $candidates) {
  if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
  $editor = Join-Path $candidate 'Engine\Binaries\Win64\UnrealEditor.exe'
  if (Test-Path -LiteralPath $editor) {
    $resolvedEngineRoot = $candidate
    break
  }
}

if (-not $resolvedEngineRoot) {
  Write-Host "Missing UnrealEditor.exe under UE_ENGINE_ROOT: $engineRoot"
  exit 1
}

$ueEditor = Join-Path $resolvedEngineRoot 'Engine\Binaries\Win64\UnrealEditor.exe'
$buildBat = Join-Path $resolvedEngineRoot 'Engine\Build\BatchFiles\Build.bat'

if (-not (Test-Path -LiteralPath $buildBat)) {
  Write-Host "Missing: $buildBat"
  exit 1
}

$sourceRoots = @(
  (Join-Path $root 'UE\HiveTest\Source'),
  (Join-Path $root 'UE\HiveTest\Plugins\AssetHive\Source')
)

$binaryTargets = @(
  (Join-Path $root 'UE\HiveTest\Binaries\Win64\UnrealEditor-HiveTest.dll'),
  (Join-Path $root 'UE\HiveTest\Plugins\AssetHive\Binaries\Win64\UnrealEditor-AssetHive.dll')
)

$sourceFiles = @()
foreach ($r in $sourceRoots) {
  if (Test-Path -LiteralPath $r) {
    $sourceFiles += Get-ChildItem -LiteralPath $r -Recurse -File -ErrorAction SilentlyContinue
  }
}

$needBuild = $false
if ($sourceFiles.Count -gt 0) {
  $latestSource = $sourceFiles | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  $binFiles = @()
  foreach ($f in $binaryTargets) {
    if (Test-Path -LiteralPath $f) {
      $binFiles += Get-Item -LiteralPath $f
    }
  }
  if ($binFiles.Count -eq 0) {
    $needBuild = $true
  } else {
    $latestBinary = $binFiles | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if ($latestSource.LastWriteTimeUtc -gt $latestBinary.LastWriteTimeUtc) {
      $needBuild = $true
    }
  }
}

if ($needBuild) {
  $projectDir = Split-Path -Parent $uproject
  $buildConfigDirs = @(
    (Join-Path $projectDir 'Saved\UnrealBuildTool'),
    (Join-Path $projectDir 'Config\UnrealBuildTool')
  )
  $ubaRoot = Join-Path $env:LOCALAPPDATA 'Epic\UnrealBuildAccelerator'
  New-Item -ItemType Directory -Path $ubaRoot -Force | Out-Null
  $configXml = @'
<?xml version="1.0" encoding="utf-8"?>
<Configuration xmlns="https://www.unrealengine.com/BuildConfiguration">
  <BuildConfiguration>
    <bAllowUBAExecutor>false</bAllowUBAExecutor>
    <bAllowUBALocalExecutor>false</bAllowUBALocalExecutor>
  </BuildConfiguration>
  <UnrealBuildAccelerator>
    <RootDir>{0}</RootDir>
    <bDisableRemote>true</bDisableRemote>
  </UnrealBuildAccelerator>
</Configuration>
'@
  $configXml = [string]::Format($configXml, $ubaRoot)
  foreach ($dir in $buildConfigDirs) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $path = Join-Path $dir 'BuildConfiguration.xml'
    Set-Content -LiteralPath $path -Value $configXml -Encoding UTF8
  }

  $logDir = Join-Path $env:TEMP 'assethive-ubt-logs'
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
  $logFile = Join-Path $logDir ("UBT_HiveTest_{0}.log" -f (Get-Date -Format 'yyyyMMdd_HHmmss'))
  & $buildBat 'HiveTestEditor' 'Win64' 'Development' "-Project=$uproject" '-WaitMutex' '-FromMsBuild' '-NoHotReloadFromIDE' "-log=$logFile"
  if ($LASTEXITCODE -ne 0) {
    Write-Host 'Build failed.'
    exit $LASTEXITCODE
  }
}

Start-Process -FilePath $ueEditor -ArgumentList @($uproject)
exit 0
