!include "LogicLib.nsh"

; Read only the stored shell-link target. Never resolve the link, run its target,
; enumerate user shortcuts, or delete links based on their display name alone.
!macro YuyinWebViewShortcutTarget PREFIX
Function ${PREFIX}ShortcutTargetsThisInstall
    Push $0
    Push $1
    Push $2
    Push $3
    Push $4
    Push $5
    StrCpy $ShortcutMatches "0"
    ${If} ${FileExists} "$ShortcutPath"
        System::Call 'ole32::CoInitialize(p 0)i.r5'
        StrCpy $0 0
        StrCpy $1 0
        ; CLSID_ShellLink / IID_IShellLinkW, CLSCTX_INPROC_SERVER.
        System::Call 'ole32::CoCreateInstance(g "{00021401-0000-0000-C000-000000000046}", p 0, i 1, g "{000214F9-0000-0000-C000-000000000046}", *p .r0)i.r2'
        ${If} $2 == 0
            ; IPersistFile::Load(STGM_READ); no ShellLink::Resolve call.
            System::Call '$0->0(g "{0000010B-0000-0000-C000-000000000046}", *p .r1)i.r2'
            ${If} $2 == 0
                System::Call '$1->5(w "$ShortcutPath", i 0)i.r2'
                ${If} $2 == 0
                    System::Call '$0->3(w .r3, i ${NSIS_MAX_STRLEN}, p 0, i 4)i.r2'
                    ${If} $2 == 0
                    ${AndIf} $3 != ""
                        ; Accept only absolute paths; compare canonical paths
                        ; case-insensitively, never filename/prefix matches.
                        StrCpy $2 $3 2
                        StrCpy $4 $3 2 1
                        ${If} $2 == "\\"
                        ${OrIf} $4 == ":\"
                            ; Unlike NSIS GetFullPathName, this API also works
                            ; before the payload exists and after its removal.
                            ; Failed/truncated normalization never matches.
                            System::Call 'kernel32::GetFullPathNameW(w r3, i ${NSIS_MAX_STRLEN}, w .r3, p 0)i.r2'
                            ${If} $2 > 0
                            ${AndIf} $2 < ${NSIS_MAX_STRLEN}
                                System::Call 'kernel32::GetFullPathNameW(w "$ShortcutExpectedTarget", i ${NSIS_MAX_STRLEN}, w .r4, p 0)i.r2'
                                ${If} $2 > 0
                                ${AndIf} $2 < ${NSIS_MAX_STRLEN}
                                    System::Call 'kernel32::lstrcmpiW(w r3, w r4)i.r2'
                                    ${If} $2 == 0
                                        StrCpy $ShortcutMatches "1"
                                    ${EndIf}
                                ${EndIf}
                            ${EndIf}
                        ${EndIf}
                    ${EndIf}
                ${EndIf}
                System::Call '$1->2()'
            ${EndIf}
            System::Call '$0->2()'
        ${EndIf}
        ${If} $5 >= 0
            System::Call 'ole32::CoUninitialize()'
        ${EndIf}
    ${EndIf}
    Pop $5
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
FunctionEnd
!macroend

!macro YuyinWebViewCheckShortcutSlot LINK TARGET
    StrCpy $ShortcutPath "${LINK}"
    StrCpy $ShortcutExpectedTarget "${TARGET}"
    ${If} ${FileExists} "$ShortcutPath"
        Call ShortcutTargetsThisInstall
        ${If} $ShortcutMatches != "1"
            StrCpy $FailureMessage "无法替换已有的 open音乐 快捷方式，因为它属于其他安装或无法确认目标。请先重命名该快捷方式，再重试。$\r$\n$ShortcutPath"
            Call StopInstall
        ${EndIf}
    ${EndIf}
!macroend

!macro YuyinWebViewCheckShortcutSlots
    ${If} $ShortcutDesktop != ""
        !insertmacro YuyinWebViewCheckShortcutSlot "$ShortcutDesktop\open音乐.lnk" "$INSTDIR\Yuyin.WindowsHost.exe"
        !insertmacro YuyinWebViewCheckShortcutSlot "$ShortcutPrograms\open音乐\open音乐.lnk" "$INSTDIR\Yuyin.WindowsHost.exe"
        !insertmacro YuyinWebViewCheckShortcutSlot "$ShortcutPrograms\open音乐\卸载open音乐.lnk" "$INSTDIR\Uninstall Yuyin.exe"
    ${EndIf}
!macroend

!macro YuyinWebViewRemoveOwnedShortcut PREFIX LINK TARGET
    StrCpy $ShortcutPath "${LINK}"
    StrCpy $ShortcutExpectedTarget "${TARGET}"
    Call ${PREFIX}ShortcutTargetsThisInstall
    ${If} $ShortcutMatches == "1"
        ClearErrors
        Delete "$ShortcutPath"
        ${If} ${Errors}
!if "${PREFIX}" == ""
            StrCpy $FailureMessage "替换旧快捷方式失败，请检查该快捷方式的权限，或关闭正在占用它的程序后重试。$\r$\n$ShortcutPath"
            Call StopInstall
!else
            ${IfNot} ${Silent}
                MessageBox MB_OK|MB_ICONSTOP "无法删除此安装的快捷方式，请检查权限或关闭占用它的程序后重试。$\r$\n$ShortcutPath"
            ${EndIf}
            SetErrorLevel 2
            Quit
!endif
        ${EndIf}
    ${EndIf}
!macroend

; Only former installer-managed names are considered for migration. Arbitrary
; user-created links and shortcuts to another install (including Electron) stay.
!macro YuyinWebViewRemoveLegacyShortcuts PREFIX
    !insertmacro YuyinWebViewRemoveOwnedShortcut "${PREFIX}" "$ShortcutDesktop\openmusic音乐播放器.lnk" "$INSTDIR\Yuyin.WindowsHost.exe"
    !insertmacro YuyinWebViewRemoveOwnedShortcut "${PREFIX}" "$ShortcutDesktop\openmusic.lnk" "$INSTDIR\Yuyin.WindowsHost.exe"
    !insertmacro YuyinWebViewRemoveOwnedShortcut "${PREFIX}" "$ShortcutDesktop\余音音乐播放器.lnk" "$INSTDIR\Yuyin.WindowsHost.exe"
    !insertmacro YuyinWebViewRemoveOwnedShortcut "${PREFIX}" "$ShortcutDesktop\余音.lnk" "$INSTDIR\Yuyin.WindowsHost.exe"
    !insertmacro YuyinWebViewRemoveOwnedShortcut "${PREFIX}" "$ShortcutPrograms\openmusic\openmusic音乐播放器.lnk" "$INSTDIR\Yuyin.WindowsHost.exe"
    !insertmacro YuyinWebViewRemoveOwnedShortcut "${PREFIX}" "$ShortcutPrograms\openmusic\卸载openmusic.lnk" "$INSTDIR\Uninstall Yuyin.exe"
    !insertmacro YuyinWebViewRemoveOwnedShortcut "${PREFIX}" "$ShortcutPrograms\余音\余音音乐播放器.lnk" "$INSTDIR\Yuyin.WindowsHost.exe"
    !insertmacro YuyinWebViewRemoveOwnedShortcut "${PREFIX}" "$ShortcutPrograms\余音\卸载余音.lnk" "$INSTDIR\Uninstall Yuyin.exe"
    RMDir "$ShortcutPrograms\openmusic"
    RMDir "$ShortcutPrograms\余音"
!macroend

!macro YuyinWebViewCreateOwnedShortcut LINK TARGET
    ClearErrors
    CreateShortcut "${LINK}" "${TARGET}"
    ${If} ${Errors}
        StrCpy $FailureMessage "创建 open音乐 快捷方式失败，请检查桌面与开始菜单目录权限后重试。$\r$\n${LINK}"
        Call StopInstall
    ${EndIf}
    StrCpy $ShortcutPath "${LINK}"
    StrCpy $ShortcutExpectedTarget "${TARGET}"
    Call ShortcutTargetsThisInstall
    ${If} $ShortcutMatches != "1"
        StrCpy $FailureMessage "无法确认新快捷方式指向本次安装，旧入口尚未迁移。$\r$\n$ShortcutPath"
        Call StopInstall
    ${EndIf}
!macroend

!macro YuyinWebViewInstallShortcuts
    ${If} $ShortcutDesktop != ""
        ; Repeat collision checks immediately before creation, and create the
        ; new links before retiring old ones so a failed write leaves old links.
        !insertmacro YuyinWebViewCheckShortcutSlots
        ClearErrors
        CreateDirectory "$ShortcutDesktop"
        ${If} ${Errors}
            StrCpy $FailureMessage "创建桌面快捷方式目录失败，旧入口尚未迁移。$\r$\n$ShortcutDesktop"
            Call StopInstall
        ${EndIf}
        ClearErrors
        CreateDirectory "$ShortcutPrograms\open音乐"
        ${If} ${Errors}
            StrCpy $FailureMessage "创建开始菜单快捷方式目录失败，旧入口尚未迁移。$\r$\n$ShortcutPrograms\open音乐"
            Call StopInstall
        ${EndIf}
        !insertmacro YuyinWebViewCreateOwnedShortcut "$ShortcutDesktop\open音乐.lnk" "$INSTDIR\Yuyin.WindowsHost.exe"
        !insertmacro YuyinWebViewCreateOwnedShortcut "$ShortcutPrograms\open音乐\open音乐.lnk" "$INSTDIR\Yuyin.WindowsHost.exe"
        !insertmacro YuyinWebViewCreateOwnedShortcut "$ShortcutPrograms\open音乐\卸载open音乐.lnk" "$INSTDIR\Uninstall Yuyin.exe"
        !insertmacro YuyinWebViewRemoveLegacyShortcuts ""
    ${EndIf}
!macroend

!macro YuyinWebViewUninstallShortcuts
    ${If} $ShortcutDesktop != ""
        !insertmacro YuyinWebViewRemoveOwnedShortcut "un." "$ShortcutDesktop\open音乐.lnk" "$INSTDIR\Yuyin.WindowsHost.exe"
        !insertmacro YuyinWebViewRemoveOwnedShortcut "un." "$ShortcutPrograms\open音乐\open音乐.lnk" "$INSTDIR\Yuyin.WindowsHost.exe"
        !insertmacro YuyinWebViewRemoveOwnedShortcut "un." "$ShortcutPrograms\open音乐\卸载open音乐.lnk" "$INSTDIR\Uninstall Yuyin.exe"
        !insertmacro YuyinWebViewRemoveLegacyShortcuts "un."
        RMDir "$ShortcutPrograms\open音乐"
    ${EndIf}
!macroend
