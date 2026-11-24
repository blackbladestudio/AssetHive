const path = require('node:path');
const crypto = require('node:crypto');
const lod = require('../../shared/characterLods.cjs');
const { activeCharacterFiles } = require('../../shared/characterComponents.mjs');
const { inspectCharacterModel } = require('./characterFileInspection');
const { analyzeFbxInWorker } = require('./modelAnalysis');
const embeddedCounts = new Map();
async function embeddedLodCount(source, analyze) {
  if (analyze !== analyzeFbxInWorker) return (await inspectCharacterModel(source.sourcePath, analyze)).lodCount || 1;
  if (!embeddedCounts.has(source.sourceHash)) {
    const count = await require('./characterLinkContent').meshLodCount(source.sourcePath);
    if (embeddedCounts.size >= 256) embeddedCounts.delete(embeddedCounts.keys().next().value);
    embeddedCounts.set(source.sourceHash, count);
  }
  return embeddedCounts.get(source.sourceHash);
}
const model = file => ['model', 'staticMesh', 'skeletalMesh'].includes(file.role);
const skeletal = file => file.role === 'skeletalMesh' || file.role === 'model' && /^SK_/i.test(path.basename(file.normalizedName || file.storedPath));
const meshIdentity = file => (skeletal(file) ? 'SK:' : 'SM:') + lod.identity(file.normalizedName || file.storedPath).replace(/^(?:sk|sm)_/i, '');
const absolute = value => path.resolve(value).toLowerCase();
const pairedIdentity = file => meshIdentity(file).slice(3);

async function attachCharacterLods(result, asset, options, analyze, managedFile) {
  for (const entry of result.entries.filter(item => ['staticMesh', 'skeletalMesh'].includes(item.kind))) {
    entry.config = { ...entry.config, lodPolicy: 'lod1-reduction-v2' };
    entry.fingerprint = crypto.createHash('sha256').update(JSON.stringify({ previous: entry.fingerprint, lodPolicy: entry.config.lodPolicy })).digest('hex');
  }
  const files = activeCharacterFiles(asset).filter(model);
  const bases = files.filter(file => !lod.level(file.normalizedName || file.storedPath));
  for (const base of bases.filter(file => file.lodReset)) {
    const source = await managedFile(asset, base.storedPath);
    const entry = result.entries.find(item => ['staticMesh', 'skeletalMesh'].includes(item.kind)
      && absolute(item.sourcePath) === absolute(source.sourcePath));
    if (!entry) continue;
    entry.config = { ...entry.config, lodReset: base.lodReset,
      ...(base.ignoreEmbeddedLods ? { ignoreEmbeddedLods: true } : {}) };
    entry.fingerprint = crypto.createHash('sha256').update(JSON.stringify({ previous: entry.fingerprint,
      lodReset: base.lodReset, ignoreEmbeddedLods: Boolean(base.ignoreEmbeddedLods) })).digest('hex');
  }
  const chains = new Map();
  for (const file of files) {
    const name = file.normalizedName || file.storedPath;
    const index = lod.level(name);
    if (!index) continue;
    if (!/\.fbx$/i.test(name)) throw new Error('独立 LOD 仅支持 FBX；Groom 请使用 UE Groom 自身的 LOD 设置：' + name);
    const matches = bases.filter(base => meshIdentity(base) === meshIdentity(file));
    if (!matches.length && !skeletal(file) && index === 1
      && bases.filter(base => skeletal(base) && pairedIdentity(base) === pairedIdentity(file)).length === 1) continue;
    if (matches.length !== 1) throw new Error('LOD 缺少唯一的 LOD0 主模型：' + name);
    const base = matches[0];
    const key = base.storedPath;
    if (!chains.has(key)) chains.set(key, []);
    chains.get(key).push({ file, index });
  }
  for (const [basePath, chain] of chains) {
    const source = await managedFile(asset, basePath);
    const entry = result.entries.find(item => ['staticMesh', 'skeletalMesh'].includes(item.kind)
      && absolute(item.sourcePath) === absolute(source.sourcePath));
    if (!entry && !options.includeStaticMeshes) continue;
    if (!entry) throw new Error('LOD 主模型未进入导出清单：' + basePath);
    chain.sort((a, b) => a.index - b.index);
    const baseAnalysis = await inspectCharacterModel(source.sourcePath, analyze);
    const slots = new Set(baseAnalysis.materialNames || []);
    const bones = new Map((baseAnalysis.bones || []).map(bone => [bone.name, bone.parent]));
    const sources = [];
    for (let i = 0; i < chain.length; i++) {
      const { file, index } = chain[i];
      if (index !== i + 1) throw new Error('LOD 等级必须从 LOD0 连续排列，不能重复或跳级：' + basePath);
      const managed = await managedFile(asset, file.storedPath);
      const analysis = await inspectCharacterModel(managed.sourcePath, analyze);
      if (analysis.error || analysis.meshKind !== entry.kind) throw new Error('LOD 模型类型与主模型不一致：' + file.normalizedName);
      if ((analysis.materialNames || []).some(slot => !slots.has(slot))) throw new Error('LOD 材质槽必须沿用主模型名称：' + file.normalizedName);
      if (entry.kind === 'skeletalMesh' && (!analysis.hasSkin || !(analysis.bones || []).length
        || analysis.bones.some(bone => !bones.has(bone.name) || bones.get(bone.name) !== bone.parent))) {
        throw new Error('LOD 蒙皮或骨骼层级与主模型不兼容：' + file.normalizedName);
      }
      sources.push({ index, ...managed });
    }
    entry.config = { ...entry.config, lodImportVersion: 1, lodSources: sources };
    // Changes to any level invalidate this mesh, without creating another UE asset.
    entry.fingerprint = crypto.createHash('sha256').update(JSON.stringify({ previous: entry.fingerprint, lodSources: sources })).digest('hex');
  }
  // Pair by full normalized component identity, including variant/form/side.
  // Rebuild from the complete active manifest, so arrival order is irrelevant.
  for (const entry of result.entries.filter(item => item.kind === 'skeletalMesh')) {
    if (entry.config.lodSources?.some(source => source.index === 1)) continue;
    let base;
    for (const file of bases.filter(skeletal)) {
      if (absolute((await managedFile(asset, file.storedPath)).sourcePath) === absolute(entry.sourcePath)) { base = file; break; }
    }
    if (!base) continue;
    const candidates = files.filter(file => !skeletal(file)
      && lod.level(file.normalizedName || file.storedPath) === 1 && pairedIdentity(file) === pairedIdentity(base));
    if (candidates.length > 1) throw new Error('SM LOD1 来源不唯一：' + entry.name);
    let source, sourceLod = 0;
    if (candidates.length) source = await managedFile(asset, candidates[0].storedPath);
    else {
      const staticBases = bases.filter(file => !skeletal(file) && pairedIdentity(file) === pairedIdentity(base));
      if (staticBases.length > 1) throw new Error('SM LOD 来源不唯一：' + entry.name);
      if (!staticBases.length || staticBases[0].ignoreEmbeddedLods) continue;
      source = await managedFile(asset, staticBases[0].storedPath);
      if (await embeddedLodCount(source, analyze) < 2) continue;
      sourceLod = 1;
    }
    const analysis = await inspectCharacterModel(source.sourcePath, analyze);
    if (analysis.error || analysis.meshKind !== 'staticMesh') throw new Error('蒙皮 LOD 的几何来源必须为静态模型：' + entry.name);
    const staticEntry = result.entries.find(item => item.kind === 'staticMesh'
      && item.key === entry.key.replace(':skeletalMesh:', ':staticMesh:'));
    const sourceMaterials = { ...staticEntry?.externalMaterials };
    for (const [slot, key] of Object.entries(staticEntry?.materials || {})) {
      const material = result.entries.find(item => item.key === key && item.kind === 'material');
      if (material) sourceMaterials[slot] = material.targetPath;
    }
    entry.config = { ...entry.config, skinLodSource: { ...source, sourceLod, version: 1,
      ...(Object.keys(sourceMaterials).length ? { sourceMaterials } : {}) } };
    entry.fingerprint = crypto.createHash('sha256').update(JSON.stringify({ previous: entry.fingerprint,
      skinLodSource: { sourceHash: source.sourceHash, sourceLod, version: 1, sourceMaterials } })).digest('hex');
  }
}
module.exports = { attachCharacterLods };
