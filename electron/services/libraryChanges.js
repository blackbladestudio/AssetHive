const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { Buffer } = require("node:buffer");
const { setTimeout: delay } = require("node:timers/promises");
const { ARCHIVE_DIRECTORY, ARCHIVE_NAME, JOURNAL_NAME } = require("./libraryChangeRetention");

const MAX_DELTA_BYTES = 4 * 1024 * 1024;
const JOURNAL_ROTATION_MS = 7 * 24 * 60 * 60 * 1000;
const writerId = randomUUID();
let pendingWrite = Promise.resolve();

function journalIdentity(stat) {
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}

function cursorMatchesFile(cursor, stat) {
  return stat.isFile() && cursor.fileId === journalIdentity(stat)
    && cursor.offset === stat.size && cursor.mtimeMs === stat.mtimeMs;
}

async function archivedCursorsMatch(directory, retired, previous) {
  const archive = path.join(directory, ARCHIVE_DIRECTORY);
  if (!(await fs.lstat(archive).catch(() => null))?.isDirectory()) return false;
  const remaining = new Set(retired);
  for (const entry of await fs.readdir(archive, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = ARCHIVE_NAME.exec(entry.name);
    if (!match || !remaining.has(match[1])) continue;
    const stat = await fs.lstat(path.join(archive, entry.name)).catch(() => null);
    if (stat && cursorMatchesFile(previous[match[1]], stat)) remaining.delete(match[1]);
    if (remaining.size === 0) return true;
  }
  return false;
}

async function openJournalForAppend(file) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fs.open(file, "a");
    } catch (error) {
      // A retention pass can briefly hold an exclusive Windows file handle.
      if (process.platform !== "win32" || attempt >= 3 ||
          !["EBUSY", "EACCES", "EPERM"].includes(error.code)) throw error;
      await delay(50 * (attempt + 1));
    }
  }
}

function changedDirectories(root, directories) {
  const base = path.resolve(root);
  const candidates = new Map();
  for (const directory of directories) {
    if (typeof directory !== "string" || !directory) throw new Error("Invalid changed directory");
    const resolved = path.resolve(base, directory);
    const relative = path.relative(base, resolved);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      || relative.split(path.sep).some(part => part.startsWith("."))) throw new Error("Changed directory is outside the asset tree");
    candidates.set(process.platform === "win32" ? resolved.toLowerCase() : resolved, resolved);
  }
  const result = [];
  const baseLength = base.length;
  for (const key of [...candidates.keys()].sort()) {
    let parent = path.dirname(key);
    while (parent.length > baseLength && !candidates.has(parent)) parent = path.dirname(parent);
    if (!candidates.has(parent)) result.push(candidates.get(key));
  }
  return result;
}

async function recordLibraryChanges(root, directories) {
  const dirs = changedDirectories(root, directories).map(directory => path.relative(path.resolve(root), directory));
  if (!dirs.length) return Promise.resolve();
  const directory = path.join(path.resolve(root), ".assethive");
  // Each process owns a separate append-only journal. SMB clients must never
  // race to append to the same file. A weekly segment also ages out even when
  // the process keeps publishing changes continuously.
  const write = pendingWrite.catch(() => {}).then(async () => {
    const week = Math.floor(Date.now() / JOURNAL_ROTATION_MS).toString(16);
    const file = path.join(directory, `changes.${writerId}-${week}.jsonl`);
    await fs.mkdir(directory).catch(error => { if (error.code !== "EEXIST") throw error; });
    const handle = await openJournalForAppend(file);
    try {
      await handle.writeFile(`${JSON.stringify({ version: 1, directories: dirs })}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  });
  pendingWrite = write;
  return write;
}

async function readLibraryChanges(root, previous) {
  try {
    const directory = path.join(path.resolve(root), ".assethive");
    // Only read: an offline/read-only/legacy library must not be modified by a poll.
    const names = (await fs.readdir(directory)).filter(name => JOURNAL_NAME.test(name)).sort();
    // Also understand master's original single-file journal/cursor.
    const before = previous?.version === 2 ? previous.journals
      : previous?.fileId ? { "changes.jsonl": previous } : null;
    if (!names.length && !before) return { cursor: null, directories: null };
    const journals = {};
    const directories = [];
    let remaining = MAX_DELTA_BYTES;
    const listedNames = new Set(names);
    const retired = new Set(Object.keys(before || {}).filter(name => !listedNames.has(name)));
    let reset = !before;
    for (const name of names) {
      const file = path.join(directory, name);
      const old = before?.[name];
      if (old && old.mtimeMs !== undefined) {
        const stat = await fs.stat(file);
        if (cursorMatchesFile(old, stat)) {
          journals[name] = old;
          continue;
        }
      }
      // The file may have changed between the path probe and open.
      const handle = await fs.open(file, "r");
      try {
        const stat = await handle.stat();
        const fileId = journalIdentity(stat);
        journals[name] = { fileId, offset: stat.size, mtimeMs: stat.mtimeMs };
        const invalid = old && (old.fileId !== fileId || !Number.isSafeInteger(old.offset)
          || old.offset < 0 || old.offset > stat.size
          || old.offset === stat.size && old.mtimeMs !== undefined && old.mtimeMs !== stat.mtimeMs);
        if (invalid) {
          if (old.fileId !== fileId) retired.add(name);
          else reset = true;
        }
        const offset = old && !invalid ? old.offset : 0;
        const length = stat.size - offset;
        remaining -= length;
        if (remaining < 0) { reset = true; continue; }
        if (!length) continue;
        const buffer = Buffer.alloc(length);
        let read = 0;
        while (read < length) {
          const { bytesRead } = await handle.read(buffer, read, length - read, offset + read);
          if (!bytesRead) throw new Error("Change journal was truncated during read");
          read += bytesRead;
        }
        const text = buffer.toString("utf8");
        if (!text.endsWith("\n")) throw new Error("Incomplete change journal record");
        for (const line of text.trimEnd().split("\n")) {
          const entry = JSON.parse(line);
          if (entry.version !== 1 || !Array.isArray(entry.directories)) throw new Error("Invalid change journal record");
          directories.push(...entry.directories);
        }
      } finally {
        await handle.close();
      }
    }
    const validated = changedDirectories(root, directories);
    const pruned = retired.size > 0 && !reset && await archivedCursorsMatch(directory, retired, before);
    if (retired.size && !pruned) reset = true;
    return { cursor: { version: 2, journals }, directories: reset ? null : validated, pruned };
  } catch {
    return { cursor: null, directories: null };
  }
}

module.exports = { recordLibraryChanges, readLibraryChanges, changedDirectories };
