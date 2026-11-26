Unicode True
!include "LogicLib.nsh"
Name "Fribench Codex Connector"
OutFile "Fribench-Codex-Connector-x64.exe"
!ifndef VERSION
!define VERSION "0.5.0-fribench.1"
!endif
InstallDir "$LOCALAPPDATA\Fribench\CodexConnector\versions\${VERSION}"
RequestExecutionLevel user
SetCompressor /SOLID lzma
Page instfiles
Section
  SetOutPath "$INSTDIR"
  File /r "package\*.*"
  CreateShortcut "$SMPROGRAMS\Fribench Codex Connector.lnk" "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" '-NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\scripts\connector-settings.ps1"'
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\scripts\install-owner-connector.ps1"' $0
  ${If} $0 != 0
    SetErrorLevel 1
    Quit
  ${EndIf}
SectionEnd
