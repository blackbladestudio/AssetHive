const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseArgs } = require('node:util');
const { transparentPreview } = require('./lib/fab-preview.cjs');
const { lock } = require('./megascans-runner.cjs');
const { receiptPath } = require('./lib/megascans-paths.cjs');
const { writeAssetMetadata } = require('../electron/services/assetMetadata');
const { assetId, inside, atomicJson, inventory, verifyReceipt, metadataReferences, hashFile } = require('./lib/megascans-transfer.cjs');

async function repair(library, cacheRoot, id, options = {}) {
  assetId(id);
  const receiptFile = await receiptPath(library, id), receiptText = await fs.readFile(receiptFile, 'utf8'), receipt = JSON.parse(receiptText);
  await verifyReceipt(library, receipt, id);
  const root = path.resolve(library, receipt.imported.root), archive = path.resolve(library, receipt.archive.root);
  if (!inside(library, root) || !inside(library, archive)) throw new Error('预览修复路径越界');
  const metadataFile = path.join(root, 'asset_info.json'), metadataText = await fs.readFile(metadataFile, 'utf8'), meta = JSON.parse(metadataText);
  const preview = path.resolve(root, meta.previewImage || '');
  const previousPreview = receipt.imported.files.find(file => path.resolve(root, file.file) === preview);
  if (!inside(root, preview) || !previousPreview || previousPreview.sha256 !== await hashFile(preview)) throw new Error('当前预览已被修改，保留用户预览');
  const original = JSON.parse(await fs.readFile(path.join(archive, `${id}.json`), 'utf8'));
  if (!original.fab?.listingId || meta.identity?.sourceAssetId !== id) throw new Error('仅处理本次 Fab 下载资产');
  const source = path.resolve(archive, original.previews.images[0].uri);
  if (!inside(archive, source)) throw new Error('源预览路径越界');
  const importFile = path.join(library, '.megascans', 'imports', `${path.basename(receiptFile)}`);
  const recordText = await fs.readFile(importFile, 'utf8'), record = JSON.parse(recordText);
  const hashes = [metadataText, receiptText, recordText].map(text => crypto.createHash('sha256').update(text).digest('hex'));
  const local = path.join(cacheRoot, 'preview-repairs', `${id}.png`);
  const image = await transparentPreview(source, local, options);
  const backup = path.join(library, '.megascans', 'preview-repairs', 'fab-cutout', id, String(Date.now()));
  await fs.mkdir(backup, { recursive: true });
  await atomicJson(path.join(backup, 'before.json'), { meta, receipt, record });
  const relative = `Preview/${meta.assetID || meta.id}_preview_cutout_${path.basename(backup)}.png`, target = path.resolve(root, relative);
  if (!inside(root, target)) throw new Error('预览输出路径越界');
  const next = { ...meta, previewImage: relative, detailImage: relative, updatedAt: new Date().toISOString(),
    previews: { ...meta.previews, preview: { uri: relative }, images: [{ uri: relative, tags: ['preview', 'transparent'] }], relativeSize: `${image.width}x${image.height}` } };
  await atomicJson(path.join(backup, 'pending.json'), { id, target, local, next });
  for (const [index, file] of [metadataFile, receiptFile, importFile].entries()) {
    if (await hashFile(file) !== hashes[index]) throw new Error('去背景期间元数据或回执被修改，保留备份并停止');
  }
  await fs.copyFile(local, `${target}.tmp`);
  await fs.rename(`${target}.tmp`, target);
  await writeAssetMetadata(root, next);
  const saved = JSON.parse(await fs.readFile(metadataFile, 'utf8')), files = await inventory(root);
  const references = metadataReferences(root, saved, id, files);
  receipt.imported = { ...receipt.imported, files, metadataReferences: references };
  await atomicJson(importFile, { ...record, files, metadataReferences: references });
  await atomicJson(receiptFile, receipt);
  await verifyReceipt(library, receipt, id);
  await atomicJson(path.join(backup, 'completed.json'), { id, preview: relative, completedAt: new Date().toISOString() });
  console.log(JSON.stringify({ id, preview: target, ...image, transparent: true }));
  return { id, root, preview: target, backup };
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    library: { type: 'string', default: '\\\\fileshare\\share\\Artist\\AssetLibrary' },
    cache: { type: 'string', default: path.resolve(__dirname, '../.cache/fab-megascans') },
    method: { type: 'string', default: 'smart' }
  } });
  if (!positionals.length) throw new Error('请明确指定本次需要去背景的源 ID');
  const library = path.resolve(values.library), cacheRoot = path.resolve(values.cache);
  const releaseLocal = await lock(path.join(cacheRoot, 'runner.lock'));
  let releaseShare;
  try {
    releaseShare = await lock(path.join(library, '.megascans', 'runner.lock'));
    for (const id of positionals) await repair(library, cacheRoot, id, { method: values.method });
  } finally { try { if (releaseShare) await releaseShare(); } finally { await releaseLocal(); } }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { repair };
