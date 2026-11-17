const path = require("node:path");
const fs = require("node:fs/promises");

const DEFAULT_ATTEMPTS = [
  { maxRetries: 6, retryDelay: 200 },
  { maxRetries: 12, retryDelay: 400 }
];

function sleep(ms) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function sanitizeTrashLabel(value) {
  const label = String(value || "").trim().replace(/[\\/:*?"<>|]+/g, "_").replace(/^[.\s]+/, "");
  return label || "asset";
}

// 递归清除只读属性：从只读介质或网络盘拷入的文件在 Windows 上删除会返回 EPERM。
async function clearReadOnlyAttributes(targetPath, options = {}) {
  const fsImpl = options.fs || fs;
  const stats = await fsImpl.lstat(targetPath).catch(() => null);
  if (!stats) {
    return;
  }
  if (stats.isDirectory()) {
    await fsImpl.chmod(targetPath, 0o777).catch(() => {});
    const entries = await fsImpl.readdir(targetPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      await clearReadOnlyAttributes(path.join(targetPath, entry.name), options);
    }
    return;
  }
  if (stats.isFile()) {
    await fsImpl.chmod(targetPath, 0o666).catch(() => {});
  }
}

// 删除库内文件/目录：1) 带重试与退避删除（Windows/网络盘常见 EBUSY / EPERM / ENOTEMPTY 抖动）；
// 2) 失败后递归清除只读属性再删；3) 仍失败则改名移入库内回收站 <trashRoot>/.assethive/Trash，
// 扫描器忽略 .assethive，因此索引可以先移除资产，物理清理交给后台任务。
async function removeLibraryPathWithRetries(targetPath, options = {}) {
  const fsImpl = options.fs || fs;
  const attempts = Array.isArray(options.attempts) && options.attempts.length > 0 ? options.attempts : DEFAULT_ATTEMPTS;
  const resolved = path.resolve(String(targetPath || "").trim() || ".");
  const trashRoot = String(options.trashRoot || "").trim();
  const label = sanitizeTrashLabel(options.label || path.basename(resolved));
  let lastError = null;

  for (const attempt of attempts) {
    try {
      await fsImpl.rm(resolved, {
        recursive: true,
        force: true,
        maxRetries: attempt.maxRetries,
        retryDelay: attempt.retryDelay
      });
      return { ok: true, mode: "deleted", path: resolved };
    } catch (error) {
      lastError = error;
    }
    await clearReadOnlyAttributes(resolved, { fs: fsImpl });
  }

  if (trashRoot) {
    const trashDir = path.join(trashRoot, ".assethive", "Trash");
    const staged = path.join(trashDir, Date.now() + "_" + label);
    try {
      await fsImpl.mkdir(trashDir, { recursive: true });
      void pruneTrashDirectory(trashDir, { fs: fsImpl }).catch(() => {});
      await fsImpl.rename(resolved, staged);
      return { ok: true, mode: "trashed", path: resolved, staged, error: lastError };
    } catch (error) {
      lastError = lastError || error;
    }
  }

  return { ok: false, mode: "failed", path: resolved, error: lastError };
}

// 清理回收站里的历史残留（默认只清 30 分钟前的条目），避免占用网络盘空间。
async function pruneTrashDirectory(trashDir, options = {}) {
  const fsImpl = options.fs || fs;
  const target = String(trashDir || "").trim();
  if (!target) {
    return 0;
  }
  const minAgeMs = Number.isFinite(Number(options.minAgeMs)) ? Math.max(0, Number(options.minAgeMs)) : 30 * 60 * 1000;
  const entries = await fsImpl.readdir(target, { withFileTypes: true }).catch(() => []);
  let purged = 0;
  for (const entry of entries) {
    const entryPath = path.join(target, entry.name);
    const stats = await fsImpl.stat(entryPath).catch(() => null);
    if (!stats || Date.now() - Number(stats.mtimeMs || 0) < minAgeMs) {
      continue;
    }
    if (await purgeTrashEntry(entryPath, { fs: fsImpl, rounds: options.rounds, retryDelay: options.retryDelay })) {
      purged += 1;
    }
  }
  return purged;
}

// 后台清理回收站暂存路径：仍可能被占用，多轮重试后放弃，留待下次再清。
async function purgeTrashEntry(stagedPath, options = {}) {
  const fsImpl = options.fs || fs;
  const target = String(stagedPath || "").trim();
  if (!target) {
    return false;
  }
  const rounds = Number.isFinite(Number(options.rounds)) ? Math.max(1, Number(options.rounds)) : 4;
  const retryDelay = Number.isFinite(Number(options.retryDelay)) ? Number(options.retryDelay) : 1500;
  for (let index = 0; index < rounds; index += 1) {
    try {
      await fsImpl.rm(target, { recursive: true, force: true, maxRetries: 12, retryDelay: 500 });
      return true;
    } catch {
      await clearReadOnlyAttributes(target, { fs: fsImpl });
      await sleep(retryDelay);
    }
  }
  return false;
}

module.exports = {
  DEFAULT_ATTEMPTS,
  clearReadOnlyAttributes,
  pruneTrashDirectory,
  purgeTrashEntry,
  removeLibraryPathWithRetries
};
