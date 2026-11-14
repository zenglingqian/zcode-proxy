@echo off
rem ZCode CLI 便捷入口（ZCode 未在 PATH 提供命令行时使用）
rem 用法示例：
rem   zcode-cli login zai        首次使用代理前执行一次登录（浏览器授权）
rem   zcode-cli doctor           运行时诊断
rem   zcode-cli -p "hi" --output-format json
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"D:\Program Files\ZCode\ZCode.exe" "D:\Program Files\ZCode\resources\glm\zcode.cjs" %*
endlocal
