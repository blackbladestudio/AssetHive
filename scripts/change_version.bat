@echo off
setlocal
chcp 65001 >nul

call "%~dp0ensure_dependencies.bat" -Mode Node
if errorlevel 1 exit /b 1
if "%~1"=="--check-deps" exit /b 0

:: 使用 Node.js 运行修改脚本
node "%~dp0change_version.js"
set "VERSION_EXIT=%ERRORLEVEL%"

pause
exit /b %VERSION_EXIT%
