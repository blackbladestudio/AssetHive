const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Buffer } = require('node:buffer');
const { parseArgs } = require('node:util');
const sharp = require('sharp');
const { serializeAssetMetadata } = require('../electron/services/assetMetadata');
const { computeContentIdentity } = require('../electron/services/assetIdentity');
const { normalizeMegascansTextureType } = require('../electron/services/megascansTextures');
const { analyzeAssetTextureUsage } = require('../electron/services/textureAnalysis');
const { assetId, inside, exists, atomicJson, hashFile, verifyReceipt, verifyInventory, metadataReferences, renameWithRetry } = require('./lib/megascans-transfer.cjs');
const { lock } = require('./megascans-runner.cjs');
const { receiptPath: resolveReceiptPath } = require('./lib/megascans-paths.cjs');

const normalized = value => String(value || '').replaceAll('\\', '/').toLowerCase();
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const references = value => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(references);
  return value && typeof value === 'object' ? Object.values(value).flatMap(references) : [];
};
function relative(root, reference) {
  const full = path.resolve(root, reference);
  if (!inside(root, full)) throw new Error('贴图修复引用越界');
  return path.relative(root, full).replaceAll('\\', '/');
}
async function writeText(file, text) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, text, { flag: 'wx' }); await renameWithRetry(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
}
async function backupFile(source, destination, expected) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  if (await exists(destination)) {
    if (await hashFile(destination) !== expected) throw new Error('已有修复备份与原始内容不同');
    return;
  }
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.copyFile(source, temporary);
    if (await hashFile(temporary) !== expected) throw new Error('修复备份读回校验失败');
    await renameWithRetry(temporary, destination);
  } finally { await fs.rm(temporary, { force: true }); }
}

// Only declared map components are eligible. No filename / ancestor inference.
function replacementSource(original, receipt, slot) {
  const files = new Map(receipt.archive.files.map(file => [normalized(file.file), file]));
  let candidates = (original.maps || original.components || [])
    .filter(component => normalizeMegascansTextureType(component.type, '3d', { opacityAsMasked: true }) === slot)
    .flatMap(component => references(component).map(ref => files.get(normalized(ref))).filter(Boolean))
    .filter(file => /\.(png|jpe?g)$/i.test(file.file));
  candidates = [...new Map(candidates.map(file => [file.file, file])).values()];
  const withoutLod = candidates.filter(file => !/(?:^|[_ .-])lod\d+(?:$|[_ .-])/i.test(file.file));
  if (withoutLod.length) candidates = withoutLod;
  const png = candidates.filter(file => /\.png$/i.test(file.file));
  if (png.length) candidates = png;
  if (candidates.length > 1) throw new Error(`真实 ${slot} 贴图存在多个候选，停止以避免猜测`);
  return candidates[0] || null;
}

async function prepareRepair(library, issue) {
  const id = assetId(issue.id), control = path.join(library, '.megascans');
  const receiptPath = await resolveReceiptPath(library, id), importPath = path.join(control, 'imports', path.basename(receiptPath));
  const [receipt, record] = await Promise.all([readJson(receiptPath), readJson(importPath)]);
  if (!receipt.imported || !Array.isArray(issue.files) || !issue.files.length) throw new Error('修复清单或入库回执无效');
  const root = path.resolve(library, receipt.imported.root), archive = path.resolve(library, receipt.archive.root);
  if (!inside(path.join(library, 'Environment'), root) || !inside(path.join(control, 'originals'), archive)
    || normalized(await fs.realpath(root)) !== normalized(root) || normalized(await fs.realpath(archive)) !== normalized(archive)
    || normalized(record.finalRoot) !== normalized(root) || record.id !== id) throw new Error('修复目标或原始资源真实路径不匹配');
  await verifyReceipt(library, receipt, id);
  const metaPath = path.join(root, 'asset_info.json'), metaText = await fs.readFile(metaPath, 'utf8');
  const meta = JSON.parse(metaText), next = globalThis.structuredClone(meta);
  if (meta.assetType !== '3d' || (meta.modelLods || []).length) throw new Error('此修复仅处理本次审计的单层Highpoly 3D资产');
  const original = await readJson(path.join(archive, `${id}.json`));
  const previewNames = new Set(references([original.previews, original.previewImage, original.detailImage]).map(normalized));
  const changes = [];
  for (const problem of issue.files) {
    const oldFile = receipt.imported.files.find(file => normalized(file.file) === normalized(problem.file));
    const preview = receipt.archive.files.find(file => previewNames.has(normalized(file.file)) && file.sha256 === oldFile?.sha256);
    if (!oldFile || !preview) throw new Error('待修复文件不再与源预览完全一致，停止');
    const matches = next.textureEntries.filter(entry => normalized(relative(root, entry.uri)) === normalized(oldFile.file));
    if (matches.length !== 1 || matches[0].textureType !== issue.inferredFromAssetDirectory || Number(matches[0].areaIndex || 1) !== 1
      || matches[0].materialRole !== 'atlas') throw new Error('待修复槽位已变化或不属于本次审计范围');
    const entry = matches[0], source = replacementSource(original, receipt, entry.textureType);
    let replacement = null;
    if (source) {
      const file = oldFile.file.slice(0, -path.extname(oldFile.file).length) + path.extname(source.file).toLowerCase();
      if (normalized(file) === normalized(oldFile.file)) throw new Error('真实贴图与旧预览同名，停止以保留原文件');
      const sourcePath = path.resolve(archive, source.file);
      if (!inside(archive, sourcePath)) throw new Error('真实贴图路径越界');
      const image = await sharp(sourcePath).metadata();
      if (!image.width || !image.height || Math.max(image.width, image.height) > 4096) throw new Error('真实贴图超过4K或无法读取');
      const size = Math.max(image.width, image.height);
      const resolution = size >= 1024 ? `${Math.round(size / 1024)}K` : `${size}px`;
      const stat = await fs.stat(sourcePath);
      replacement = { file, source: source.file, bytes: source.bytes, sha256: source.sha256,
        dimensions: { width: image.width, height: image.height, resolution, sourceWidth: image.width, sourceHeight: image.height, sourceResolution: resolution,
          compressed: false, fileSize: source.bytes, fileModifiedAt: stat.mtimeMs } };
    }
    const isOld = ref => normalized(relative(root, ref)) === normalized(oldFile.file);
    const changedRef = ref => path.isAbsolute(ref) ? path.join(root, replacement.file).replaceAll('\\', '/') : replacement.file;
    next.textureFiles = next.textureFiles.flatMap(ref => isOld(ref) ? replacement ? [changedRef(ref)] : [] : [ref]);
    next.textureSlots = Object.fromEntries(Object.entries(next.textureSlots).flatMap(([slot, ref]) => isOld(ref) ? replacement ? [[slot, changedRef(ref)]] : [] : [[slot, ref]]));
    next.textureEntries = next.textureEntries.flatMap(item => isOld(item.uri) ? replacement ? [{ ...item, uri: replacement.file, ...replacement.dimensions }] : [] : [item]);
    next.components = next.components.flatMap(item => item.type === 'texture' && isOld(item.uri)
      ? replacement ? [{ ...item, uri: replacement.file, ...replacement.dimensions }] : [] : [item]);
    changes.push({ slot: entry.textureType, oldFile, sourcePreview: preview.file, replacement });
  }
  const now = new Date().toISOString();
  // Compute on declared archive sources for replacements, without publishing
  // them or rewriting models just to prepare the transaction.
  const modelSlots = Object.fromEntries(Object.entries(next.modelSlots).map(([slot, file]) => [slot, path.resolve(root, file)]));
  const identity = await computeContentIdentity({ modelSlots,
    textureSlots: next.textureEntries.map(entry => ({ suffix: entry.textureType, areaIndex: entry.areaIndex || 1, materialRole: entry.materialRole,
      source: changes.find(change => change.replacement?.file === entry.uri) ? path.join(archive, changes.find(change => change.replacement?.file === entry.uri).replacement.source) : path.resolve(root, entry.uri) })) });
  if (JSON.stringify(identity.modelFingerprints) !== JSON.stringify(meta.identity.modelFingerprints)) throw new Error('模型指纹发生变化，停止');
  next.identity = { ...next.identity, ...identity };
  next.updatedAt = now;
  next.revision = (Number(next.revision) || 1) + 1;
  next.importHistory = [...(next.importHistory || []), { at: now, action: 'repair-preview-texture-slots', previousFingerprint: meta.identity.contentFingerprint, nextFingerprint: identity.contentFingerprint }];
  const serialized = serializeAssetMetadata(next);
  const removed = new Set(changes.map(change => normalized(change.oldFile.file)));
  const files = receipt.imported.files.filter(file => file.file !== 'asset_info.json' && !removed.has(normalized(file.file)));
  for (const change of changes) if (change.replacement) {
    const { file, bytes, sha256 } = change.replacement;
    if (files.some(item => normalized(item.file) === normalized(file))) throw new Error('真实贴图修复目标已有文件记录');
    files.push({ file, bytes, sha256 });
  }
  files.push({ file: 'asset_info.json', bytes: Buffer.byteLength(serialized.text), sha256: digest(serialized.text) });
  const refs = metadataReferences(root, serialized.meta, id, files);
  return { version: 1, id, root, archive, repairedAt: now, changes, oldMetadataHash: digest(metaText), metadata: serialized.meta,
    oldReceiptHash: await hashFile(receiptPath), oldRecordHash: await hashFile(importPath),
    receipt: { ...receipt, imported: { ...receipt.imported, files, metadataReferences: refs } }, record: { ...record, files, metadataReferences: refs } };
}

async function repairTextureSlots(library, issue, { afterStep = async () => {} } = {}) {
  const id = assetId(issue.id), control = path.join(library, '.megascans');
  const receiptPath = await resolveReceiptPath(library, id), key = path.basename(receiptPath, '.json');
  const journalPath = path.join(control, 'texture-slot-repairs', `${key}.json`), backup = path.join(control, 'texture-slot-repairs', 'backups', key);
  const importPath = path.join(control, 'imports', `${key}.json`);
  let journal = await exists(journalPath) ? await readJson(journalPath) : null;
  if (journal?.completedAt) { await verifyReceipt(library, await readJson(receiptPath), id); return journal; }
  const fresh = !journal;
  if (!journal) {
    journal = await prepareRepair(library, issue);
    await backupFile(path.join(journal.root, 'asset_info.json'), path.join(backup, 'asset_info.json'), journal.oldMetadataHash);
    await backupFile(receiptPath, path.join(backup, 'receipt.json'), journal.oldReceiptHash);
    await backupFile(importPath, path.join(backup, 'import.json'), journal.oldRecordHash);
    for (const change of journal.changes) await backupFile(path.join(journal.root, change.oldFile.file), path.join(backup, 'removed', change.oldFile.file), change.oldFile.sha256);
    await atomicJson(journalPath, journal);
  }
  const { root, archive } = journal;
  if (journal.id !== id || !inside(path.join(library, 'Environment'), root) || !inside(path.join(control, 'originals'), archive)
    || normalized(await fs.realpath(root)) !== normalized(root) || normalized(await fs.realpath(archive)) !== normalized(archive)) throw new Error('修复日志路径无效');
  const metaPath = path.join(root, 'asset_info.json');
  if (!fresh) await verifyInventory(root, journal.receipt.imported.files.filter(file => file.file !== 'asset_info.json' && !journal.changes.some(change => change.replacement?.file === file.file)));
  const serialized = serializeAssetMetadata(journal.metadata);
  const currentHash = await hashFile(metaPath);
  if (![journal.oldMetadataHash, digest(serialized.text)].includes(currentHash)) throw new Error('修复期间元数据被编辑，停止以保留用户修改');
  for (const [file, oldHash, next] of [[receiptPath, journal.oldReceiptHash, journal.receipt], [importPath, journal.oldRecordHash, journal.record]]) {
    const hash = await hashFile(file);
    if (hash !== oldHash && JSON.stringify(await readJson(file)) !== JSON.stringify(next)) throw new Error('修复期间回执被修改，停止');
  }
  for (const change of journal.changes) if (change.replacement) {
    const replacement = change.replacement, source = path.resolve(archive, replacement.source), target = path.resolve(root, replacement.file);
    if (!inside(archive, source) || !inside(root, target)) throw new Error('修复文件路径越界');
    await backupFile(source, target, replacement.sha256);
  }
  // Refresh derived analysis only after replacement files exist. Persist the
  // final exact metadata in the journal before changing the live metadata.
  if (!journal.analysisRefreshed) {
    const previous = journal.metadata.textureAnalysis || {};
    journal.metadata.textureAnalysis = await analyzeAssetTextureUsage({ dimensions: previous.dimensions, dimensionsSource: previous.dimensionsSource,
      textureFiles: journal.metadata.textureFiles.map(file => path.resolve(root, file)) }, { force: true });
    const text = serializeAssetMetadata(journal.metadata).text;
    const metadataFile = journal.receipt.imported.files.find(file => file.file === 'asset_info.json');
    Object.assign(metadataFile, { bytes: Buffer.byteLength(text), sha256: digest(text) });
    journal.record.files = journal.receipt.imported.files;
    journal.analysisRefreshed = true;
    await atomicJson(journalPath, journal);
  }
  const finalText = serializeAssetMetadata(journal.metadata).text;
  if (![journal.oldMetadataHash, digest(finalText)].includes(await hashFile(metaPath))) throw new Error('修复期间元数据被编辑，停止以保留用户修改');
  await writeText(metaPath, finalText);
  await afterStep('metadata');
  for (const change of journal.changes) {
    const file = path.resolve(root, change.oldFile.file), saved = path.resolve(backup, 'removed', change.oldFile.file);
    if (!inside(root, file) || !inside(backup, saved) || await hashFile(saved) !== change.oldFile.sha256) throw new Error('错误贴图备份无效');
    if (await exists(file)) {
      if (await hashFile(file) !== change.oldFile.sha256) throw new Error('错误贴图在修复期间被修改');
      await fs.unlink(file);
    }
  }
  await atomicJson(importPath, journal.record);
  await afterStep('import-record');
  await atomicJson(receiptPath, journal.receipt);
  await verifyReceipt(library, journal.receipt, id);
  journal.completedAt = new Date().toISOString();
  await atomicJson(journalPath, journal);
  return journal;
}

async function main() {
  const { values } = parseArgs({ options: { apply: { type: 'boolean' }, id: { type: 'string' },
    library: { type: 'string', default: '\\\\fileshare\\share\\Artist\\AssetLibrary' },
    cache: { type: 'string', default: path.resolve(__dirname, '../.cache/megascans-download') } } });
  const library = path.resolve(values.library), cache = path.resolve(values.cache);
  const audit = await readJson(path.join(cache, 'preview-texture-audit-summary.json'));
  const issues = audit.affected.filter(issue => !values.id || issue.id === values.id);
  if (!issues.length) throw new Error('没有匹配的审计项');
  const releaseLocal = await lock(path.join(cache, 'runner.lock'));
  let releaseShare;
  const results = [];
  try {
    releaseShare = await lock(path.join(library, '.megascans', 'runner.lock'));
    for (const issue of issues) {
      const result = values.apply ? await repairTextureSlots(library, issue) : await prepareRepair(library, issue);
      const row = { id: issue.id, verified: !!result.completedAt, changes: result.changes.map(change => ({ slot: change.slot, removed: change.oldFile.file, restoredFrom: change.replacement?.source || null })) };
      results.push(row); console.log(JSON.stringify(row));
    }
    if (values.apply) await atomicJson(path.join(cache, 'texture-slot-repair-report.json'), { completedAt: new Date().toISOString(), results, backupRoot: path.join(library, '.megascans/texture-slot-repairs/backups') });
  } finally { try { if (releaseShare) await releaseShare(); } finally { await releaseLocal(); } }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { repairTextureSlots, prepareRepair, replacementSource };
