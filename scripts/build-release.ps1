param([switch]$KeepStage)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'A stable three-part version is required.' }

# The existing builders use these fixed staging directories. Reject junctions
# before either builder cleans its own staging output.
foreach ($relative in @('.cache/AssetHivePackOut', '.cache/packager-tmp', 'Output')) {
    $target = [IO.Path]::GetFullPath((Join-Path $root $relative))
    if (-not $target.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Invalid build path: $target" }
    if (Test-Path -LiteralPath $target) {
        $entries = @(Get-Item -LiteralPath $target -Force) + @(Get-ChildItem -LiteralPath $target -Recurse -Force)
        if ($entries | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw "Build directory contains a link: $target" }
    }
}

$env:ASSETHIVE_NO_PAUSE = '1'
$env:ASSETHIVE_KEEP_STAGE = if ($KeepStage) { '1' } else { '0' }
& cmd.exe /d /c package_assethive_msi.bat
if ($LASTEXITCODE -ne 0) { throw "MSI build failed ($LASTEXITCODE)." }
& cmd.exe /d /c package_assethive_exe.bat
if ($LASTEXITCODE -ne 0) { throw "EXE build failed ($LASTEXITCODE)." }

# Keep the established public filename used by BlackBlade Hub.
$publicMsi = "Output/AssetHive-$version-Windows.msi"
Copy-Item -LiteralPath "Output/AssetHive-$version-win64.msi" -Destination $publicMsi -Force
$artifacts = @($publicMsi, "Output/AssetHive-$version-Windows-setup.exe", "Output/AssetHive-$version-setup-win64.exe")
foreach ($artifact in $artifacts) {
    if ((Get-Item -LiteralPath $artifact).Length -lt 1MB) { throw "Invalid installer: $artifact" }
    # Windows PowerShell launched from pwsh can inherit a module path without
    # Microsoft.PowerShell.Utility. Use the runtime directly for this checksum.
    $algorithm = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead((Resolve-Path -LiteralPath $artifact).Path)
    try { $hash = [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $algorithm.Dispose() }
    "$hash  $(Split-Path $artifact -Leaf)" | Set-Content -LiteralPath "$artifact.sha256" -Encoding ascii
}
Write-Host "Release $version built and checksummed."
