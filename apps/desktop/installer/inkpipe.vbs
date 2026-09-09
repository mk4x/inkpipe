' Start inkpipe without a console window.
'
' ADR 0005. Running node.exe from a shortcut flashes up a terminal and leaves it
' on the taskbar for the whole session. A visible terminal is a large part of
' why this did not feel like an application.
'
' WScript.Shell Run with a window style of 0 starts the process hidden. The
' launcher then opens the real window itself, so the user sees one thing.
'
' The bundled runtime is used by absolute path on purpose: whatever Node the
' user has, or does not have, is irrelevant and cannot break this.

Option Explicit

Dim shell, here, node, entry, command
Set shell = CreateObject("WScript.Shell")

here = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
node = here & "runtime\node.exe"
entry = here & "apps\desktop\launcher\src\index.ts"

If Not CreateObject("Scripting.FileSystemObject").FileExists(node) Then
  MsgBox "The bundled Node runtime is missing from:" & vbCrLf & node & vbCrLf & vbCrLf & _
         "Reinstall inkpipe.", vbCritical, "inkpipe"
  WScript.Quit 1
End If

command = """" & node & """ --experimental-strip-types """ & entry & """"

' 0 means hidden. False means do not wait: this script exits immediately and
' the launcher owns the window's lifetime from here.
shell.Run command, 0, False
