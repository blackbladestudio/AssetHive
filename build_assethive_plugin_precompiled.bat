@echo off
setlocal
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "ENGINE_ROOT=%UE_ENGINE_ROOT%"
if not defined ENGINE_ROOT (
  echo UE_ENGINE_ROOT is required.
  echo Example: set UE_ENGINE_ROOT=C:\Path\To\UE_5.5
  exit /b 1
)
set "BUILD_BAT=%ENGINE_ROOT%\Engine\Build\BatchFiles\Build.bat"
set "PROJECT_FILE=%ROOT%\UE\HiveTest\HiveTest.uproject"
set "SOURCE_PROJECT_ROOT=%ROOT%\UE\HiveTest"
rem =========================================================================================
rem PLUGIN SOURCE: %ROOT%\UE\HiveTest\Plugins\AssetHive (DO NOT MODIFY)
rem PLUGIN OUTPUT: %ROOT%\AssetHive-UE-Plugin (Compiled version)
rem NOTE: Output is PRECOMPILED-only (no Source) for "drop-in and open" usage in other projects.
rem =========================================================================================

set "PROJECT_PLUGIN_ROOT=%ROOT%\UE\HiveTest\Plugins\AssetHive"
set "PROJECT_PLUGIN=%PROJECT_PLUGIN_ROOT%"
set "PROJECT_TARGET=HiveTestEditor"
set "OUTPUT_ROOT=%ROOT%\AssetHive-UE-Plugin"
set "OUTPUT_PLUGIN=%OUTPUT_ROOT%\AssetHive"
set "TEMP_BUILD_ROOT=%OUTPUT_ROOT%\_build_tmp"
set "TEMP_PROJECT_ROOT=%TEMP_BUILD_ROOT%\HiveTest"
set "TEMP_PROJECT_FILE=%TEMP_PROJECT_ROOT%\HiveTest.uproject"
set "TEMP_PROJECT_PLUGIN=%TEMP_PROJECT_ROOT%\Plugins\AssetHive"
set "BUILD_CS_REL=Source\AssetHive\AssetHive.Build.cs"
set "ENGINE_PLUGIN_DIR=%ENGINE_ROOT%\Engine\Plugins\Marketplace\AssetHive"
set "ICON_SOURCE=%ROOT%\LOGO\Icon_V2_128.png"

if not exist "%BUILD_BAT%" (
  echo Missing: %BUILD_BAT%
  pause
  exit /b 1
)

rem Check if the source plugin exists
if not exist "%PROJECT_PLUGIN%\AssetHive.uplugin" (
  echo Missing Source Plugin: %PROJECT_PLUGIN%\AssetHive.uplugin
  pause
  exit /b 1
)

if exist "%ENGINE_PLUGIN_DIR%\AssetHive.uplugin" (
  echo Warning: Existing engine plugin detected at %ENGINE_PLUGIN_DIR%
  echo Make sure to fully replace that directory with this script output after packaging.
)

echo Ensuring output directory exists (Cleaning previous build)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "if(Test-Path -LiteralPath '%OUTPUT_PLUGIN%'){Remove-Item -LiteralPath '%OUTPUT_PLUGIN%' -Recurse -Force}; New-Item -ItemType Directory -Path '%OUTPUT_PLUGIN%' -Force | Out-Null"

echo Preparing temporary project copy for isolated build...
powershell -NoProfile -ExecutionPolicy Bypass -Command "if(Test-Path -LiteralPath '%TEMP_PROJECT_ROOT%'){Remove-Item -LiteralPath '%TEMP_PROJECT_ROOT%' -Recurse -Force}; New-Item -ItemType Directory -Path '%TEMP_BUILD_ROOT%' -Force | Out-Null; Copy-Item -LiteralPath '%SOURCE_PROJECT_ROOT%' -Destination '%TEMP_PROJECT_ROOT%' -Recurse -Force"
if errorlevel 1 (
  echo Failed to prepare temporary project copy!
  pause
  exit /b 1
)

if not exist "%TEMP_PROJECT_PLUGIN%\AssetHive.uplugin" (
  echo Missing temp plugin after copy: %TEMP_PROJECT_PLUGIN%\AssetHive.uplugin
  pause
  exit /b 1
)

echo Building temporary project target to compile plugin...
call "%BUILD_BAT%" %PROJECT_TARGET% Win64 Development -Project="%TEMP_PROJECT_FILE%" -WaitMutex -NoHotReloadFromIDE
if errorlevel 1 (
  echo Build failed!
  pause
  exit /b 1
)

echo Copying plugin files to output...
if exist "%TEMP_PROJECT_PLUGIN%\Binaries" xcopy "%TEMP_PROJECT_PLUGIN%\Binaries" "%OUTPUT_PLUGIN%\Binaries" /I /E /Y >nul
if exist "%TEMP_PROJECT_PLUGIN%\Config" xcopy "%TEMP_PROJECT_PLUGIN%\Config" "%OUTPUT_PLUGIN%\Config" /I /E /Y >nul
if exist "%TEMP_PROJECT_PLUGIN%\Content" xcopy "%TEMP_PROJECT_PLUGIN%\Content" "%OUTPUT_PLUGIN%\Content" /I /E /Y >nul
if exist "%TEMP_PROJECT_PLUGIN%\Resources" xcopy "%TEMP_PROJECT_PLUGIN%\Resources" "%OUTPUT_PLUGIN%\Resources" /I /E /Y >nul
copy /Y "%TEMP_PROJECT_PLUGIN%\AssetHive.uplugin" "%OUTPUT_PLUGIN%\" >nul
if exist "%TEMP_PROJECT_PLUGIN%\%BUILD_CS_REL%" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$src='%TEMP_PROJECT_PLUGIN%\%BUILD_CS_REL%'; $dst='%OUTPUT_PLUGIN%\%BUILD_CS_REL%'; New-Item -ItemType Directory -Path (Split-Path -Parent $dst) -Force | Out-Null; Copy-Item -LiteralPath $src -Destination $dst -Force"
)

if not exist "%OUTPUT_PLUGIN%\Binaries\Win64\UnrealEditor-AssetHive.dll" (
  echo Missing compiled binary: %OUTPUT_PLUGIN%\Binaries\Win64\UnrealEditor-AssetHive.dll
  pause
  exit /b 1
)

echo Removing Git LFS pointer assets from packaged Content...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c='%OUTPUT_PLUGIN%\Content'; if(Test-Path -LiteralPath $c){Get-ChildItem -LiteralPath $c -Recurse -File -Include *.uasset,*.umap | ForEach-Object { $first=(Get-Content -LiteralPath $_.FullName -TotalCount 1 -ErrorAction SilentlyContinue); if($first -eq 'version https://git-lfs.github.com/spec/v1'){ Remove-Item -LiteralPath $_.FullName -Force } }}"

echo Ensuring valid plugin icon...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$icon='%OUTPUT_PLUGIN%\Resources\Icon128.png'; $iconSrc='%ICON_SOURCE%'; $dir=Split-Path -Parent $icon; New-Item -ItemType Directory -Path $dir -Force | Out-Null; if(Test-Path -LiteralPath $iconSrc){Copy-Item -LiteralPath $iconSrc -Destination $icon -Force}; $ok=$false; if(Test-Path -LiteralPath $icon){$bytes=[System.IO.File]::ReadAllBytes($icon); if($bytes.Length -ge 8 -and $bytes[0] -eq 137 -and $bytes[1] -eq 80 -and $bytes[2] -eq 78 -and $bytes[3] -eq 71){$ok=$true}}; if(-not $ok){Add-Type -AssemblyName System.Drawing; $bmp=New-Object System.Drawing.Bitmap 128,128; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.Clear([System.Drawing.Color]::FromArgb(22,22,28)); $brush=New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(92,173,255)); $g.FillEllipse($brush,12,12,104,104); $font=New-Object System.Drawing.Font('Segoe UI',44,[System.Drawing.FontStyle]::Bold,[System.Drawing.GraphicsUnit]::Pixel); $textBrush=New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White); $sf=New-Object System.Drawing.StringFormat; $sf.Alignment='Center'; $sf.LineAlignment='Center'; $g.DrawString('AH',$font,$textBrush,(New-Object System.Drawing.RectangleF(0,0,128,128)),$sf); $bmp.Save($icon,[System.Drawing.Imaging.ImageFormat]::Png); $sf.Dispose(); $textBrush.Dispose(); $font.Dispose(); $brush.Dispose(); $g.Dispose(); $bmp.Dispose()}"

echo Marking plugin as Installed and stripping Intermediate for precompiled distribution...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p='%OUTPUT_PLUGIN%\AssetHive.uplugin'; if(Test-Path -LiteralPath $p){$j=Get-Content -LiteralPath $p -Raw | ConvertFrom-Json; $j.Installed=$true; $j | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $p -Encoding UTF8}; $intermediate=Join-Path '%OUTPUT_PLUGIN%' 'Intermediate'; if(Test-Path -LiteralPath $intermediate){ Remove-Item -LiteralPath $intermediate -Recurse -Force }"

echo Cleaning temporary build project...
powershell -NoProfile -ExecutionPolicy Bypass -Command "if(Test-Path -LiteralPath '%TEMP_PROJECT_ROOT%'){Remove-Item -LiteralPath '%TEMP_PROJECT_ROOT%' -Recurse -Force}"

echo Plugin package generated: %OUTPUT_PLUGIN%
pause
exit /b 0
