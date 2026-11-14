@echo off
chcp 65001 >nul
echo [ZCode 反向代理] 停止中...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8787" ^| findstr "LISTENING"') do (
  echo   结束进程 PID=%%p
  taskkill /PID %%p /F >nul 2>&1
)
echo 完成。重新启动请运行 start.bat
pause
