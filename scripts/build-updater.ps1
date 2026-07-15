$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $root "updater\AssetHiveUpdater.cs"
$outputPath = Join-Path $root "AssetHiveUpdater.exe"

if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
  throw "Missing updater source: $sourcePath"
}

if (Test-Path -LiteralPath $outputPath) {
  Remove-Item -LiteralPath $outputPath -Force
}

$source = Get-Content -LiteralPath $sourcePath -Raw
Add-Type `
  -TypeDefinition $source `
  -OutputAssembly $outputPath `
  -OutputType ConsoleApplication `
  -Language CSharp

if (-not (Test-Path -LiteralPath $outputPath -PathType Leaf)) {
  throw "Updater build failed: $outputPath"
}

Write-Host "Updater built: $outputPath"
