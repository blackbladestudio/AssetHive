@echo off
setlocal
chcp 65001 >nul

where node >nul 2>nul
if %errorlevel% neq 0 (
  echo [ERROR] Node.js was not found. Please install Node.js and ensure node.exe is in PATH.
  echo         https://nodejs.org/
  pause
  exit /b 1
)
set "SCRIPT=%~dp0batch_import_assets.js"
if not exist "%SCRIPT%" (
  echo [ERROR] Script not found: %SCRIPT%
  pause
  exit /b 1
)
node "%SCRIPT%" %*

if "%~1"=="" pause
exit /b 0
