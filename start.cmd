@echo off
setlocal
cd /d "%~dp0"
set "REWIND_NODE=node"
where node >nul 2>nul
if errorlevel 1 (
  set "REWIND_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
)
if not "%REWIND_NODE%"=="node" if not exist "%REWIND_NODE%" (
  echo Please install Node.js 22 or newer, then run this file again.
  pause
  exit /b 1
)
"%REWIND_NODE%" scripts\serve.mjs --open
pause
