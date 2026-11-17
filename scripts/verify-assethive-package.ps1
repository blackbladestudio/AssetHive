param(
    [Parameter(Mandatory = $true)][string]$SourcePlugin,
    [Parameter(Mandatory = $true)][string]$PackagePlugin
)
$ErrorActionPreference = 'Stop'
function Get-SourceHash([string]$Path) {
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::OpenRead($Path)
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)) }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}
$sourceRoot = (Resolve-Path -LiteralPath (Join-Path $SourcePlugin 'Source')).Path
$sourceFiles = @(Get-ChildItem -LiteralPath $sourceRoot -Recurse -File)
if (-not ($sourceFiles | Where-Object Extension -eq '.cpp')) { throw 'Plugin C++ source is missing.' }
foreach ($file in $sourceFiles) {
    $relative = $file.FullName.Substring($sourceRoot.Length).TrimStart('\')
    $destination = Join-Path (Join-Path $PackagePlugin 'Source') $relative
    if (-not (Test-Path -LiteralPath $destination -PathType Leaf)) { throw "Missing packaged source: $relative" }
    if ((Get-SourceHash $file.FullName) -ne (Get-SourceHash $destination)) {
        throw "Packaged source differs: $relative"
    }
}
foreach ($relative in @('AssetHive.uplugin', 'Binaries\Win64\UnrealEditor-AssetHive.dll', 'Binaries\Win64\UnrealEditor.modules')) {
    if (-not (Test-Path -LiteralPath (Join-Path $PackagePlugin $relative) -PathType Leaf)) { throw "Missing package file: $relative" }
}
Write-Host "Verified $($sourceFiles.Count) source files and Win64 plugin binaries."
