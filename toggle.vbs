Option Explicit

Dim fso, sh, dir, i, rc

Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")

Function IsUp()
  Dim http
  IsUp = False
  On Error Resume Next
  Set http = CreateObject("MSXML2.XMLHTTP")
  http.Open "GET", "http://127.0.0.1:8787/api/health", False
  http.Send
  If Err.Number = 0 Then
    If http.Status = 200 Then IsUp = True
  End If
  Err.Clear
  On Error GoTo 0
End Function

If IsUp() Then
  ' второй клик — остановить всё
  sh.Run "cmd /c """ & dir & "\stop.cmd""", 0, True
  WScript.Quit
End If

rc = sh.Run("cmd /c where node >nul 2>nul", 0, True)
If rc <> 0 Then
  MsgBox "Node.js not found. Install Node.js 20+ from https://nodejs.org", 16, "EVE Flip Scanner"
  WScript.Quit
End If

' первый клик — запустить скрыто
sh.CurrentDirectory = dir
sh.Run "wscript """ & dir & "\server.vbs""", 0, False
sh.Run "wscript """ & dir & "\notifier.vbs""", 0, False

For i = 1 To 40
  WScript.Sleep 250
  If IsUp() Then Exit For
Next

sh.Run "cmd /c start """" ""http://127.0.0.1:8787""", 0, False
