<#
  Lists locally installed Unreal Engine builds and lets the user pick which one
  to compile/package AssetHive with. The selected engine root is written to
  -OutFile so the calling batch script can read it back.

  -Requested accepts either an engine root path or a version string such as 5.5
  (or a folder name such as UE_5.5) and skips the interactive menu.
#>
[CmdletBinding()]
param(
  [string]$Requested = '',
  [string]$OutFile = ''
)

$ErrorActionPreference = 'Stop'

function Test-EngineRoot {
  param([string]$Root)
  if ([string]::IsNullOrWhiteSpace($Root)) { return $false }
  # Paths typed by hand can carry quotes or stray characters; treat those as invalid
  # rather than letting Test-Path throw and abort the selection.
  $Root = $Root.Trim().Trim('"')
  if ($Root.Length -lt 3) { return $false }
  try {
    return (Test-Path -LiteralPath (Join-Path $Root 'Engine\Build\BatchFiles\RunUAT.bat'))
  } catch {
    return $false
  }
}

function Get-EngineInfo {
  param([string]$Root)
  $info = [pscustomobject]@{ Version = ''; Promoted = $false }
  $versionFile = Join-Path $Root 'Engine\Build\Build.version'
  if (-not (Test-Path -LiteralPath $versionFile)) { return $info }
  try {
    $json = Get-Content -LiteralPath $versionFile -Raw | ConvertFrom-Json
  } catch {
    return $info
  }
  if ($null -ne $json.MajorVersion -and $null -ne $json.MinorVersion) {
    $parts = @([int]$json.MajorVersion, [int]$json.MinorVersion)
    if ($null -ne $json.PatchVersion) { $parts += [int]$json.PatchVersion }
    $info.Version = ($parts -join '.')
  }
  # Promoted builds come from the launcher; source/custom builds have no changelist
  # and produce binaries that will not load in an official engine of the same version.
  $info.Promoted = ($json.IsPromotedBuild -eq 1 -and $json.Changelist -gt 0)
  return $info
}

function Get-VersionSortKey {
  param([string]$Version)
  if ([string]::IsNullOrWhiteSpace($Version)) { return [version]'0.0.0' }
  $parts = @($Version -split '\.' | Where-Object { $_ -ne '' })
  while ($parts.Count -lt 3) { $parts += '0' }
  try {
    return [version](($parts[0..2]) -join '.')
  } catch {
    return [version]'0.0.0'
  }
}

$candidates = New-Object System.Collections.Generic.List[string]

function Add-Candidate {
  param([string]$Root)
  if ([string]::IsNullOrWhiteSpace($Root)) { return }
  $Root = $Root.Trim().TrimEnd('\')
  if (-not (Test-EngineRoot $Root)) { return }
  $full = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\')
  if (-not $candidates.Contains($full)) { $candidates.Add($full) }
}

# Epic Launcher manifest records every installed engine under InstallLocation.
$launcherDat = Join-Path $env:ProgramData 'Epic\UnrealEngineLauncher\LauncherInstalled.dat'
if (Test-Path -LiteralPath $launcherDat) {
  try {
    $manifest = Get-Content -LiteralPath $launcherDat -Raw | ConvertFrom-Json
    foreach ($entry in $manifest.InstallationList) {
      Add-Candidate $entry.InstallLocation
    }
  } catch {
    # A malformed manifest just means fewer auto-detected candidates.
  }
}

# Plus the usual install roots, in case the launcher manifest is missing.
$searchRoots = @(
  $env:UE_ENGINE_ROOT,
  'C:\Program Files\Epic Games',
  'D:\Program Files\Epic Games',
  'E:\Program Files\Epic Games',
  'C:\Program Files\Unreal Engine',
  'D:\Program Files\Unreal Engine',
  'E:\Program Files\Unreal Engine',
  'C:\Program Files\UE',
  'D:\Program Files\UE',
  'E:\Program Files\UE'
)
foreach ($base in $searchRoots) {
  if ([string]::IsNullOrWhiteSpace($base)) { continue }
  if (-not (Test-Path -LiteralPath $base)) { continue }
  Add-Candidate $base
  Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'UE*' } |
    ForEach-Object { Add-Candidate $_.FullName }
}

$rows = @(
  @(
    foreach ($root in $candidates) {
      $info = Get-EngineInfo $root
      [pscustomobject]@{ Root = $root; Version = $info.Version; Promoted = $info.Promoted }
    }
  ) | Sort-Object -Property @{ Expression = { if ($_.Promoted) { 0 } else { 1 } } }, @{ Expression = { Get-VersionSortKey $_.Version }; Descending = $true }
)

$selected = $null

if (-not [string]::IsNullOrWhiteSpace($Requested)) {
  $want = $Requested.Trim().Trim('"').TrimEnd('\')
  if (Test-EngineRoot $want) {
    $selected = (Resolve-Path -LiteralPath $want).Path.TrimEnd('\')
  } else {
    $match = $rows | Where-Object {
      $_.Version -eq $want -or
      $_.Version -like "$want.*" -or
      (Split-Path -Leaf $_.Root) -like "*$want"
    } | Select-Object -First 1
    if ($match) { $selected = $match.Root }
  }
  if (-not $selected) {
    Write-Host "No local Unreal Engine matched ASSETHIVE_ENGINE='$Requested'."
    exit 1
  }
}

if (-not $selected) {
  if ($rows.Count -eq 0) {
    Write-Host 'No local Unreal Engine installation was found.'
    Write-Host 'Set ASSETHIVE_ENGINE to an engine root, or install an engine and retry.'
    exit 1
  }

  $defaultIndex = 0
  if (Test-EngineRoot $env:UE_ENGINE_ROOT) {
    $envRoot = (Resolve-Path -LiteralPath $env:UE_ENGINE_ROOT).Path.TrimEnd('\')
    for ($i = 0; $i -lt $rows.Count; $i++) {
      if ($rows[$i].Root -eq $envRoot) { $defaultIndex = $i + 1; break }
    }
  }
  if ($defaultIndex -eq 0) {
    for ($i = 0; $i -lt $rows.Count; $i++) {
      if ($rows[$i].Promoted) { $defaultIndex = $i + 1; break }
    }
  }
  if ($defaultIndex -eq 0) { $defaultIndex = 1 }

  Write-Host ''
  Write-Host 'Select the Unreal Engine build to compile and package AssetHive with:'
  for ($i = 0; $i -lt $rows.Count; $i++) {
    $ver = $rows[$i].Version
    if ([string]::IsNullOrWhiteSpace($ver)) { $ver = 'unknown' }
    $suffix = ''
    if (-not $rows[$i].Promoted) { $suffix = '  [source build]' }
    if (($i + 1) -eq $defaultIndex) { $suffix += '  (default)' }
    Write-Host ('  [{0}] UE {1}  {2}{3}' -f ($i + 1), $ver, $rows[$i].Root, $suffix)
  }
  Write-Host '  [0] Enter an engine path manually'
  Write-Host '  [Q] Quit'

  $choice = Read-Host ('Choose [1-{0}, 0, Q] (Enter = {1})' -f $rows.Count, $defaultIndex)

  if ($choice -match '^\s*$') {
    $selected = $rows[$defaultIndex - 1].Root
  } elseif ($choice -match '^\s*[Qq]\s*$') {
    exit 0
  } elseif ($choice -match '^\s*0\s*$') {
    for ($attempt = 0; $attempt -lt 3 -and -not $selected; $attempt++) {
      $manual = (Read-Host 'Engine root (folder containing Engine\Build\BatchFiles\RunUAT.bat)').Trim().Trim('"')
      if ([string]::IsNullOrWhiteSpace($manual)) { break }
      if (Test-EngineRoot $manual) {
        $selected = (Resolve-Path -LiteralPath $manual).Path.TrimEnd('\')
      } else {
        Write-Host "Not a valid engine root: $manual"
      }
    }
    if (-not $selected) { exit 1 }
  } elseif ($choice -match '^\s*\d{1,4}\s*$' -and [int]$choice -ge 1 -and [int]$choice -le $rows.Count) {
    $selected = $rows[[int]$choice - 1].Root
  } else {
    Write-Host "Invalid choice: $choice"
    exit 1
  }
}

$chosen = Get-EngineInfo $selected

if ($OutFile) {
  [System.IO.File]::WriteAllText($OutFile, $selected)
}

Write-Host ''
Write-Host ('Engine: UE {0}  {1}' -f $chosen.Version, $selected)
if (-not $chosen.Promoted) {
  Write-Host 'WARNING: not a promoted (launcher) engine build.'
  Write-Host 'Binaries compiled with it will not load in an official engine of the same version.'
}
exit 0
