$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$listPath = Get-ChildItem -LiteralPath $root -File -Filter "to_delete_*_existing.txt" | Sort-Object LastWriteTime -Descending | Select-Object -First 1 | ForEach-Object { $_.FullName }
if (-not $listPath) {
  Write-Host "[ERROR] List file not found in:"
  Write-Host "        $root"
  exit 1
}

$paths = Get-Content -LiteralPath $listPath -Encoding UTF8 | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }
Write-Host "[INFO] List:"
Write-Host "       $listPath"
Write-Host "[INFO] Paths: $($paths.Count)"
$answer = Read-Host "Proceed with delete? (Y/N)"
if ($answer.ToLower() -ne "y") {
  Write-Host "[CANCEL] Cancelled"
  exit 0
}

$deleted = 0
$missing = 0
$failed = 0
foreach ($p in $paths) {
  if (Test-Path -LiteralPath $p) {
    try {
      Remove-Item -LiteralPath $p -Force -ErrorAction Stop
      if (Test-Path -LiteralPath $p) {
        Write-Host "[FAIL] $p"
        $failed += 1
      } else {
        $deleted += 1
      }
    } catch {
      Write-Host "[FAIL] $p -> $($_.Exception.Message)"
      $failed += 1
    }
  } else {
    $missing += 1
  }
}

Write-Host "[DONE] deleted=$deleted missing=$missing failed=$failed"
