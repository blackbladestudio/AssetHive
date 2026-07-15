$ErrorActionPreference = "Stop"

$REPO = "blackbladestudio/AssetHive"
$API_URL = "https://api.github.com/repos/$REPO/releases/latest"
$PROXY_PREFIXES = @(
    "https://ghfast.top/",
    "https://ghproxy.net/",
    "https://gh-proxy.com/",
    "https://mirror.ghproxy.com/",
    "https://ghp.ci/",
    "https://v6.gh-proxy.org/",
    "https://ghproxy.vip/",
    "https://gh.api.99988866.xyz/"
)
$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$BAR_WIDTH = 40

function Write-Status($msg) { Write-Host "[AssetHive] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)     { Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Warn($msg)   { Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Write-Err($msg)    { Write-Host "[ERROR] $msg" -ForegroundColor Red }

function Show-ProgressBar($percent, $totalMB, $downloadedMB, $speedText, $etaText) {
    $filled = [math]::Floor($percent * $BAR_WIDTH / 100)
    $empty = $BAR_WIDTH - $filled
    $bar = ("█" * $filled) + ("░" * $empty)
    $line = "`r  [$bar] {0,6}%  {1,8} / {2,-8}  {3}  {4}" -f $percent, "$([math]::Round($downloadedMB,1)) MB", "$totalMB MB", $speedText, $etaText
    if ($percent -ge 100) {
        $line += "`n"
    }
    Write-Host $line -NoNewline
}

function Format-Speed($bytesPerSec) {
    if ($bytesPerSec -ge 1048576) {
        return "{0:N1} MB/s" -f ($bytesPerSec / 1048576)
    } elseif ($bytesPerSec -ge 1024) {
        return "{0:N1} KB/s" -f ($bytesPerSec / 1024)
    } else {
        return "{0:N0} B/s" -f $bytesPerSec
    }
}

function Format-Eta($seconds) {
    if ($seconds -lt 60) {
        return "ETA: {0}s" -f [int]$seconds
    } elseif ($seconds -lt 3600) {
        return "ETA: {0}:{1:D2}" -f [int]($seconds / 60), ($seconds % 60)
    } else {
        $h = [int]($seconds / 3600)
        $m = [int](($seconds % 3600) / 60)
        return "ETA: {0}:{1:D2}:00" -f $h, $m
    }
}

function Download-WithProgress($url, $targetPath, $expectedSize) {
    Add-Type -AssemblyName System.Net.Http

    $handler = New-Object System.Net.Http.HttpClientHandler
    $client = New-Object System.Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromMinutes(10)

    try {
        $responseMsg = $client.GetAsync($url, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).Result
        $responseMsg.EnsureSuccessStatusCode() | Out-Null
        $stream = $responseMsg.Content.ReadAsStreamAsync().Result
    } catch {
        throw $_
    }

    $totalBytes = $responseMsg.Content.Headers.ContentLength
    if (-not $totalBytes -or $totalBytes -le 0) { $totalBytes = $expectedSize }

    $dir = Split-Path $targetPath -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

    $fs = [System.IO.File]::Create($targetPath)
    $buffer = New-Object byte[] 81920
    $totalRead = 0L
    $lastTick = [Environment]::TickCount
    $lastRead = 0L
    $speedSamples = @()
    $tickFreq = 1000 / [Environment]::TickCountFrequency

    try {
        while ($true) {
            $read = $stream.Read($buffer, 0, $buffer.Length)
            if ($read -le 0) { break }
            $fs.Write($buffer, 0, $read)
            $totalRead += $read

            $nowTick = [Environment]::TickCount
            $elapsedMs = ($nowTick - $lastTick) * $tickFreq
            if ($elapsedMs -ge 300) {
                $delta = $totalRead - $lastRead
                $instantSpeed = if ($elapsedMs -gt 0) { $delta / $elapsedMs } else { 0 }
                $speedSamples += $instantSpeed
                if ($speedSamples.Count -gt 5) { $speedSamples = $speedSamples[-5..-1] }
                $avgSpeed = ($speedSamples | Measure-Object -Average).Average

                $percent = if ($totalBytes -gt 0) { [math]::Min(100, [math]::Round($totalRead * 100 / $totalBytes)) } else { 0 }
                $totalMB = $totalBytes / 1MB
                $dlMB = $totalRead / 1MB
                $spd = Format-Speed $avgSpeed
                $etaSeconds = if ($avgSpeed -gt 0) { ($totalBytes - $totalRead) / $avgSpeed } else { 0 }
                $eta = Format-Eta $etaSeconds

                Show-ProgressBar $percent $totalMB $dlMB $spd $eta

                $lastTick = $nowTick
                $lastRead = $totalRead
            }
        }
    } finally {
        $fs.Close()
        $stream.Close()
        $client.Dispose()
    }

    $finalPercent = if ($totalBytes -gt 0) { 100 } else { 100 }
    $totalMB = $totalBytes / 1MB
    $dlMB = $totalRead / 1MB
    Show-ProgressBar $finalPercent $totalMB $dlMB "" ""

    return $totalRead
}

function Find-AssetHiveExe($searchDir) {
    $direct = Join-Path $searchDir "AssetHive.exe"
    if (Test-Path $direct) { return $direct }
    $results = @(Get-ChildItem -Path $searchDir -Filter "AssetHive.exe" -Recurse -Depth 2 -ErrorAction SilentlyContinue)
    if ($results.Count -gt 0) { return $results[0].FullName }
    return $null
}

function Get-InstalledVersion($exePath) {
    if (-not $exePath -or -not (Test-Path $exePath)) { return $null }
    try {
        $vi = (Get-Item $exePath).VersionInfo
        $fv = $vi.FileVersion
        if ($fv -and $fv -ne "0.0.0.0") { return $fv }
        $pv = $vi.ProductVersion
        if ($pv -and $pv -ne "0.0.0.0") { return $pv }
    } catch {}
    $appAsar = Join-Path (Split-Path $exePath -Parent) "resources\app.asar"
    if (Test-Path $appAsar) {
        try {
            $pkgJson = Join-Path (Split-Path $exePath -Parent) "resources\app-update.yml"
            if (Test-Path $pkgJson) {
                $content = Get-Content $pkgJson -Raw -ErrorAction SilentlyContinue
                $m = [regex]::Match($content, 'version:\s*[''"]?([\d.]+)')
                if ($m.Success) { return $m.Groups[1].Value }
            }
        } catch {}
    }
    return $null
}

function Compare-SemVer($a, $b) {
    $pa = ($a -replace '^v','' -split '\.' | ForEach-Object { [int]$_ }) + @(0,0,0)
    $pb = ($b -replace '^v','' -split '\.' | ForEach-Object { [int]$_ }) + @(0,0,0)
    for ($i = 0; $i -lt 3; $i++) {
        if ($pa[$i] -gt $pb[$i]) { return 1 }
        if ($pa[$i] -lt $pb[$i]) { return -1 }
    }
    return 0
}

function Get-AssetScore($asset) {
    $name = $asset.name.ToLower()
    $score = 0
    if ($name.EndsWith(".zip")) { $score += 60 }
    if ($name.EndsWith(".exe")) { $score += 50 }
    if ($name.EndsWith(".msi")) { $score += 40 }
    if ($name.Contains("portable")) { $score += 20 }
    if ($name.Contains("setup")) { $score += 15 }
    if ($name.Contains("x64") -or $name.Contains("win64")) { $score += 10 }
    return $score
}

function Get-AssetWithFallback($allAssets, $preferZip) {
    $windowsAssets = @()
    foreach ($asset in $allAssets) {
        $name = $asset.name.ToLower()
        if ($name.EndsWith(".exe") -or $name.EndsWith(".msi") -or $name.EndsWith(".zip")) {
            $windowsAssets += $asset
        }
    }
    if ($windowsAssets.Count -eq 0) { return $null }
    $sorted = $windowsAssets | Sort-Object { Get-AssetScore $_ } -Descending
    return $sorted[0]
}

$existingExe = Find-AssetHiveExe $SCRIPT_DIR
$installDir = if ($existingExe) { Split-Path $existingExe -Parent } else { $null }
$currentVersion = if ($existingExe) { Get-InstalledVersion $existingExe } else { $null }

if ($existingExe) {
    Write-Status "Found existing installation: $existingExe"
    if ($currentVersion) {
        Write-Status "Current version: $currentVersion"
    } else {
        Write-Warn "Could not determine installed version"
    }
} else {
    Write-Status "No existing installation found in: $SCRIPT_DIR"
    Write-Status "Will perform a fresh install."
}

Write-Status "Fetching latest release from $REPO ..."

$headers = @{
    "User-Agent" = "AssetHive-Downloader"
    "Accept"     = "application/vnd.github+json"
}

$release = $null
$apiCandidates = @($API_URL)
foreach ($prefix in $PROXY_PREFIXES) {
    $apiCandidates += "${prefix}${API_URL}"
}

foreach ($url in $apiCandidates) {
    try {
        $resp = Invoke-WebRequest -Uri $url -Headers $headers -UseBasicParsing -TimeoutSec 15
        $release = $resp.Content | ConvertFrom-Json
        if ($release.tag_name) { break }
        $release = $null
    } catch {
        continue
    }
}

if (-not $release -or -not $release.tag_name) {
    Write-Err "Failed to fetch release info from GitHub."
    Write-Err "Please check your network connection or try again later."
    exit 1
}

$latestVersion = $release.tag_name
$releaseName = $release.name
$publishedAt = $release.published_at
$assets = $release.assets

Write-Ok "Latest version: $latestVersion ($releaseName)"
Write-Ok "Published at: $publishedAt"

if ($currentVersion) {
    $cmp = Compare-SemVer $currentVersion $latestVersion
    if ($cmp -ge 0) {
        Write-Ok "Already up to date! (installed: $currentVersion, latest: $latestVersion)"
        exit 0
    }
    Write-Status "Update available: $currentVersion -> $latestVersion"
}

$pickedAsset = Get-AssetWithFallback $assets ($null -ne $installDir)
if (-not $pickedAsset) {
    Write-Err "No Windows installer found in the latest release."
    Write-Err "Available assets:"
    foreach ($a in $assets) { Write-Host "  - $($a.name)" -ForegroundColor Gray }
    exit 1
}

Write-Status "Selected asset: $($pickedAsset.name) ($( [math]::Round($pickedAsset.size / 1MB, 1) ) MB)"

$updateDir = if ($installDir) {
    Join-Path $installDir ".update"
} else {
    Join-Path $SCRIPT_DIR "AssetHive-Latest"
}

if (-not (Test-Path $updateDir)) {
    New-Item -ItemType Directory -Path $updateDir -Force | Out-Null
}

$targetFile = Join-Path $updateDir $pickedAsset.name

if (Test-Path $targetFile) {
    $existingSize = (Get-Item $targetFile).Length
    if ($existingSize -eq $pickedAsset.size) {
        Write-Ok "Package already downloaded: $targetFile"
    } else {
        Write-Warn "File exists but size mismatch (local: $existingSize, remote: $($pickedAsset.size)). Re-downloading..."
        Remove-Item $targetFile -Force
        $targetFile = $null
    }
}

if (-not (Test-Path $targetFile)) {
    $downloadUrl = $pickedAsset.browser_download_url
    $candidateUrls = @($downloadUrl)
    foreach ($prefix in $PROXY_PREFIXES) {
        $candidateUrls += "${prefix}${downloadUrl}"
    }

    $downloaded = $false
    foreach ($url in $candidateUrls) {
        try {
            Write-Status "Downloading via: $url"
            Download-WithProgress -url $url -targetPath $targetFile -expectedSize $pickedAsset.size
            $downloaded = $true
            Write-Ok "`nDownload succeeded!"
            break
        } catch {
            Write-Warn "`nFailed: $($_.Exception.Message)"
            if (Test-Path $targetFile) {
                Remove-Item $targetFile -Force -ErrorAction SilentlyContinue
            }
            continue
        }
    }

    if (-not $downloaded) {
        Write-Err "All download attempts failed."
        Write-Err "You can manually download from: $downloadUrl"
        exit 1
    }

    $finalSize = (Get-Item $targetFile).Length
    if ($finalSize -ne $pickedAsset.size) {
        Write-Warn "Downloaded file size ($finalSize) does not match expected size ($($pickedAsset.size))."
        Write-Warn "The file may be corrupted. Please verify manually."
    } else {
        Write-Ok "Download complete: $targetFile"
        Write-Ok "Version: $latestVersion | Size: $( [math]::Round($finalSize / 1MB, 1) ) MB"
    }
}

$isZip = $pickedAsset.name.ToLower().EndsWith(".zip")
$isInstaller = $pickedAsset.name.ToLower().EndsWith(".exe") -or $pickedAsset.name.ToLower().EndsWith(".msi")

if ($isZip -and $installDir) {
    Write-Status "Extracting update package..."
    $extractDir = Join-Path $updateDir "extracted"
    if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force }

    Expand-Archive -Path $targetFile -DestinationPath $extractDir -Force

    $extractedExe = $null
    $exeCandidates = @(Get-ChildItem -Path $extractDir -Filter "AssetHive.exe" -Recurse -Depth 2 -ErrorAction SilentlyContinue)
    if ($exeCandidates.Count -gt 0) {
        $extractedExe = $exeCandidates[0].FullName
    }

    if (-not $extractedExe) {
        Write-Ok "Extracted to: $extractDir"
        Write-Warn "Could not find AssetHive.exe in the archive. Please install manually."
        exit 0
    }

    $sourceDir = Split-Path $extractedExe -Parent

    $running = Get-Process -Name "AssetHive" -ErrorAction SilentlyContinue
    if ($running) {
        Write-Status "AssetHive is running. Attempting to close it..."
        $running | Stop-Process -Force
        Start-Sleep -Seconds 3
        $stillRunning = Get-Process -Name "AssetHive" -ErrorAction SilentlyContinue
        if ($stillRunning) {
            Write-Err "Cannot close AssetHive. Please close it manually and run this script again."
            exit 1
        }
    }

    Write-Status "Updating files in: $installDir"
    Get-ChildItem -Path $sourceDir -Exclude ".update" | ForEach-Object {
        $dest = Join-Path $installDir $_.Name
        if ($_.PSIsContainer) {
            if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
            Copy-Item -Path $_.FullName -Destination $dest -Recurse -Force
        } else {
            Copy-Item -Path $_.FullName -Destination $dest -Force
        }
    }

    Write-Status "Cleaning up temporary files..."
    Remove-Item $extractDir -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $targetFile -Force -ErrorAction SilentlyContinue

    Write-Host ""
    Write-Ok "Update complete! AssetHive $latestVersion is ready."
    Write-Status "You can launch AssetHive from: $existingExe"

} elseif ($isZip -and -not $installDir) {
    $extractDir = Join-Path $SCRIPT_DIR "AssetHive-$latestVersion"
    if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force }
    Expand-Archive -Path $targetFile -DestinationPath $extractDir -Force
    Write-Ok "Extracted to: $extractDir"

    $newExe = $null
    $exeCandidates = @(Get-ChildItem -Path $extractDir -Filter "AssetHive.exe" -Recurse -Depth 2 -ErrorAction SilentlyContinue)
    if ($exeCandidates.Count -gt 0) { $newExe = $exeCandidates[0].FullName }
    if ($newExe) {
        Write-Host ""
        Write-Ok "Done! AssetHive $latestVersion is ready."
        Write-Status "You can launch AssetHive from: $newExe"
    } else {
        Write-Ok "Done! Files extracted to: $extractDir"
    }

} elseif ($isInstaller) {
    Write-Host ""
    Write-Ok "Download complete: $targetFile"
    if ($installDir) {
        Write-Status "This is an installer package. It will be launched to update your existing installation."
    } else {
        Write-Status "This is an installer package. Run it to install AssetHive."
    }
    $launch = Read-Host "Launch installer now? (Y/n)"
    if ($launch -ne "n" -and $launch -ne "N") {
        Start-Process -FilePath $targetFile
        Write-Ok "Installer launched."
    }
}

Write-Host ""
