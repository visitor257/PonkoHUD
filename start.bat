@echo off
rem Ponko HUD fallback launcher: Edge --app with an ISOLATED profile.
rem Prefer start-native.bat (real window, own taskbar icon). This one only needs Edge.
setlocal
set "ROOT=%~dp0"
set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=msedge"

rem start backend unless port 8787 is already listening
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if errorlevel 1 start "Ponko HUD backend" /MIN node "%ROOT%server\server.js"
timeout /t 1 /nobreak >nul

start "" "%EDGE%" --app=http://127.0.0.1:8787/ ^
  --user-data-dir="%LOCALAPPDATA%\PonkoHUD\edge-profile" ^
  --no-first-run --no-default-browser-check --disable-extensions ^
  --disable-features=msWebOOUI,msPdfOOUI,Translate ^
  --window-size=1680,940
endlocal
