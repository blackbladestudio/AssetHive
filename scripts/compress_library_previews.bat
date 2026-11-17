@echo off
chcp 65001 >nul
setlocal

:: Path Configuration
set SCRIPT_NAME=compress_library_previews.js
set SCRIPT_PATH=%~dp0%SCRIPT_NAME%
set TARGET_DIR=F:\ArkLibrayData

echo ====================================================
echo   AssetHive Preview Optimizer
echo ====================================================
echo Target: %TARGET_DIR%
echo Script: %SCRIPT_PATH%
echo.

:: Check if Node.js is installed
call "%~dp0ensure_dependencies.bat" -Mode Project
if errorlevel 1 exit /b 1
if "%~1"=="--check-deps" exit /b 0

:: Check if script exists
if not exist "%SCRIPT_PATH%" (
    echo [ERROR] Script file not found: %SCRIPT_NAME%
    echo Please ensure both .bat and .js files are in the same folder.
    pause
    exit /b 1
)

:: Run the compression script
echo [INFO] Starting compression process...
node "%SCRIPT_PATH%" "%TARGET_DIR%"
set "COMPRESS_EXIT=%ERRORLEVEL%"

if not "%COMPRESS_EXIT%"=="0" (
    echo.
    echo [ERROR] Compression process failed.
) else (
    echo.
    echo [SUCCESS] Optimization finished.
)

echo.
pause
exit /b %COMPRESS_EXIT%
