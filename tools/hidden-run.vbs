' Hidden-window launcher for the ZCode asar swap watcher (apply-update.mjs wait).
' Usage: wscript.exe hidden-run.vbs <node.exe> <script.mjs> [args...]
'   - wscript is a GUI-subsystem host (no console of its own);
'   - sh.Run(..., 0, False) starts node with SW_HIDE, so no terminal window appears.
' (Scheduling node.exe directly makes Task Scheduler allocate a visible console window;
'  WMI Win32_Process.Create does the same. WMI + wscript did not start node in tests,
'  but Task Scheduler + wscript does.)
If WScript.Arguments.Count < 2 Then
  WScript.Echo "usage: wscript hidden-run.vbs <node.exe> <script> [args...]"
  WScript.Quit 2
End If
node = WScript.Arguments(0)
script = WScript.Arguments(1)
extra = ""
For i = 2 To WScript.Arguments.Count - 1
  extra = extra & " """ & WScript.Arguments(i) & """"
Next
Set sh = CreateObject("WScript.Shell")
sh.Run """" & node & """ """ & script & """" & extra, 0, False
