const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { Buffer } = require('node:buffer');
const { parseArgs } = require('node:util');
const sharp = require('sharp');
const { FabMegascans, downloadFabFile, transientFabConnection } = require('./lib/fab-megascans.cjs');
const { readJson } = require('./lib/megascans-json.cjs');
const { inside, exists, atomicJson, hashFile, renameWithRetry, metadataReferences, verifyReceipt } = require('./lib/megascans-transfer.cjs');
const { serializeAssetMetadata } = require('../electron/services/assetMetadata');
const { analyzeAssetTextureUsage } = require('../electron/services/textureAnalysis');
const { lock } = require('./megascans-runner.cjs');

sharp.cache(false);
sharp.concurrency(1);

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const normalized = value => String(value).replaceAll('\\', '/').toLowerCase();
const normalType = value => /^normal(?:bump|map)?$|^nrm$|^nor$/i.test(value || '');
const repairKind = 'fab-raw-normal-v1';
const repairDone = receipt => receipt.repairs?.some(item => item.kind === repairKind);

async function cachedRawNormal(downloadDir, item) {
  const work = checked(downloadDir, item.key), recordFile = checked(work, 'download.json');
  if (!await exists(recordFile)) return null;
  await ordinary(recordFile);
  const record = await readJson(recordFile);
  if (record.version !== 1 || record.id !== item.id || record.key !== item.key || record.listingId !== item.listingId
    || typeof record.file !== 'string' || path.basename(record.file) !== record.file
    || !Number.isSafeInteger(record.bytes) || record.bytes <= 0 || !/^[a-f0-9]{64}$/.test(record.sha256)
    || !/_raw\.zip$/i.test(record.rawPackage || '') || !normalType(record.normal?.type)
    || record.normal?.tier != null && record.normal.tier !== 0
    || record.normal?.uri !== record.file) throw new Error('本地 Raw 法线缓存来源无效，保留待检查');
  const source = checked(work, record.file), stat = await ordinary(source);
  if (stat.size !== record.bytes || await hashFile(source) !== record.sha256) throw new Error('本地 Raw 法线缓存校验失败，保留待检查');
  return { ...record, source };
}

async function downloadWithCdnRetryHint(client, file, work, download) {
  try { return await download(file, work, { reserveBytes: 10 * 1024 ** 3 }); }
  catch (error) {
    if (!error.status && transientFabConnection(error) && file.zip?.url) client.unreachableCdns?.add(new globalThis.URL(file.zip.url).hostname);
    throw error;
  }
}

// This phase uses only the saved audit and official Fab downloads. It must not
// stat, lock, read or write the shared library while the share is unavailable.
async function downloadRawNormal(cacheRoot, downloadDir, item, client, { download = downloadFabFile } = {}) {
  const cached = await cachedRawNormal(downloadDir, item);
  if (cached) return cached;
  const work = checked(downloadDir, item.key);
  await fs.mkdir(work, { recursive: true });
  let plan;
  for (let attempt = 0; ; attempt++) {
    try {
      plan = await client.plan({ uid: item.listingId, sourceId: item.id, listingType: '3d-model' }, { normalOnly: true });
      if (plan.meta.id !== item.id || plan.files.length !== 1 || plan.normal?.uri !== plan.files[0].file
        || !normalType(plan.normal?.type) || plan.normal.tier != null && plan.normal.tier !== 0
        || !/_raw\.zip$/i.test(plan.rawPackage || '')) throw new Error('官方 Raw 法线来源身份不符');
      const file = plan.files[0], source = checked(work, file.file);
      if (path.basename(file.file) !== file.file) throw new Error('Raw 法线缓存文件名无效');
      // Reuse the four verified files downloaded before the share stopped
      // responding. Keep their old copies until the final repair succeeds.
      const legacy = checked(path.join(cacheRoot, 'raw-normal-repair/assets', item.key), file.file);
      if (!await exists(source) && await exists(legacy) && await exists(`${legacy}.transfer-sha256`)) {
        const previousHash = (await fs.readFile(`${legacy}.transfer-sha256`, 'utf8')).trim();
        if ((await ordinary(legacy)).size === file.bytes && await hashFile(legacy) === previousHash) {
          await backupFile(legacy, source, previousHash);
          await fs.writeFile(`${source}.transfer-sha256`, previousHash, { flag: 'wx' });
        }
      }
      await downloadWithCdnRetryHint(client, file, work, download);
      break;
    } catch (error) {
      if (attempt >= 2 || !transientFabConnection(error)) throw error;
      await new Promise(resolve => globalThis.setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
  const file = plan.files[0], source = checked(work, file.file), stat = await ordinary(source);
  const image = await sharp(source).metadata();
  if (stat.size !== file.bytes || !image.width || !image.height || Math.max(image.width, image.height) > 8192) throw new Error('Raw 法线下载尺寸或长度无效');
  const record = { version: 1, id: item.id, key: item.key, listingId: item.listingId, file: file.file,
    bytes: stat.size, sha256: await hashFile(source), normal: plan.normal, rawPackage: plan.rawPackage,
    sourceWidth: image.width, sourceHeight: image.height, downloadedAt: new Date().toISOString() };
  await atomicJson(checked(work, 'download.json'), record);
  return { ...record, source };
}

async function downloadOnly(manifest, items, cacheRoot, downloadDir, workers) {
  if (inside(manifest.library, downloadDir) || inside(downloadDir, manifest.library)) throw new Error('Raw 法线下载目录必须独立于共享库');
  await fs.mkdir(downloadDir, { recursive: true });
  const release = await lock(checked(downloadDir, 'download.lock'));
  const client = new FabMegascans(cacheRoot), results = [], errors = [];
  let reportWrite = Promise.resolve(), stopped = false, finished = false;
  const previous = await exists(path.join(cacheRoot, 'raw-normal-repair/progress.json'))
    ? await readJson(path.join(cacheRoot, 'raw-normal-repair/progress.json')) : null;
  const repaired = new Set((previous?.results || []).map(result => result.id));
  const pending = items.filter(item => !repaired.has(item.id));
  const pauseFile = checked(downloadDir, 'pause-request.json');
  const report = () => {
    const state = { updatedAt: new Date().toISOString(), status: stopped ? 'paused' : finished ? errors.length ? 'pending_retry' : 'completed' : 'running',
      phase: 'download_only', downloadDir, total: pending.length, alreadyRepaired: items.length - pending.length,
      completed: results.length, failed: errors.length, results: [...results], errors: [...errors] };
    reportWrite = reportWrite.then(() => atomicJson(checked(downloadDir, 'progress.json'), state)); return reportWrite;
  };
  try {
    const marker = checked(downloadDir, '.fab-raw-normal-cache.json');
    if (await exists(marker)) {
      const owner = await readJson(marker);
      if (owner.kind !== repairKind || normalized(owner.library) !== normalized(manifest.library)) throw new Error('该下载目录属于其他任务');
    } else await atomicJson(marker, { version: 1, kind: repairKind, library: manifest.library, createdAt: new Date().toISOString() });
    await atomicJson(checked(downloadDir, 'manifest.json'), manifest);
    await report();
    await mapLimit(pending, workers, async item => {
      if (stopped || await exists(pauseFile)) { stopped = true; return; }
      try {
        const cached = await downloadRawNormal(cacheRoot, downloadDir, item, client);
        results.push({ id: item.id, key: item.key, file: cached.file, bytes: cached.bytes, sha256: cached.sha256, downloadedAt: cached.downloadedAt });
        console.log(JSON.stringify({ stage: 'raw-normal-downloaded', id: item.id, completed: results.length, total: pending.length }));
      } catch (error) {
        errors.push({ id: item.id, name: error.name, code: error.code, status: error.status, error: error.message });
        console.log(JSON.stringify({ stage: 'raw-normal-download-failed', id: item.id, code: error.code, error: error.message }));
        if (['ENOSPC', 'EIO', 'EACCES', 'EPERM'].includes(error.code) || /本地剩余空间不足/.test(error.message)) stopped = true;
      }
      await report();
    });
    finished = true; await report();
    if (errors.length) process.exitCode = 1;
  } finally { try { await client.close(); } finally { await release(); } }
}

async function mapLimit(items, workers, operation) {
  let cursor = 0, failure;
  await Promise.all(Array.from({ length: Math.min(workers, items.length) }, async () => {
    while (!failure && cursor < items.length) {
      try { await operation(items[cursor++]); } catch (error) { failure ||= error; }
    }
  }));
  if (failure) throw failure;
}
function checked(root, relative) {
  const target = path.resolve(root, relative);
  if (!inside(root, target) || target === path.resolve(root)) throw new Error('法线修复文件路径越界');
  return target;
}
async function ordinary(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || normalized(await fs.realpath(file)) !== normalized(path.resolve(file))) throw new Error('法线修复拒绝重定向文件');
  return stat;
}
async function writeText(file, text) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, text, { flag: 'wx' }); await renameWithRetry(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
}
async function backupFile(source, target, expected) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (await exists(target)) {
    if (await hashFile(target) !== expected) throw new Error('已有法线备份校验不符');
    return;
  }
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.copyFile(source, temporary);
    if (await hashFile(temporary) !== expected) throw new Error('法线备份读回校验失败');
    await renameWithRetry(temporary, target);
  } finally { await fs.rm(temporary, { force: true }); }
}

async function buildManifest(library, cacheRoot) {
  const receipts = path.join(library, '.megascans/receipts');
  const files = (await fs.readdir(receipts)).filter(file => file.endsWith('.json'));
  const items = [], alreadyCorrect = [], errors = [];
  let scanned = 0;
  await mapLimit(files, 12, async file => {
    try {
      const receipt = await readJson(path.join(receipts, file));
      if (receipt.imported?.metadataReferences?.assetType !== '3d') return;
      const archive = checked(library, receipt.archive.root);
      const source = await readJson(checked(archive, `${receipt.id}.json`));
      if (!source.fab?.listingId) return;
      if (repairDone(receipt) || (source.maps || []).some(map => normalType(map.type) && map.tier === 0 && /(?:^|_)Raw_/i.test(path.basename(map.uri)))) {
        alreadyCorrect.push(receipt.id); return;
      }
      const normals = (source.maps || []).filter(map => normalType(map.type));
      if (!normals.length) throw new Error('已入库 Fab 3D 资产的源 JSON 没有 Normal');
      const rawModels = (source.models || []).filter(model => /\.fbx$/i.test(model.uri || ''));
      if (!rawModels.length || rawModels.some(model => !/(?:^|_)Raw\.fbx$/i.test(path.basename(model.uri)))) throw new Error('源模型不是明确的 Raw FBX，保留待检查');
      items.push({ id: receipt.id, key: path.basename(file, '.json'), listingId: source.fab.listingId,
        root: receipt.imported.root, archive: receipt.archive.root, normalSources: normals.map(map => map.uri) });
    } catch (error) { errors.push({ file, error: error.message }); }
    finally { if (++scanned % 500 === 0) console.log(JSON.stringify({ stage: 'auditing', scanned, receipts: files.length, affected: items.length })); }
  });
  items.sort((left, right) => left.id.localeCompare(right.id));
  const manifest = { version: 1, library: path.resolve(library), auditedAt: new Date().toISOString(), receipts: files.length, items, alreadyCorrect, errors };
  await atomicJson(path.join(cacheRoot, 'raw-normal-repair/manifest.json'), manifest);
  return manifest;
}

// Models and other maps retain their recorded content digests. Rebuild the
// identity using the Raw source digest without reading terabytes of untouched
// meshes over SMB. The changed old/new normal bytes are verified separately.
function repairedIdentity(meta, root, files, normalUri, sourceHash) {
  const hashes = new Map(files.map(file => [normalized(file.file), `sha256:${file.sha256}`]));
  const entries = meta.textureEntries.map(entry => ({ suffix: entry.textureType, materialRole: entry.materialRole || '',
    areaIndex: Math.max(1, Number(entry.areaIndex) || 1), source: path.resolve(root, entry.uri) }));
  const descriptors = entries.sort((left, right) => left.suffix.localeCompare(right.suffix, undefined, { sensitivity: 'base' })
    || left.materialRole.localeCompare(right.materialRole, undefined, { sensitivity: 'base' })
    || left.source.localeCompare(right.source, undefined, { sensitivity: 'base' })).map(entry => {
    const relative = path.relative(root, entry.source).replaceAll('\\', '/');
    const file = normalized(relative) === normalized(normalUri) ? `sha256:${sourceHash}` : hashes.get(normalized(relative));
    if (!inside(root, entry.source) || !file) throw new Error('无法对应资源指纹，保留资产不修改');
    return { suffix: entry.suffix, materialRole: entry.materialRole || undefined, areaIndex: entry.areaIndex, file };
  });
  const textureFingerprint = `sha256:${digest(JSON.stringify(descriptors))}`;
  const models = Object.entries(meta.identity.modelFingerprints).sort((left, right) => left[0].localeCompare(right[0], undefined, { sensitivity: 'base' }));
  return { ...meta.identity, textureFingerprint, contentFingerprint: `sha256:${digest(JSON.stringify({
    fingerprintVersion: meta.identity.fingerprintVersion, models, textures: descriptors, textureFingerprint
  }))}` };
}

async function prepareRepair(library, cacheRoot, item, source, sourceMap, sourcePackage) {
  const receiptPath = checked(path.join(library, '.megascans/receipts'), `${item.key}.json`);
  const importPath = checked(path.join(library, '.megascans/imports'), `${item.key}.json`);
  const receipt = await readJson(receiptPath), record = await readJson(importPath);
  const root = checked(library, receipt.imported.root), metaPath = checked(root, 'asset_info.json');
  if (receipt.id !== item.id || record.id !== item.id || normalized(record.finalRoot) !== normalized(root)
    || normalized(root) !== normalized(checked(library, item.root)) || !inside(path.join(library, 'Environment/3D Assets'), root)) throw new Error('法线修复资产所有权不匹配');
  if (normalized(await fs.realpath(root)) !== normalized(root)) throw new Error('法线修复拒绝重定向资产目录');
  await verifyReceipt(library, receipt, item.id, { content: false });
  const metaText = await fs.readFile(metaPath, 'utf8'), meta = JSON.parse(metaText);
  if (meta.assetType !== '3d' || meta.identity?.sourceAssetId !== item.id || (meta.modelLods || []).length) throw new Error('此修复仅处理 Fab Raw 单层高模');
  const normals = meta.textureEntries.filter(entry => normalType(entry.textureType));
  if (normals.length !== 1 || Number(normals[0].areaIndex || 1) !== 1) throw new Error('法线槽不唯一，保留待检查');
  const normal = normals[0], normalUri = path.relative(root, checked(root, normal.uri)).replaceAll('\\', '/');
  const target = checked(root, normalUri);
  await ordinary(target);
  const recorded = record.files.find(file => normalized(file.file) === normalized(normalUri));
  const oldNormalHash = await hashFile(target);
  if (!recorded || recorded.sha256 !== oldNormalHash) throw new Error('法线已被用户修改，与入库回执不同，保留待检查');
  const image = await sharp(source).metadata();
  if (!image.width || !image.height || Math.max(image.width, image.height) > 8192 || !normalType(sourceMap.type)
    || sourceMap.tier != null && sourceMap.tier !== 0) throw new Error('Raw Normal 源尺寸或质量档无效');
  const work = path.join(cacheRoot, 'raw-normal-repair/assets', item.key);
  await fs.mkdir(work, { recursive: true });
  const output = path.join(work, `replacement${path.extname(target)}`);
  let pipeline = sharp(source).resize({ width: 4096, height: 4096, fit: 'inside', withoutEnlargement: true });
  if (/\.jpe?g$/i.test(target)) pipeline = pipeline.jpeg({ quality: 95, chromaSubsampling: '4:4:4' });
  else if (/\.png$/i.test(target)) pipeline = pipeline.png({ compressionLevel: 3, effort: 2 });
  else throw new Error('法线目标不是 PNG/JPEG，保留待检查');
  await pipeline.toFile(output);
  const dimensions = await sharp(output).metadata(), stat = await fs.stat(output);
  const sourceHash = await hashFile(source), nextNormalHash = await hashFile(output), repairedAt = new Date().toISOString();
  const resolution = value => value >= 1024 ? `${value / 1024}K` : `${value}px`;
  const fields = { width: dimensions.width, height: dimensions.height, resolution: resolution(Math.max(dimensions.width, dimensions.height)),
    sourceWidth: image.width, sourceHeight: image.height, sourceResolution: resolution(Math.max(image.width, image.height)),
    compressed: image.width > dimensions.width || image.height > dimensions.height, fileSize: stat.size, fileModifiedAt: stat.mtimeMs };
  const next = globalThis.structuredClone(meta);
  const matches = uri => normalized(path.relative(root, path.resolve(root, uri))) === normalized(normalUri);
  next.textureEntries = next.textureEntries.map(entry => matches(entry.uri) ? { ...entry, ...fields } : entry);
  next.components = next.components.map(entry => entry.type === 'texture' && matches(entry.uri) ? { ...entry, ...fields } : entry);
  next.identity = repairedIdentity(meta, root, record.files, normalUri, sourceHash);
  next.updatedAt = repairedAt; next.revision = (Number(next.revision) || 1) + 1;
  const provenance = { kind: repairKind, repairedAt, listingId: item.listingId, package: sourcePackage,
    sourceFile: path.basename(source), sourceSha256: sourceHash, sourceResolution: sourceMap.resolution,
    file: normalUri, previousSha256: oldNormalHash, sha256: nextNormalHash };
  next.importHistory = [...(next.importHistory || []), { at: repairedAt, action: repairKind, previousFingerprint: meta.identity.contentFingerprint,
    nextFingerprint: next.identity.contentFingerprint, source: provenance }];
  const serialized = serializeAssetMetadata(next);
  const metaFile = { file: 'asset_info.json', bytes: Buffer.byteLength(serialized.text), sha256: digest(serialized.text) };
  const normalFile = { file: normalUri, bytes: stat.size, sha256: nextNormalHash };
  const replace = files => files.map(file => file.file === 'asset_info.json' ? metaFile : normalized(file.file) === normalized(normalUri) ? normalFile : file);
  const recordFiles = replace(record.files), receiptFiles = replace(receipt.imported.files);
  if (!receiptFiles.some(file => normalized(file.file) === normalized(normalUri))) throw new Error('完成回执缺少法线记录');
  const refs = metadataReferences(root, serialized.meta, item.id, recordFiles);
  const journal = { version: 1, id: item.id, key: item.key, root, normalUri, output, metaText: serialized.text, provenance,
    oldMetadataHash: digest(metaText), oldReceiptHash: await hashFile(receiptPath), oldRecordHash: await hashFile(importPath),
    record: { ...record, files: recordFiles, metadataReferences: refs },
    receipt: { ...receipt, imported: { ...receipt.imported, files: receiptFiles, metadataReferences: refs }, repairs: [...(receipt.repairs || []), provenance] } };
  const backup = path.join(library, '.megascans/raw-normal-repairs/backups', item.key);
  await backupFile(metaPath, path.join(backup, 'asset_info.json'), journal.oldMetadataHash);
  await backupFile(receiptPath, path.join(backup, 'receipt.json'), journal.oldReceiptHash);
  await backupFile(importPath, path.join(backup, 'import.json'), journal.oldRecordHash);
  await backupFile(target, checked(backup, normalUri), oldNormalHash);
  return journal;
}

async function publishRepair(library, cacheRoot, journal, { afterStep = async () => {} } = {}) {
  const root = checked(library, journal.receipt.imported.root);
  if (normalized(root) !== normalized(journal.root) || !inside(path.join(library, 'Environment/3D Assets'), root)
    || journal.id !== journal.receipt.id || journal.id !== journal.record.id) throw new Error('修复日志目标无效');
  const target = checked(root, journal.normalUri), metaPath = checked(root, 'asset_info.json');
  await ordinary(target); await ordinary(metaPath);
  const receiptPath = checked(path.join(library, '.megascans/receipts'), `${journal.key}.json`);
  const importPath = checked(path.join(library, '.megascans/imports'), `${journal.key}.json`);
  for (const [file, oldHash, nextHash] of [[target, journal.provenance.previousSha256, journal.provenance.sha256],
    [metaPath, journal.oldMetadataHash, digest(journal.metaText)], [receiptPath, journal.oldReceiptHash, digest(JSON.stringify(journal.receipt, null, 2))],
    [importPath, journal.oldRecordHash, digest(JSON.stringify(journal.record, null, 2))]]) {
    if (![oldHash, nextHash].includes(await hashFile(file))) throw new Error('修复期间资产或回执被修改，保留备份并停止');
  }
  if (await hashFile(target) !== journal.provenance.sha256) {
    if (!inside(path.join(cacheRoot, 'raw-normal-repair/assets'), journal.output) || await hashFile(journal.output) !== journal.provenance.sha256) throw new Error('暂存 Raw 法线校验不符');
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.copyFile(journal.output, temporary);
      if (await hashFile(temporary) !== journal.provenance.sha256) throw new Error('共享盘法线读回校验失败');
      await renameWithRetry(temporary, target);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  await afterStep('normal');
  if (!journal.analysisRefreshed) {
    const meta = JSON.parse(journal.metaText), previous = meta.textureAnalysis || {}, stat = await fs.stat(target);
    const isNormal = uri => normalized(path.relative(root, path.resolve(root, uri))) === normalized(journal.normalUri);
    meta.textureEntries = meta.textureEntries.map(entry => isNormal(entry.uri) ? { ...entry, fileModifiedAt: stat.mtimeMs } : entry);
    meta.components = meta.components.map(entry => entry.type === 'texture' && isNormal(entry.uri) ? { ...entry, fileModifiedAt: stat.mtimeMs } : entry);
    meta.textureAnalysis = await analyzeAssetTextureUsage({ dimensions: previous.dimensions, dimensionsSource: previous.dimensionsSource,
      textureFiles: meta.textureFiles.map(uri => checked(root, uri)) }, { force: true });
    journal.metaText = serializeAssetMetadata(meta).text;
    const replacement = { file: 'asset_info.json', bytes: Buffer.byteLength(journal.metaText), sha256: digest(journal.metaText) };
    for (const section of [journal.record, journal.receipt.imported]) section.files = section.files.map(file => file.file === 'asset_info.json' ? replacement : file);
    journal.analysisRefreshed = true;
    await atomicJson(path.join(library, '.megascans/raw-normal-repairs', `${journal.key}.json`), journal);
  }
  await writeText(metaPath, journal.metaText);
  await afterStep('metadata');
  await atomicJson(importPath, journal.record);
  await afterStep('import-record');
  await atomicJson(receiptPath, journal.receipt);
  await verifyReceipt(library, journal.receipt, journal.id, { content: false });
  if (await hashFile(target) !== journal.provenance.sha256) throw new Error('已发布 Raw 法线校验失败');
  journal.completedAt = new Date().toISOString();
  await atomicJson(path.join(library, '.megascans/raw-normal-repairs', `${journal.key}.json`), journal);
  return journal;
}

// Explicit recovery only: a background analysis refresh may invalidate an
// unpublished transaction. Keep both snapshots and accept no other edits.
async function rebaseRepairAnalysis(library, cacheRoot, journal) {
  const root = checked(library, journal.receipt.imported.root);
  if (journal.completedAt || journal.analysisRefreshed || journal.version !== 1
    || normalized(root) !== normalized(journal.root) || !inside(path.join(library, 'Environment/3D Assets'), root)
    || journal.id !== journal.receipt.id || journal.id !== journal.record.id) throw new Error('仅可恢复尚未发布的法线事务');
  const journalPath = checked(path.join(library, '.megascans/raw-normal-repairs'), `${journal.key}.json`);
  const journalText = await fs.readFile(journalPath, 'utf8');
  if (JSON.stringify(JSON.parse(journalText)) !== JSON.stringify(journal)) throw new Error('恢复期间事务日志被修改');
  const target = checked(root, journal.normalUri), metaPath = checked(root, 'asset_info.json');
  const receiptPath = checked(path.join(library, '.megascans/receipts'), `${journal.key}.json`);
  const recordPath = checked(path.join(library, '.megascans/imports'), `${journal.key}.json`);
  const backup = checked(path.join(library, '.megascans/raw-normal-repairs/backups'), journal.key);
  const oldMetaPath = checked(backup, 'asset_info.json');
  for (const file of [target, metaPath, receiptPath, recordPath, oldMetaPath, journalPath]) await ordinary(file);
  if (await hashFile(oldMetaPath) !== journal.oldMetadataHash) throw new Error('原始元数据备份校验不符');
  const oldMeta = await readJson(oldMetaPath), currentText = await fs.readFile(metaPath, 'utf8'), current = JSON.parse(currentText);
  const changed = [...new Set([...Object.keys(oldMeta), ...Object.keys(current)])]
    .filter(key => JSON.stringify(oldMeta[key]) !== JSON.stringify(current[key]));
  if (changed.length !== 1 || changed[0] !== 'textureAnalysis') throw new Error('存在分析缓存以外的元数据修改，保留待检查');
  if (!inside(path.join(cacheRoot, 'raw-normal-repair/assets'), journal.output)
    || await hashFile(journal.output) !== journal.provenance.sha256) throw new Error('暂存 Raw 法线校验不符');
  const guards = [[target, journal.provenance.previousSha256], [metaPath, digest(currentText)],
    [receiptPath, journal.oldReceiptHash], [recordPath, journal.oldRecordHash], [journalPath, digest(journalText)]];
  const verify = async () => {
    for (const [file, expected] of guards) if (await hashFile(file) !== expected) throw new Error('恢复期间资产、元数据或回执被修改');
  };
  await verify();
  const saved = checked(backup, `analysis-rebases/${crypto.randomUUID()}`);
  await backupFile(journalPath, path.join(saved, 'journal.json'), digest(journalText));
  await backupFile(metaPath, path.join(saved, 'asset_info.json'), digest(currentText));
  const next = globalThis.structuredClone(journal), meta = JSON.parse(next.metaText);
  meta.textureAnalysis = current.textureAnalysis;
  next.metaText = serializeAssetMetadata(meta).text;
  next.oldMetadataHash = digest(currentText);
  const metadataFile = { file: 'asset_info.json', bytes: Buffer.byteLength(next.metaText), sha256: digest(next.metaText) };
  for (const section of [next.record, next.receipt.imported]) {
    section.files = section.files.map(file => file.file === 'asset_info.json' ? metadataFile : file);
  }
  next.analysisRebases = [...(next.analysisRebases || []), { at: new Date().toISOString(), fields: changed,
    previousMetadataHash: journal.oldMetadataHash, metadataHash: next.oldMetadataHash, backup: path.relative(library, saved) }];
  await verify();
  await atomicJson(journalPath, next);
  return next;
}

async function repairOne(library, cacheRoot, item, client, { downloadDir, downloadMissing = false, download = downloadFabFile } = {}) {
  const journalPath = path.join(library, '.megascans/raw-normal-repairs', `${item.key}.json`);
  if (await exists(journalPath)) {
    const journal = await readJson(journalPath);
    if (journal.completedAt) {
      const receipt = await readJson(path.join(library, '.megascans/receipts', `${item.key}.json`));
      if (!repairDone(receipt)) throw new Error('已完成法线修复的回执标记缺失');
      if (await hashFile(checked(journal.root, journal.normalUri)) !== journal.provenance.sha256) throw new Error('修复后的法线被修改');
      return journal;
    }
    return publishRepair(library, cacheRoot, journal);
  }
  const work = path.join(cacheRoot, 'raw-normal-repair/assets', item.key);
  await fs.mkdir(work, { recursive: true });
  if (downloadDir) {
    const cached = await cachedRawNormal(downloadDir, item);
    if (cached) {
      const journal = await prepareRepair(library, cacheRoot, item, cached.source, cached.normal, cached.rawPackage);
      await atomicJson(journalPath, journal);
      return publishRepair(library, cacheRoot, journal);
    }
    if (!downloadMissing) throw new Error('此项 Raw 法线尚未完成本地下载，保留待处理');
  }
  let plan;
  for (let attempt = 0; ; attempt++) {
    try {
      plan = await client.plan({ uid: item.listingId, sourceId: item.id, listingType: '3d-model' }, { normalOnly: true });
      if (plan.meta.id !== item.id || plan.files.length !== 1) throw new Error('官方 Raw 法线来源身份不符');
      await downloadWithCdnRetryHint(client, plan.files[0], work, download);
      break;
    } catch (error) {
      if (attempt >= 2 || !transientFabConnection(error)) throw error;
      await new Promise(resolve => globalThis.setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
  const journal = await prepareRepair(library, cacheRoot, item, checked(work, plan.files[0].file), plan.normal, plan.rawPackage);
  await atomicJson(journalPath, journal);
  return publishRepair(library, cacheRoot, journal);
}

async function refreshIndexes(library, cacheRoot, results, { localCacheRoot } = {}) {
  if (!results.length) return { updated: 0 };
  const { getAssetDetailsByMetaPath } = require('../electron/services/assetScanner');
  const records = new Map();
  await mapLimit(results, 6, async item => {
    if (!inside(path.join(library, 'Environment/3D Assets'), item.root)) throw new Error('索引同步目标不属于本次 Fab 3D 资产库');
    const metaPath = checked(item.root, 'asset_info.json');
    const record = await getAssetDetailsByMetaPath(metaPath);
    if (!record || record.meta.identity?.sourceAssetId !== item.id) throw new Error('修复后索引记录身份校验失败');
    records.set(normalized(metaPath), { record, stat: await fs.stat(metaPath) });
  });
  const memoRoot = localCacheRoot || path.join(process.env.APPDATA || '', 'AssetHive/LibraryCache');
  const localFiles = (localCacheRoot || process.env.APPDATA) && await exists(memoRoot) ? await fs.readdir(memoRoot) : [];
  const indexFiles = [path.join(library, '.assethive/custom-index.json'), path.join(library, '.assethive/custom-index.json.gz'),
    ...localFiles.filter(file => file.endsWith('.memo.json.gz')).map(file => path.join(memoRoot, file))];
  const updated = [];
  for (const indexFile of indexFiles) {
    if (!await exists(indexFile)) continue;
    for (let attempt = 0; ; attempt++) {
      const before = await fs.stat(indexFile), bytes = await fs.readFile(indexFile);
      const compressed = indexFile.endsWith('.gz');
      const doc = JSON.parse((compressed ? zlib.gunzipSync(bytes) : bytes).toString());
      let changed = 0;
      for (const entry of doc.assets || []) {
        const replacement = records.get(normalized(entry.metaPath || entry.record?.metaPath || ''));
        if (!replacement) continue;
        entry.record = replacement.record;
        entry.metaMtimeMs = replacement.stat.mtimeMs; entry.metaSize = replacement.stat.size; changed++;
      }
      if (!changed) break;
      const now = await fs.stat(indexFile);
      if (now.mtimeMs !== before.mtimeMs || now.size !== before.size) {
        if (attempt < 3) continue;
        throw new Error('索引正在被其他任务修改，请稍后重试索引同步');
      }
      const backup = path.join(cacheRoot, 'raw-normal-repair/index-backups', digest(indexFile) + (compressed ? '.json.gz' : '.json'));
      if (!await exists(backup)) await backupFile(indexFile, backup, digest(bytes));
      doc.generatedAt = new Date().toISOString();
      const next = Buffer.from(JSON.stringify(doc));
      const current = await fs.stat(indexFile);
      if (current.mtimeMs !== before.mtimeMs || current.size !== before.size) {
        if (attempt < 3) continue;
        throw new Error('索引在发布前已变化，未覆盖');
      }
      await writeText(indexFile, compressed ? zlib.gzipSync(next, { level: 1 }) : next);
      updated.push({ file: indexFile, records: changed }); break;
    }
  }
  // SQLite stores summary fields rather than texture slots. Refresh only the
  // texture analysis column for the exact affected metadata paths.
  const { DatabaseSync } = require('node:sqlite');
  for (const name of localFiles.filter(file => file.endsWith('.sqlite'))) {
    const db = new DatabaseSync(path.join(memoRoot, name));
    try {
      db.exec('PRAGMA busy_timeout=5000');
      if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='assets'").get()) continue;
      const columns = db.prepare('PRAGMA table_info(assets)').all().map(column => column.name);
      if (!columns.includes('textureAnalysisJson') || !columns.includes('metaPath')) continue;
      const update = db.prepare('UPDATE assets SET textureAnalysisJson = ? WHERE metaPath = ?');
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const { record } of records.values()) update.run(JSON.stringify(record.textureAnalysis || null), record.metaPath);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    } finally { db.close(); }
  }
  return { updated: records.size, files: updated };
}

async function main() {
  const { values } = parseArgs({ options: { apply: { type: 'boolean' }, audit: { type: 'boolean' }, 'refresh-indexes': { type: 'boolean' }, id: { type: 'string' },
    'download-only': { type: 'boolean' }, 'download-dir': { type: 'string' }, 'download-missing': { type: 'boolean' },
    limit: { type: 'string' }, workers: { type: 'string', default: '4' }, library: { type: 'string', default: '\\\\fileshare\\share\\Artist\\AssetLibrary' },
    cache: { type: 'string', default: path.resolve(__dirname, '../.cache/fab-megascans') } } });
  const library = path.resolve(values.library), cacheRoot = path.resolve(values.cache);
  if (values['download-only'] && (values.apply || values.audit || values['refresh-indexes'] || !values['download-dir'])) throw new Error('只下载模式需要 --download-dir，且不能同时审计或替换');
  if (values['download-missing'] && (!values.apply || !values['download-dir'])) throw new Error('边下载边替换需要 --apply 和 --download-dir');
  if (values['refresh-indexes']) {
    const releaseLocal = await lock(path.join(cacheRoot, 'runner.lock'));
    let releaseShare;
    try {
      releaseShare = await lock(path.join(library, '.megascans/runner.lock'));
      const progress = await readJson(path.join(cacheRoot, 'raw-normal-repair/progress.json'));
      console.log(JSON.stringify(await refreshIndexes(library, cacheRoot, progress.results)));
    } finally { try { if (releaseShare) await releaseShare(); } finally { await releaseLocal(); } }
    return;
  }
  const manifestFile = path.join(cacheRoot, 'raw-normal-repair/manifest.json');
  if (values['download-only'] && !await exists(manifestFile)) throw new Error('只下载模式需要已保存的审计清单，当前不会访问共享库');
  const manifest = values.audit || !await exists(manifestFile) ? await buildManifest(library, cacheRoot) : await readJson(manifestFile);
  if (normalized(manifest.library) !== normalized(library)) throw new Error('法线修复清单属于其他资产库');
  console.log(JSON.stringify({ stage: 'audit-complete', affected: manifest.items.length, alreadyCorrect: manifest.alreadyCorrect.length, errors: manifest.errors.length }));
  if (!values.apply && !values['download-only']) return;
  const workers = Number(values.workers);
  if (!Number.isInteger(workers) || workers < 1 || workers > 4) throw new Error('修复并发必须为 1–4');
  const items = manifest.items.filter(item => !values.id || item.id === values.id).slice(0, values.limit ? Number(values.limit) : undefined);
  const downloadDir = values['download-dir'] ? path.resolve(values['download-dir']) : undefined;
  if (values['download-only']) return downloadOnly(manifest, items, cacheRoot, downloadDir, workers);
  const releaseLocal = await lock(path.join(cacheRoot, 'runner.lock'));
  let releaseShare;
  const client = new FabMegascans(cacheRoot), results = [], errors = [];
  const pauseFile = path.join(cacheRoot, 'raw-normal-repair/pause-request.json');
  await fs.rm(pauseFile, { force: true });
  let stopped = false, finished = false;
  let indexedCount = 0, indexWrite = Promise.resolve();
  const flushIndexes = () => { indexWrite = indexWrite.then(async () => {
    const batch = results.slice(indexedCount);
    await refreshIndexes(library, cacheRoot, batch); indexedCount += batch.length;
  }); return indexWrite; };
  const reportFile = path.join(cacheRoot, 'raw-normal-repair/progress.json');
  let reportWrite = Promise.resolve();
  const report = () => { const state = { updatedAt: new Date().toISOString(), status: stopped ? 'paused' : finished ? errors.length ? 'pending_retry' : 'completed' : 'running',
    phase: values['download-missing'] || !downloadDir ? 'download_and_replace' : 'apply_cached',
    total: items.length, completed: results.length, failed: errors.length, indexed: indexedCount, results: [...results], errors: [...errors] };
    reportWrite = reportWrite.then(() => atomicJson(reportFile, state)); return reportWrite; };
  try {
    releaseShare = await lock(path.join(library, '.megascans/runner.lock'));
    await report();
    await mapLimit(items, workers, async item => {
      if (stopped || await exists(pauseFile)) { stopped = true; return; }
      try {
        const journal = await repairOne(library, cacheRoot, item, client, { downloadDir, downloadMissing: values['download-missing'] });
        results.push({ id: item.id, root: journal.root, file: journal.normalUri, completedAt: journal.completedAt });
        console.log(JSON.stringify({ stage: 'repaired', id: item.id, completed: results.length, total: items.length }));
        // Delete only this tool's known local files after the durable shared
        // journal and readback succeed. Keep every previous library normal.
        const work = path.join(cacheRoot, 'raw-normal-repair/assets', item.key);
        if (await exists(work)) for (const name of await fs.readdir(work)) {
          const file = checked(work, name); await ordinary(file); await fs.unlink(file);
        }
      } catch (error) {
        errors.push({ id: item.id, code: error.code, error: error.message });
        console.log(JSON.stringify({ stage: 'failed', id: item.id, code: error.code, error: error.message }));
      }
      await report();
      if (results.length - indexedCount >= 100) await flushIndexes();
    });
    await flushIndexes();
    finished = true;
    await report();
    console.log(JSON.stringify({ stage: 'finished', completed: results.length, failed: errors.length }));
    if (errors.length) process.exitCode = 1;
  } finally { await client.close(); try { if (releaseShare) await releaseShare(); } finally { await releaseLocal(); } }
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { buildManifest, repairedIdentity, prepareRepair, publishRepair, rebaseRepairAnalysis, repairOne, refreshIndexes, repairKind, cachedRawNormal, downloadRawNormal, downloadOnly };
