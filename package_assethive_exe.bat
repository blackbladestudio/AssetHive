@echo off
setlocal
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "OUTPUT_ROOT=%ROOT%\Output"
set "STAGE_OUT=%TEMP%\AssetHivePackOut"
set "APP_ICON=%ROOT%\LOGO\v2.ico"
set "ELECTRON_CACHE=%ROOT%\.cache\electron"
set "PACKAGER_TMP=%ROOT%\.cache\packager-tmp"
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"
set "PACKAGER=@electron/packager@latest"
set "TARGET_MAX_MB=280"
set "STRIP_GPU_RUNTIME=0"
set "STRIP_MEDIA_RUNTIME=0"
set "FINAL_DEST="
set "UPDATER_SOURCE=%ROOT%\updater\AssetHiveUpdater.cs"
set "UPDATER_EXE=%ROOT%\AssetHiveUpdater.exe"
if not exist "%APP_ICON%" (
  echo Missing: %APP_ICON%
  goto :fail
)
taskkill /IM AssetHive.exe /F >nul 2>nul
timeout /t 1 /nobreak >nul
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; New-Item -ItemType Directory -Path '%OUTPUT_ROOT%' -Force | Out-Null"
if errorlevel 1 goto :fail
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $target='%STAGE_OUT%'; if(Test-Path -LiteralPath $target){Remove-Item -LiteralPath $target -Recurse -Force}; New-Item -ItemType Directory -Path $target -Force | Out-Null"
if errorlevel 1 goto :fail
powershell -NoProfile -ExecutionPolicy Bypass -Command "if(-not (Test-Path -LiteralPath '%ELECTRON_CACHE%')){New-Item -ItemType Directory -Path '%ELECTRON_CACHE%' | Out-Null}"
if errorlevel 1 goto :fail
powershell -NoProfile -ExecutionPolicy Bypass -Command "if(-not (Test-Path -LiteralPath '%PACKAGER_TMP%')){New-Item -ItemType Directory -Path '%PACKAGER_TMP%' | Out-Null}"
if errorlevel 1 goto :fail
pushd "%ROOT%"
if errorlevel 1 goto :fail
call npm run check:unused-deps
if errorlevel 1 (
  echo Unused dependency check failed, skip and continue packaging...
)
call npm run build
if errorlevel 1 (
  goto :fail
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; if(-not (Test-Path -LiteralPath '%UPDATER_SOURCE%')){throw 'Missing updater source: %UPDATER_SOURCE%'}; if(Test-Path -LiteralPath '%UPDATER_EXE%'){Remove-Item -LiteralPath '%UPDATER_EXE%' -Force}; $src=Get-Content -LiteralPath '%UPDATER_SOURCE%' -Raw; Add-Type -TypeDefinition $src -OutputAssembly '%UPDATER_EXE%' -OutputType ConsoleApplication -Language CSharp; if(-not (Test-Path -LiteralPath '%UPDATER_EXE%')){throw 'Updater build failed: %UPDATER_EXE%'}"
if errorlevel 1 (
  goto :fail
)
call npx --yes %PACKAGER% . AssetHive --platform=win32 --arch=x64 --overwrite --icon="%APP_ICON%" --out="%STAGE_OUT%" --prune=true --asar --electron-version=40.8.0 --download.cache="%ELECTRON_CACHE%" --tmpdir="%PACKAGER_TMP%" --win32metadata.CompanyName="Biscuits" --win32metadata.FileDescription="AssetHive" --win32metadata.ProductName="AssetHive" --app-copyright="Biscuits" --ignore="^/Output($|/)" --ignore="^/\.git($|/)" --ignore="^/\.cache($|/)" --ignore="^/\.update($|/)" --ignore="^/src($|/)" --ignore="^/UE($|/)" --ignore="^/Rerfence($|/)" --ignore="^/AssetHive-UE-Plugin($|/)" --ignore="^/updater($|/)" --ignore="^/Log($|/)" --ignore="^/Logs($|/)" --ignore="^/LOGO($|/)" --ignore="^/scripts($|/)" --ignore="^/node_modules/\.vite($|/)" --ignore="^/AssetHive\.exe$" --ignore="^/AssetHiveUpdater\.exe$" --ignore="^/assethive\.log$" --ignore="^/import_.*\.log$" --ignore="^/import_.*\.json$" --ignore="^/Note\.txt$" --ignore="^/tmp_.*\.json$" --ignore="\.psd$" --ignore="\.bat$" --ignore="^/tsconfig\.json$" --ignore="^/vite\.config\.ts$" --ignore="^/eslint\.config\.js$"
if errorlevel 1 (
  goto :fail
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $dest='%STAGE_OUT%\AssetHive-win32-x64\AssetHiveUpdater.exe'; if(-not (Test-Path -LiteralPath '%UPDATER_EXE%')){throw 'Missing updater exe: %UPDATER_EXE%'}; Copy-Item -LiteralPath '%UPDATER_EXE%' -Destination $dest -Force; if(-not (Test-Path -LiteralPath $dest)){throw 'Updater was not copied to package root'}"
if errorlevel 1 (
  goto :fail
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $logoDir='%STAGE_OUT%\AssetHive-win32-x64\LOGO'; New-Item -ItemType Directory -Path $logoDir -Force | Out-Null; Copy-Item -LiteralPath '%APP_ICON%' -Destination (Join-Path $logoDir 'v2.ico') -Force; if(-not (Test-Path -LiteralPath (Join-Path $logoDir 'v2.ico'))){throw 'Runtime icon was not copied to package root'}"
if errorlevel 1 (
  goto :fail
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $localeDir='%STAGE_OUT%\AssetHive-win32-x64\locales'; if(Test-Path -LiteralPath $localeDir){Get-ChildItem -LiteralPath $localeDir -File | Where-Object { $_.Name -notin @('en-US.pak','zh-CN.pak') } | Remove-Item -Force}"
if errorlevel 1 (
  goto :fail
)
if "%STRIP_GPU_RUNTIME%"=="1" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $root='%STAGE_OUT%\AssetHive-win32-x64'; $remove=@('d3dcompiler_47.dll','dxcompiler.dll','dxil.dll','vk_swiftshader.dll','vk_swiftshader_icd.json','vulkan-1.dll'); foreach($name in $remove){$path=Join-Path $root $name; if(Test-Path -LiteralPath $path){Remove-Item -LiteralPath $path -Force}}"
  if errorlevel 1 (
    goto :fail
  )
)
if "%STRIP_MEDIA_RUNTIME%"=="1" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $file='%STAGE_OUT%\AssetHive-win32-x64\ffmpeg.dll'; if(Test-Path -LiteralPath $file){Remove-Item -LiteralPath $file -Force}"
  if errorlevel 1 (
    goto :fail
  )
)
for /f "usebackq delims=" %%S in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $size=(Get-ChildItem -LiteralPath '%STAGE_OUT%\AssetHive-win32-x64' -Recurse -File | Measure-Object -Property Length -Sum).Sum; [math]::Round($size/1MB)"`) do set "PKG_SIZE_MB=%%S"
echo Package size before move: %PKG_SIZE_MB% MB
if defined TARGET_MAX_MB if %PKG_SIZE_MB% GTR %TARGET_MAX_MB% (
  echo Warning: package size exceeds %TARGET_MAX_MB% MB
)
for /f "usebackq delims=" %%D in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $base='%OUTPUT_ROOT%\AssetHive'; $dest=$base; $index=1; while(Test-Path -LiteralPath $dest){$dest = $base + '-' + $index; $index += 1}; Rename-Item -LiteralPath '%STAGE_OUT%\AssetHive-win32-x64' -NewName 'AssetHive' -Force; Move-Item -LiteralPath '%STAGE_OUT%\AssetHive' -Destination $dest -Force; Write-Output $dest"`) do set "FINAL_DEST=%%D"
if errorlevel 1 (
  goto :fail
)
if not defined FINAL_DEST (
  goto :fail
)

echo Compressing to ZIP...
for /f "usebackq delims=" %%Z in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $version = (Get-Content -Path '%ROOT%\package.json' -Raw | ConvertFrom-Json).version; $zipName = 'AssetHive-v' + $version + '-win64.zip'; $zipPath = Join-Path '%OUTPUT_ROOT%' $zipName; if(Test-Path $zipPath){Remove-Item $zipPath -Force}; Compress-Archive -Path '%FINAL_DEST%' -DestinationPath $zipPath -Force; Write-Output $zipPath"`) do set "ZIP_DEST=%%Z"
if errorlevel 1 (
  echo Zip compression failed.
  goto :fail
)

popd
echo App package generated: %FINAL_DEST%
echo Compressed ZIP generated: %ZIP_DEST%
call :maybe_pause
exit /b 0

:fail
set "ERR=%ERRORLEVEL%"
popd >nul 2>nul
echo Package failed with code %ERR%
call :maybe_pause
exit /b %ERR%

:maybe_pause
if "%ASSETHIVE_NO_PAUSE%"=="1" exit /b 0
pause
exit /b 0
