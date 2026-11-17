const fs = require('node:fs/promises');
const path = require('node:path');
const { assetId, inside, exists, inventory, hashFile, atomicJson, verifyReceipt, verifyImportedFiles, archiveRetentionFiles, DOWNLOAD_POLICY } = require('./megascans-transfer.cjs');
const { paused } = require('./megascans-recovery.cjs');
const { receiptPath: resolveReceiptPath } = require('./megascans-paths.cjs');
const { readJson: read } = require('./megascans-json.cjs');

const normalized = value => String(value).replaceAll('\\', '/').toLowerCase();
const refs = value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(refs) : value && typeof value === 'object' ? Object.values(value).flatMap(refs) : [];
async function canonical(root) {
  if (normalized(await fs.realpath(root)) !== normalized(path.resolve(root))) throw new Error('归档清理拒绝重定向路径');
}
async function checkedFile(root, name) {
  const file = path.resolve(root, name);
  if (!inside(root, file) || file === path.resolve(root) || path.isAbsolute(name)) throw new Error('归档清理路径越界');
  await canonical(path.dirname(file));
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('归档清理目标不是普通文件');
  return file;
}

async function pruneArchive({ library, id, shouldStop = async () => false, afterDelete = async () => {} }) {
  assetId(id);
  const receiptPath = await resolveReceiptPath(library, id);
  const storageKey = path.basename(receiptPath, '.json');
  let receipt = await read(receiptPath);
  if (receipt.mode !== 'import' || !receipt.imported?.metadataReferences || JSON.stringify(receipt.policy) !== JSON.stringify(DOWNLOAD_POLICY)) throw new Error('仅已完成且带资源引用回执的入库资产可清理');
  const archive = path.resolve(library, receipt.archive.root), imported = path.resolve(library, receipt.imported.root);
  if (normalized(archive) !== normalized(path.join(library, '.megascans/originals', `v${DOWNLOAD_POLICY.version}`, storageKey))
    || !inside(path.join(library, 'Environment'), imported)) throw new Error('归档清理目标不属于本任务资产目录');
  await canonical(archive); await canonical(imported);
  if (await shouldStop()) throw paused();
  await verifyReceipt(library, receipt, id, { content: false });
  if (receipt.archive.retention?.status === 'pruned') return { id, removedBytes: 0, completed: true };
  await verifyImportedFiles(imported, id, receipt.imported.files, receipt.imported.metadataReferences, { onFile: async () => { if (await shouldStop()) throw paused(); } });
  const source = await read(path.join(archive, `${id}.json`));
  const previewNames = new Set(refs([source.previews, source.previewImage, source.detailImage, source.referencePreviews]).map(normalized));
  const previewHashes = new Set(receipt.archive.files.filter(file => previewNames.has(normalized(file.file))).map(file => file.sha256));
  const mapNames = new Set(refs([source.maps, source.components, source.meshes, source.models]).map(normalized));
  const eligible = receipt.archive.files.filter(file => mapNames.has(normalized(file.file)) && !previewNames.has(normalized(file.file))
    && !previewHashes.has(file.sha256) && /\.(fbx|png|jpe?g|webp)$/i.test(file.file));
  if (!receipt.archive.retention) {
    if (!eligible.length) return { id, removedBytes: 0, completed: false };
    const backup = path.join(library, '.megascans/archive-retention/receipts', `${storageKey}.json`);
    if (await exists(backup)) {
      if (JSON.stringify(await read(backup)) !== JSON.stringify(receipt)) throw new Error('发现未匹配的原始归档清理备份，请检查后重试');
    } else await atomicJson(backup, receipt);
    const current = await read(receiptPath);
    if (JSON.stringify(current) !== JSON.stringify(receipt)) throw new Error('清理期间完成回执已变化');
    receipt = { ...receipt, archive: { ...receipt.archive, retention: { version: 1, reason: 'capacity', status: 'pruning',
      startedAt: new Date().toISOString(), removedFiles: eligible.map(file => file.file) } } };
    await atomicJson(receiptPath, receipt); // Intent must be durable before unlink.
  }
  const removed = archiveRetentionFiles(receipt);
  const eligibleNames = new Set(eligible.map(file => file.file));
  if ([...removed].some(name => !eligibleNames.has(name))) throw new Error('清理日志包含源元数据之外的资源');
  let removedBytes = 0;
  for (const item of receipt.archive.files.filter(file => removed.has(file.file))) {
    if (await shouldStop()) throw paused();
    const target = path.resolve(archive, item.file);
    if (!await exists(target)) continue;
    const file = await checkedFile(archive, item.file);
    if (await hashFile(file) !== item.sha256) throw new Error(`原始资源在清理前被修改：${id}/${item.file}`);
    await fs.unlink(file);
    removedBytes += item.bytes;
    await afterDelete(item);
  }
  await verifyReceipt(library, receipt, id, { content: false });
  const current = await read(receiptPath);
  if (JSON.stringify(current) !== JSON.stringify(receipt)) throw new Error('清理期间完成回执已变化');
  receipt.archive.retention = { ...receipt.archive.retention, status: 'pruned', completedAt: new Date().toISOString() };
  await atomicJson(receiptPath, receipt);
  return { id, removedBytes, completed: true };
}

// Called only by the publisher while holding both existing runner locks.
// Scan actual bytes once per run, then reserve before every archive copy.
async function createArchiveBudget({ library, maxBytes, shouldStop = async () => false, onProgress = async () => {} }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('原始归档上限必须为正数');
  const root = path.join(library, '.megascans/originals');
  await fs.mkdir(root, { recursive: true }); await canonical(root);
  let usedBytes = (await inventory(root, { content: false })).reduce((sum, file) => sum + file.bytes, 0);
  const receipts = path.join(library, '.megascans/receipts');
  const candidates = [];
  for (const file of await fs.readdir(receipts).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
    if (!file.endsWith('.json')) continue;
    const receipt = await read(path.join(receipts, file));
    if (receipt.mode === 'import' && receipt.imported?.metadataReferences && receipt.archive?.retention?.status !== 'pruned') candidates.push(receipt);
  }
  candidates.sort((a, b) => String(a.completedAt).localeCompare(String(b.completedAt)) || a.id.localeCompare(b.id));
  let prunedAssets = 0, reclaimedBytes = 0;
  const report = async () => onProgress({ archiveBytes: usedBytes, maxArchiveBytes: maxBytes, prunedAssets, reclaimedBytes });
  await report();
  const prune = async receipt => {
    const result = await pruneArchive({ library, id: receipt.id, shouldStop });
    usedBytes -= result.removedBytes; reclaimedBytes += result.removedBytes;
    if (result.completed) prunedAssets++;
    await report();
  };
  // Resume all durable deletion intents even if an interruption already brought
  // usage below the limit; missing files remain explicitly accounted for.
  for (const receipt of candidates.filter(item => item.archive.retention?.status === 'pruning')) await prune(receipt);
  const pending = candidates.filter(item => !item.archive.retention);
  let cursor = 0;
  const trim = async (incoming = 0) => {
    if (incoming > maxBytes) throw new Error('当前资产原始文件超过共享归档容量上限');
    while (usedBytes + incoming > maxBytes && cursor < pending.length) {
      if (await shouldStop()) throw paused();
      await prune(pending[cursor++]);
    }
    if (usedBytes + incoming > maxBytes) throw new Error('原始归档容量不足；剩余内容包含受保护或未成功入库的文件，已保留并停止');
    await report();
  };
  await trim();
  const reservations = new Map();
  return { trim, snapshot: () => ({ usedBytes, maxBytes, prunedAssets, reclaimedBytes }),
    completed: receipt => {
      if (receipt?.mode === 'import' && receipt.imported?.metadataReferences && !receipt.archive.retention
        && !pending.some(item => item.id === receipt.id)) pending.push(receipt);
    },
    reserve: async ({ id, archiveRoot, files }) => {
      assetId(id);
      const expected = path.join(root, `v${DOWNLOAD_POLICY.version}`, path.basename(await resolveReceiptPath(library, id), '.json'));
      if (normalized(archiveRoot) !== normalized(expected)) throw new Error('归档预留目标不匹配');
      if (await exists(archiveRoot)) await canonical(archiveRoot);
      const existing = await exists(archiveRoot) ? await inventory(archiveRoot, { content: false }) : [];
      const existingBytes = existing.reduce((sum, file) => sum + file.bytes, 0);
      const targetBytes = existingBytes + files.filter(file => !existing.some(item => normalized(item.file) === normalized(file.file))).reduce((sum, file) => sum + file.bytes, 0);
      const incoming = Math.max(0, targetBytes - (reservations.get(id) ?? existingBytes));
      await trim(incoming);
      usedBytes += incoming; reservations.set(id, Math.max(targetBytes, existingBytes));
      await report();
    } };
}

module.exports = { pruneArchive, createArchiveBudget };
