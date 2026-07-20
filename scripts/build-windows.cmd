@echo off
setlocal

cd /d "%~dp0.."

where powershell.exe >nul 2>nul
if errorlevel 1 (
  echo 未找到 PowerShell。
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-windows.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo Windows 构建失败，退出码：%EXIT_CODE%
  pause
)

exit /b %EXIT_CODE%
