@echo off
echo Stopping EVE Flip Scanner on port 8787...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8787" ^| findstr "LISTENING"') do (
  taskkill /PID %%a /F >nul 2>nul
  echo Process %%a stopped.
)
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*notifier.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>nul
echo Notifier stopped.
echo Done.
ping -n 3 127.0.0.1 >nul