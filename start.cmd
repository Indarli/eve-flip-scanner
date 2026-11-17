@echo off
chcp 65001 >nul
title EVE Flip Scanner
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js not found. Install Node.js 20+ from https://nodejs.org
  echo.
  pause
  exit /b 1
)

set OPEN_BROWSER=1
if /i "%~1"=="--no-browser" set OPEN_BROWSER=0

node server.mjs

echo.
echo Server stopped.
pause >nul
