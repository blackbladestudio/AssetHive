const fs = require('node:fs/promises');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { removeMegascansNameTags } = require('../electron/services/megascansTags');
const { writeAssetMetadata, serializeAssetMetadata } = require('../electron/services/assetMetadata');
const { lock } = require('./megascans-runner.cjs');
const { readJson } = require('./lib/megascans-json.cjs');
const { inside, atomicJson, hashFile, metadataReferences, verifyReceipt } = require('./lib/megascans-transfer.cjs');

async function repair(library, receiptFile, backupRoot) {
  const receipt = await readJson(receiptFile);
  if (!receipt.imported?.metadataReferences) return null;
  const root = path.resolve(library, receipt.imported.root), archive = path.resolve(library, receipt.archive.root);
  if (!inside(library, root) || !inside(library, archive)) throw new Error('标签修复路径越界');
  const source = await readJson(path.join(archive, `${receipt.id}.json`));
  if (!source.fab?.listingId) return null;
  const metaPath = path.join(root, 'asset_info.json'), beforeHash = await hashFile(metaPath), meta = await readJson(metaPath);
  if (meta.identity?.sourceAssetId !== receipt.id) throw new Error('标签修复源 ID 不匹配');
  const clean = tags => removeMegascansNameTags(tags, source, [meta.name]);
  const tags = clean(meta.tags), contains = clean(meta.semanticTags?.contains);
  const removed = [...new Set([...(meta.tags || []), ...(meta.semanticTags?.contains || [])].filter(tag => !clean([tag]).length))];
  if (!removed.length) return null;
  await verifyReceipt(library, receipt, receipt.id, { content: false });
  const next = { ...meta, tags, semanticTags: { ...meta.semanticTags, contains }, updatedAt: new Date().toISOString() };
  const serialized = serializeAssetMetadata(next);
  const references = metadataReferences(root, serialized.meta, receipt.id, receipt.imported.files);
  if (JSON.stringify(references) !== JSON.stringify(receipt.imported.metadataReferences)) throw new Error('标签修复意外改变了资源引用');
  const recordPath = path.join(library, '.megascans/imports', path.basename(receiptFile)), record = await readJson(recordPath);
  const backup = path.join(backupRoot, path.basename(receiptFile));
  await atomicJson(backup, { id: receipt.id, root, beforeHash, removed, meta, receipt, record });
  if (await hashFile(metaPath) !== beforeHash) throw new Error('标签修复期间元数据被修改，已保留备份并停止');
  await writeAssetMetadata(root, next);
  const replacement = { file: 'asset_info.json', bytes: (await fs.stat(metaPath)).size, sha256: await hashFile(metaPath) };
  const updatedFiles = files => files.map(file => file.file === 'asset_info.json' ? replacement : file);
  await atomicJson(recordPath, { ...record, files: updatedFiles(record.files) });
  const updatedReceipt = { ...receipt, imported: { ...receipt.imported, files: updatedFiles(receipt.imported.files) } };
  await atomicJson(receiptFile, updatedReceipt);
  await verifyReceipt(library, updatedReceipt, receipt.id, { content: false });
  return { id: receipt.id, name: meta.name, removed };
}

async function main() {
  const { values } = parseArgs({ options: {
    library: { type: 'string', default: '\\\\fileshare\\share\\Artist\\AssetLibrary' },
    cache: { type: 'string', default: path.resolve(__dirname, '../.cache/fab-megascans') }
  } });
  const library = path.resolve(values.library), cacheRoot = path.resolve(values.cache);
  const releaseLocal = await lock(path.join(cacheRoot, 'runner.lock'));
  let releaseShare;
  const results = [], backupRoot = path.join(library, '.megascans/tag-repairs', `fab-${Date.now()}`);
  try {
    releaseShare = await lock(path.join(library, '.megascans/runner.lock'));
    const receipts = path.join(library, '.megascans/receipts');
    for (const file of await fs.readdir(receipts)) {
      if (!file.endsWith('.json')) continue;
      const result = await repair(library, path.join(receipts, file), backupRoot);
      if (result) { results.push(result); if (results.length % 25 === 0) console.log(`已清理 ${results.length} 项名称标签`); }
      await atomicJson(path.join(cacheRoot, 'name-tag-repair.json'), { backupRoot, completed: results.length, results });
    }
    console.log(JSON.stringify({ completed: results.length, removedTags: results.reduce((sum, item) => sum + item.removed.length, 0), backupRoot }));
  } finally { try { if (releaseShare) await releaseShare(); } finally { await releaseLocal(); } }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { repair };
