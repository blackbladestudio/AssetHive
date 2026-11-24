const path = require('node:path');
const crypto = require('node:crypto');
const lod = require('../../shared/characterLods.cjs');
const { activeCharacterFiles } = require('../../shared/characterComponents.mjs');
const { inspectCharacterModel } = require('./characterFileInspection');
const model = file => ['model', 'staticMesh', 'skeletalMesh'].includes(file.role);
const meshIdentity = file => (file.role === 'skeletalMesh' ? 'SK:' : 'SM:') + lod.identity(file.normalizedName || file.storedPath).replace(/^(?:sk|sm)_/i, '');
const absolute = value => path.resolve(value).toLowerCase();

async function attachCharacterLods(result, asset, options, analyze, managedFile) {
  for (const entry of result.entries.filter(item => ['staticMesh', 'skeletalMesh'].includes(item.kind))) {
    entry.config = { ...entry.config, lodPolicy: 'lod1-reduction-v2' };
    entry.fingerprint = crypto.createHash('sha256').update(JSON.stringify({ previous: entry.fingerprint, lodPolicy: entry.config.lodPolicy })).digest('hex');
  }
  const files = activeCharacterFiles(asset).filter(model);
  const bases = files.filter(file => !lod.level(file.normalizedName || file.storedPath));
  const chains = new Map();
  for (const file of files) {
    const name = file.normalizedName || file.storedPath;
    const index = lod.level(name);
    if (!index) continue;
    if (!/\.fbx$/i.test(name)) throw new Error('独立 LOD 仅支持 FBX；Groom 请使用 UE Groom 自身的 LOD 设置：' + name);
    const matches = bases.filter(base => meshIdentity(base) === meshIdentity(file));
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
}
module.exports = { attachCharacterLods };
