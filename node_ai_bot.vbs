Set WshShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")

bat = FSO.BuildPath(FSO.GetParentFolderName(WScript.ScriptFullName), "node_ai_bot.bat")

WshShell.Run Chr(34) & bat & Chr(34), 0, False