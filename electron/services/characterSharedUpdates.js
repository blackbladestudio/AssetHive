const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const shared = require('./characterSharedResources');
const { safePath } = require('./libraryRecycle');
const { transactionalFs } = require('./assetFileTransaction');
const { updateAssetMetadataFile } = require('./assetMetadata');
const { activeCharacterFiles, characterModelPreviewComponents } = require('../../shared/characterComponents.mjs');
const hash = text => createHash('sha256').update(text).digest('hex');
const normalized = name => String(name || '').toLowerCase();
const metadataFingerprint = meta => hash(JSON.stringify({ id: meta.assetID || meta.id, assetType: meta.assetType,
  revision: meta.characterComponents?.contentRevision || 'initial', files: activeCharacterFiles({ assetType: meta.assetType, meta }) }));

async function prepareSharedFileUpdates(root, parent, files, changes) {
  let state = await shared.readRegistry(root);
  const changed = new Set(changes.filter(change => change.status === 'changed').map(change => normalized(change.name)));
  const updates = [], metadata = new Map();
  for (const resource of Object.values(state.resources)) {
    if (resource.evidence.kind !== 'texture') continue;
    const own = resource.references.filter(ref => ref.assetId === parent.id && changed.has(normalized(ref.sourceName)));
    if (!own.length) continue;
    const replacements = own.map(ref => files.find(item => normalized(item.normalizedName) === normalized(ref.sourceName)));
    if (replacements.some(file => !file || file.role !== 'texture')) throw new Error('共享贴图的更新文件无法对应，请重新检查');
    if (new Set(replacements.map(file => file.sha256.toLowerCase())).size !== 1) throw new Error('同一共享贴图提供了不同内容，请美术保留一份确认后的贴图再更新');
    const file = replacements[0];
    const plan = shared.planResourceUpdate(state, resource.id, { ...resource.evidence, sourceHash: file.sha256 });
    if (plan.unchanged) continue;
    for (const ref of plan.references) {
      if (metadata.has(ref.assetId)) continue;
      const metaPath = await safePath(root, path.resolve(root, ref.metadataPath));
      const text = await fs.readFile(metaPath, 'utf8');
      const meta = JSON.parse(text.replace(/^\uFEFF/, ''));
      if (String(meta.assetID || meta.id) !== ref.assetId) throw new Error('共享资源的所属资产已变化，请重新检查');
      metadata.set(ref.assetId, { assetId: ref.assetId, name: meta.name || ref.assetId, metadataPath: ref.metadataPath,
        contentFingerprint: metadataFingerprint(meta) });
    }
    updates.push({ plan, sourcePath: file.sourcePath, initiatingNames: own.map(ref => normalized(ref.sourceName)) });
    state = shared.applyResourceUpdate(state, plan);
  }
  const maskPlan = require('./characterSharedMaskUpdates').planSharedMaskAdditions(state, parent, files, changes);
  for (const ref of maskPlan.references) {
    if (metadata.has(ref.assetId)) continue;
    const metaPath = await safePath(root, path.resolve(root, ref.metadataPath));
    const meta = JSON.parse((await fs.readFile(metaPath, 'utf8')).replace(/^\uFEFF/, ''));
    if (String(meta.assetID || meta.id) !== ref.assetId) throw new Error('共享资源的所属资产已变化，请重新检查');
    metadata.set(ref.assetId, { assetId: ref.assetId, name: meta.name || ref.assetId, metadataPath: ref.metadataPath, contentFingerprint: metadataFingerprint(meta) });
  }
  return { updates, maskOperations: maskPlan.operations, addedMasks: maskPlan.textures, removedMasks: maskPlan.removedTextures, affectedAssets: [...metadata.values()] };
}

// Run inside the package update's existing library lock and file transaction.
// The initiating asset is written by that caller; all other owners join it here.
async function applySharedFileUpdates(root, parent, changeSet, note) {
  if (!changeSet || !changeSet.updates.length && !changeSet.addedMasks?.length && !changeSet.removedMasks?.length) return [];
  let state = await shared.readRegistry(root);
  for (const item of changeSet.updates) state = shared.applyResourceUpdate(state, item.plan);
  for (const operation of changeSet.maskOperations || []) {
    state = operation.type === 'register' ? shared.registerResource(state, operation.request).state
      : operation.type === 'detach' ? shared.removeResourceReferences(state, operation.resourceId, operation.references) : shared.applyResourceUpdate(state, operation.plan);
  }
  const work = new Map();
  for (const ref of changeSet.removedMasks || []) {
    if (ref.assetId === parent.id) continue;
    if (!work.has(ref.assetId)) work.set(ref.assetId, []);
    work.get(ref.assetId).push({ ref, remove: true });
  }
  for (const item of [...changeSet.updates, ...(changeSet.addedMasks || [])]) {
    const resource = state.resources[item.plan?.resourceId || item.resourceId];
    const actual = await require('./characterComponents').fileHash(item.sourcePath);
    if (actual !== resource.evidence.sourceHash) throw new Error('共享贴图在更新中变化，请重新检查');
    for (const ref of item.targets || resource.references) {
      if (ref.assetId === parent.id && item.initiatingNames.includes(normalized(ref.sourceName))) continue;
      if (!work.has(ref.assetId)) work.set(ref.assetId, []);
      work.get(ref.assetId).push({ ref, sourcePath: item.sourcePath, sourceHash: actual });
    }
  }
  for (const [assetId, replacements] of work) {
    const expected = changeSet.affectedAssets.find(item => item.assetId === assetId);
    const metaPath = await safePath(root, path.resolve(root, expected.metadataPath));
    const directory = path.dirname(metaPath);
    const revision = randomUUID();
    await updateAssetMetadataFile(metaPath, async meta => {
      // The initiating owner has already been checked and written by the caller
      // under this same library lock. Its other aliases still need the update.
      if (assetId !== parent.id && metadataFingerprint(meta) !== expected.contentFingerprint) throw new Error('共享资源或使用它的资产已变化，请重新检查影响范围');
      if (String(meta.assetID || meta.id) !== assetId) throw new Error('共享资源所属资产已变化，请刷新');
      const asset = { id: assetId, path: directory, metaPath, assetType: meta.assetType, meta };
      const active = activeCharacterFiles(asset);
      const parts = characterModelPreviewComponents(asset);
      const nextByName = new Map();
      const addedByAnchor = new Map();
      const removedNames = new Set();
      for (const replacement of replacements) {
        const matches = active.filter(file => file.role === 'texture' && normalized(file.normalizedName) === normalized(replacement.ref.sourceName));
        if (replacement.remove) {
          if (matches.length !== 1) throw new Error('待恢复的共享贴图已变化，请重新检查');
          removedNames.add(normalized(replacement.ref.sourceName));
          continue;
        }
        if ((matches.length !== 1 && !replacement.ref.anchorName) || (matches.length && replacement.ref.anchorName)) throw new Error('共享贴图引用无法唯一对应，请联系 TA：' + replacement.ref.sourceName);
        const anchors = replacement.ref.anchorName ? active.filter(file => normalized(file.normalizedName) === normalized(replacement.ref.anchorName)) : [];
        if (replacement.ref.anchorName && anchors.length !== 1) throw new Error('新增共享贴图的所属材质组已变化，请重新检查');
        const old = matches[0] || { ...anchors[0], normalizedName: replacement.ref.sourceName, originalName: path.basename(replacement.sourcePath) };
        const storedPath = `Versions/${revision}/Shared/${path.basename(old.normalizedName)}`;
        const destination = await safePath(root, path.join(directory, storedPath), { missing: true });
        await transactionalFs.mkdir(path.dirname(destination), { recursive: true });
        await transactionalFs.copyFile(replacement.sourcePath, destination);
        if (await require('./characterComponents').fileHash(destination) !== replacement.sourceHash) throw new Error('共享贴图写入校验失败，未发布更新');
        nextByName.set(normalized(old.normalizedName), { ...old, storedPath, size: (await fs.stat(destination)).size, sha256: replacement.sourceHash });
        if (replacement.ref.anchorName) addedByAnchor.set(normalized(old.normalizedName), normalized(replacement.ref.anchorName));
      }
      const at = new Date().toISOString();
      const snapshotKeys = ['name', 'character', 'characterManifest', 'characterMetrics', 'characterComponents', 'modelFiles', 'modelSlots', 'textureFiles', 'textureSlots', 'textureEntries', 'components', 'previews', 'previewImage', 'detailImage'];
      const snapshot = globalThis.structuredClone(Object.fromEntries(snapshotKeys.map(key => [key, meta[key]])));
      meta.characterPackageHistory = [...(meta.characterPackageHistory || []), { id: randomUUID(), createdAt: at, snapshot }];
      const replace = file => nextByName.get(normalized(file.normalizedName)) || file;
      meta.characterManifest.files = meta.characterManifest.files.filter(file => !removedNames.has(normalized(file.normalizedName))).map(replace);
      meta.characterManifest.files.push(...[...addedByAnchor.keys()].map(name => nextByName.get(name)));
      meta.characterManifest.fileCount = meta.characterManifest.files.length;
      const components = meta.characterComponents ||= { schemaVersion: 1, slots: {} };
      components.slots ||= {};
      for (const part of parts.filter(part => part.files.some(file => nextByName.has(normalized(file.normalizedName)) || removedNames.has(normalized(file.normalizedName)) || [...addedByAnchor.values()].includes(normalized(file.normalizedName))))) {
        const slot = components.slots[part.slot] ||= {};
        const added = [...addedByAnchor.entries()].filter(([, anchor]) => part.files.some(file => normalized(file.normalizedName) === anchor)).map(([name]) => nextByName.get(name));
        slot.revisions = [...(slot.revisions || []), { id: revision, createdAt: at, name: part.name, files: [...part.files.filter(file => !removedNames.has(normalized(file.normalizedName))).map(replace), ...added] }];
        slot.activeRevision = revision;
        slot.updatedAt = at;
      }
      components.contentRevision = revision;
      require('./characterComponents').markCharacterAutomaticPreviewsReloading(meta, components);
      await require('./characterComponents').syncActiveCharacterMetadata(meta, asset);
      require('./characterUpdateHistory').appendCharacterUpdateHistory(meta, { at, label: '共享贴图更新', note,
        changes: [...[...nextByName.values()].map(file => ({ name: file.normalizedName, status: addedByAnchor.has(normalized(file.normalizedName)) ? 'added' : 'changed' })),
          ...active.filter(file => removedNames.has(normalized(file.normalizedName))).map(file => ({ name: file.normalizedName, status: 'removed' }))],
        details: { sourceAssetId: parent.id } });
      meta.updatedAt = at;
      return meta;
    });
  }
  await shared.writeRegistryInTransaction(root, state);
  return [...new Set(changeSet.affectedAssets.map(item => item.assetId))];
}

module.exports = { prepareSharedFileUpdates, applySharedFileUpdates };
