param([switch]$CheckDependenciesOnly)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
Write-Host '========================================'
Write-Host 'AssetHive Preview'
Write-Host '========================================'

function Stop-PreviewElectronProcesses {
  # 复用 npm run dev / 打包脚本共用的清理脚本：
  # 只结束可执行路径或命令行指向本仓库的 electron / AssetHive 进程。
  param([switch]$Quiet)
  $cleaner = Join-Path $PSScriptRoot 'scripts\kill-stale-electron.cjs'
  if ((Get-Command node.exe -ErrorAction SilentlyContinue) -and (Test-Path -LiteralPath $cleaner)) {
    $arguments = @($cleaner)
    if ($Quiet) { $arguments += '--quiet' }
    & node.exe @arguments
    if ($LASTEXITCODE -eq 0) { return }
    Write-Host '[WARN] Stale preview process cleanup reported leftovers.' -ForegroundColor Yellow
    return
  }
  # Node 不可用时的兜底实现（正常流程不会走到这里）。
  $electronRoot = Join-Path $PSScriptRoot 'node_modules\electron'
  if (-not (Test-Path -LiteralPath $electronRoot)) { return }
  $electronRootPath = [IO.Path]::GetFullPath($electronRoot)
  if (-not $electronRootPath.EndsWith([IO.Path]::DirectorySeparatorChar)) {
    $electronRootPath += [IO.Path]::DirectorySeparatorChar
  }
  $previewProcesses = @(Get-Process -Name 'AssetHive','electron' -ErrorAction SilentlyContinue | Where-Object {
    try {
      if (-not $_.Path) { return $false }
      $processPath = [IO.Path]::GetFullPath($_.Path)
      $processPath.StartsWith($electronRootPath, [StringComparison]::OrdinalIgnoreCase)
    } catch {
      $false
    }
  })
  if ($previewProcesses.Count -eq 0) { return }
  $previewProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
}

# 旧版本预览 userData 使用「<启动器 PID>-<时间戳>」命名；这些遗留目录在启动器退出后可安全清理。
function Copy-PreviewPersistentFiles {
  # Keep user settings/favorites while using an isolated per-launch userData directory.
  param([string]$Source, [string]$Destination)
  foreach ($name in @('settings.json', 'favorites.json')) {
    $sourceFile = Join-Path $Source $name
    if (-not (Test-Path -LiteralPath $sourceFile -PathType Leaf)) { continue }
    try {
      Copy-Item -LiteralPath $sourceFile -Destination (Join-Path $Destination $name) -Force -ErrorAction Stop
    } catch {
      Write-Host "[WARN] Failed to sync preview file: $name" -ForegroundColor Yellow
    }
  }
}

function Remove-StalePreviewUserData {
  # 新版本使用固定的 shared 目录持久化设置，这里仅清理旧格式的临时目录。
  param([string]$Keep)
  $previewRoot = Join-Path ([IO.Path]::GetTempPath()) 'AssetHive\Preview'
  if (-not (Test-Path -LiteralPath $previewRoot)) { return }
  $resolvedRoot = [IO.Path]::GetFullPath($previewRoot) + [IO.Path]::DirectorySeparatorChar
  $keepPath = if ($Keep) { [IO.Path]::GetFullPath($Keep) } else { '' }
  foreach ($directory in Get-ChildItem -LiteralPath $previewRoot -Directory -ErrorAction SilentlyContinue) {
    $resolvedDirectory = [IO.Path]::GetFullPath($directory.FullName)
    if (-not $resolvedDirectory.StartsWith($resolvedRoot, [StringComparison]::OrdinalIgnoreCase)) { continue }
    if ($keepPath -and $resolvedDirectory -eq $keepPath) { continue }
    $match = [regex]::Match($directory.Name, '^(\d+)-')
    if (-not $match.Success) { continue }
    $ownerPid = [int]$match.Groups[1].Value
    if ($ownerPid -gt 0 -and (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue)) { continue }
    Remove-Item -LiteralPath $resolvedDirectory -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# 预览模式使用隔离的 userData（下方 ASSETHIVE_PREVIEW_USER_DATA），Electron 的单实例锁
# scoped 到 userData，因此与已安装并运行中的 AssetHive 互不冲突，允许同时运行。
# Clean this repository's stale Electron before dependency repair.
# Otherwise electron.exe stays locked and npm ci fails with EPERM.
Stop-PreviewElectronProcesses
. (Join-Path $PSScriptRoot 'scripts\ensure_dependencies.ps1') -Mode Preview
if ($CheckDependenciesOnly) { exit 0 }
Remove-StalePreviewUserData
$previewRoot = Join-Path ([IO.Path]::GetTempPath()) 'AssetHive\Preview'
$previewPersistentRoot = Join-Path $previewRoot 'shared'
New-Item -ItemType Directory -Force -Path $previewPersistentRoot | Out-Null
# Electron's single-instance lock is scoped to userData. An unkillable stale process can block the fixed shared path forever, so each preview launch gets an isolated userData directory. Settings/favorites are copied in and out to preserve persistence.
$previewUserData = Join-Path $previewRoot ("$PID-" + [DateTime]::UtcNow.ToString('yyyyMMddHHmmssfff'))
New-Item -ItemType Directory -Force -Path $previewUserData | Out-Null
Copy-PreviewPersistentFiles -Source $previewPersistentRoot -Destination $previewUserData
$env:ASSETHIVE_PREVIEW = '1'
$env:ASSETHIVE_PREVIEW_USER_DATA = $previewUserData
$env:ASSETHIVE_PREVIEW_SHARED = $previewPersistentRoot
# 启动器独占锁：Electron 侧看门狗据此判断预览启动器是否仍在运行。
# 本进程持有 launcher.lock（FileShare.None）期间 Electron 探测会被拒绝；终端被强制
# 关闭时本进程立刻消失、句柄由系统释放，Electron 探测成功后自行退出，不再残留。
$script:previewLockPath = Join-Path $previewUserData 'launcher.lock'
$script:previewLockStream = [System.IO.File]::Open($script:previewLockPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
$script:previewLockWriter = New-Object System.IO.StreamWriter($script:previewLockStream)
$script:previewLockWriter.WriteLine("$PID")
$script:previewLockWriter.Flush()
Write-Host "[INFO] Preview user data: $previewUserData"
Write-Host '[INFO] Starting Vite and Electron. Press Ctrl+C to stop preview.'
# A caller may have used Electron as Node for diagnostics. Launch the GUI normally.
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$previewExit = 1
try {
  & npm.cmd run dev
  $previewExit = $LASTEXITCODE
} finally {
  try {
    if ($script:previewLockWriter) { $script:previewLockWriter.Dispose() }
    if ($script:previewLockStream) { $script:previewLockStream.Dispose() }
  } catch {}
  try { Stop-PreviewElectronProcesses -Quiet } catch {}
  # 保留 shared userData，确保目标路径等设置跨预览重启生效。
  try { Copy-PreviewPersistentFiles -Source $previewUserData -Destination $previewPersistentRoot } catch {}
  try { Remove-StalePreviewUserData } catch {}
  Remove-Item Env:ASSETHIVE_PREVIEW -ErrorAction SilentlyContinue
  Remove-Item Env:ASSETHIVE_PREVIEW_USER_DATA -ErrorAction SilentlyContinue
}
if ($previewExit -ne 0) { Write-Host "[ERROR] Preview stopped with code $previewExit." -ForegroundColor Red }
exit $previewExit
