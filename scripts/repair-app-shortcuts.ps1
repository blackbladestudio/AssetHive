<#
  Repair AssetHive's Windows shortcuts after a dev Electron instance or another
  Electron tool took over its taskbar / Start Menu identity.

  What it does:
    1. Finds the installed AssetHive.exe (Program Files, per-user Programs, or
       the uninstall registry entry).
    2. Points existing AssetHive shortcuts back at that exe and the AssetHive
       icon. Creates a per-user Start Menu shortcut when none exists.
    3. Backs up and removes Electron.lnk shortcuts that point into a repository
       `node_modules\electron\dist\electron.exe` and carry an AssetHive AUMID.

  Every modified / removed shortcut is copied to
  %LOCALAPPDATA%\AssetHive\ShortcutBackups before the change.
#>
[CmdletBinding()]
param(
  [string]$InstalledExe = "",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$backupRoot = Join-Path $env:LOCALAPPDATA "AssetHive\ShortcutBackups"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$shell = New-Object -ComObject WScript.Shell
$changes = New-Object System.Collections.Generic.List[string]

function Write-Change([string]$message) {
  $changes.Add($message)
  Write-Host $message
}

function Backup-Shortcut([string]$path) {
  if ($DryRun) { return }
  New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
  $safeName = ($path -replace '[\\/:*?"<>|]', "_")
  $target = Join-Path $backupRoot ("{0}-{1}" -f $stamp, $safeName)
  Copy-Item -LiteralPath $path -Destination $target -Force
}

function Find-AssetHiveExe {
  $candidates = New-Object System.Collections.Generic.List[string]
  if ($InstalledExe) { $candidates.Add($InstalledExe) }
  $candidates.Add((Join-Path $env:ProgramFiles "AssetHive\AssetHive.exe"))
  if (${env:ProgramFiles(x86)}) {
    $candidates.Add((Join-Path ${env:ProgramFiles(x86)} "AssetHive\AssetHive.exe"))
  }
  $candidates.Add((Join-Path $env:LOCALAPPDATA "Programs\AssetHive\AssetHive.exe"))
  $uninstallRoots = @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
  )
  foreach ($root in $uninstallRoots) {
    Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue | ForEach-Object {
      $entry = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
      if ($entry.DisplayName -eq "AssetHive" -and $entry.InstallLocation) {
        $candidates.Add((Join-Path $entry.InstallLocation "AssetHive.exe"))
      }
    }
  }
  foreach ($candidate in $candidates) {
    if (-not $candidate -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    $item = Get-Item -LiteralPath $candidate
    $version = $item.VersionInfo
    if ($version.ProductName -eq "AssetHive" -or $version.FileDescription -eq "AssetHive" -or $item.Name -eq "AssetHive.exe") {
      return $item.FullName
    }
  }
  throw "找不到已安装的 AssetHive.exe。请先在设置里指定 -InstalledExe <路径>。"
}

function Get-ShortcutRoots {
  @(
    (Join-Path $env:ProgramData "Microsoft\Windows\Start Menu\Programs"),
    (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"),
    (Join-Path $env:PUBLIC "Desktop"),
    (Join-Path $env:USERPROFILE "Desktop")
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique
}

function Test-DevElectronShortcut([string]$path) {
  try {
    $shortcut = $shell.CreateShortcut($path)
    $target = [string]$shortcut.TargetPath
    if (-not $target) { return $false }
    if ($target -notmatch '(?i)[\\/]node_modules[\\/]electron[\\/]dist[\\/]electron\.exe$') {
      return $false
    }
    $bytes = [System.IO.File]::ReadAllBytes($path)
    $unicode = [System.Text.Encoding]::Unicode.GetString($bytes)
    return ($unicode -match 'Biscuits\.AssetHive' -or $unicode -match 'com\.blackblade\.assethive(\.preview)?')
  } catch {
    return $false
  }
}

$installedExe = Find-AssetHiveExe
Write-Host "AssetHive.exe: $installedExe"

$roots = Get-ShortcutRoots
$assetHiveShortcuts = New-Object System.Collections.Generic.List[string]
foreach ($root in $roots) {
  Get-ChildItem -LiteralPath $root -Recurse -Filter "AssetHive.lnk" -ErrorAction SilentlyContinue | ForEach-Object {
    $assetHiveShortcuts.Add($_.FullName)
  }
}

foreach ($path in $assetHiveShortcuts) {
  $shortcut = $shell.CreateShortcut($path)
  $currentTarget = [string]$shortcut.TargetPath
  if ($currentTarget -and $currentTarget -ieq $installedExe) {
    Write-Host "OK shortcut: $path"
    continue
  }
  Write-Change ("Relink shortcut: {0} -> {1}" -f $path, $installedExe)
  if (-not $DryRun) {
    Backup-Shortcut $path
    $shortcut.TargetPath = $installedExe
    $shortcut.WorkingDirectory = Split-Path -Parent $installedExe
    $shortcut.IconLocation = "$installedExe,0"
    $shortcut.Description = "AssetHive"
    $shortcut.Save()
  }
}

if ($assetHiveShortcuts.Count -eq 0) {
  $createdPath = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\AssetHive.lnk"
  Write-Change ("Create Start Menu shortcut: {0}" -f $createdPath)
  if (-not $DryRun) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $createdPath) -Force | Out-Null
    $shortcut = $shell.CreateShortcut($createdPath)
    $shortcut.TargetPath = $installedExe
    $shortcut.WorkingDirectory = Split-Path -Parent $installedExe
    $shortcut.IconLocation = "$installedExe,0"
    $shortcut.Description = "AssetHive"
    $shortcut.Save()
  }
}

foreach ($root in $roots) {
  Get-ChildItem -LiteralPath $root -Recurse -Filter "Electron.lnk" -ErrorAction SilentlyContinue | ForEach-Object {
    if (Test-DevElectronShortcut $_.FullName) {
      Write-Change ("Remove dev Electron shortcut: {0}" -f $_.FullName)
      if (-not $DryRun) {
        Backup-Shortcut $_.FullName
        Remove-Item -LiteralPath $_.FullName -Force
      }
    } else {
      Write-Host "Keep unrelated Electron shortcut: $($_.FullName)"
    }
  }
}

if (-not $DryRun) {
  try {
    & "$env:SystemRoot\System32\ie4uinit.exe" -show | Out-Null
  } catch {
    # Icon cache refresh is best-effort; the shortcut changes are already saved.
  }
}

if ($changes.Count -eq 0) {
  Write-Host "没有需要修复的快捷方式。"
} else {
  Write-Host ""
  Write-Host ("完成 {0} 项修改。备份目录：{1}" -f $changes.Count, $backupRoot)
}
