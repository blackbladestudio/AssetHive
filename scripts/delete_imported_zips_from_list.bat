@echo off
setlocal EnableExtensions

set "SCRIPT=%~dp0delete_imported_zips_from_list.ps1"
if not exist "%SCRIPT%" (
  echo [ERROR] Script not found:
  echo         %SCRIPT%
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
pause
exit /b 0

