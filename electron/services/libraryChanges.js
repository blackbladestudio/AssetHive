const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { Buffer } = require("node:buffer");

const MAX_DELTA_BYTES = 4 * 1024 * 1024;
const writerName = `changes.${randomUUID()}.jsonl`;
let pendingWrite = Promise.resolve();

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
  const file = path.join(path.resolve(root), ".assethive", writerName);
  // Each process owns a separate append-only journal. SMB clients must never
  // race to append to the same file; serialize this process's writes as well.
  const write = pendingWrite.catch(() => {}).then(async () => {
    await fs.mkdir(path.dirname(file)).catch(error => { if (error.code !== "EEXIST") throw error; });
    const handle = await fs.open(file, "a");
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
    const names = (await fs.readdir(directory)).filter(name => name === "changes.jsonl"
      || /^changes\.[a-f0-9-]+\.jsonl$/.test(name)).sort();
    if (!names.length) return { cursor: null, directories: null };
    // Also understand master's original single-file journal/cursor.
    const before = previous?.version === 2 ? previous.journals
      : previous?.fileId ? { "changes.jsonl": previous } : null;
    const journals = {};
    const directories = [];
    let remaining = MAX_DELTA_BYTES;
    let reset = !before || Object.keys(before).some(name => !names.includes(name));
    for (const name of names) {
      const handle = await fs.open(path.join(directory, name), "r");
      try {
        const stat = await handle.stat();
        const fileId = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
        const old = before?.[name];
        journals[name] = { fileId, offset: stat.size, mtimeMs: stat.mtimeMs };
        const invalid = old && (old.fileId !== fileId || !Number.isSafeInteger(old.offset)
          || old.offset < 0 || old.offset > stat.size
          || old.offset === stat.size && old.mtimeMs !== undefined && old.mtimeMs !== stat.mtimeMs);
        if (invalid) reset = true;
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
    return { cursor: { version: 2, journals }, directories: reset ? null : validated };
  } catch {
    return { cursor: null, directories: null };
  }
}

module.exports = { recordLibraryChanges, readLibraryChanges, changedDirectories };
