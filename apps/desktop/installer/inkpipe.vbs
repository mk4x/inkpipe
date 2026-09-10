' Start inkpipe without a console window.
'
' ADR 0005. Running node.exe from a shortcut flashes up a terminal and leaves it
' on the taskbar for the whole session. A visible terminal is a large part of
' why this did not feel like an application.
'
' It also used to hide every failure. The first installed build died on its
' first import and the user saw nothing at all: no window, no error, no clue.
' Hiding the console must not mean hiding the crash, so this waits for the
' process, keeps its output, and shows what went wrong if it exits badly.
'
' The bundled runtime is used by absolute path on purpose: whatever Node the
' user has, or does not have, is irrelevant and cannot break this.

Option Explicit

Dim shell, fso, here, node, entry, logPath, command, code, details
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
node = here & "runtime\node.exe"
entry = here & "apps\desktop\launcher\src\index.ts"
logPath = shell.ExpandEnvironmentStrings("%APPDATA%") & "\inkpipe\launcher.log"

If Not fso.FileExists(node) Then
  MsgBox "The bundled Node runtime is missing from:" & vbCrLf & node & vbCrLf & vbCrLf & _
         "Reinstall inkpipe.", vbCritical, "inkpipe"
  WScript.Quit 1
End If

If Not fso.FolderExists(shell.ExpandEnvironmentStrings("%APPDATA%") & "\inkpipe") Then
  fso.CreateFolder shell.ExpandEnvironmentStrings("%APPDATA%") & "\inkpipe"
End If

' cmd.exe wraps the call only so stdout and stderr can be captured to a file.
' Without it a crash leaves nothing behind to read.
command = "cmd /c """"" & node & """ --experimental-strip-types """ & entry & """ > """ & logPath & """ 2>&1"""

' 0 hides the window. True waits, so the exit code is real: this script stays
' alive alongside the app, which costs nothing and is what makes the error
' message below possible.
code = shell.Run(command, 0, True)

If code <> 0 Then
  details = ""
  If fso.FileExists(logPath) Then
    On Error Resume Next
    details = fso.OpenTextFile(logPath, 1).ReadAll()
    On Error Goto 0
    If Len(details) > 1500 Then details = Right(details, 1500)
  End If

  MsgBox "inkpipe stopped with code " & code & "." & vbCrLf & vbCrLf & _
         details & vbCrLf & vbCrLf & _
         "The full log is at:" & vbCrLf & logPath, vbCritical, "inkpipe"
End If
