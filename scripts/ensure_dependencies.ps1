param([ValidateSet('Preview', 'Project', 'Node')][string]$Mode = 'Preview')

$ErrorActionPreference = 'Stop'
$dependencyRoot = Split-Path -Parent $PSScriptRoot
$portableNode = Join-Path $dependencyRoot 'tools\node'

function Test-NodeRuntime {
  if (-not (Get-Command node.exe -ErrorAction SilentlyContinue) -or -not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { return $false }
  $nodeVersion = & node.exe -p 'process.versions.node' 2>$null
  if ($LASTEXITCODE -ne 0) { return $false }
  try { $parsedVersion = [version]$nodeVersion } catch { return $false }
  if (-not ($parsedVersion.Major -ge 24 -or ($parsedVersion.Major -eq 22 -and $parsedVersion.Minor -ge 12))) { return $false }
  & npm.cmd --version >$null 2>$null
  return $LASTEXITCODE -eq 0
}

function Initialize-NodeRuntime {
  if (Test-Path -LiteralPath (Join-Path $portableNode 'node.exe')) { $env:Path = "$portableNode;$env:Path" }
  if (Test-NodeRuntime) { return }
  Write-Host '[INFO] Node.js/npm is missing or too old. Downloading portable Node.js 24 LTS into tools\node...'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $ProgressPreference = 'SilentlyContinue'
  $architecture = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
  $downloadRoot = Join-Path $dependencyRoot '.cache\node-download'
  New-Item -ItemType Directory -Path $downloadRoot -Force | Out-Null
  $baseUrl = 'https://nodejs.org/dist/latest-v24.x/'
  $checksums = (Invoke-WebRequest -UseBasicParsing -Uri ($baseUrl + 'SHASUMS256.txt') -TimeoutSec 120).Content
  $match = [regex]::Match([string]$checksums, "(?m)^([a-fA-F0-9]{64})\s+(node-v24\.\d+\.\d+-win-$architecture\.zip)\s*$")
  if (-not $match.Success) { throw 'Could not find the Node.js Windows download in the official checksum manifest.' }
  $archive = Join-Path $downloadRoot $match.Groups[2].Value
  $checksum = $match.Groups[1].Value
  if (-not (Test-Path -LiteralPath $archive) -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $checksum) {
    Invoke-WebRequest -UseBasicParsing -Uri ($baseUrl + $match.Groups[2].Value) -OutFile $archive -TimeoutSec 180
  }
  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $checksum) { throw 'Node.js download failed SHA256 validation. Run the script again to retry.' }
  Expand-Archive -LiteralPath $archive -DestinationPath $downloadRoot -Force
  $extracted = Join-Path $downloadRoot ([IO.Path]::GetFileNameWithoutExtension($archive))
  New-Item -ItemType Directory -Path $portableNode -Force | Out-Null
  Get-ChildItem -LiteralPath $extracted | Copy-Item -Destination $portableNode -Recurse -Force
  $env:Path = "$portableNode;$env:Path"
  if (-not (Test-NodeRuntime)) { throw 'Portable Node.js/npm validation failed.' }
}

function Initialize-AssetHiveDependencies {
  Initialize-NodeRuntime
  Write-Host "[OK] Node.js $(& node.exe --version) / npm $(& npm.cmd --version)"
  if ($Mode -eq 'Node') { return }
  if (-not (Test-Path -LiteralPath (Join-Path $dependencyRoot 'package.json'))) { throw 'AssetHive package.json is missing.' }
  $env:npm_config_cache = Join-Path $dependencyRoot '.cache\npm'
  $probe = Join-Path $PSScriptRoot 'check_dependencies.cjs'
  Write-Host '[INFO] Checking installed packages, versions and command shims...'
  & node.exe $probe
  $packagesReady = $LASTEXITCODE -eq 0
  if ($packagesReady) {
    & node.exe (Join-Path $PSScriptRoot 'verify_sharp_webp.cjs') --source
    $packagesReady = $LASTEXITCODE -eq 0
  }
  if (-not $packagesReady) {
    Write-Host '[INFO] Installing/repairing project dependencies, including development and native packages...'
    $oldSkip = $env:ELECTRON_SKIP_BINARY_DOWNLOAD
    try {
      # Download Electron separately with a timeout, mirror fallback and a runtime probe.
      $env:ELECTRON_SKIP_BINARY_DOWNLOAD = '1'
      if (Test-Path -LiteralPath (Join-Path $dependencyRoot 'package-lock.json')) {
        & npm.cmd ci --include=dev --include=optional --no-audit --no-fund --fetch-retries=2 --fetch-timeout=60000
      } else {
        & npm.cmd install --include=dev --include=optional --no-audit --no-fund --fetch-retries=2 --fetch-timeout=60000
      }
      if ($LASTEXITCODE -ne 0) { throw 'npm dependency installation failed. Check the network/registry or close processes locking node_modules, then retry.' }
    } finally { $env:ELECTRON_SKIP_BINARY_DOWNLOAD = $oldSkip }
    & node.exe $probe
    if ($LASTEXITCODE -ne 0) { throw 'Project dependencies are still incomplete after installation.' }
    & node.exe (Join-Path $PSScriptRoot 'verify_sharp_webp.cjs') --source
    if ($LASTEXITCODE -ne 0) { throw 'Sharp/WebP native runtime still fails after installation.' }
  }
  if ($Mode -eq 'Preview') {
    & node.exe $probe --electron
    if ($LASTEXITCODE -ne 0) {
      & node.exe (Join-Path $PSScriptRoot 'install_electron.cjs')
      if ($LASTEXITCODE -ne 0) { throw 'Electron download or runtime validation failed.' }
    }
  }
  Write-Host '[OK] Required dependencies are ready.'
}

Push-Location $dependencyRoot
try { Initialize-AssetHiveDependencies }
catch { Write-Host "[ERROR] $($_.Exception.Message)" -ForegroundColor Red; exit 1 }
finally { Pop-Location }
