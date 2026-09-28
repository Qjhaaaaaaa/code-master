Set WshShell = CreateObject("WScript.Shell")
Dim scriptDir
scriptDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)

' Step 1: Check if litellm is already running on port 4000
alreadyRunning = False
Set checkExec = WshShell.Exec("cmd /c netstat -ano | findstr "":4000"" | findstr ""LISTENING""")
checkOutput = ""
Do While Not checkExec.StdOut.AtEndOfStream
    checkOutput = checkOutput & checkExec.StdOut.ReadLine()
Loop
If Len(Trim(checkOutput)) > 0 Then
    alreadyRunning = True
End If

' Step 2: If litellm not running, start it in a minimized window
If Not alreadyRunning Then
    WshShell.Run "powershell.exe -Command ""& 'E:\Python310\Scripts\litellm.exe' --config '" & scriptDir & "\litellm_config.yaml' --port 4000""", 2, False

    ' Wait up to 30 seconds for port 4000 to be ready
    For i = 1 To 30
        WScript.Sleep 1000
        Set waitExec = WshShell.Exec("cmd /c netstat -ano | findstr "":4000"" | findstr ""LISTENING""")
        waitOutput = ""
        Do While Not waitExec.StdOut.AtEndOfStream
            waitOutput = waitOutput & waitExec.StdOut.ReadLine()
        Loop
        If Len(Trim(waitOutput)) > 0 Then
            Exit For
        End If
    Next
End If

' Step 3: Launch Electron directly (no cmd window, no npx wrapper)
WshShell.CurrentDirectory = scriptDir & "\desktop"
WshShell.Run """" & scriptDir & "\desktop\node_modules\.bin\electron.exe"" """ & scriptDir & "\desktop""", 0, False
