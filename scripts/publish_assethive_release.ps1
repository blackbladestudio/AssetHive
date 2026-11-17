# publish_assethive_release.ps1
#
# 发布 AssetHive 2.2.3 到 https://github.com/blackbladestudio/AssetHive
#
# 前置条件：当前 gh 登录的账号必须对该仓库有写权限（Write/Maintain/Admin）。
#   验证：gh api repos/blackbladestudio/AssetHive --jq .permissions
#   如果 push=false，请先让仓库管理员把账号或 blackblade-develop 团队加为 Write。
#
# 用法（本机只装了 Windows PowerShell 5.1，用 powershell.exe 运行）：
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\publish_assethive_release.ps1
#
# 如使用其他账号的令牌：
#   $env:GH_TOKEN = "<有写权限的 token>"; powershell.exe -NoProfile -File scripts\publish_assethive_release.ps1

[CmdletBinding()]
param(
  [string]$Repo   = 'blackbladestudio/AssetHive',
  [string]$Tag    = 'v2.2.3',
  [string]$Target = 'main',
  [string]$Title  = 'AssetHive 2.2.3',
  [string]$Root   = '',
  [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$OutputDir = Join-Path $Root 'Output'
$NotesFile = Join-Path $Root 'docs\release-notes-2.2.3.md'

$assets = @(
  'AssetHive-2.2.3-Windows.msi',
  'AssetHive-2.2.3-Windows.msi.sha256',
  'AssetHive-2.2.3-setup-win64.exe',
  'AssetHive-2.2.3-setup-win64.exe.sha256'
)

Write-Host "== 检查发布物 ==" -ForegroundColor Cyan
$paths = @()
foreach ($name in $assets) {
  $p = Join-Path $OutputDir $name
  if (-not (Test-Path -LiteralPath $p)) { throw "缺少发布物: $p" }
  $size = (Get-Item -LiteralPath $p).Length
  Write-Host ("  {0,-42} {1,14:N0} bytes" -f $name, $size)
  $paths += $p
}
if (-not (Test-Path -LiteralPath $NotesFile)) { throw "缺少 release notes: $NotesFile" }

Write-Host "== 校验 SHA-256 文件与实际文件一致 ==" -ForegroundColor Cyan
foreach ($name in ($assets | Where-Object { $_ -notlike '*.sha256' })) {
  $expected = ((Get-Content -LiteralPath (Join-Path $OutputDir "$name.sha256") -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
  $actual = (Get-FileHash -LiteralPath (Join-Path $OutputDir $name) -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($expected -ne $actual) { throw "SHA-256 不一致: $name`n  文件内: $expected`n  实际值: $actual" }
  Write-Host ("  OK  {0}  {1}" -f $name, $actual)
}

Write-Host "== 检查仓库写权限 ==" -ForegroundColor Cyan
$perm = gh api "repos/$Repo" --jq '.permissions' | ConvertFrom-Json
if (-not $perm.push) {
  throw "当前账号对 $Repo 没有写权限（push=false）。请让仓库管理员授予 Write 权限，或把令牌放进 `$env:GH_TOKEN 后重试（需指向有写权限的账号）。"
}
Write-Host "  写权限 OK"

$existing = cmd /c "gh api ""repos/$Repo/releases/tags/$Tag"" --jq "".tag_name"" 2>nul"
if ($LASTEXITCODE -eq 0 -and $existing) { throw "发布 $Tag 已存在，请勿重复发布（Release 不可覆盖重发）。" }
Write-Host "  $Tag 尚未发布，可以创建"

if ($WhatIf) { Write-Host "`n(WhatIf) 未执行发布。" -ForegroundColor Yellow; return }

Write-Host "== 创建 Release 并上传 4 个附件 ==" -ForegroundColor Cyan
gh release create $Tag @paths `
  --repo $Repo `
  --target $Target `
  --title $Title `
  --notes-file $NotesFile
if ($LASTEXITCODE -ne 0) { throw "gh release create 失败（exit $LASTEXITCODE）" }

Write-Host "== 结果 ==" -ForegroundColor Green
$verify = gh api "repos/$Repo/releases/tags/$Tag" --jq '.html_url' 2>$null
Write-Host "  Release: $verify"
if ($verify) {
  gh api "repos/$Repo/releases/tags/$Tag" -q '.assets[] | [.name, (.size|tostring), .state] | @tsv' |
    ForEach-Object { $f = $_ -split "`t"; Write-Host ("  {0,-42} {1,14} bytes  [{2}]" -f $f[0], $f[1], $f[2]) }
}
