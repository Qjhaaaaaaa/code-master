Set WshShell = CreateObject("WScript.Shell")
Dim scriptDir
scriptDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)

Set Shortcut = WshShell.CreateShortcut(WshShell.SpecialFolders("Desktop") & "\CC-Master.lnk")
Shortcut.TargetPath = "wscript.exe"
Shortcut.Arguments = scriptDir & "\CC-Desktop.vbs"
Shortcut.WorkingDirectory = scriptDir & "\desktop"
Shortcut.Description = "CC Master - AI Coding Assistant"
Shortcut.IconLocation = scriptDir & "\cc-master.ico,0"
Shortcut.Save
WScript.Echo "Shortcut created"
