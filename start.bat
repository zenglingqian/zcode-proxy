@echo off
chcp 65001 >nul
title ZCode 反向代理
cd /d "%~dp0"
echo [ZCode 反向代理] 启动中...  (Ctrl+C 停止)
echo   OpenAI Base URL: http://127.0.0.1:8787/v1
echo   模型: 见 config.json (默认 zcode / zcode-bigmodel)
echo.
node server.js
pause
