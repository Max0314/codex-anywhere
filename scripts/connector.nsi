Unicode True
!include "MUI2.nsh"
!include "LogicLib.nsh"
Name "Fribench Codex Connector"
OutFile "Fribench-Codex-Connector-x64.exe"
!ifndef VERSION
!define VERSION "0.5.0-fribench.4"
!endif
InstallDir "$LOCALAPPDATA\Fribench\CodexConnector\versions\${VERSION}"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "Fribench"
SetFont "Microsoft YaHei UI" 9
VIProductVersion "0.5.0.4"
VIAddVersionKey /LANG=2052 "ProductName" "Fribench Codex Connector"
VIAddVersionKey /LANG=2052 "FileDescription" "Fribench Codex Connector 安装程序"
VIAddVersionKey /LANG=2052 "CompanyName" "Fribench"
VIAddVersionKey /LANG=2052 "LegalCopyright" "Fribench contributors"
VIAddVersionKey /LANG=2052 "FileVersion" "${VERSION}"
!define MUI_ICON "assets\connector.ico"
!define MUI_WELCOMEFINISHPAGE_BITMAP "assets\welcome.bmp"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "连接电脑上的 Codex"
!define MUI_WELCOMEPAGE_TEXT "从手机继续你的 Codex 会话。$\r$\n$\r$\n安装包内置运行环境。登录 Windows 后自动连接，更新保留设备身份。$\r$\n$\r$\n请先在这台电脑安装并登录 Codex Desktop。"
!insertmacro MUI_PAGE_WELCOME
!define MUI_PAGE_HEADER_TEXT "正在安装 Connector"
!define MUI_PAGE_HEADER_SUBTEXT "安装文件准备完成后，才会安全切换正在运行的版本。"
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TITLE "安装完成"
!define MUI_FINISHPAGE_TEXT "打开客户端，点击「登录 Fribench」，在系统浏览器确认这台电脑。$\r$\n$\r$\n已绑定的电脑会沿用原有授权。"
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "打开 Fribench Codex Connector"
!define MUI_FINISHPAGE_RUN_FUNCTION OpenConnector
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "SimpChinese"
Var StageDirectory
Var InstallerMutex

Function .onInit
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "Local\Fribench-Codex-Installer-Package") p .r0 ?e'
  Pop $1
  StrCpy $InstallerMutex $0
  ${If} $1 == 183
    IfSilent +2
    MessageBox MB_OK|MB_ICONINFORMATION "另一安装程序正在运行，请先完成它。"
    SetErrorLevel 1
    Abort
  ${EndIf}
FunctionEnd

Function OpenConnector
  Exec '"$SYSDIR\wscript.exe" "$LOCALAPPDATA\Fribench\CodexConnector\settings.vbs"'
FunctionEnd

Function .onGUIEnd
  ${If} $StageDirectory != ""
    RMDir /r "$StageDirectory"
  ${EndIf}
  System::Call 'kernel32::CloseHandle(p $InstallerMutex)'
FunctionEnd

Function .onInstFailed
  ${If} $StageDirectory != ""
    RMDir /r "$StageDirectory"
  ${EndIf}
FunctionEnd

Section
  CreateDirectory "$LOCALAPPDATA\Fribench\CodexConnector\staging"
  GetTempFileName $StageDirectory "$LOCALAPPDATA\Fribench\CodexConnector\staging"
  Delete "$StageDirectory"
  CreateDirectory "$StageDirectory"
  SetOutPath "$StageDirectory\payload"
  File /r "package\*.*"
  ; Release the payload working directory before PowerShell moves it into place.
  SetOutPath "$TEMP"
  DetailPrint "安全切换版本并保留设备设置…"
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "$StageDirectory\payload\scripts\install-owner-connector.ps1"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    IfSilent +2
    MessageBox MB_OK|MB_ICONSTOP "安装未完成。$\r$\n$\r$\n$1"
    SetErrorLevel 1
    Abort
  ${EndIf}
  RMDir /r "$StageDirectory"
  StrCpy $StageDirectory ""
SectionEnd
