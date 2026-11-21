; Omni's additions to Tauri's NSIS installer (tauri.windows.conf.json, bundle.windows.nsis).
; WebView2, which the window runs in, needs Windows 10 or later: stop older systems before
; anything is copied, rather than leave an app that opens to a blank window.
!include WinVer.nsh

!macro NSIS_HOOK_PREINSTALL
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_ICONSTOP "Omni needs Windows 10 or later." /SD IDOK
    Abort
  ${EndIf}
!macroend
