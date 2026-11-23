[CmdletBinding()]
param(
  [string]$Root = '',
  [string]$NotesFile = '',
  [switch]$WhatIf
)
$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$version = (Get-Content -LiteralPath (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json).version
if (-not $NotesFile) { $NotesFile = Join-Path $Root "docs/release-notes-$version.md" }
# 两个入口共用发布校验与目标仓库，不再保留固定历史版本。
$releaseArguments = @((Join-Path $Root 'scripts/publish_release.js'), '--notes-file', $NotesFile)
if ($WhatIf) { $releaseArguments += '--dry-run' }
& node @releaseArguments
if ($LASTEXITCODE -ne 0) { throw "发布检查失败 ($LASTEXITCODE)" }
