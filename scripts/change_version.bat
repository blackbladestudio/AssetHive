@echo off
setlocal
chcp 65001 >nul

:: 使用 Node.js 运行修改脚本
node "%~dp0change_version.js"

pause
exit /b 0
