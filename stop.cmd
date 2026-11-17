@echo off
chcp 65001 >nul
echo Stopping EVE Flip Scanner on port 8787...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8787" ^| findstr "LISTENING"') do (
  taskkill /PID %%a /F >nul 2>nul
  echo Process %%a stopped.
)
echo Done.
timeout /t 2 >nul
