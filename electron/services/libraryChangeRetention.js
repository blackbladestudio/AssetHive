const fs = require("node:fs/promises");
const path = require("node:path");
const { Buffer } = require("node:buffer");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const ARCHIVE_DIRECTORY = "change-log-archive";
const JOURNAL_NAME = /^changes(?:\.[a-f0-9-]+)?\.jsonl$/;
const ARCHIVE_NAME = /^(changes(?:\.[a-f0-9-]+)?\.jsonl)\.(\d{4}-\d{2}-\d{2})\.[a-f0-9]{32}\.archived$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 30;
const runFile = promisify(execFile);
const unavailable = new Set(["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EROFS"]);
const archiveScript = `
$ErrorActionPreference = 'Stop'
$metadata = $env:ASSETHIVE_CHANGE_LOG_METADATA
$archive = [IO.Path]::Combine($metadata, '${ARCHIVE_DIRECTORY}')
foreach ($directory in @($metadata, $archive)) {
  if ([IO.File]::GetAttributes($directory) -band [IO.FileAttributes]::ReparsePoint) {
    throw 'The change journal directories must not be reparse points.'
  }
}
$day = $env:ASSETHIVE_CHANGE_LOG_DAY
$cutoff = [datetime]::Parse($env:ASSETHIVE_CHANGE_LOG_CUTOFF, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
$archiveCutoff = $cutoff.ToString('yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
$archived = 0
$deleted = 0
$skipped = 0
foreach ($file in [IO.DirectoryInfo]::new($metadata).EnumerateFiles('changes*.jsonl')) {
  if ($file.Name -cnotmatch '${JOURNAL_NAME.source}' -or
      ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $file.LastWriteTimeUtc -gt $cutoff) { continue }
  $handle = $null
  try {
    # Deny new reads and writes while checking and moving this file. An existing
    # reader or writer makes the open fail. Delete sharing permits the rename.
    $handle = [IO.File]::Open($file.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Delete)
    $writeTime = [IO.File]::GetLastWriteTimeUtc($file.FullName)
    if ($writeTime.Year -le 1601 -or $writeTime -gt $cutoff) { continue }
    $destination = [IO.Path]::Combine($archive, ($file.Name + '.' + $day + '.' + [guid]::NewGuid().ToString('N') + '.archived'))
    [IO.File]::Move($file.FullName, $destination)
    $archived++
  } catch [IO.IOException], [UnauthorizedAccessException] {
    $skipped++
  } finally {
    if ($null -ne $handle) { $handle.Dispose() }
  }
}
foreach ($file in [IO.DirectoryInfo]::new($archive).EnumerateFiles()) {
  if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
  $isArchived = $file.Name -cmatch '${ARCHIVE_NAME.source}'
  if ($isArchived) { $stamp = $Matches[2] }
  elseif ($file.Name -cmatch '^(\\d{4}-\\d{2}-\\d{2})\\.sweep$') { $stamp = $Matches[1] }
  else { continue }
  if ([string]::CompareOrdinal($stamp, $archiveCutoff) -ge 0 -or $file.LastWriteTimeUtc -gt $cutoff) { continue }
  try {
    [IO.File]::Delete($file.FullName)
    if ($isArchived) { $deleted++ }
  } catch [IO.IOException], [UnauthorizedAccessException] {
    $skipped++
  }
}
ConvertTo-Json -Compress -InputObject @{ archived = $archived; deleted = $deleted; skipped = $skipped }
`;

function createLibraryChangeMaintenance(now = Date.now) {
  const attemptedDays = new Map();
  return async function maintainLibraryChangeJournals(root) {
    if (process.platform !== "win32" || !root) return null;
    const checkedAt = now();
    const day = new Date(checkedAt).toISOString().slice(0, 10);
    const directory = path.join(path.resolve(root), ".assethive");
    const key = directory.toLowerCase();
    if (attemptedDays.get(key) === day) return null;
    attemptedDays.set(key, day);
    const archive = path.join(directory, ARCHIVE_DIRECTORY);
    try {
      if (!(await fs.lstat(directory)).isDirectory()) return null;
      await fs.mkdir(archive).catch(error => { if (error.code !== "EEXIST") throw error; });
      if (!(await fs.lstat(archive)).isDirectory()) return null;
      // A daily marker is an atomic claim, including across SMB clients.
      const claim = await fs.open(path.join(archive, `${day}.sweep`), "wx");
      await claim.close();
    } catch (error) {
      if (error.code === "EEXIST" || unavailable.has(error.code)) return null;
      throw error;
    }
    const executable = path.win32.join(process.env.SystemRoot || "C:\\Windows",
      "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const { stdout } = await runFile(executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(archiveScript, "utf16le").toString("base64")], {
      windowsHide: true,
      timeout: 60 * 1000,
      maxBuffer: 64 * 1024,
      env: { ...process.env,
        ASSETHIVE_CHANGE_LOG_METADATA: path.toNamespacedPath(directory),
        ASSETHIVE_CHANGE_LOG_DAY: day,
        ASSETHIVE_CHANGE_LOG_CUTOFF: new Date(checkedAt - RETENTION_DAYS * DAY_MS).toISOString()
      }
    });
    return JSON.parse(stdout.replace(/^\uFEFF/, "").trim());
  };
}

module.exports = { ARCHIVE_DIRECTORY, ARCHIVE_NAME, JOURNAL_NAME, createLibraryChangeMaintenance };
