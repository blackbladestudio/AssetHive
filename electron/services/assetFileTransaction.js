const fs = require("node:fs/promises");
const path = require("node:path");
const { AsyncLocalStorage } = require("node:async_hooks");
const { randomUUID } = require("node:crypto");

// Windows may briefly hold entries after a recursive removal.
const recursiveRemoveOptions = { recursive: true, force: true, maxRetries: 3, retryDelay: 50 };
const storage = new AsyncLocalStorage();
const locks = new Map();
const stat = file => fs.lstat(file).catch(error => { if (error.code === "ENOENT") return null; throw error; });

async function move(source, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try { await fs.rename(source, destination); }
  catch (error) {
    if (error.code !== "EXDEV") throw error;
    const pending = `${destination}.copying-${randomUUID()}`;
    await fs.cp(source, pending, { recursive: true, force: true });
    await fs.rename(pending, destination);
    await fs.rm(source, recursiveRemoveOptions);
  }
}

async function saveJournal(directory, actions) {
  await fs.mkdir(directory, { recursive: true });
  const journal = path.join(directory, "journal.json");
  const temporary = `${journal}.tmp`;
  await fs.writeFile(temporary, JSON.stringify({ actions }), { flush: true });
  await fs.rename(temporary, journal);
}

async function undo(actions, persist) {
  const remaining = [...actions];
  while (remaining.length) {
    const action = remaining[remaining.length - 1];
    try {
      if (action.kind === "restore") {
        if (await stat(action.backup)) {
          await fs.rm(action.target, recursiveRemoveOptions);
          await fs.mkdir(path.dirname(action.target), { recursive: true });
          await fs.cp(action.backup, action.target, { recursive: true, force: true });
        }
      } else if (action.kind === "remove") {
        await fs.rm(action.target, recursiveRemoveOptions);
      } else if (action.kind === "rename") {
        if (!await stat(action.source) && await stat(action.target)) await move(action.target, action.source);
      }
      remaining.pop();
      // Persist each inverse operation before starting the next. Repeating the
      // last inverse after a crash is safe; replaying a whole moved tree is not.
      await persist(remaining);
    } catch (error) {
      throw new Error(`资产恢复未完成，已保留备份：${action.target}（${error.message}）`, { cause: error });
    }
  }
}

class FileTransaction {
  constructor(directory) {
    this.directory = directory;
    this.actions = [];
    this.active = true;
  }

  async record(action) {
    this.actions.push(action);
    await saveJournal(this.directory, this.actions);
  }

  async protect(target, remove = false) {
    target = path.resolve(target);
    const existing = await stat(target);
    if (!existing) {
      if (!remove) await this.record({ kind: "remove", target });
      return false;
    }
    const backup = path.join(this.directory, `backup-${this.actions.length}`);
    // Persist the intent first. Recovery ignores a backup that was never made.
    await this.record({ kind: "restore", target, backup });
    if (remove) await move(target, backup);
    else {
      await fs.cp(target, `${backup}.pending`, { recursive: true, force: true, dereference: false });
      await fs.rename(`${backup}.pending`, backup);
    }
    return true;
  }

  async rollback() {
    this.active = false;
    await undo(this.actions, actions => saveJournal(this.directory, actions));
    await fs.rm(this.directory, recursiveRemoveOptions);
  }

  async commit() {
    // A committed marker makes cleanup retryable without undoing a saved asset.
    await fs.writeFile(path.join(this.directory, "committed"), "1", { flush: true });
    this.active = false;
    await fs.rm(this.directory, recursiveRemoveOptions).catch(() => {});
  }
}

async function protectFile(target) {
  const tx = storage.getStore();
  if (tx?.active) await tx.protect(target);
}

async function commitFileTransaction() {
  const tx = storage.getStore();
  if (tx?.active) await tx.commit();
}

// Only mutations in the edit's async context are journaled. Unrelated imports,
// scans and background jobs continue to use the normal filesystem semantics.
const transactionalFs = new Proxy(fs, {
  get(target, name) {
    if (!["writeFile", "copyFile", "cp", "rename", "rm", "unlink"].includes(name)) return target[name];
    return async (...args) => {
      const tx = storage.getStore();
      if (!tx?.active) return target[name](...args);
      if (name === "rm" || name === "unlink") {
        const existed = await tx.protect(args[0], true);
        if (existed) return;
      } else if (name === "rename") {
        if (path.resolve(args[0]) === path.resolve(args[1])) return;
        await tx.protect(args[1], true);
        await tx.record({ kind: "rename", source: path.resolve(args[0]), target: path.resolve(args[1]) });
      } else {
        await tx.protect(name === "writeFile" ? args[0] : args[1]);
      }
      return target[name](...args);
    };
  }
});

async function withFileTransaction({ root, owner, key }, callback) {
  const previous = locks.get(key) || Promise.resolve();
  const run = previous.catch(() => {}).then(async () => {
    const directory = path.join(root, ".assethive", "EditTransactions", owner, randomUUID());
    const tx = new FileTransaction(directory);
    // An empty transaction must also have a directory for its commit marker.
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "scope.json"), JSON.stringify({ key }));
    try {
      const result = await storage.run(tx, callback);
      if (!tx.active) return result;
      if (result?.ok === false) await tx.rollback();
      else await tx.commit();
      return result;
    } catch (error) {
      if (tx.active) {
        try { await tx.rollback(); }
        catch (recoveryError) { throw new Error(`${error.message}；${recoveryError.message}`, { cause: error }); }
      }
      throw error;
    }
  });
  locks.set(key, run);
  try { return await run; }
  finally { if (locks.get(key) === run) locks.delete(key); }
}

async function recoverFileTransactions(root, owner, extraRoots = [], options = {}) {
  const parent = path.join(root, ".assethive", "EditTransactions", owner);
  const entries = await fs.readdir(parent, { withFileTypes: true }).catch(error => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(parent, entry.name);
    if (!await stat(path.join(directory, "committed"))) {
      const raw = await fs.readFile(path.join(directory, "journal.json"), "utf8").catch(error => {
        if (error.code === "ENOENT") return '{"actions":[]}';
        throw error;
      });
      const actions = JSON.parse(raw).actions;
      const within = (target, base) => {
        const relative = path.relative(path.resolve(base), path.resolve(target));
        return !relative.startsWith("..") && !path.isAbsolute(relative);
      };
      if (options.key) {
        const scope = await fs.readFile(path.join(directory, "scope.json"), "utf8")
          .then(text => JSON.parse(text)).catch(error => { if (error.code === "ENOENT") return null; throw error; });
        if (scope?.key && scope.key !== options.key) continue;
        if (!scope?.key && (!Array.isArray(actions) || !actions.some(action => [action?.target, action?.source]
          .some(target => target && (options.paths || []).some(base => within(target, base)))))) continue;
      }
      if (!Array.isArray(actions) || actions.some(action => !action || !["restore", "remove", "rename"].includes(action.kind)
        || ![root, ...extraRoots].some(base => within(action.target, base))
        || (action.backup && !within(action.backup, directory))
        || (action.source && ![root, ...extraRoots].some(base => within(action.source, base))))) {
        throw new Error(`资产恢复日志包含无效路径，已保留备份：${directory}`);
      }
      await undo(actions, remaining => saveJournal(directory, remaining));
    }
    await fs.rm(directory, recursiveRemoveOptions);
  }
}

module.exports = { transactionalFs, protectFile, commitFileTransaction, withFileTransaction, recoverFileTransactions };
