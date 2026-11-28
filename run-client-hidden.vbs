' Hidden launcher for the WeChat <-> Codex bridge.
' Runs run-client.cmd with window style 0 (fully hidden, no console flash).
' ASCII-only on purpose: wscript reads scripts in the system ANSI codepage.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "cmd /c """ & base & "\run-client.cmd""", 0, False
