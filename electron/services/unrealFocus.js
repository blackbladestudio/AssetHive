const { execFile } = require('node:child_process');
const { Buffer } = require('node:buffer');

// Switch only to the editor PID that acknowledged this job. Failure to focus
// must never change a saved import into a failure or cause another dispatch.
async function focusUnrealEditor(pid, run = execFile, platform = process.platform) {
  if (platform !== 'win32' || !Number.isSafeInteger(pid) || pid <= 0) return false;
  const script = `
$editorProcess = Get-Process -Id ${pid} -ErrorAction Stop
if ($editorProcess.ProcessName -ne 'UnrealEditor') { exit 1 }
$editorHandle = $editorProcess.MainWindowHandle
if ($editorHandle -eq 0) { exit 1 }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AssetHiveWindow {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr handle, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
}
'@
[void][AssetHiveWindow]::ShowWindowAsync($editorHandle, 9)
if (-not [AssetHiveWindow]::SetForegroundWindow($editorHandle)) { exit 1 }
`;
  return new Promise(resolve => {
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 8000 }, error => resolve(!error));
  });
}
module.exports = { focusUnrealEditor };
