param(
  [Parameter(Mandatory = $true)]
  [string]$SourceZipDir,
  [Parameter(Mandatory = $true)]
  [string]$LibraryRoot,
  [string]$AssetType = "3d",
  [string]$Category = "Nature",
  [int]$BatchSize = 1,
  [int]$StartIndex = 0,
  [string]$AssetPattern = "",
  [string]$TempRoot = (Join-Path $env:TEMP "AssetHive\LibraryImportTemp")
)

$ErrorActionPreference = "Stop"

function Sanitize-Token([string]$Value) {
  $token = ($Value.Trim().ToLowerInvariant() -replace "[^a-z0-9]+", "_").Trim("_")
  if ([string]::IsNullOrWhiteSpace($token)) { return "asset" }
  return $token
}

function New-UniqueId {
  $chars = "abcdefghijklmnopqrstuvwxyz0123456789".ToCharArray()
  return (-join (1..7 | ForEach-Object { $chars[(Get-Random -Minimum 0 -Maximum $chars.Length)] }))
}

function Detect-TextureSuffix([string]$Name) {
  $n = $Name.ToLowerInvariant()
  if ($n -match "(albedo|basecolor|base_color|diffuse|color)") { return "Albedo" }
  if ($n -match "(ao|ambientocclusion|ambient_occlusion)") { return "AO" }
  if ($n -match "(normal|nrm|nor)") { return "Normal" }
  if ($n -match "(roughness|rough)") { return "Roughness" }
  if ($n -match "(metalness|metallic|metal)") { return "Metalness" }
  if ($n -match "(displacement|height)") { return "Displacement" }
  if ($n -match "(specular|spec)") { return "Specular" }
  if ($n -match "(gloss|glossiness)") { return "Gloss" }
  if ($n -match "(cavity)") { return "Cavity" }
  if ($n -match "(opacity|alpha|transparency)") { return "Opacity" }
  if ($n -match "(mask)") { return "Mask" }
  if ($n -match "(bump)") { return "Bump" }
  if ($n -match "(brush)") { return "Brush" }
  if ($n -match "(fuzz)") { return "Fuzz" }
  if ($n -match "(translucency|translucent)") { return "Translucency" }
  return ""
}

function Get-AreaIndexFromUdim([string]$BaseName) {
  $matched = [regex]::Match($BaseName, "(?<!\d)(1\d{3})(?!\d)")
  if ($matched.Success) {
    $udim = [int]$matched.Groups[1].Value
    if ($udim -ge 1001) { return ($udim - 1000) }
  }
  return 1
}

function Make-MeshSlotName([int]$Order) {
  if ($Order -le 1) { return "Mesh" }
  return "Mesh" + $Order.ToString("00")
}

function Make-ModelBaseName([string]$AssetNameToken, [string]$AssetId) {
  return "SM_${AssetNameToken}_${AssetId}"
}

function Make-TextureToken([string]$TextureType, [int]$AreaIndex, [int]$AreaCount) {
  if ($AreaCount -le 1) { return $TextureType }
  return ("{0}_{1}" -f $AreaIndex.ToString("000"), $TextureType)
}

function Make-TextureBaseName([string]$AssetNameToken, [string]$AssetId, [string]$Token) {
  return "T_${AssetNameToken}_${AssetId}_${Token}"
}

function Convert-ToDisplayName([string]$ZipBase) {
  $name = ($ZipBase -replace "^\d+[_\-\s]*", "")
  $name = ($name -replace "[_\-]+", " ").Trim()
  if ([string]::IsNullOrWhiteSpace($name)) { return "Imported Asset" }
  return $name
}

$typeToken = Sanitize-Token $AssetType
$assetTypeDir = Join-Path $LibraryRoot $typeToken
[System.IO.Directory]::CreateDirectory($assetTypeDir) | Out-Null
[System.IO.Directory]::CreateDirectory($TempRoot) | Out-Null

$zipFiles = Get-ChildItem -LiteralPath $SourceZipDir -File -Filter *.zip | Sort-Object Name
if (-not [string]::IsNullOrWhiteSpace($AssetPattern)) {
  $zipFiles = @($zipFiles | Where-Object { $_.Name -like $AssetPattern })
}
if (-not $zipFiles -or $zipFiles.Count -eq 0) {
  throw "No zip files found under: $SourceZipDir"
}

$selected = @($zipFiles | Select-Object -Skip ([Math]::Max(0, $StartIndex)) -First ([Math]::Max(1, $BatchSize)))
if ($selected.Count -eq 0) {
  throw "No zip files matched current batch window."
}

$tagList = @("3d", "nature", "PBR Max", "Cliff", "Rock", "Stone", "Outdoors", "Rough")
$summary = @()

foreach ($zip in $selected) {
  $zipBase = [System.IO.Path]::GetFileNameWithoutExtension($zip.Name)
  $displayName = Convert-ToDisplayName $zipBase
  $assetNameToken = Sanitize-Token $displayName

  $extractDir = Join-Path $TempRoot ("extract_" + $zipBase + "_" + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
  [System.IO.Directory]::CreateDirectory($extractDir) | Out-Null
  Expand-Archive -LiteralPath $zip.FullName -DestinationPath $extractDir -Force
  $allFiles = Get-ChildItem -LiteralPath $extractDir -Recurse -File

  $fbxFiles = @($allFiles | Where-Object { $_.Extension.ToLowerInvariant() -eq ".fbx" })
  if ($fbxFiles.Count -eq 0) {
    $summary += [ordered]@{
      zip = $zip.Name
      imported = $false
      reason = "No fbx found"
    }
    continue
  }

  $largestFbx = $fbxFiles | Sort-Object Length -Descending | Select-Object -First 1

  $previewCandidates = @($allFiles | Where-Object { $_.Extension.ToLowerInvariant() -in @(".jpg", ".jpeg") })
  if ($previewCandidates.Count -eq 0) {
    $summary += [ordered]@{
      zip = $zip.Name
      imported = $false
      reason = "No jpg preview found"
    }
    continue
  }
  $previewSource = $previewCandidates | Select-Object -First 1

  $textureExt = @(".png", ".jpg", ".jpeg", ".tif", ".tiff", ".exr", ".tga", ".webp", ".bmp")
  $textureSources = @($allFiles | Where-Object {
    $ext = $_.Extension.ToLowerInvariant()
    ($textureExt -contains $ext) -and
    $_.FullName -ne $previewSource.FullName -and
    $_.Name -notmatch "(?i)(^|[_\-.])lod\d+([_\-.]|$)"
  })

  $textureCandidates = @()
  foreach ($tex in $textureSources) {
    $slot = Detect-TextureSuffix $tex.Name
    if ([string]::IsNullOrWhiteSpace($slot)) { continue }
    $areaIndex = Get-AreaIndexFromUdim $tex.BaseName
    $textureCandidates += [pscustomobject]@{
      source = $tex
      textureType = $slot
      areaIndex = $areaIndex
    }
  }

  $modelSlot = "Mesh"
  $assetIdBase = Sanitize-Token $assetNameToken
  $uid = New-UniqueId
  $assetId = "${assetIdBase}_${uid}"
  
  $assetFolderName = "${typeToken}_${assetNameToken}_${uid}"
  $assetDir = Join-Path $assetTypeDir $assetFolderName
  if (Test-Path -LiteralPath $assetDir) { Remove-Item -LiteralPath $assetDir -Recurse -Force }
  [System.IO.Directory]::CreateDirectory($assetDir) | Out-Null

  # Copy Model (Largest FBX only)
  $modelFileName = "SM_${assetNameToken}_${uid}.fbx"
  $modelDest = Join-Path $assetDir $modelFileName
  [System.IO.File]::Copy($largestFbx.FullName, $modelDest, $true)
  $modelUri = $modelFileName
  $modelDestNorm = ($modelDest -replace "\\", "/")

  # Copy Preview
  $previewDir = Join-Path $assetDir "Preview"
  [System.IO.Directory]::CreateDirectory($previewDir) | Out-Null
  $previewFileName = "${uid}_preview" + $previewSource.Extension.ToLowerInvariant()
  $previewDest = Join-Path $previewDir $previewFileName
  [System.IO.File]::Copy($previewSource.FullName, $previewDest, $true)
  $previewLen = (Get-Item -LiteralPath $previewDest).Length
  $previewUri = "Preview/" + $previewFileName

  # Process Textures
  # Group by (TextureType + AreaIndex) to avoid duplicates if multiple files map to same slot
  $uniqueTextures = @{}
  foreach ($cand in $textureCandidates) {
    $key = "${cand.textureType}_${cand.areaIndex}"
    if (-not $uniqueTextures.Contains($key)) {
      $uniqueTextures[$key] = $cand
    } else {
      # If duplicate slot found, prefer larger file size? or just skip? 
      # Let's prefer larger file as it might be higher res or better quality
      if ($cand.source.Length -gt $uniqueTextures[$key].source.Length) {
        $uniqueTextures[$key] = $cand
      }
    }
  }
  
  $textureEntries = @()
  $textureFiles = @()
  $textureSlots = [ordered]@{}
  $componentTextures = @()

  foreach ($key in $uniqueTextures.Keys) {
    $item = $uniqueTextures[$key]
    $token = $item.textureType
    if ($maxArea -gt 1) {
      $token = ("{0:D3}_{1}" -f $item.areaIndex, $item.textureType)
    }
    
    $texFileName = "T_${assetNameToken}_${uid}_${token}" + $item.source.Extension.ToLowerInvariant()
    $texDest = Join-Path $assetDir $texFileName
    [System.IO.File]::Copy($item.source.FullName, $texDest, $true)
    
    $texUri = $texFileName
    $texDestNorm = ($texDest -replace "\\", "/")
    
    $textureFiles += $texDestNorm
    
    # Add to textureSlots (only for area 1)
    if ($item.areaIndex -eq 1 -and -not $textureSlots.Contains($item.textureType)) {
      $textureSlots[$item.textureType] = $texDestNorm
    }
    
    $entry = [ordered]@{
      textureType = $item.textureType
      areaIndex = $item.areaIndex
      uri = $texUri
    }
    $textureEntries += $entry
    
    $comp = [ordered]@{
      type = "texture"
      slot = $item.textureType
      areaIndex = $item.areaIndex
      uri = $texUri
    }
    $componentTextures += $comp
  }

  # Build Metadata
  $components = @(
    [ordered]@{
      type = "model"
      slot = "Mesh"
      uri = $modelUri
    }
  ) + $componentTextures

  $tagList = @($typeToken, "nature", "PBR Max", "Cliff", "Rock", "Stone", "Outdoors", "Rough")

  $meta = [ordered]@{
    pack = $null
    semanticTags = [ordered]@{
      name = $displayName
      asset_type = $typeToken
      contains = @($typeToken, "nature")
      theme = @("Nature")
      descriptive = @()
      state = @()
      subject_matter = "Nature"
      environment = @("Outdoors")
    }
    name = $displayName
    assetID = $uid
    slug = $assetFolderName
    assetType = $typeToken
    category = "Nature"
    tags = $tagList
    previews = [ordered]@{
      images = @(
        [ordered]@{
          contentLength = $previewLen
          resolution = "unknown"
          uri = $previewUri
          tags = @("preview")
        }
      )
      relativeSize = "2x1"
    }
    json = [ordered]@{
      contentLength = 0
      uri = "${uid}.json"
    }
    categories = @($typeToken, "nature")
    meta = @()
    components = $components
    modelFiles = @($modelDestNorm)
    modelSlots = [ordered]@{ Mesh = $modelDestNorm }
    textureFiles = $textureFiles
    textureSlots = $textureSlots
    textureEntries = $textureEntries
    normalMapFormat = "opengl"
    createdAt = (Get-Date).ToString("o")
  }

  $jsonPath = Join-Path $assetDir ("${uid}.json")
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($jsonPath, ($meta | ConvertTo-Json -Depth 16), $utf8NoBom)
  $meta.json.contentLength = (Get-Item -LiteralPath $jsonPath).Length
  [System.IO.File]::WriteAllText($jsonPath, ($meta | ConvertTo-Json -Depth 16), $utf8NoBom)

  $summary += [ordered]@{
    zip = $zip.Name
    imported = $true
    assetFolder = $assetFolderName
    assetId = $uid
    model = $modelUri
    textureCount = $textureEntries.Count
    textureGroupMax = $maxArea
    preview = $previewUri
    json = $jsonPath
  }
}

$summaryPath = Join-Path $TempRoot ("library-import-summary-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".json")
$utf8NoBomSummary = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($summaryPath, ($summary | ConvertTo-Json -Depth 10), $utf8NoBomSummary)

Write-Output ("Imported/processed: " + $selected.Count + " zip(s)")
Write-Output ("Summary: " + $summaryPath)
