param(
  [Parameter(Mandatory = $true)]
  [string]$SourceZipDir,
  [string]$TempRoot = (Join-Path $env:TEMP "AssetHive\BatchImportTemp"),
  [string]$ProjectPath = (Join-Path $PSScriptRoot "..\UE\HiveTest\HiveTest.uproject"),
  [string]$EditorCmdPath = "",
  [string]$JobPath = (Join-Path $env:TEMP "AssetHive\batch-import-job.json"),
  [string]$LogPath = (Join-Path $env:TEMP "AssetHive\AssetHiveImport.log")
)

$ProjectPath = [System.IO.Path]::GetFullPath($ProjectPath)
if (-not $EditorCmdPath -and $env:UE_ENGINE_ROOT) {
  $EditorCmdPath = Join-Path $env:UE_ENGINE_ROOT "Engine\Binaries\Win64\UnrealEditor-Cmd.exe"
}
if (-not $EditorCmdPath) {
  throw "EditorCmdPath is required. Pass -EditorCmdPath or set UE_ENGINE_ROOT."
}

function Detect-TextureSlot([string]$FilePath) {
  $name = [System.IO.Path]::GetFileNameWithoutExtension($FilePath).ToLowerInvariant()
  if ($name -match "albedo|basecolor|base_color|diffuse|color") { return "albedo" }
  if ($name -match "ambientocclusion|ambient_occlusion|\bao\b") { return "ao" }
  if ($name -match "normal|nrm|\bnor\b") { return "normal" }
  if ($name -match "roughness|rough") { return "roughness" }
  if ($name -match "displacement|height") { return "displacement" }
  if ($name -match "fuzz") { return "fuzz" }
  if ($name -match "ordp|orm") { return "ordp" }
  if ($name -match "metalness|metallic|metal") { return "metalness" }
  if ($name -match "specular|spec") { return "specular" }
  if ($name -match "opacity|alpha|transparency") { return "opacity" }
  return ""
}

function Normalize-Name([string]$Name) {
  return [regex]::Replace($Name, '\.(10\d{2})(?=\.)', {
    param($m)
    $num = [int]$m.Groups[1].Value
    "_" + ("{0:D3}" -f ($num - 1000))
  })
}

$extractRoot = Join-Path $TempRoot "extract"
$stageRoot = Join-Path $TempRoot "stage"
Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $extractRoot -Force | Out-Null
New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null

if (-not (Test-Path -LiteralPath $SourceZipDir)) {
  throw "SourceZipDir does not exist: $SourceZipDir"
}

$zipFiles = Get-ChildItem -LiteralPath $SourceZipDir -File -Filter *.zip | Sort-Object Name
if (-not $zipFiles) {
  throw "No zip files found: $SourceZipDir"
}

$assets = @()
foreach ($zip in $zipFiles) {
  $assetName = [System.IO.Path]::GetFileNameWithoutExtension($zip.Name)
  $extractDir = Join-Path $extractRoot $assetName
  $stageDir = Join-Path $stageRoot $assetName
  New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
  New-Item -ItemType Directory -Path $stageDir -Force | Out-Null
  Expand-Archive -LiteralPath $zip.FullName -DestinationPath $extractDir -Force

  $allFiles = Get-ChildItem -LiteralPath $extractDir -Recurse -File
  foreach ($file in $allFiles) {
    $relative = $file.FullName.Substring($extractDir.Length).TrimStart('\')
    $folderPart = [System.IO.Path]::GetDirectoryName($relative)
    $newName = Normalize-Name $file.Name
    $targetDir = if ([string]::IsNullOrEmpty($folderPart)) { $stageDir } else { Join-Path $stageDir $folderPart }
    New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
    $targetPath = Join-Path $targetDir $newName
    Copy-Item -LiteralPath $file.FullName -Destination $targetPath -Force
  }

  $modelExt = @(".fbx", ".obj", ".abc", ".gltf", ".glb")
  $texExt = @(".png", ".jpg", ".jpeg", ".tga", ".bmp", ".exr", ".tif", ".tiff", ".webp")
  $models = Get-ChildItem -LiteralPath $stageDir -Recurse -File | Where-Object { $modelExt -contains $_.Extension.ToLowerInvariant() }
  $textures = Get-ChildItem -LiteralPath $stageDir -Recurse -File | Where-Object { $texExt -contains $_.Extension.ToLowerInvariant() }
  if (-not $models) {
    continue
  }
  $highModel = $models | Where-Object { $_.BaseName.ToLowerInvariant() -match "highpoly|_high|-high|high$|lod0|ztool" } | Select-Object -First 1
  if (-not $highModel) {
    $highModel = $models | Select-Object -First 1
  }

  $textureFiles = @()
  $textureSlots = @()
  foreach ($tex in $textures) {
    $slot = Detect-TextureSlot $tex.FullName
    if ([string]::IsNullOrWhiteSpace($slot)) {
      continue
    }
    $textureFiles += $tex.FullName
    $textureSlots += $slot
  }

  $assets += [ordered]@{
    id = $assetName
    name = $assetName
    modelFiles = @($highModel.FullName)
    textureFiles = $textureFiles
    textureSlots = $textureSlots
  }
}

if (-not $assets) {
  throw "No importable assets generated."
}

$payload = [ordered]@{
  createdAt = (Get-Date).ToString("s")
  destinationPath = "/Game/AssetHive"
  assets = $assets
}

$payload | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $JobPath -Encoding UTF8

& $EditorCmdPath $ProjectPath -run=AssetHiveImport "-Job=$JobPath" -unattended -nop4 -NoSourceControl -nosplash -log "-abslog=$LogPath" -forcelogflush
