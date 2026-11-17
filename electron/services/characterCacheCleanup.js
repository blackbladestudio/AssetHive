const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { clearCharacterInspection } = require('./characterFileInspection');
const hash = value => createHash('sha256').update(value).digest('hex');
const key = value => path.resolve(value).toLowerCase();
const within = (root, file) => { const relative = path.relative(root, file); return relative && !relative.startsWith('..') && !path.isAbsolute(relative); };

async function prepareCharacterCacheCleanup(asset, libraryRoot, cacheRoot) {
  const meta = JSON.parse(await fs.readFile(asset.metaPath, 'utf8'));
  if (String(meta.assetID || meta.id) !== asset.id) throw new Error('删除资产身份已变化');
  const paths = new Set(), contentHashes = [], modelSources = [];
  async function collect(folder) {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) throw new Error('管理目录含链接，停止清理');
      if (entry.isDirectory()) await collect(file); else paths.add(file);
    }
  }
  await collect(asset.path);
  for (const file of meta.characterManifest?.files || []) {
    if (file.originalPath) paths.add(path.resolve(file.originalPath));
    if (file.sha256) contentHashes.push(file.sha256);
    if (file.originalPath && ['staticMesh', 'skeletalMesh', 'model'].includes(file.role)) modelSources.push(file.originalPath);
  }
  for (const file of [...paths]) paths.add(await fs.realpath(file).catch(() => file));
  const localDerived = path.join(cacheRoot, 'ThumbCache', 'DerivedCache', 'v1', hash(path.resolve(libraryRoot).toLowerCase()).slice(0, 16));
  const sharedDerived = path.join(libraryRoot, '.assethive', 'DerivedCache', 'v1');
  const tgaCache = path.join(cacheRoot, 'ImportSources', 'CharacterPreviewTextures');
  const files = new Set();
  for (const source of paths) {
    const stat = await fs.stat(source).catch(() => null);
    if (!stat?.isFile()) continue;
    const relative = within(libraryRoot, source) ? path.relative(libraryRoot, source).replaceAll('\\', '/') : null;
    const thumb = hash(JSON.stringify(['thumbnail-v1:512:png-alpha:jpeg72:hdr-v2', relative ?? path.resolve(source), stat.size, stat.mtimeMs]));
    for (const root of [localDerived, ...(relative !== null ? [sharedDerived] : [])]) for (const ext of ['.png', '.jpg']) files.add(path.join(root, 'Thumbnails', thumb.slice(0, 2), thumb + ext));
    if (/\.tga$/i.test(source)) files.add(path.join(tgaCache, hash(`${source.toLowerCase()}|${stat.size}|${stat.mtimeMs}`) + '.png'));
  }
  return { assetId: asset.id, assetPath: asset.path, paths: [...paths], contentHashes, modelSources, queueId: meta.importQueueId || '',
    files: [...files], cacheRoots: [localDerived, sharedDerived, tgaCache] };
}

function matchesCharacterDraft(draft, scope) {
  const form = draft?.form || {};
  if (scope.queueId && form.queueId === scope.queueId) return true;
  if (form.assetId === scope.assetId) return true;
  const sources = new Set(scope.modelSources.map(key));
  return Object.values(form.modelSlots || {}).some(file => typeof file === 'string' && file && (sources.has(key(file)) || within(scope.assetPath, path.resolve(file))));
}

async function clearCharacterCacheFiles(scope) {
  await clearCharacterInspection(scope);
  for (const file of scope.files) {
    if (!scope.cacheRoots.some(root => within(root, file))) throw new Error('缓存清理超出范围');
    const actual = await fs.realpath(file).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (!actual) continue;
    const roots = await Promise.all(scope.cacheRoots.map(root => fs.realpath(root).catch(() => root)));
    if (!roots.some(root => within(root, actual))) throw new Error('缓存路径含越界链接');
    await fs.unlink(actual);
  }
}
async function clearCharacterScanMemos(scope, libraryRoot, memoPaths) {
  const { readGzipJsonArray, gzipJsonArray } = require('./jsonArrayStream');
  const { writeFileAtomic } = require('./atomicFile');
  for (const file of memoPaths) {
    if (!await fs.stat(file).catch(e => { if (e.code === 'ENOENT') return null; throw e; })) continue;
    const memo = await readGzipJsonArray(file);
    if (key(memo.root || '') !== key(libraryRoot) || !Array.isArray(memo.assets)) continue;
    const assets = memo.assets.filter(entry => String(entry?.record?.id || '').split('::part::')[0] !== scope.assetId);
    if (assets.length === memo.assets.length) continue;
    const envelope = { ...memo }; delete envelope.assets;
    await writeFileAtomic(file, await gzipJsonArray(envelope, assets));
  }
}
module.exports = { prepareCharacterCacheCleanup, clearCharacterCacheFiles, matchesCharacterDraft, clearCharacterScanMemos };
