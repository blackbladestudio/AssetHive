@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "LIST=%~dp0..\to_delete_森林植被_299_existing.txt"

if not exist "%LIST%" (
  echo [ERROR] List file not found:
  echo         %LIST%
  pause
  exit /b 1
)

echo [INFO] Deleting zip files listed in:
echo        %LIST%
echo.
choice /c YN /m "Proceed with delete? (Y/N)"
if errorlevel 2 (
  echo [CANCEL] Cancelled
  exit /b 0
)

set /a deleted=0
set /a missing=0
set /a failed=0

for /f "usebackq delims=" %%P in ("%LIST%") do (
  set "P=%%P"
  if not "!P!"=="" (
    if exist "!P!" (
      del /f /q "!P!" >nul 2>nul
      if exist "!P!" (
        echo [FAIL] !P!
        set /a failed+=1
      ) else (
        set /a deleted+=1
      )
    ) else (
      set /a missing+=1
    )
  )
)

echo.
echo [DONE] deleted=!deleted! missing=!missing! failed=!failed!
pause
exit /b 0
