const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID, createHash } = require("node:crypto");
const { writeFileAtomic } = require("./atomicFile");
const { isFlatCustomAssetType, isAnimationModelMetaPath } = require("./customAssetLayout");
const { isSidecarAssetMetaFileName } = require("./assetMetadata");
const { getAnimationIdentitySidecarPath } = require("./animationIdentity");

// Deliberately separate from legacy Trash: it is never automatically purged.
const BIN = path.join(".assethive", "RecycleBin");
const key = value => process.platform === "win32" ? value.toLowerCase() : value;
const stat = async file => fs.lstat(file).catch(error => { if (error.code === "ENOENT") return null; throw error; });
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function childPath(root, value, allowPrivate = false) {
  if (!value || !path.isAbsolute(value)) throw new Error("拒绝空路径或相对路径");
  const resolved = path.resolve(value);
  const relative = path.relative(root, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("拒绝库根目录或库外路径：" + value);
  }
  if (!allowPrivate && relative.split(path.sep)[0].toLowerCase() === ".assethive") throw new Error("不能删除库内部管理目录");
  return resolved;
}

async function libraryRoot(value) {
  if (!value || !path.isAbsolute(value)) throw new Error("未配置有效的标准库绝对路径");
  const root = path.resolve(value);
  if (key(root) === key(path.parse(root).root)) throw new Error("不能将磁盘或共享根目录作为删除库");
  const info = await stat(root);
  if (!info) throw Object.assign(new Error("标准库不存在：" + root), { code: "ENOENT", path: root });
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("标准库不可访问或是链接目录");
  return root;
}

async function safePath(root, value, { allowPrivate = false, missing = false } = {}) {
  const resolved = childPath(root, value, allowPrivate);
  let cursor = root;
  for (const part of path.relative(root, resolved).split(path.sep)) {
    cursor = path.join(cursor, part);
    const info = await stat(cursor);
    if (!info) {
      if (missing) break;
      throw new Error("路径不存在：" + cursor);
    }
    if (info.isSymbolicLink()) throw new Error("拒绝符号链接或目录联接：" + cursor);
  }
  // realpath also detects a linked ancestor above the configured library root.
  if (await stat(resolved)) {
    const realRoot = await fs.realpath(root);
    childPath(realRoot, await fs.realpath(resolved), true);
  }
  return resolved;
}

async function inventory(root, target, allowPrivate = false, concurrency = 1) {
  async function visit(file) {
    await safePath(root, file, { allowPrivate });
    const info = await fs.lstat(file);
    if (info.isDirectory()) {
      const files = [[path.relative(target, file), "directory"]];
      const names = (await fs.readdir(file)).sort();
      for (let offset = 0; offset < names.length; offset += concurrency) {
        const children = await Promise.all(names.slice(offset, offset + concurrency).map(name => visit(path.join(file, name))));
        files.push(...children.flat());
      }
      return files;
    } else if (info.isFile()) {
      return [[path.relative(target, file), info.size, info.mtimeMs]];
    } else throw new Error("不支持的文件类型：" + file);
  }
  const files = await visit(target);
  return { fingerprint: hash(files), count: files.filter(item => item[1] !== "directory").length,
    bytes: files.reduce((sum, item) => sum + (typeof item[1] === "number" ? item[1] : 0), 0) };
}

function referencedPaths(record) {
  const meta = record.meta || {};
  const values = [record.metaPath, ...(record.modelFiles || []), ...(record.textureFiles || []),
    record.previewImage, record.detailImage, record.preview, record.previewSkeletonPath, record.previewSkeletalMeshPath,
    ...Object.values(meta.modelSlots || {}), ...Object.values(meta.textureSlots || {}),
    ...(meta.components || []).map(item => item.uri), ...(meta.textureEntries || []).map(item => item.filePath),
    ...(meta.characterManifest?.files || []).map(item => item.storedPath),
    ...(meta.previews?.images || []).map(item => item.uri)];
  return values.filter(value => typeof value === "string" && value).map(value => path.isAbsolute(value) ? path.resolve(value) : path.resolve(record.path, value));
}

async function prepareAssetDeletion({ root: rootValue, asset, records = [], inventoryConcurrency = 1 }) {
  if (asset?.meta?.componentView || String(asset?.id || "").includes("::part::")) throw new Error("部件不能单独删除，请从主体删除整套及所属部件");
  const root = await libraryRoot(rootValue);
  if (!asset?.id || asset.source !== "custom") throw new Error("仅允许删除已入库的自定义资产");
  const folder = await safePath(root, asset.path);
  const flat = isFlatCustomAssetType(asset.assetType) || isAnimationModelMetaPath(asset.metaPath)
    || isSidecarAssetMetaFileName(path.basename(asset.metaPath || ""));
  const paths = new Set();
  if (!flat) {
    const metaPath = await safePath(root, asset.metaPath);
    if (key(path.dirname(metaPath)) !== key(folder) || !/^asset_info\.(?:json|jason)$/i.test(path.basename(metaPath))) {
      throw new Error("资产目录与元数据边界不一致，拒绝整包删除");
    }
    const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
    if (String(meta.assetID || meta.id || "") !== asset.id) throw new Error("资产 ID 已变化，请刷新后重试");
    paths.add(folder);
  } else {
    // Flat animation archives share their directory. Never move Preview/ wholesale.
    for (const value of [asset.metaPath, ...(asset.modelFiles || []), ...(asset.textureFiles || [])]) {
      const file = await safePath(root, value);
      if (!(await fs.lstat(file)).isFile()) throw new Error("平铺资产只允许按文件删除：" + file);
      paths.add(file);
    }
    for (const model of asset.modelFiles || []) {
      const sidecar = getAnimationIdentitySidecarPath(model);
      if (await stat(sidecar)) paths.add(await safePath(root, sidecar));
    }
    // Machine-local previews and unowned sibling files are intentionally retained.
    for (const value of [asset.previewImage, asset.preview, asset.detailImage]) {
      if (!value || !path.isAbsolute(value)) continue;
      let file;
      try { file = childPath(root, value); } catch { continue; }
      if (await stat(file)) {
        await safePath(root, file);
        if (!(await fs.lstat(file)).isFile()) throw new Error("预览引用不是单个文件");
        paths.add(file);
      }
    }
  }
  if (!paths.size) throw new Error("没有可删除的库内文件");
  const owns = file => [...paths].some(target => key(file) === key(target) || (!flat && key(file).startsWith(key(target + path.sep))));
  const dependents = records.filter(other => other.id !== asset.id && (
    (!flat && other.path && owns(path.resolve(other.path))) || referencedPaths(other).some(owns)
    || (other.meta?.dependencies || []).some(item => (typeof item === "string" ? item : item.assetId) === asset.id)
  ));
  if (dependents.length) throw new Error("仍被其他资产引用，未删除：" + dependents.map(item => `${item.name || item.id} (${item.id})`).join("、"));
  const entries = [];
  for (const file of paths) entries.push({ relativePath: path.relative(root, file), ...(await inventory(root, file, false, Math.max(1, Math.min(4, inventoryConcurrency)))) });
  const plan = { assetId: asset.id, name: asset.name || asset.id, path: folder, flat, entries,
    fileCount: entries.reduce((sum, item) => sum + item.count, 0), bytes: entries.reduce((sum, item) => sum + item.bytes, 0) };
  return { ...plan, token: hash(plan) };
}

async function withRecycleLock(root, work) {
  const directory = path.join(root, BIN);
  await safePath(root, directory, { allowPrivate: true, missing: true });
  await fs.mkdir(directory, { recursive: true });
  await safePath(root, directory, { allowPrivate: true });
  const lockPath = path.join(directory, "operation.lock");
  let handle;
  try { handle = await fs.open(lockPath, "wx"); }
  catch (error) {
    if (error.code === "EEXIST") {
      await safePath(root, lockPath, { allowPrivate: true });
      const owner = JSON.parse(await fs.readFile(lockPath, "utf8"));
      let dead = false;
      if (owner.host === os.hostname() && Number.isInteger(owner.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); } catch (failure) { dead = failure.code === "ESRCH"; }
      }
      if (!dead) throw new Error("库内已有删除/恢复操作锁；远端或仍存活的进程锁不会被抢占，请联系操作人核对");
      // Only reclaim a proven-dead process on this machine. Keep the old lock as an audit record.
      await fs.rename(lockPath, path.join(directory, `stale-lock-${randomUUID()}.json`));
      handle = await fs.open(lockPath, "wx");
    } else {
    throw error;
    }
  }
  try {
    await handle.writeFile(JSON.stringify({ host: os.hostname(), pid: process.pid, startedAt: new Date().toISOString() }));
    await handle.sync();
    return await work(directory);
  } finally { await handle.close(); await fs.unlink(lockPath); }
}

async function writeJournal(directory, journal) {
  await writeFileAtomic(path.join(directory, "record.json"), JSON.stringify(journal, null, 2));
}

async function moveChecked(root, source, destination, rename = fs.rename) {
  await safePath(root, source, { allowPrivate: true });
  await safePath(root, destination, { allowPrivate: true, missing: true });
  if (await stat(destination)) throw new Error("目标已存在，拒绝覆盖：" + destination);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await safePath(root, path.dirname(destination), { allowPrivate: true });
  // Same-library rename only. No copy-and-delete fallback on EXDEV or SMB failure.
  await rename(source, destination);
}

function entryPaths(root, directory, entry, index) {
  if (!entry.relativePath || path.isAbsolute(entry.relativePath)) throw new Error("恢复日志路径无效");
  return { original: childPath(root, path.resolve(root, entry.relativePath)), stored: path.join(directory, "files", String(index)) };
}

async function restoreFiles(root, directory, journal, rename = fs.rename) {
  const moves = [];
  // Validate the entire restore before moving anything, including unfinished deletions.
  for (const [index, entry] of journal.entries.entries()) {
    const { original, stored } = entryPaths(root, directory, entry, index);
    await safePath(root, original, { missing: true });
    await safePath(root, stored, { allowPrivate: true, missing: true });
    const [source, destination] = await Promise.all([stat(stored), stat(original)]);
    if (source && destination) throw new Error("原位置已有文件，恢复不会覆盖：" + original);
    if (!source && !destination) throw new Error("恢复源文件缺失：" + stored);
    const inspected = await inventory(root, source ? stored : original, Boolean(source));
    if (inspected.fingerprint !== entry.fingerprint) throw new Error("文件在删除或恢复后发生变化，停止恢复：" + (source ? stored : original));
    if (source) moves.push({ original, stored });
  }
  for (const item of moves) await moveChecked(root, item.stored, item.original, rename);
}

async function recycleAsset({ root: value, asset, records, token, rename, onIndexChange }) {
  const root = await libraryRoot(value);
  return withRecycleLock(root, async bin => {
    const plan = await prepareAssetDeletion({ root, asset, records });
    if (!token || token !== plan.token) throw new Error("删除范围已变化或未确认，请重新预检后确认");
    const transactionId = randomUUID();
    const directory = path.join(bin, transactionId);
    await fs.mkdir(path.join(directory, "files"), { recursive: true });
    const journal = { schemaVersion: 1, transactionId, state: "moving", deletedAt: new Date().toISOString(),
      actor: { host: os.hostname(), user: os.userInfo().username }, ...plan, asset };
    await writeJournal(directory, journal);
    try {
      for (const [i, entry] of journal.entries.entries()) {
        const { original, stored } = entryPaths(root, directory, entry, i);
        if ((await inventory(root, original)).fingerprint !== entry.fingerprint) throw new Error("文件已变化，取消删除：" + original);
        await moveChecked(root, original, stored, rename);
      }
      journal.state = "deleted";
      await writeJournal(directory, journal);
    } catch (error) {
      journal.error = String(error.message || error);
      try { await restoreFiles(root, directory, journal, rename); journal.state = "rolled_back"; }
      catch (rollbackError) { journal.state = "recovery_required"; journal.error += "；" + rollbackError.message; }
      await writeJournal(directory, journal).catch(() => {});
      throw new Error(`${journal.state === "rolled_back" ? "删除失败，文件已回滚" : "删除中断，请从已删除资产恢复，文件未被清空"}：${journal.error}\n日志：${directory}`);
    }
    let indexPending = false;
    try { await onIndexChange?.("delete", asset); }
    catch (error) { indexPending = true; journal.indexError = String(error.message || error); await writeJournal(directory, journal).catch(() => {}); }
    return { ok: true, assetId: asset.id, transactionId, recoveryPath: directory, indexPending,
      message: indexPending ? "文件已移入可恢复区，但索引同步失败；请刷新库，不要重复删除" : "资产已移入可恢复区，可在设置 → 已删除资产中恢复" };
  });
}

async function readJournal(root, transactionId) {
  if (!/^[a-f0-9-]{36}$/i.test(transactionId)) throw new Error("恢复记录 ID 无效");
  const directory = path.join(root, BIN, transactionId);
  await safePath(root, path.join(directory, "record.json"), { allowPrivate: true });
  const journal = JSON.parse(await fs.readFile(path.join(directory, "record.json"), "utf8"));
  if (journal.schemaVersion !== 1 || journal.transactionId !== transactionId || !Array.isArray(journal.entries) || !journal.entries.length || journal.asset?.id !== journal.assetId) {
    throw new Error("恢复日志无效，停止操作");
  }
  journal.entries.forEach((entry, i) => entryPaths(root, directory, entry, i));
  return { directory, journal };
}

async function listRecycledAssets(value, { concurrency = 1 } = {}) {
  const root = await libraryRoot(value);
  const bin = path.join(root, BIN);
  await safePath(root, bin, { allowPrivate: true, missing: true });
  const names = await fs.readdir(bin).catch(error => { if (error.code === "ENOENT") return []; throw error; });
  const entries = [];
  const records = names.filter(name => /^[a-f0-9-]{36}$/i.test(name));
  const width = Math.max(1, Math.min(8, Math.floor(Number(concurrency) || 1)));
  const read = async name => {
    const { journal, directory } = await readJournal(root, name);
    if (["restored", "rolled_back"].includes(journal.state)) return;
    return { transactionId: name, assetId: journal.assetId, name: journal.name, deletedAt: journal.deletedAt,
      state: journal.state, originalPath: path.join(root, journal.entries[0].relativePath), recoveryPath: directory,
      fileCount: journal.fileCount, bytes: journal.bytes, error: journal.error || journal.indexError || "" };
  };
  for (let offset = 0; offset < records.length; offset += width) {
    const batch = await Promise.allSettled(records.slice(offset, offset + width).map(read));
    for (const result of batch) {
      if (result.status === 'rejected') throw result.reason;
      if (result.value) entries.push(result.value);
    }
  }
  return entries.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

async function restoreRecycledAsset({ root: value, transactionId, records = [], onIndexChange, rename }) {
  const root = await libraryRoot(value);
  return withRecycleLock(root, async () => {
    const { directory, journal } = await readJournal(root, transactionId);
    if (["restored", "rolled_back"].includes(journal.state)) throw new Error("此记录已经恢复");
    const existing = records.find(record => record.id === journal.assetId);
    if (existing && key(path.resolve(existing.path)) !== key(path.resolve(journal.asset.path))) throw new Error("资产 ID 被其他记录占用，不能恢复");
    journal.state = "restoring";
    await writeJournal(directory, journal);
    try { await restoreFiles(root, directory, journal, rename); }
    catch (error) {
      journal.state = "recovery_required"; journal.error = error.message;
      await writeJournal(directory, journal);
      throw error;
    }
    journal.state = "restored";
    journal.restoredAt = new Date().toISOString();
    await writeJournal(directory, journal);
    let indexPending = false;
    try { await onIndexChange?.("restore", journal.asset); }
    catch { indexPending = true; }
    return { ok: true, assetId: journal.assetId, asset: journal.asset, indexPending,
      message: indexPending ? "文件已恢复，但索引同步失败；请刷新库" : "资产已恢复到原位置" };
  });
}

module.exports = { prepareAssetDeletion, recycleAsset, listRecycledAssets, restoreRecycledAsset, childPath, referencedPaths, libraryRoot, safePath, withRecycleLock };
