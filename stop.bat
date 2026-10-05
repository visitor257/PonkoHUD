@echo off
rem Ponko HUD: stop the native window host and its node backend.
setlocal
set "ROOT=%~dp0"

if exist "%ROOT%run\host.pid" (
  for /f %%i in ('type "%ROOT%run\host.pid"') do taskkill /pid %%i /t /f >nul 2>&1
  del "%ROOT%run\host.pid" >nul 2>&1
)
if exist "%ROOT%run\backend.pid" (
  for /f %%i in ('type "%ROOT%run\backend.pid"') do taskkill /pid %%i /t /f >nul 2>&1
  del "%ROOT%run\backend.pid" >nul 2>&1
)

rem fallback: anything still holding port 8787
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"
echo stopped.
endlocal
