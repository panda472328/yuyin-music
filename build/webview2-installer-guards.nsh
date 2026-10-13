!include "LogicLib.nsh"

; Only opens the exact bundled file for write access, without writing,
; truncating, enumerating processes or killing them. Missing files are valid.
!macro YuyinWebViewCheckFile PREFIX
Function ${PREFIX}CheckFile
    Push $0
    Push $1
    System::Call 'kernel32::CreateFileW(w "$ProbePath", i 0x40000000, i 7, p 0, i 3, i 0x80, p 0)p.r0 ?e'
    Pop $1
    ${If} $0 != -1
        System::Call 'kernel32::CloseHandle(p r0)'
    ${ElseIf} $1 != 2
    ${AndIf} $1 != 3
        ${IfNot} ${Silent}
            MessageBox MB_OK|MB_ICONSTOP "程序文件正在使用或无法写入（Windows 错误 $1）。请先退出open音乐，再重新安装或卸载。$\r$\n$ProbePath"
        ${EndIf}
        SetErrorLevel 2
        Quit
    ${EndIf}
    Pop $1
    Pop $0
FunctionEnd
!macroend
