@echo off
chcp 65001 >nul
setlocal
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "OUTPUT_ROOT=%ROOT%\Output"
set "STAGE_OUT=%ROOT%\.cache\AssetHivePackOut"
set "APP_ICON=%ROOT%\images\v2.ico"
set "ELECTRON_CACHE=%ROOT%\.cache\electron"
set "PACKAGER_TMP=%ROOT%\.cache\packager-tmp"
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"
set "PACKAGER=@electron/packager@20.3.0"
set "TARGET_MAX_MB=1800"
set "STRIP_GPU_RUNTIME=0"
set "STRIP_MEDIA_RUNTIME=0"
set "FINAL_DEST="
set "UPDATER_SOURCE=%ROOT%\updater\AssetHiveUpdater.cs"
set "UPDATER_EXE=%ROOT%\AssetHiveUpdater.exe"
set "INNO_DIR=%ROOT%\tools\InnoSetup"
set "ISCC=%INNO_DIR%\ISCC.exe"
set "ISETUP=%TEMP%\isetup-assethive.exe"
set "INSTALLER_ISS=%ROOT%\installer\assethive.iss"
if not exist "%APP_ICON%" (
  echo Missing: %APP_ICON%
  goto :fail
)
call "%ROOT%\scripts\ensure_dependencies.bat" -Mode Preview
if errorlevel 1 goto :fail
if "%~1"=="--check-deps" exit /b 0

rem 不再用 taskkill 结束所有 AssetHive.exe：会误杀用户已安装并正在使用的软件。
rem 仓库内残留的预览 Electron / AssetHive 由 kill-stale-electron.cjs 按可执行文件路径前缀精确清理，
rem 不会影响安装目录下的已安装软件。
if not "%ASSETHIVE_KEEP_RUNNING%"=="1" call node "%~dp0scripts\kill-stale-electron.cjs"
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

rem Use the validated lockfile runtime; old Chromium blocks on files dragged from ZIP folders.
set "ELECTRON_VERSION="
for /f "delims=" %%V in ('node scripts\check_dependencies.cjs --electron-version') do set "ELECTRON_VERSION=%%V"
if not defined ELECTRON_VERSION (
  echo Failed to validate the locked Electron runtime.
  popd
  exit /b 1
)

call npm run check:unused-deps
if errorlevel 1 (
  echo Unused dependency check failed, skip and continue packaging...
)
call npm run build
if errorlevel 1 (
  goto :fail
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; if(-not (Test-Path -LiteralPath '%UPDATER_SOURCE%')){throw 'Missing updater source: %UPDATER_SOURCE%'}; if(Test-Path -LiteralPath '%UPDATER_EXE%'){Remove-Item -LiteralPath '%UPDATER_EXE%' -Force}; $src=Get-Content -LiteralPath '%UPDATER_SOURCE%' -Raw -Encoding UTF8; Add-Type -TypeDefinition $src -OutputAssembly '%UPDATER_EXE%' -OutputType ConsoleApplication -Language CSharp; if(-not (Test-Path -LiteralPath '%UPDATER_EXE%')){throw 'Updater build failed: %UPDATER_EXE%'}"
if errorlevel 1 (
  goto :fail
)
set "NODE_OPTIONS=--require=%ROOT%\scripts\retry_windows_rename.cjs %NODE_OPTIONS%"
call npx --yes %PACKAGER% . AssetHive --platform=win32 --arch=x64 --overwrite --icon="%APP_ICON%" --out="%STAGE_OUT%" --prune=true --asar.unpack="**/*.node" --asar.unpackDir="{node_modules/@img/sharp-win32-x64,node_modules/onnxruntime-node/bin/napi-v6/win32/x64,electron/models}" --electron-version=%ELECTRON_VERSION% --download.cacheRoot="%ELECTRON_CACHE%" --tmpdir="%PACKAGER_TMP%" --win32metadata.CompanyName="BlackBlade Studio" --win32metadata.FileDescription="AssetHive" --win32metadata.ProductName="AssetHive" --app-copyright="BlackBlade Studio" --ignore="^/context[.]md$" --ignore="^/Output($|/)" --ignore="^/outputs($|/)" --ignore="^/[.](agents|claude|codex|aws|tmp|wix)($|/)" --ignore="^/[.]write_test[.]tmp$" --ignore="^/docs($|/)" --ignore="^/preview($|/)" --ignore="^/\.git($|/)" --ignore="^/\.cache($|/)" --ignore="^/\.update($|/)" --ignore="^/src($|/)" --ignore="^/UE($|/)" --ignore="^/Rerfence($|/)" --ignore="^/AssetHive-UE-Plugin($|/)" --ignore="^/updater($|/)" --ignore="^/Log($|/)" --ignore="^/Logs($|/)" --ignore="^/images($|/)" --ignore="^/scripts/(?!lib(?:/|$))" --ignore="^/installer($|/)" --ignore="^/tools($|/)" --ignore="^/resources/blender($|/)" --ignore="^/BlenderPlugin($|/)" --ignore="^/node_modules/\.vite($|/)" --ignore="^/AssetHive\.exe$" --ignore="^/AssetHiveUpdater\.exe$" --ignore="^/assethive\.log$" --ignore="^/import_.*\.log$" --ignore="^/import_.*\.json$" --ignore="^/Note\.txt$" --ignore="^/tmp_.*\.json$" --ignore="\.psd$" --ignore="\.bat$" --ignore="^/tsconfig\.json$" --ignore="^/vite\.config\.ts$" --ignore="^/eslint\.config\.js$"
if errorlevel 1 (
  goto :fail
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; Copy-Item -LiteralPath '%ROOT%\BlenderPlugin' -Destination '%STAGE_OUT%\AssetHive-win32-x64\BlenderPlugin' -Recurse -Force"
if errorlevel 1 (
  goto :fail
)
call node scripts\verify_sharp_webp.cjs "%STAGE_OUT%\AssetHive-win32-x64"
if errorlevel 1 (
  echo [ERROR] Packaged Sharp/WebP runtime validation failed.
  goto :fail
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $dest='%STAGE_OUT%\AssetHive-win32-x64\AssetHiveUpdater.exe'; if(-not (Test-Path -LiteralPath '%UPDATER_EXE%')){throw 'Missing updater exe: %UPDATER_EXE%'}; Copy-Item -LiteralPath '%UPDATER_EXE%' -Destination $dest -Force; if(-not (Test-Path -LiteralPath $dest)){throw 'Updater was not copied to package root'}"
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

rem ---- Read app version from package.json ----
for /f "usebackq delims=" %%V in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; (Get-Content -Path '%ROOT%\package.json' -Raw | ConvertFrom-Json).version"`) do set "APP_VERSION=%%V"
if not defined APP_VERSION (
  echo Failed to read app version.
  goto :fail
)

rem ---- Bootstrap Inno Setup (download + silent install into project tools dir if missing) ----
if not exist "%ISCC%" (
  echo Inno Setup not found, downloading and installing to %INNO_DIR% ...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $urls=@('https://ghfast.top/https://github.com/jrsoftware/issrc/releases/download/is-6_7_3/innosetup-6.7.3.exe','https://gh-proxy.com/https://github.com/jrsoftware/issrc/releases/download/is-6_7_3/innosetup-6.7.3.exe','https://ghproxy.net/https://github.com/jrsoftware/issrc/releases/download/is-6_7_3/innosetup-6.7.3.exe','https://mirror.ghproxy.com/https://github.com/jrsoftware/issrc/releases/download/is-6_7_3/innosetup-6.7.3.exe'); $done=$false; foreach($u in $urls){ try { Write-Host ('Downloading: ' + $u); (New-Object System.Net.WebClient).DownloadFile($u,'%ISETUP%'); if((Get-Item '%ISETUP%').Length -gt 1MB){ $done=$true; Write-Host ('Downloaded: ' + (Get-Item '%ISETUP%').Length + ' bytes'); break } } catch { Write-Host ('Download failed: ' + $_.Exception.Message) } }; if(-not $done){ exit 1 }"
  if errorlevel 1 (
    echo Inno Setup download failed.
    goto :fail
  )
  echo Installing Inno Setup silently...
  "%ISETUP%" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /CURRENTUSER /NOICONS /DIR="%INNO_DIR%"
  if errorlevel 1 (
    echo Inno Setup install failed.
    goto :fail
  )
  if not exist "%ISCC%" (
    echo Inno Setup ISCC.exe not found after install.
    goto :fail
  )
)
if not exist "%INSTALLER_ISS%" (
  echo Missing installer script: %INSTALLER_ISS%
  goto :fail
)

rem ---- Compile Inno Setup installer from stage dir ----
echo Compiling Inno Setup installer...
"%ISCC%" /Qp "/DMyAppVersion=%APP_VERSION%" "/DMyAppSourceDir=%STAGE_OUT%\AssetHive-win32-x64" /O"%OUTPUT_ROOT%" "%INSTALLER_ISS%"
if errorlevel 1 (
  echo Inno Setup compile failed.
  goto :fail
)
echo Installer generated: %OUTPUT_ROOT%\AssetHive-%APP_VERSION%-setup-win64.exe

rem Keep this release's installer formats; remove older versions only after success.
call node scripts\cleanup-installers.cjs --output "%OUTPUT_ROOT%" --version "%APP_VERSION%" --require "%OUTPUT_ROOT%\AssetHive-%APP_VERSION%-setup-win64.exe"
if errorlevel 1 goto :fail

rem ---- 清理打包临时 stage 目录（仅保留 Output 下的 setup.exe）----
if not "%ASSETHIVE_KEEP_STAGE%"=="1" powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; if(Test-Path -LiteralPath '%STAGE_OUT%'){Remove-Item -LiteralPath '%STAGE_OUT%' -Recurse -Force}"
if errorlevel 1 (
  echo Warning: failed to clean stage dir %STAGE_OUT%
)
set "FINAL_DEST=%OUTPUT_ROOT%\AssetHive-%APP_VERSION%-setup-win64.exe"

popd
echo Installer generated: %FINAL_DEST%
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
