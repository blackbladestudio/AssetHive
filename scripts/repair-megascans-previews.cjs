const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Buffer } = require('node:buffer');
const { parseArgs } = require('node:util');
const { materialPreview } = require('../electron/services/megascansPreview');
const { serializeAssetMetadata } = require('../electron/services/assetMetadata');
const { assetId, inside, exists, atomicJson, hashFile, inventory, verifyInventory, verifyReceipt, catalogAssetType, metadataReferences } = require('./lib/megascans-transfer.cjs');
const { lock } = require('./megascans-runner.cjs');
const { receiptPath: resolveReceiptPath } = require('./lib/megascans-paths.cjs');

async function repairPreview(library, id) {
  assetId(id);
  const control = path.join(library, '.megascans');
  const receiptPath = await resolveReceiptPath(library, id), key = path.basename(receiptPath, '.json');
  const importPath = path.join(control, 'imports', `${key}.json`);
  const journalPath = path.join(control, 'preview-repairs', `${key}.json`);
  let journal;
  if (await exists(journalPath)) journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
  if (!journal) {
    const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
    if (!receipt.imported) return false;
    const archive = path.resolve(library, receipt.archive.root), root = path.resolve(library, receipt.imported.root);
    if (!inside(library, archive) || !inside(library, root)) throw new Error('预览修复路径越界');
    const original = JSON.parse(await fs.readFile(path.join(archive, `${id}.json`), 'utf8'));
    const selected = materialPreview(original, catalogAssetType(original));
    if (!selected) return false;
    await verifyReceipt(library, receipt, id);
    const source = path.resolve(archive, selected.uri);
    if (!inside(archive, source)) throw new Error('材质球源文件越界');
    const metaPath = path.join(root, 'asset_info.json');
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    const relative = `Preview/megascans_material_grid${path.extname(source).toLowerCase()}`;
    const target = path.join(root, relative);
    if (await exists(target)) {
      if (await hashFile(target) !== await hashFile(source)) throw new Error('预览修复目标已有不同内容');
    } else { await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(source, target); }
    const next = { ...meta, updatedAt: new Date().toISOString(), previewImage: relative, detailImage: relative,
      previews: { ...meta.previews, preview: { uri: relative }, images: [{ uri: relative, tags: ['thumb', 'preview', 'sphere'] }], relativeSize: '1x1' } };
    const serialized = serializeAssetMetadata(next);
    const files = (await inventory(root)).map(entry => entry.file === 'asset_info.json' ? { file: entry.file,
      bytes: Buffer.byteLength(serialized.text), sha256: crypto.createHash('sha256').update(serialized.text).digest('hex') } : entry);
    const record = JSON.parse(await fs.readFile(importPath, 'utf8'));
    journal = { id, root, metadata: serialized.meta, oldMetadataHash: await hashFile(metaPath),
      newMetadataHash: files.find(file => file.file === 'asset_info.json').sha256,
      receipt: { ...receipt, imported: { ...receipt.imported, files } }, record: { ...record, files },
      sourcePreview: selected.uri, repairedAt: new Date().toISOString() };
    // Durable journal permits replay if interrupted between metadata/receipts.
    await atomicJson(journalPath, journal);
  }
  if (!journal.obsoletePreviews) {
    const keep = journal.metadata.previewImage;
    journal.obsoletePreviews = journal.receipt.imported.files.filter(file => /^Preview\//i.test(file.file)
      && /\.(png|jpe?g|webp)$/i.test(file.file) && file.file !== keep);
    const obsolete = new Set(journal.obsoletePreviews.map(file => file.file));
    journal.receipt.imported.files = journal.receipt.imported.files.filter(file => !obsolete.has(file.file));
    journal.record.files = journal.record.files.filter(file => !obsolete.has(file.file));
    await atomicJson(journalPath, journal);
  }
  journal.receipt.imported.files = journal.receipt.imported.files.filter(file => !/^(thumbs\.db|desktop\.ini|\.DS_Store)$/i.test(path.basename(file.file)));
  journal.record.files = journal.record.files.filter(file => !/^(thumbs\.db|desktop\.ini|\.DS_Store)$/i.test(path.basename(file.file)));
  const root = path.resolve(journal.root);
  if (journal.id !== id || !inside(library, root)) throw new Error('预览修复记录无效');
  const metaPath = path.join(root, 'asset_info.json');
  const hash = await hashFile(metaPath);
  if (![journal.oldMetadataHash, journal.newMetadataHash].includes(hash)) throw new Error('预览修复期间资产元数据被修改，停止');
  await verifyInventory(root, journal.receipt.imported.files.filter(file => file.file !== 'asset_info.json'));
  for (const entry of journal.obsoletePreviews) {
    const file = path.resolve(root, entry.file);
    const backup = path.resolve(control, 'preview-repairs', 'backups', id, entry.file);
    if (!inside(root, file) || !inside(path.join(control, 'preview-repairs', 'backups', id), backup)) throw new Error('旧预览备份路径越界');
    if (await exists(file)) {
      if (await hashFile(file) !== entry.sha256) throw new Error('旧预览已被修改，停止清理');
      await fs.mkdir(path.dirname(backup), { recursive: true });
      if (await exists(backup)) {
        if (await hashFile(backup) !== entry.sha256) throw new Error('旧预览备份内容不一致');
        await fs.unlink(file);
      } else {
        const { renameWithRetry } = require('./lib/megascans-transfer.cjs');
        await renameWithRetry(file, backup);
      }
    } else if (!await exists(backup) || await hashFile(backup) !== entry.sha256) throw new Error('旧预览及备份均缺失');
  }
  const serialized = serializeAssetMetadata(journal.metadata);
  // serializeAssetMetadata preserves persisted dates, but use its exact text so
  // the repaired checksum and the canonical on-disk serialization agree.
  const temp = `${metaPath}.preview-repair.tmp`;
  await fs.writeFile(temp, serialized.text);
  const { renameWithRetry } = require('./lib/megascans-transfer.cjs');
  await renameWithRetry(temp, metaPath);
  await verifyInventory(root, journal.receipt.imported.files);
  const latestReceipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  if (latestReceipt.imported?.metadataReferences) {
    journal.receipt.imported.metadataReferences = metadataReferences(root, journal.metadata, id, journal.receipt.imported.files);
  }
  await atomicJson(importPath, journal.record);
  await atomicJson(receiptPath, journal.receipt);
  await verifyReceipt(library, journal.receipt, id);
  return true;
}

async function main() {
  const { values } = parseArgs({ options: { library: { type: 'string', default: '\\\\fileshare\\share\\Artist\\AssetLibrary' },
    cache: { type: 'string', default: path.resolve(__dirname, '../.cache/megascans-download') } } });
  const library = path.resolve(values.library), cache = path.resolve(values.cache);
  const releaseLocal = await lock(path.join(cache, 'runner.lock'));
  let releaseShare;
  try {
    releaseShare = await lock(path.join(library, '.megascans', 'runner.lock'));
    for (const file of await fs.readdir(path.join(library, '.megascans', 'receipts'))) {
      if (/^[a-zA-Z0-9_-]+\.json$/.test(file) && await repairPreview(library, file.slice(0, -5))) console.log(`[材质球预览已修复] ${file.slice(0, -5)}`);
    }
  } finally { if (releaseShare) await releaseShare(); await releaseLocal(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { repairPreview };
