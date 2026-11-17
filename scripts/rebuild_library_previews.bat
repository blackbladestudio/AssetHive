@echo off
setlocal
node "%~dp0rebuild_library_previews.js" %*
set "RESULT=%ERRORLEVEL%"
if "%~1"=="" pause
exit /b %RESULT%
