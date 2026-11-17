const { recordLibraryChanges } = require("./libraryChanges");
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createAssetMetadata, writeAssetMetadata } = require('./assetMetadata');
const { DOWNLOAD_POLICY, assetId, inside, exists, inventory, verifyImportedFiles, metadataReferences, verifyReceipt, atomicJson, renameWithRetry } = require('../../scripts/lib/megascans-transfer.cjs');
const { encodedKey, receiptPath: resolveReceiptPath } = require('../../scripts/lib/megascans-paths.cjs');

const TYPE_FOLDERS = { '3d': '3D Assets', '3dplant': 'Foliage', surface: 'Surfaces', decal: 'Decals', atlas: 'Atlases', imperfection: 'Imperfections', displacement: 'Displacements', hdri: 'HDRI' };

function buildPayload(metadata, destinationPath) {
  if (!TYPE_FOLDERS[metadata.assetType]) throw new Error(`AssetHive 暂不支持此类型：${metadata.assetType}`);
  const modelSlots = {}, modelVariantKeys = {}, modelLodFiles = {};
  for (const [index, file] of (metadata.modelFiles || []).entries()) {
    if (path.extname(file).toLowerCase() !== '.fbx') throw new Error('自动入库只接受 FBX；原始资源已归档');
    const slot = index === 0 ? 'Mesh' : `Mesh${index + 1}`;
    const variant = (metadata.modelVariants || []).find(v => path.resolve(v.file) === path.resolve(file));
    modelSlots[slot] = file;
    modelVariantKeys[slot] = variant?.variantKey || '01';
    modelLodFiles[slot] = (metadata.modelLods || []).filter(v => String(v.variantKey || '01') === modelVariantKeys[slot])
      .map(v => ({ filePath: v.file, lod: v.lod }));
  }
  return {
    assetName: metadata.name,
    assetType: metadata.assetType,
    category: metadata.category,
    standardAssetTags: metadata.standardAssetTags,
    tags: metadata.tags,
    sourceIdentity: metadata.sourceIdentity,
    sourceSemanticTags: metadata.sourceSemanticTags,
    sourceClassification: metadata.sourceClassification,
    modelSlots, modelVariantKeys, modelLodFiles,
    textureEntries: (metadata.textureSlots || []).filter(entry => metadata.assetType === 'hdri'
      ? /\.(hdr|exr)$/i.test(entry.filePath || '') : path.extname(entry.filePath || '').toLowerCase() !== '.exr'),
    previewImagePath: metadata.previewImagePath,
    normalMapFormat: 'dx', normalMapFormats: { 1: 'dx' },
    destinationPath
    // Explicit slots above avoid a second broad source-folder scan, which can
    // otherwise mix preview/billboard images or duplicate model variants.
  };
}

function relocate(value, previous, next) {
  if (Array.isArray(value)) return value.map(v => relocate(v, previous, next));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, relocate(v, previous, next)]));
  if (typeof value === 'string') {
    const normalized = value.replaceAll('\\', '/'), prefix = previous.replaceAll('\\', '/');
    if (normalized === prefix || normalized.toLowerCase().startsWith(`${prefix.toLowerCase()}/`)) return next.replaceAll('\\', '/') + normalized.slice(prefix.length);
  }
  return value;
}

async function validateImported(root, id) {
  const meta = JSON.parse(await fs.readFile(path.join(root, 'asset_info.json'), 'utf8'));
  if (meta.identity?.sourceAssetId !== id || meta.identity?.sourceKind !== 'megascans') throw new Error('入库元数据的第三方 ID 不匹配');
  const references = [...(meta.modelFiles || []), ...(meta.textureFiles || []), ...(meta.modelLods || []).map(v => v.file), ...(meta.components || []).map(v => v.uri)];
  if (!references.length) throw new Error('入库资产没有模型或贴图');
  for (const reference of references) {
    const file = path.isAbsolute(reference) ? reference : path.join(root, reference);
    if (!inside(root, file) || !(await fs.stat(file)).isFile()) throw new Error('入库文件引用无效');
  }
  return meta;
}

// 批量预检与正式入库共用源解析，预检只返回原生识别结果，不创建资产或修改索引。
async function inspectImportSource(job, { readMetadata }) {
  const id = assetId(job.id);
  const source = await fs.realpath(path.resolve(job.source));
  const metadata = await readMetadata([path.join(source, `${id}.json`)]);
  if (!metadata || !metadata.standardAssetTags?.includes('Megascans')) throw new Error('无法识别 Bridge 元数据');
  return { ok: true, metadata };
}

async function runImportJob(job, { readMetadata, importAsset }) {
  const id = assetId(job.id), library = path.resolve(job.library), archive = path.resolve(job.source);
  const storageKey = job.storageKey || id, cacheKey = job.cacheKey || id;
  if (![id, encodedKey(id)].includes(storageKey) || ![id, encodedKey(id)].includes(cacheKey)) throw new Error('自动入库存储路径身份不匹配');
  if (!inside(path.join(library, '.megascans', 'originals'), archive) || path.basename(archive) !== storageKey) throw new Error('自动入库源目录必须是本任务的原始归档');
  let source = archive;
  if (job.localSource) {
    if (!job.cacheRoot) throw new Error('本地入库源缺少缓存所有权');
    const cacheRoot = await fs.realpath(job.cacheRoot);
    const expected = path.join(cacheRoot, 'assets', cacheKey, 'payload');
    const local = path.resolve(job.localSource);
    if (local.toLowerCase() !== expected.toLowerCase() || (await fs.realpath(local)).toLowerCase() !== expected.toLowerCase()) throw new Error('本地入库源不属于当前资产缓存');
    const marker = JSON.parse(await fs.readFile(path.join(cacheRoot, 'assets', cacheKey, '.transfer-owner.json'), 'utf8'));
    if (marker.id !== id || marker.tool !== 'assethive-megascans-v1') throw new Error('本地入库源缺少缓存所有权');
    source = local;
  }
  const { metadata } = await inspectImportSource({ id, source }, { readMetadata });
  // Constrain import to this transaction, including resumes with old files in
  // the archive. HDRI keeps its HDR/EXR source; ordinary maps exclude EXR.
  const allowed = Array.isArray(job.sourceFiles) ? new Set(job.sourceFiles.map(file => path.resolve(source, file).toLowerCase())) : null;
  const permitted = file => typeof file === 'string' && (metadata.assetType === 'hdri' || path.extname(file).toLowerCase() !== '.exr') && (!allowed || allowed.has(path.resolve(file).toLowerCase()));
  metadata.textureSlots = (metadata.textureSlots || []).filter(entry => permitted(entry.filePath));
  metadata.modelFiles = (metadata.modelFiles || []).filter(permitted);
  metadata.modelVariants = (metadata.modelVariants || []).filter(entry => permitted(entry.file));
  metadata.modelLods = metadata.assetType === '3d' ? [] : (metadata.modelLods || []).filter(entry => permitted(entry.file));
  const folder = TYPE_FOLDERS[metadata.assetType];
  if (!folder || (!(metadata.modelFiles || []).length && !(metadata.textureSlots || []).length)) return { ok: true, archivedOnly: true, message: '此资源没有 AssetHive 支持的模型/贴图槽（例如 Brush）；已保留 Bridge 原始文件与元数据' };
  const finalRoot = path.join(library, 'Environment', folder, `megascans_${storageKey}`);
  const commitPath = path.join(library, '.megascans', 'imports', `${storageKey}.json`);
  if (await exists(finalRoot)) {
    // A durable prepare record lets a crash after rename resume without making
    // another random-ID asset. A different existing folder is never overwritten.
    const record = JSON.parse(await fs.readFile(commitPath, 'utf8'));
    if (record.id !== id || record.finalRoot !== finalRoot) throw new Error('已有目录不是本任务发布的资产');
    await validateImported(finalRoot, id);
    let references = record.metadataReferences;
    if (!references) {
      const receiptPath = await resolveReceiptPath(library, id);
      if (await exists(receiptPath)) {
        const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
        await verifyReceipt(library, receipt, id);
        if (path.resolve(library, receipt.imported?.root || '') !== finalRoot) throw new Error('完成回执与导入目录不匹配');
        references = receipt.imported.metadataReferences;
      }
    }
    await verifyImportedFiles(finalRoot, id, record.files, references);
    await recordLibraryChanges(library, [finalRoot]);
    return { ok: true, assetPath: finalRoot, files: record.files, recovered: true };
  }
  const staging = path.join(library, '.megascans', 'staging', storageKey, crypto.randomUUID());
  await fs.mkdir(staging, { recursive: true });
  if (job.removePreviewBackground) {
    const { transparentPreview } = require('../../scripts/lib/fab-preview.cjs');
    if (!metadata.previewImagePath) throw new Error('Fab 缺少可去背景的源预览');
    const preview = path.resolve(metadata.previewImagePath);
    if (!inside(source, preview)) throw new Error('Fab 源预览路径越界');
    // Fab surfaces/decals use a sphere render: preserve its shaded interior.
    const method = ['surface', 'decal', 'imperfection'].includes(metadata.assetType) ? 'color' : 'smart';
    await transparentPreview(preview, path.join(staging, 'preview-cutout.png'), { method });
    metadata.previewImagePath = path.join(staging, 'preview-cutout.png');
  }
  const result = await importAsset(buildPayload(metadata, staging));
  if (!result?.ok) throw new Error(result?.message || 'AssetHive 未返回入库结果');
  const stagedRoot = result.assetPath;
  if (!inside(staging, stagedRoot)) throw new Error('AssetHive 入库输出不在临时目录');
  const raw = JSON.parse(await fs.readFile(path.join(stagedRoot, 'asset_info.json'), 'utf8'));
  if (job.removePreviewBackground) {
    const sharp = require('sharp');
    const preview = path.resolve(stagedRoot, raw.previewImage || '');
    if (!inside(stagedRoot, preview)) throw new Error('Fab 入库预览路径越界');
    const image = await sharp(preview).metadata(), stats = await sharp(preview).stats();
    if (image.format !== 'png' || !image.hasAlpha || Math.max(image.width, image.height) > 1024
      || stats.channels.at(-1).min !== 0 || !stats.channels.at(-1).max) throw new Error('Fab 入库预览未保留有效透明通道');
  }
  const moved = relocate(raw, stagedRoot, finalRoot);
  moved.slug = path.basename(finalRoot);
  const meta = createAssetMetadata(moved);
  await writeAssetMetadata(stagedRoot, meta);
  const files = await inventory(stagedRoot);
  const references = metadataReferences(finalRoot, meta, id, files);
  await fs.mkdir(path.dirname(finalRoot), { recursive: true });
  await atomicJson(commitPath, { id, finalRoot, files, metadataReferences: references, stagedRoot, policy: DOWNLOAD_POLICY });
  await renameWithRetry(stagedRoot, finalRoot);
  await validateImported(finalRoot, id);
  await verifyImportedFiles(finalRoot, id, files, references);
  await recordLibraryChanges(library, [finalRoot]);
  return { ok: true, assetPath: finalRoot, files, warnings: result.warnings || [] };
}

module.exports = { buildPayload, relocate, validateImported, inspectImportSource, runImportJob };
