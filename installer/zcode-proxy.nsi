; ZCode 反向代理 安装包脚本（NSIS 3.x，Unicode）
; 编译：node build-installer.mjs（会自动布置 resources/app 并调用 makensis）

Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"

!define APPNAME "ZCode 反向代理"
!define APPVERSION "2.0.4"
!define PUBLISHER "ZCodeProxy"
!define REGKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\ZCodeProxy"
!define APPDATA_DIR "$INSTDIR\resources\app"

Name "${APPNAME} ${APPVERSION}"
OutFile "..\ZCodeProxy-Setup.exe"
InstallDir "$LOCALAPPDATA\ZCodeProxy"
InstallDirRegKey HKCU "${REGKEY}" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma

; 目录决策（.onInit 在卸载器里同样会执行）：
;   ① 注册表已记录实际安装位置（重装/卸载）→ 一律使用它（否则 D 盘安装会被固定卸载 C 盘）
;   ② 全新安装且未通过 /D= 指定 → 使用默认目录 %LOCALAPPDATA%\ZCodeProxy
Function .onInit
  ReadRegStr $R0 HKCU "${REGKEY}" "InstallDir"
  ${If} $R0 != ""
    StrCpy $INSTDIR $R0
  ${ElseIf} $INSTDIR == ""
    StrCpy $INSTDIR "$LOCALAPPDATA\ZCodeProxy"
  ${EndIf}
FunctionEnd

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\ZCodeProxy.exe"
!define MUI_FINISHPAGE_RUN_TEXT "立即启动 ZCode 反向代理"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

; 隐藏段：安装/升级前停掉已运行实例（按端口 + 按安装路径）
Section "-StopOldInstance"
  DetailPrint "停止已运行的 ZCode 反向代理实例..."
  nsExec::ExecToStack "powershell -NoProfile -Command $\"Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $$_.OwningProcess -Force -ErrorAction SilentlyContinue }$\""
  nsExec::ExecToStack "powershell -NoProfile -Command $\"Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { ($$_.Name -eq 'ZCodeProxy.exe' -or $$_.Name -eq 'node.exe') -and $$_.CommandLine -like '*ZCodeProxy*' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }$\""
  Sleep 800
SectionEnd

Section "${APPNAME} 主程序" SEC_MAIN
  SectionIn RO
  SetOutPath "$INSTDIR"
  ; Electron 运行时 + 应用（ZCodeProxy.exe 在根；resources\app 内含后端 js 与 config.json）
  File /r "..\vendor\electron\*.*"
  ; CLI/调试回退
  SetOutPath "$INSTDIR\vendor\node"
  File "..\vendor\node\node.exe"
  SetOutPath "$INSTDIR"
  File "..\启动反代.bat"
  File "..\README.md"
  File "..\使用说明.md"

  ; 保留用户已有 config.json / settings.json（升级不覆盖）
  ${IfNot} ${FileExists} "${APPDATA_DIR}\config.json"
    SetOutPath "${APPDATA_DIR}"
    File /oname=config.json "..\config.example.json"
  ${EndIf}
  SetOutPath "$INSTDIR"

  ; 卸载器 + 「应用和功能」注册
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "${REGKEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "${REGKEY}" "DisplayVersion" "${APPVERSION}"
  WriteRegStr HKCU "${REGKEY}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKCU "${REGKEY}" "DisplayIcon" "$INSTDIR\ZCodeProxy.exe"
  WriteRegStr HKCU "${REGKEY}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${REGKEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "${REGKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${REGKEY}" "NoRepair" 1

  ; 快捷方式
  CreateDirectory "$SMPROGRAMS\ZCode Proxy"
  CreateShortCut "$SMPROGRAMS\ZCode Proxy\${APPNAME}.lnk" "$INSTDIR\ZCodeProxy.exe"
  CreateShortCut "$SMPROGRAMS\ZCode Proxy\卸载 ${APPNAME}.lnk" "$INSTDIR\Uninstall.exe"
SectionEnd

Section "桌面快捷方式" SEC_DESKTOP
  CreateShortCut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\ZCodeProxy.exe"
SectionEnd

Section "开机自动启动" SEC_AUTO
  DetailPrint "写入开机自启（注册表 Run 键）..."
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "ZCodeProxy" '"$INSTDIR\ZCodeProxy.exe" --hidden'
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_DESKTOP} "在桌面创建「${APPNAME}」快捷方式"
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_AUTO} "登录 Windows 后在托盘静默启动并恢复代理状态"
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Section "Uninstall"
  DetailPrint "停止正在运行的实例..."
  nsExec::ExecToStack "powershell -NoProfile -Command $\"Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $$_.OwningProcess -Force -ErrorAction SilentlyContinue }$\""
  nsExec::ExecToStack "powershell -NoProfile -Command $\"Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $$_.Name -eq 'ZCodeProxy.exe' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }$\""
  Sleep 800

  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "ZCodeProxy"
  Delete "$SMSTARTUP\${APPNAME}.lnk"
  Delete "$DESKTOP\${APPNAME}.lnk"
  Delete "$SMPROGRAMS\ZCode Proxy\*.*"
  RMDir "$SMPROGRAMS\ZCode Proxy"

  ; 备份用户配置 → 全目录删除 → 还原配置（config.json / settings.json / runtime 数据保留）
  CreateDirectory "$TEMP\ZCodeProxyUninstCfg"
  CopyFiles /SILENT "${APPDATA_DIR}\config.json" "$TEMP\ZCodeProxyUninstCfg\config.json"
  CopyFiles /SILENT "${APPDATA_DIR}\settings.json" "$TEMP\ZCodeProxyUninstCfg\settings.json"
  CopyFiles /SILENT "${APPDATA_DIR}\runtime" "$TEMP\ZCodeProxyUninstCfg\runtime"
  RMDir /r "$INSTDIR"
  CreateDirectory "${APPDATA_DIR}"
  CopyFiles /SILENT "$TEMP\ZCodeProxyUninstCfg\*.*" "${APPDATA_DIR}"
  RMDir /r "$TEMP\ZCodeProxyUninstCfg"
  DeleteRegKey HKCU "${REGKEY}"
  DetailPrint "已保留 config.json / settings.json / 运行数据。"
SectionEnd
