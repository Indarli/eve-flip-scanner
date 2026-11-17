@echo off
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

if not defined EVEFLIP_NO_NOTIFIER start "" wscript "%~dp0notifier.vbs"

powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8787/api/health' -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }"
if not errorlevel 1 (
  echo Server is already running: http://127.0.0.1:8787
  if /i not "%~1"=="--no-browser" start "" "http://127.0.0.1:8787"
  ping -n 3 127.0.0.1 >nul
  exit /b 0
)

set OPEN_BROWSER=1
if /i "%~1"=="--no-browser" set OPEN_BROWSER=0

node server.mjs

echo.
echo Server stopped.
pause >nul