@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0preview_assethive.ps1" %*
set "PREVIEW_EXIT=%ERRORLEVEL%"
if not "%ASSETHIVE_NO_PAUSE%"=="1" if not "%~1"=="-CheckDependenciesOnly" if not "%PREVIEW_EXIT%"=="0" pause
exit /b %PREVIEW_EXIT%
