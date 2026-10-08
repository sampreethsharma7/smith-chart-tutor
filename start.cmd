@echo off
rem Launch Smith Tutor (double-click or run from any terminal).
cd /d "%~dp0"
rem VS Code terminals set this, which makes Electron run as plain Node.
set ELECTRON_RUN_AS_NODE=
if not exist node_modules (
  echo Installing dependencies...
  call npm.cmd install || goto :error
)
call npm.cmd run dev
exit /b

:error
echo.
echo Install failed. See the messages above.
pause
