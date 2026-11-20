const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { writeFileAtomic } = require("./atomicFile");
const { prepareAssetDeletion, libraryRoot, safePath, withRecycleLock } = require("./libraryRecycle");
const { boundedMap } = require('./boundedMap');

async function preparePermanentCharacterDeletion(options) {
  if (!["monster", "suit", "npc", "weapon", "item"].includes(options.asset?.assetType)) throw new Error("仅处理角色主体资产");
  const plan = await prepareAssetDeletion({ ...options, inventoryConcurrency: 4 });
  if (plan.flat || plan.entries.length !== 1) throw new Error("角色资产目录边界异常");
  return { ...plan, permanent: true };
}

// Logs contain only the deletion outcome, never retained asset files or a restore action.
async function listPermanentlyDeletedAssets(value, { concurrency = 8 } = {}) {
  const root = await libraryRoot(value);
  const directory = path.join(root, ".assethive", "Deletions");
  await safePath(root, directory, { allowPrivate: true, missing: true });
  const names = await fs.readdir(directory).catch(error => { if (error.code === "ENOENT") return []; throw error; });
  const records = await boundedMap(names.filter(name => /^[a-f0-9-]{36}\.json$/i.test(name)), concurrency, async name => {
    const file = path.join(directory, name);
    await safePath(root, file, { allowPrivate: true });
    const record = JSON.parse(await fs.readFile(file, "utf8"));
    return record.state === "deleted" && typeof record.assetId === "string" ? record : null;
  });
  return records.filter(Boolean);
}

async function removeWithRetry(operation) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (attempt >= 3 || !["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"].includes(error.code)) throw error;
      await new Promise(resolve => globalThis.setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
}

async function deleteCharacterPermanently({ root: value, asset, records, token, confirmPermanent, onIndexChange, onProgress, unlink = fs.unlink }) {
  const root = await libraryRoot(value);
  return withRecycleLock(root, async () => {
    onProgress?.(0, '正在复核删除范围…');
    const plan = await preparePermanentCharacterDeletion({ root, asset, records });
    if (confirmPermanent !== true || !token || token !== plan.token) throw new Error("请重新预检并确认永久删除；范围变化时不能沿用旧确认");
    const target = await safePath(root, plan.path);
    const files = [], directories = [];
    async function collect(folder) {
      await safePath(root, folder);
      const children = await boundedMap(await fs.readdir(folder, { withFileTypes: true }), 4, async entry => {
        const file = await safePath(root, path.join(folder, entry.name));
        const info = await fs.lstat(file);
        if (info.isDirectory()) return file;
        else if (info.isFile()) { files.push(file); return null; }
        else throw new Error("不支持的资产文件：" + file);
      });
      for (const child of children.filter(Boolean)) await collect(child);
      directories.push(folder);
    }
    await collect(target);
    onProgress?.(15, `正在删除文件 0/${files.length}`);
    // Keep metadata until all content and child directories are removed. A
    // partial failure remains visible and can be re-preflighted by the user.
    const metaPath = path.resolve(asset.metaPath);
    files.sort((a, b) => Number(path.resolve(a).toLowerCase() === metaPath.toLowerCase()) - Number(path.resolve(b).toLowerCase() === metaPath.toLowerCase()));
    const logDirectory = path.join(root, ".assethive", "Deletions");
    await safePath(root, logDirectory, { allowPrivate: true, missing: true });
    await fs.mkdir(logDirectory, { recursive: true });
    const logPath = path.join(logDirectory, `${randomUUID()}.json`);
    const log = { assetId: asset.id, path: target, state: "deleting", at: new Date().toISOString(), removedFiles: 0 };
    await writeFileAtomic(logPath, JSON.stringify(log));
    try {
      for (const file of files) {
        if (path.resolve(file).toLowerCase() === metaPath.toLowerCase()) {
          for (const folder of directories.filter(folder => folder !== target)) {
            await safePath(root, folder);
            await removeWithRetry(() => fs.rmdir(folder));
          }
          const remaining = await fs.readdir(target);
          if (remaining.length !== 1 || remaining[0].toLowerCase() !== path.basename(metaPath).toLowerCase()) throw new Error("删除期间出现新文件，请重新核对目录");
        }
        await safePath(root, file);
        await removeWithRetry(() => unlink(file));
        log.removedFiles++;
        onProgress?.(15 + log.removedFiles / files.length * 80, `正在删除文件 ${log.removedFiles}/${files.length}`);
      }
      await safePath(root, target);
      await removeWithRetry(() => fs.rmdir(target));
    } catch (error) {
      log.state = "failed"; log.error = String(error.message || error);
      await writeFileAtomic(logPath, JSON.stringify(log));
      return { ok: false, assetId: asset.id, partial: log.removedFiles > 0,
        message: `永久删除未完成：已删除 ${log.removedFiles} 个文件，剩余文件仍在 ${target}。请解除占用并重新核对后再删除。${log.error}` };
    }
    log.state = "deleted";
    let indexPending = false;
    try { await writeFileAtomic(logPath, JSON.stringify(log)); } catch { indexPending = true; }
    try { await onIndexChange?.("delete", asset); } catch { indexPending = true; }
    onProgress?.(100, '库内文件删除完成');
    return { ok: true, assetId: asset.id, indexPending, message: indexPending ? "库内文件已永久删除，但索引同步失败，请刷新资产库" : "整套及所属部件已永久删除" };
  });
}

module.exports = { preparePermanentCharacterDeletion, deleteCharacterPermanently, listPermanentlyDeletedAssets };
