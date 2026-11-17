const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { Buffer } = require("node:buffer");

const execFileAsync = promisify(execFile);
const LOCAL_DRIVE_TYPES = new Set(["Fixed", "Removable", "CDRom", "Ram"]);

async function readWindowsDriveTypes(roots) {
  // DriveInfo.DriveType uses GetDriveType, without traversing the library or
  // requiring WMI/admin access. Pass roots as data, never as shell commands.
  const script = `
$ErrorActionPreference = 'Stop'
$rows = @(($env:ASSETHIVE_WATCH_DRIVE_ROOTS | ConvertFrom-Json) | ForEach-Object {
  [pscustomobject]@{ root = $_; type = ([IO.DriveInfo]::new($_)).DriveType.ToString() }
})
ConvertTo-Json -InputObject $rows -Compress
`;
  const executable = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const { stdout } = await execFileAsync(executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024,
    env: { ...process.env, ASSETHIVE_WATCH_DRIVE_ROOTS: JSON.stringify(roots) }
  });
  const rows = JSON.parse(stdout.replace(/^\uFEFF/, "").trim());
  if (!Array.isArray(rows)) throw new Error("Invalid drive-type response");
  return new Map(rows.map(row => [String(row.root).toUpperCase(), row.type]));
}

async function planLibraryWatch(paths, { platform = process.platform, readDriveTypes = readWindowsDriveTypes } = {}) {
  const watchPaths = [], skipped = [], candidates = [];
  for (const input of Array.isArray(paths) ? paths : []) {
    const value = String(input || "").trim();
    if (!value) continue;
    // Distinguish extended DOS paths from extended UNC paths before testing
    // for a network prefix. A drive letter alone does not imply local storage.
    const normalized = value.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
    if (/^(\\\\|\/\/)/.test(normalized)) skipped.push({ path: value, reason: "network" });
    else if (platform !== "win32") watchPaths.push(value);
    else {
      const match = /^([a-z]:)[\\/]/i.exec(normalized);
      if (match) candidates.push({ path: value, root: `${match[1].toUpperCase()}\\` });
      else skipped.push({ path: value, reason: "unresolved-drive" });
    }
  }
  if (candidates.length) {
    let types;
    try { types = await readDriveTypes([...new Set(candidates.map(item => item.root))]); }
    catch { /* Unverified storage uses periodic scans, never a recursive watch. */ }
    for (const item of candidates) {
      const type = types?.get(item.root);
      if (LOCAL_DRIVE_TYPES.has(type)) watchPaths.push(item.path);
      else skipped.push({ path: item.path, reason: type === "Network" ? "network" : "unresolved-drive" });
    }
  }
  return { watchPaths, skipped };
}

module.exports = { planLibraryWatch };
