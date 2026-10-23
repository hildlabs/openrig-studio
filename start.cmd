@echo off
rem Double-click to start OpenRig Studio on Windows.
cd /d "%~dp0"
title OpenRig Studio
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required. Download it from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
start "" "http://localhost:4330"
node src\server\main.js
pause
