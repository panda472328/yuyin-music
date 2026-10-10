; Repository-owned NSIS extension: never patch electron-builder's templates.
; Only exact installation files are checked; no process enumeration or kills.
!include LogicLib.nsh
!include FileFunc.nsh
!ifdef BUILD_UNINSTALLER
  !define YUYIN_FUNCTION_PREFIX "un."
!else
  !define YUYIN_FUNCTION_PREFIX ""
!endif

Var YuyinProbePath
Var YuyinFailureMessage
!ifndef BUILD_UNINSTALLER
Var YuyinProbeDirectory
Var YuyinCreateDirectory
Var YuyinOldShellDirectory
Var YuyinOldUserDirectory
Var YuyinOldUninstallCommand
Var YuyinParsedDirectory
!endif

Function ${YUYIN_FUNCTION_PREFIX}YuyinStop
  ; Silent updates must fail instead of blocking on an invisible dialog.
  ${IfNot} ${Silent}
    MessageBox MB_OK|MB_ICONSTOP "$YuyinFailureMessage"
  ${EndIf}
  SetErrorLevel 2
  Quit
FunctionEnd

!ifndef BUILD_UNINSTALLER
Function YuyinCheckDirectory
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  ; Separator-aware, case-insensitive containment avoids matching sibling dirs.
  GetFullPathName $0 "$YuyinProbeDirectory"
  StrCpy $1 $0 1 -1
  ${If} $1 != "\"
    StrCpy $0 "$0\"
  ${EndIf}
  GetFullPathName $1 "$EXEDIR"
  StrCpy $2 $1 1 -1
  ${If} $2 != "\"
    StrCpy $1 "$1\"
  ${EndIf}
  StrLen $2 $0
  StrCpy $3 $1 $2
  System::Call 'kernel32::lstrcmpiW(w r0, w r3)i.r4'
  ${If} $4 == 0
    StrCpy $YuyinFailureMessage "请把安装包移到下载或桌面目录，再重新安装。$\r$\n安装包正在目标安装目录内运行，继续安装会覆盖或删除安装包自身。$\r$\n$YuyinProbeDirectory"
    Call ${YUYIN_FUNCTION_PREFIX}YuyinStop
  ${EndIf}

  System::Call 'kernel32::GetFileAttributesW(w "$YuyinProbeDirectory")i.r0 ?e'
  Pop $1
  ${If} $0 == -1
    ${If} $1 != 2
    ${AndIf} $1 != 3
      Goto directoryDenied
    ${EndIf}
    ${If} $YuyinCreateDirectory != "1"
      Goto directoryChecked
    ${EndIf}
    ClearErrors
    CreateDirectory "$YuyinProbeDirectory"
    ${If} ${Errors}
      Goto directoryDenied
    ${EndIf}
  ${Else}
    IntOp $2 $0 & 0x10
    ${If} $2 == 0
      Goto directoryDenied
    ${EndIf}
  ${EndIf}

  ; Only the uniquely named, owned probe is written/deleted. Existing files
  ; and application profiles are never used as writable test files.
  ClearErrors
  GetTempFileName $1 "$YuyinProbeDirectory"
  ${If} ${Errors}
    Goto directoryDenied
  ${EndIf}
  ClearErrors
  FileOpen $2 "$1" w
  ${If} ${Errors}
    Delete "$1"
    Goto directoryDenied
  ${EndIf}
  ClearErrors
  FileWrite $2 "Yuyin installer write check$\r$\n"
  ${If} ${Errors}
    FileClose $2
    Delete "$1"
    Goto directoryDenied
  ${EndIf}
  FileClose $2
  ClearErrors
  Delete "$1"
  ${If} ${Errors}
    Goto directoryDenied
  ${EndIf}
  Goto directoryChecked

  directoryDenied:
    StrCpy $YuyinFailureMessage "无法写入安装目录，安装已停止，尚未覆盖程序文件。$\r$\n$YuyinProbeDirectory$\r$\n请使用“仅为我安装”的默认目录；安装到 Program Files 时，请选择“为所有用户安装”并允许管理员权限。也请检查安全软件限制。"
    Call ${YUYIN_FUNCTION_PREFIX}YuyinStop
  directoryChecked:
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
FunctionEnd

; Older/partially damaged registrations may retain UninstallString after
; InstallLocation disappears. Parse only the quoted, absolute executable path;
; do not execute a command or guess a relative path during this capture.
Function YuyinParseOldUninstallDirectory
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  StrCpy $YuyinParsedDirectory ""
  StrCpy $0 $YuyinOldUninstallCommand 1
  ${If} $0 != '$\"'
    Goto oldCommandInvalid
  ${EndIf}
  StrCpy $0 1
  oldCommandScan:
    StrCpy $1 $YuyinOldUninstallCommand 1 $0
    ${If} $1 == ""
      Goto oldCommandInvalid
    ${EndIf}
    ${If} $1 == '$\"'
      Goto oldCommandQuoted
    ${EndIf}
    IntOp $0 $0 + 1
    Goto oldCommandScan
  oldCommandQuoted:
    IntOp $0 $0 - 1
    StrCpy $2 $YuyinOldUninstallCommand $0 1
    ${If} $2 == ""
      Goto oldCommandInvalid
    ${EndIf}
    ; Require either a rooted drive path or a complete UNC share path.
    ${GetRoot} "$2" $3
    ${If} $3 == ""
      Goto oldCommandInvalid
    ${EndIf}
    StrCpy $1 $2 2
    ${If} $1 != "\\"
      StrCpy $1 $2 2 1
      ${If} $1 != ":\"
        Goto oldCommandInvalid
      ${EndIf}
    ${EndIf}
    ${GetFileExt} "$2" $4
    ${If} $4 != "exe"
      Goto oldCommandInvalid
    ${EndIf}
    ${GetParent} "$2" $YuyinParsedDirectory
    ${If} $YuyinParsedDirectory == ""
      Goto oldCommandInvalid
    ${EndIf}
    ; FileFunc returns C: for a file in a drive root; retain rooted semantics.
    ${If} $YuyinParsedDirectory == $3
      StrCpy $YuyinParsedDirectory "$YuyinParsedDirectory\"
    ${EndIf}
    Goto oldCommandCaptured
  oldCommandInvalid:
    StrCpy $YuyinFailureMessage "旧版卸载登记不完整，无法安全确定旧安装目录，安装已停止。$\r$\n请先通过 Windows 设置正常卸载旧版，或使用原安装包修复旧版后再更新。"
    Call YuyinStop
  oldCommandCaptured:
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
FunctionEnd

!macro YuyinCaptureOldDirectory ROOT DIRECTORY
  ReadRegStr ${DIRECTORY} ${ROOT} "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} ${DIRECTORY} == ""
    ReadRegStr $YuyinOldUninstallCommand ${ROOT} "${UNINSTALL_REGISTRY_KEY}" UninstallString
    ${If} $YuyinOldUninstallCommand != ""
      Call YuyinParseOldUninstallDirectory
      StrCpy ${DIRECTORY} $YuyinParsedDirectory
    ${EndIf}
  ${EndIf}
!macroend
!endif

Function ${YUYIN_FUNCTION_PREFIX}YuyinCheckFile
  Push $0
  Push $1
  Push $2
  checkFileAgain:
    ; GENERIC_WRITE, SHARE_READ|WRITE|DELETE, OPEN_EXISTING. This is an open
    ; check only: no truncation, write, rename or termination of processes.
    System::Call 'kernel32::CreateFileW(w "$YuyinProbePath", i 0x40000000, i 7, p 0, i 3, i 0x80, p 0)p.r0 ?e'
    Pop $1
    ${If} $0 != -1
      System::Call 'kernel32::CloseHandle(p r0)'
      Goto fileChecked
    ${EndIf}
    ${If} $1 == 2
    ${OrIf} $1 == 3
      Goto fileChecked
    ${EndIf}
    ${If} $1 == 32
    ${OrIf} $1 == 33
      StrCpy $YuyinFailureMessage "程序文件仍在使用，安装或卸载已停止。$\r$\n请先正常退出余音（包括桌面歌词窗口），并关闭此前的安装或卸载窗口，再点击重试。$\r$\n$YuyinProbePath"
      ${IfNot} ${Silent}
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$YuyinFailureMessage" IDRETRY checkFileAgain
        SetErrorLevel 2
        Quit
      ${EndIf}
    ${Else}
      StrCpy $YuyinFailureMessage "无法写入程序文件，安装或卸载已停止（Windows 错误 $1）。$\r$\n$YuyinProbePath$\r$\n请先退出余音和此前的安装或卸载程序。请使用当前用户默认目录；安装到 Program Files 时请选择为所有用户安装并允许管理员权限。也请检查只读属性和安全软件限制。"
    ${EndIf}
    Call ${YUYIN_FUNCTION_PREFIX}YuyinStop
  fileChecked:
    Pop $2
    Pop $1
    Pop $0
FunctionEnd

!macro YuyinCheckInstallationDirectory DIRECTORY CREATE
  StrCpy $YuyinProbeDirectory "${DIRECTORY}"
  StrCpy $YuyinCreateDirectory "${CREATE}"
  Call ${YUYIN_FUNCTION_PREFIX}YuyinCheckDirectory
  StrCpy $YuyinProbePath "${DIRECTORY}\${APP_EXECUTABLE_FILENAME}"
  Call ${YUYIN_FUNCTION_PREFIX}YuyinCheckFile
  StrCpy $YuyinProbePath "${DIRECTORY}\${UNINSTALL_FILENAME}"
  Call ${YUYIN_FUNCTION_PREFIX}YuyinCheckFile
!macroend

!macro customCheckAppRunning
  !ifdef BUILD_UNINSTALLER
    ; Never open the running uninstaller's own executable for writing.
    StrCpy $YuyinProbePath "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    Call un.YuyinCheckFile
  !else
    !insertmacro YuyinCheckInstallationDirectory "$INSTDIR" "1"
    ; Capture locations before the old uninstaller deletes its registry.
    !insertmacro YuyinCaptureOldDirectory SHELL_CONTEXT $YuyinOldShellDirectory
    !insertmacro YuyinCaptureOldDirectory HKCU $YuyinOldUserDirectory
    ${If} $YuyinOldShellDirectory != ""
    ${AndIf} $YuyinOldShellDirectory != $INSTDIR
      !insertmacro YuyinCheckInstallationDirectory "$YuyinOldShellDirectory" "0"
    ${EndIf}
    ${If} $installMode == "all"
    ${AndIf} $YuyinOldUserDirectory != ""
    ${AndIf} $YuyinOldUserDirectory != $INSTDIR
    ${AndIf} $YuyinOldUserDirectory != $YuyinOldShellDirectory
      !insertmacro YuyinCheckInstallationDirectory "$YuyinOldUserDirectory" "0"
    ${EndIf}
  !endif
!macroend

!macro YuyinCheckOldUninstallResult DIRECTORY
  ; Inspect ExecWait's Errors/$R0 before another operation can change them.
  ; Upstream ignores some launch failures; our hook must stop before extraction.
  ${If} ${Errors}
    StrCpy $YuyinFailureMessage "无法启动旧版卸载程序，安装已停止，尚未覆盖程序文件。$\r$\n请先退出余音和此前的安装或卸载窗口，再重新运行安装包。"
    Call YuyinStop
  ${EndIf}
  ${If} $R0 != 0
    StrCpy $YuyinFailureMessage "旧版卸载未完成，安装已停止，尚未覆盖程序文件（退出码 $R0）。$\r$\n请先正常退出余音；旧目录需要管理员权限时，请为所有用户安装。"
    Call YuyinStop
  ${EndIf}
  ${If} "${DIRECTORY}" != ""
    ; Some old uninstallers return zero after cancellation of the close dialog.
    ${If} ${FileExists} "${DIRECTORY}\${APP_EXECUTABLE_FILENAME}"
      StrCpy $YuyinFailureMessage "旧版程序仍在安装目录中，卸载尚未完成。安装已停止，尚未覆盖程序文件。$\r$\n请先正常退出余音和此前的安装或卸载窗口，再重试。$\r$\n${DIRECTORY}"
      Call YuyinStop
    ${EndIf}
    ; In-place uninstall may leave its own file behind; overwrite it only once
    ; ExecWait has returned and the exact file can be opened for writing.
    StrCpy $YuyinProbePath "${DIRECTORY}\${UNINSTALL_FILENAME}"
    Call YuyinCheckFile
  ${EndIf}
!macroend

!macro customUnInstallCheck
  !insertmacro YuyinCheckOldUninstallResult "$YuyinOldShellDirectory"
!macroend
!macro customUnInstallCheckCurrentUser
  !insertmacro YuyinCheckOldUninstallResult "$YuyinOldUserDirectory"
!macroend

; Visible assisted installations sanitize the selected path in instFilesPre.
; Run our check immediately afterwards, including the elevated UAC inner
; instance that upstream installSection deliberately excludes from its guard.
!macro customPageAfterChangeDir
  !ifndef BUILD_UNINSTALLER
    !ifdef MUI_PAGE_CUSTOMFUNCTION_PRE
      !undef MUI_PAGE_CUSTOMFUNCTION_PRE
    !endif
    !define MUI_PAGE_CUSTOMFUNCTION_PRE YuyinInstFilesPre
    Function YuyinInstFilesPre
      !ifdef allowToChangeInstallationDirectory
        Call instFilesPre
      !endif
      !insertmacro customCheckAppRunning
    FunctionEnd
  !endif
!macroend

; Silent installs have no MUI page callbacks. initMultiUser has already applied
; the old install mode and /D before customInit. A non-elevated all-users
; instance must wait for the UAC inner instance, whose .onInit checks the same
; final target with administrator permissions before reaching extraction.
!macro customInit
  !ifndef BUILD_UNINSTALLER
    ${If} ${Silent}
      ${If} $installMode != "all"
        !insertmacro customCheckAppRunning
      ${ElseIf} ${UAC_IsAdmin}
        !insertmacro customCheckAppRunning
      ${EndIf}
    ${EndIf}
  !endif
!macroend
