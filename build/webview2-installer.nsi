Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "x64.nsh"
!include "WinVer.nsh"
!include "${YUYIN_ROOT}\build\webview2-installer-guards.nsh"

Name "openmusic音乐播放器"
OutFile "${YUYIN_INSTALLER}"
!ifdef YUYIN_QA
  !define YUYIN_INSTALL_KEY "Software\YuyinWebView2Qa\${YUYIN_QA}"
  !define YUYIN_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\YuyinWebView2Qa.${YUYIN_QA}"
  InstallDir "${YUYIN_QA_INSTALLDIR}"
!else
  !define YUYIN_INSTALL_KEY "Software\YuyinMusic\WebView2"
  !define YUYIN_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\YuyinMusic.WebView2"
  InstallDir "$LOCALAPPDATA\Programs\YuyinMusic"
!endif
InstallDirRegKey HKCU "${YUYIN_INSTALL_KEY}" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 64
ShowInstDetails show
ShowUninstDetails show
VIProductVersion "${YUYIN_VERSION}.0"
VIAddVersionKey /LANG=2052 "ProductName" "openmusic音乐播放器"
VIAddVersionKey /LANG=2052 "FileDescription" "openmusic Windows WebView2 安装程序"
VIAddVersionKey /LANG=2052 "FileVersion" "${YUYIN_VERSION}"
VIAddVersionKey /LANG=2052 "LegalCopyright" "MIT License"
Icon "${YUYIN_ROOT}\build\icon.ico"
UninstallIcon "${YUYIN_ROOT}\build\icon.ico"

!define YUYIN_WEBVIEW2_KEY "Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\Yuyin.WindowsHost.exe"
!define MUI_FINISHPAGE_RUN_TEXT "启动openmusic"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${YUYIN_ROOT}\LICENSE"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Var ProbePath
Var FailureMessage
Var RuntimeVersion
Var ForceRun
Var ParentPid

Function StopInstall
    ${IfNot} ${Silent}
        MessageBox MB_OK|MB_ICONSTOP "$FailureMessage"
    ${EndIf}
    SetErrorLevel 2
    Quit
FunctionEnd

; Read the shared Evergreen runtime registrations, never browser profile data.
Function CheckWebView2
!ifdef YUYIN_QA
    ; Native integration fixtures never touch real runtime registrations.
    StrCpy $RuntimeVersion "QA-controlled-runtime"
!else
    SetRegView 32
    ReadRegStr $RuntimeVersion HKLM "${YUYIN_WEBVIEW2_KEY}" "pv"
    ${If} $RuntimeVersion == ""
    ${OrIf} $RuntimeVersion == "0.0.0.0"
        ReadRegStr $RuntimeVersion HKCU "${YUYIN_WEBVIEW2_KEY}" "pv"
    ${EndIf}
    SetRegView 64
!endif
FunctionEnd

!insertmacro YuyinWebViewCheckFile ""
!insertmacro YuyinWebViewCheckFile "un."

Function .onInit
    ${IfNot} ${RunningX64}
        StrCpy $FailureMessage "此安装包适用于 64 位 Windows。"
        Call StopInstall
    ${EndIf}
    ${IfNot} ${AtLeastWin10}
        StrCpy $FailureMessage "openmusic WebView2 版需要 Windows 10 1903 或更新系统。"
        Call StopInstall
    ${EndIf}
    ${IfNot} ${AtLeastBuild} 18362
        StrCpy $FailureMessage "openmusic WebView2 版需要 Windows 10 1903 或更新系统。"
        Call StopInstall
    ${EndIf}
    SetShellVarContext current
    SetRegView 64
    ${GetParameters} $0
    ClearErrors
    ${GetOptions} $0 "/YUYINPID=" $ParentPid
    ${IfNot} ${Errors}
        ; The updater supplies only the current PID. Validate a bounded decimal
        ; ID, then wait on that exact process handle without terminating it.
        StrLen $1 $ParentPid
        ${If} $1 < 1
        ${OrIf} $1 > 10
            StrCpy $FailureMessage "更新进程参数不合法，请从发布页重新下载安装包。"
            Call StopInstall
        ${EndIf}
        StrCpy $3 $ParentPid 1
        ${If} $3 == "0"
            StrCpy $FailureMessage "更新进程参数不合法，请从发布页重新下载安装包。"
            Call StopInstall
        ${EndIf}
        StrCpy $2 0
        parentDigitLoop:
            StrCpy $3 $ParentPid 1 $2
            ${Switch} $3
                ${Case} "0"
                ${Case} "1"
                ${Case} "2"
                ${Case} "3"
                ${Case} "4"
                ${Case} "5"
                ${Case} "6"
                ${Case} "7"
                ${Case} "8"
                ${Case} "9"
                    ${Break}
                ${Default}
                    StrCpy $FailureMessage "更新进程参数不合法，请从发布页重新下载安装包。"
                    Call StopInstall
            ${EndSwitch}
            IntOp $2 $2 + 1
            ${If} $2 < $1
                Goto parentDigitLoop
            ${EndIf}
        ${If} $1 == 10
            ; Compare digits before DWORD conversion to reject overflow.
            StrCpy $4 "4294967295"
            StrCpy $2 0
            parentRangeLoop:
                StrCpy $3 $ParentPid 1 $2
                StrCpy $5 $4 1 $2
                ${If} $3 > $5
                    StrCpy $FailureMessage "更新进程参数超出有效范围。"
                    Call StopInstall
                ${ElseIf} $3 < $5
                    Goto parentRangeValid
                ${EndIf}
                IntOp $2 $2 + 1
                ${If} $2 < 10
                    Goto parentRangeLoop
                ${EndIf}
            parentRangeValid:
        ${EndIf}
        System::Call 'kernel32::GetCurrentProcessId()i.r1'
        ${If} $ParentPid == $1
            StrCpy $FailureMessage "更新进程参数不合法，请重新运行安装包。"
            Call StopInstall
        ${EndIf}
        System::Call 'kernel32::OpenProcess(i 0x100000, i 0, i "$ParentPid")p.r1 ?e'
        Pop $2
        ${If} $1 != 0
            System::Call 'kernel32::WaitForSingleObject(p r1, i 60000)i.r2'
            System::Call 'kernel32::CloseHandle(p r1)'
            ${If} $2 != 0
                StrCpy $FailureMessage "openmusic尚未正常退出，更新已停止。请先退出openmusic和桌面歌词，再重新安装。"
                Call StopInstall
            ${EndIf}
        ${ElseIf} $2 != 87
            StrCpy $FailureMessage "无法确认openmusic更新进程已退出（Windows 错误 $2），更新已停止。请退出openmusic后重新安装。"
            Call StopInstall
        ${EndIf}
    ${EndIf}
    ${GetParameters} $0
    ClearErrors
    ${GetOptions} $0 "--force-run" $ForceRun
    ${IfNot} ${Errors}
        StrCpy $ForceRun "1"
    ${EndIf}
FunctionEnd

Section "openmusic" MainSection
    ; An installer inside its target would overwrite/delete its own payload.
    GetFullPathName $0 "$INSTDIR\"
    GetFullPathName $1 "$EXEDIR\"
    StrLen $2 $0
    StrCpy $3 $1 $2
    System::Call 'kernel32::lstrcmpiW(w r0, w r3)i.r4'
    ${If} $4 == 0
        StrCpy $FailureMessage "请把安装包移到下载或桌面目录，再重新安装。安装包不能位于目标安装目录中。"
        Call StopInstall
    ${EndIf}
    ClearErrors
    CreateDirectory "$INSTDIR"
    GetTempFileName $0 "$INSTDIR"
    FileOpen $1 "$0" w
    ${If} ${Errors}
        Delete "$0"
        StrCpy $FailureMessage "无法写入安装目录，请使用当前用户默认安装目录，或检查目录权限。"
        Call StopInstall
    ${EndIf}
    FileClose $1
    Delete "$0"
    !include "${YUYIN_GUARDS}"
    StrCpy $ProbePath "$INSTDIR\Uninstall Yuyin.exe"
    Call CheckFile
    StrCpy $ProbePath "$INSTDIR\installed.marker"
    Call CheckFile

    Call CheckWebView2
    ${If} $RuntimeVersion == ""
    ${OrIf} $RuntimeVersion == "0.0.0.0"
        DetailPrint "正在安装系统 WebView2 运行时（需要联网，仅首次缺失时下载）…"
        InitPluginsDir
        SetOutPath "$PLUGINSDIR"
        File /oname=MicrosoftEdgeWebview2Setup.exe "${YUYIN_BOOTSTRAPPER}"
        ClearErrors
        ExecWait '"$PLUGINSDIR\MicrosoftEdgeWebview2Setup.exe" /silent /install' $0
        ${If} ${Errors}
            StrCpy $FailureMessage "无法启动 WebView2 运行时安装程序。请从微软官方网站安装后重试。"
            Call StopInstall
        ${EndIf}
        Call CheckWebView2
        ${If} $RuntimeVersion == ""
        ${OrIf} $RuntimeVersion == "0.0.0.0"
            StrCpy $FailureMessage "系统 WebView2 运行时未安装成功（退出码 $0）。请检查网络后重试，或从微软官方网站安装 Evergreen Runtime。openmusic程序文件尚未覆盖。"
            ${IfNot} ${Silent}
                MessageBox MB_YESNO|MB_ICONEXCLAMATION "$FailureMessage$\r$\n现在打开官方下载页面？" IDNO +2
                ExecShell "open" "https://developer.microsoft.com/microsoft-edge/webview2/#download-section"
            ${EndIf}
            SetErrorLevel 2
            Quit
        ${EndIf}
    ${EndIf}

    SetOutPath "$INSTDIR"
    ClearErrors
    File /r "${YUYIN_PAYLOAD}\*"
    ${If} ${Errors}
        StrCpy $FailureMessage "写入openmusic程序文件失败，请检查磁盘空间和目录权限后重试。"
        Call StopInstall
    ${EndIf}
    ClearErrors
    WriteUninstaller "$INSTDIR\Uninstall Yuyin.exe"
    ${If} ${Errors}
        StrCpy $FailureMessage "写入openmusic卸载程序失败，请检查目录权限后重试。"
        Call StopInstall
    ${EndIf}
    ClearErrors
    FileOpen $0 "$INSTDIR\installed.marker" w
    ${If} ${Errors}
        StrCpy $FailureMessage "保存openmusic安装状态失败，请检查目录权限后重试。"
        Call StopInstall
    ${EndIf}
    FileWrite $0 "yuyin-webview2-installed-v1"
    ${If} ${Errors}
        FileClose $0
        Delete "$INSTDIR\installed.marker"
        StrCpy $FailureMessage "保存openmusic安装状态失败，请检查目录权限后重试。"
        Call StopInstall
    ${EndIf}
    FileClose $0
    WriteRegStr HKCU "${YUYIN_INSTALL_KEY}" "InstallLocation" "$INSTDIR"
    WriteRegStr HKCU "${YUYIN_UNINSTALL_KEY}" "DisplayName" "openmusic音乐播放器"
    WriteRegStr HKCU "${YUYIN_UNINSTALL_KEY}" "DisplayVersion" "${YUYIN_VERSION}"
    WriteRegStr HKCU "${YUYIN_UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
    WriteRegStr HKCU "${YUYIN_UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\Yuyin.WindowsHost.exe"
    WriteRegStr HKCU "${YUYIN_UNINSTALL_KEY}" "UninstallString" '$\"$INSTDIR\Uninstall Yuyin.exe$\"'
    WriteRegStr HKCU "${YUYIN_UNINSTALL_KEY}" "QuietUninstallString" '$\"$INSTDIR\Uninstall Yuyin.exe$\" /S'
    WriteRegDWORD HKCU "${YUYIN_UNINSTALL_KEY}" "NoModify" 1
    WriteRegDWORD HKCU "${YUYIN_UNINSTALL_KEY}" "NoRepair" 1
!ifndef YUYIN_QA
    CreateDirectory "$SMPROGRAMS\openmusic"
    CreateShortcut "$SMPROGRAMS\openmusic\openmusic音乐播放器.lnk" "$INSTDIR\Yuyin.WindowsHost.exe"
    CreateShortcut "$SMPROGRAMS\openmusic\卸载openmusic.lnk" "$INSTDIR\Uninstall Yuyin.exe"
    CreateShortcut "$DESKTOP\openmusic音乐播放器.lnk" "$INSTDIR\Yuyin.WindowsHost.exe"
!endif
    ${If} ${Silent}
    ${AndIf} $ForceRun == "1"
        Exec '"$INSTDIR\Yuyin.WindowsHost.exe"'
    ${EndIf}
SectionEnd

Function un.onInit
    SetShellVarContext current
    SetRegView 64
FunctionEnd

Section "Uninstall"
    ; The generated lists contain only exact files bundled by this build.
    ; Music data and settings live outside INSTDIR and are never deleted.
    !include "${YUYIN_UNINSTALL_GUARDS}"
    StrCpy $ProbePath "$INSTDIR\installed.marker"
    Call un.CheckFile
    !include "${YUYIN_UNINSTALL_FILES}"
    Delete "$INSTDIR\installed.marker"
    Delete "$INSTDIR\Uninstall Yuyin.exe"
!ifndef YUYIN_QA
    Delete "$DESKTOP\openmusic音乐播放器.lnk"
    Delete "$SMPROGRAMS\openmusic\openmusic音乐播放器.lnk"
    Delete "$SMPROGRAMS\openmusic\卸载openmusic.lnk"
    RMDir "$SMPROGRAMS\openmusic"
!endif
    RMDir "$INSTDIR"
    DeleteRegKey HKCU "${YUYIN_UNINSTALL_KEY}"
    DeleteRegKey HKCU "${YUYIN_INSTALL_KEY}"
SectionEnd
