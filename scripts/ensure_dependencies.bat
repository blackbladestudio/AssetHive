@echo off
rem Intentionally no setlocal: export the project-local Node path to the caller.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0ensure_dependencies.ps1" %*
if errorlevel 1 exit /b 1
if exist "%~dp0..\tools\node\node.exe" set "PATH=%~dp0..\tools\node;%PATH%"
set "npm_config_cache=%~dp0..\.cache\npm"
exit /b 0
