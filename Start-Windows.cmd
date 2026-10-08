@echo off
rem Smith Chart Tutor: double-click to set up (first time only) and start.
rem No admin rights needed: everything goes into this folder (.runtime\), nothing system-wide.
rem To uninstall, delete this folder.
setlocal EnableExtensions
title Smith Chart Tutor
cd /d "%~dp0"
if not exist "package.json" goto :notextracted

set "NODE_VERSION=24.18.0"
set "RT=%CD%\.runtime"
set "ARCH=x64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "ARCH=arm64"
if /i "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "ARCH=arm64"
set "NODE_NAME=node-v%NODE_VERSION%-win-%ARCH%"
set "NODE_HOME=%RT%\%NODE_NAME%"
rem Trust the company's certificates (Windows store) for npm's downloads, as the browser does.
set "NODE_OPTIONS=--use-system-ca"
set "ELECTRON_RUN_AS_NODE="

if exist "%NODE_HOME%\node.exe" goto :run

echo.
echo   Smith Chart Tutor: first-time setup. This takes a few minutes, once.
echo   Everything goes into this folder; nothing is installed on the system.
echo.
echo   [1/3] Downloading a private copy of Node.js %NODE_VERSION%...
if not exist "%RT%" mkdir "%RT%"
where curl.exe >nul 2>&1 || goto :oldwindows
where tar.exe >nul 2>&1 || goto :oldwindows
curl.exe -fL --retry 3 --progress-bar -o "%RT%\%NODE_NAME%.zip" "https://nodejs.org/dist/v%NODE_VERSION%/%NODE_NAME%.zip" || goto :neterror
curl.exe -fsSL --retry 3 -o "%RT%\SHASUMS256.txt" "https://nodejs.org/dist/v%NODE_VERSION%/SHASUMS256.txt" || goto :neterror

rem Check the download against Node.js's published checksum.
set "EXPECTED="
for /f "tokens=1" %%h in ('findstr /c:" %NODE_NAME%.zip" "%RT%\SHASUMS256.txt"') do set "EXPECTED=%%h"
if not defined EXPECTED goto :hasherror
certutil -hashfile "%RT%\%NODE_NAME%.zip" SHA256 > "%RT%\hash.txt" 2>nul || goto :hasherror
findstr /i /c:"%EXPECTED%" "%RT%\hash.txt" >nul || goto :hasherror

rem Unpack beside, then move into place: a window closed halfway never leaves a half-unpacked Node.
if exist "%RT%\unpack" rmdir /s /q "%RT%\unpack"
mkdir "%RT%\unpack"
tar.exe -xf "%RT%\%NODE_NAME%.zip" -C "%RT%\unpack" || goto :unpackerror
if exist "%NODE_HOME%" rmdir /s /q "%NODE_HOME%"
move "%RT%\unpack\%NODE_NAME%" "%NODE_HOME%" >nul || goto :unpackerror
rmdir /s /q "%RT%\unpack" >nul 2>&1
del /q "%RT%\%NODE_NAME%.zip" "%RT%\SHASUMS256.txt" "%RT%\hash.txt" >nul 2>&1

:run
"%NODE_HOME%\node.exe" "scripts\launch.mjs" %*
if errorlevel 1 goto :failed
exit /b 0

:notextracted
echo.
echo   Please extract the ZIP first: right-click it, choose "Extract All...",
echo   then double-click Start-Windows.cmd in the extracted folder.
echo.
pause
exit /b 1

:oldwindows
echo.
echo   This needs Windows 10 (version 1803) or newer, which include curl and tar.
echo.
pause
exit /b 1

:neterror
echo.
echo   Could not download Node.js from nodejs.org.
echo   - Check the internet connection, then double-click Start-Windows.cmd again.
echo   - On a company network, nodejs.org may be blocked or need a proxy. Ask IT, or set
echo     HTTPS_PROXY (e.g. http://proxy.company.com:8080) and try again.
echo.
del /q "%RT%\%NODE_NAME%.zip" >nul 2>&1
pause
exit /b 1

:hasherror
echo.
echo   The Node.js download did not match its published checksum, so it was not used.
echo   Double-click Start-Windows.cmd again to download it afresh.
echo.
del /q "%RT%\%NODE_NAME%.zip" "%RT%\SHASUMS256.txt" "%RT%\hash.txt" >nul 2>&1
pause
exit /b 1

:unpackerror
echo.
echo   Could not unpack Node.js. Antivirus software sometimes blocks this; try again,
echo   or move this folder somewhere simple such as C:\Users\%USERNAME%\SmithChartTutor.
echo.
pause
exit /b 1

:failed
echo   Setup stopped; see the message above. Double-click Start-Windows.cmd to try again.
echo.
pause
exit /b 1
