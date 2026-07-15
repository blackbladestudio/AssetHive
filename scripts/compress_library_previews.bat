@echo off
chcp 65001 >nul
setlocal

:: Path Configuration
set SCRIPT_NAME=compress_library_previews.js
set SCRIPT_PATH=%~dp0%SCRIPT_NAME%
set "TARGET_DIR=%~1"
if not defined TARGET_DIR (
    echo Usage: %~nx0 ^<library-path^>
    exit /b 2
)

echo ====================================================
echo   AssetHive Preview Optimizer
echo ====================================================
echo Target: %TARGET_DIR%
echo Script: %SCRIPT_PATH%
echo.

:: Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed. Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

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

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Compression process failed.
) else (
    echo.
    echo [SUCCESS] Optimization finished.
)

echo.
pause
