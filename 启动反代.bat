@echo off
chcp 65001 >nul
title ZCode Proxy (127.0.0.1:8787)
cd /d "%~dp0"

netstat -ano | findstr ":8787" | findstr "LISTENING" >nul
if %errorlevel%==0 (
  echo [!] Port 8787 already in use. The proxy may already be running.
  echo     Open http://127.0.0.1:8787/ to check.
  pause
  exit /b
)

echo [i] Starting ZCode Proxy...
echo [i] Admin UI : http://127.0.0.1:8787/
echo [i] API      : http://127.0.0.1:8787/v1
echo [i] Close this window to stop the service.
echo.
rem Use system node if available, otherwise the bundled portable node.
set "NODE_EXE=node"
where node >nul 2>&1 || set "NODE_EXE=%~dp0vendor\node\node.exe"
"%NODE_EXE%" server.js

echo.
echo [!] Service exited. Press any key to close.
pause >nul
