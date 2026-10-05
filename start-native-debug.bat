@echo off
rem Same as start-native.bat but keeps a console + WebView2 dev tools for debugging.
setlocal
set "ROOT=%~dp0"
set "PY=C:\Python314\python.exe"
if not exist "%PY%" set "PY=python"
start "Ponko HUD window" "%PY%" "%ROOT%native_host.py" --devtools %*
endlocal
