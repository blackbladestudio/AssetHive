const path = require('node:path');
const shared = require('./characterSharedResources');
const { safePath } = require('./libraryRecycle');
const { activeCharacterFiles } = require('../../shared/characterComponents.mjs');

// Used by import and by existing related packages on their first export. Every
// reference is to a managed file; grouping is explicit import-batch provenance.
async function registerManifestResources(root, state, assets, suits, appearance = null) {
  const byAsset = new Map(assets.map(asset => [asset.id, asset]));
  let next = state;
  for (const suit of suits) {
    const asset = byAsset.get(suit.assetId);
    if (!asset) throw new Error('共享资源的所属资产未加载，请刷新后重试');
    if (!asset.meta?.characterImportGroupId && !Object.values(next.resources).some(resource => resource.references.some(ref => ref.assetId === asset.id))) continue;
    const metadata = await safePath(root, asset.metaPath);
    const metadataPath = path.relative(root, metadata).replaceAll('\\', '/');
    const scopeId = asset.meta?.characterImportGroupId || `asset:${asset.id}`;
    const files = activeCharacterFiles(asset);
    const localTextures = new Map();
    const register = input => {
      if (appearance) {
        const existing = Object.values(next.resources).find(resource => resource.references.some(ref => ref.assetId === asset.id && ref.localKey === input.reference.localKey));
        const incoming = shared.evidenceDigest(input.evidence);
        const previous = existing?.references.find(ref => ref.assetId === asset.id && ref.localKey === input.reference.localKey);
        input.reference.localEvidence = incoming;
        if (existing && shared.evidenceDigest(existing.evidence) !== incoming && shared.sameResourceContent(existing.evidence, input.evidence)) {
          const explicit = appearance.explicitKeys?.has(input.reference.localKey);
          if (explicit || !previous.localEvidence || previous.localEvidence !== incoming) {
            if (appearance.requested.has(existing.id) && appearance.requested.get(existing.id) !== incoming) throw new Error('同一共享材质或贴图选择了不同设置，请统一后重新检查');
            appearance.requested.set(existing.id, incoming);
            const plan = shared.planResourceUpdate(next, existing.id, input.evidence);
            next = shared.applyResourceUpdate(next, plan);
            appearance.references.push(...plan.references);
          } else {
            input.evidence = next.resources[existing.id].evidence;
          }
        }
      }
      const registered = shared.registerResource(next, input);
      next = registered.state;
      return registered;
    };
    for (const entry of suit.entries.filter(item => item.kind === 'texture' && !item.validationError)) {
      const source = await safePath(root, entry.sourcePath);
      const file = files.find(item => path.resolve(asset.path, item.storedPath).toLowerCase() === path.resolve(source).toLowerCase());
      if (!file || file.role !== 'texture') throw new Error('共享贴图不在该资产的有效文件清单中，请重新检查');
      const registered = register({
        reference: { assetId: asset.id, localKey: entry.key, metadataPath, sourceName: file.normalizedName },
        evidence: { kind: 'texture', sourceHash: entry.sourceHash, channel: entry.channel, config: entry.config },
        scopeId, ueTarget: { key: entry.key, path: entry.targetPath }
      });
      next = registered.state;
      if (appearance) entry.config = globalThis.structuredClone(registered.resource.evidence.config);
      localTextures.set(entry.key, registered.resource.id);
    }
    for (const entry of suit.entries.filter(item => item.kind === 'material' && !item.validationError && !item.config?.blockoutMaterial)) {
      if (Object.values(entry.textures || {}).some(key => !localTextures.has(key))) continue;
      const registered = register({
        reference: { assetId: asset.id, localKey: entry.key, metadataPath },
        evidence: { kind: 'material', parentPath: entry.config?.parentPath, config: entry.config,
          textures: Object.fromEntries(Object.entries(entry.textures || {}).map(([channel, key]) => [channel, localTextures.get(key)])) },
        scopeId, ueTarget: { key: entry.key, path: entry.targetPath }
      });
      next = registered.state;
      if (appearance) {
        entry.config = globalThis.structuredClone(registered.resource.evidence.config);
        if (entry.materialType !== undefined) entry.materialType = entry.config.materialRole === 'monsterSkin' ? 'skin' : 'cloth';
      }
    }
  }
  return next;
}

async function prepareSharedExport(root, assets, suits, explicitKeys = new Set()) {
  if (!root) return { suits, aliases: {} };
  const projected = globalThis.structuredClone(suits);
  const appearance = { explicitKeys, requested: new Map(), references: [] };
  const registered = await shared.mutateRegistry(root, async state => ({ state: await registerManifestResources(root, state, assets, projected, appearance) }));
  // Later owners in this batch may request a change. Project every earlier
  // owner through the resulting setting before deduplicating the UE payload.
  const materialTypes = {};
  const sharedResources = [];
  for (const suit of projected) for (const entry of suit.entries) {
    const resource = Object.values(registered.state.resources).find(item => item.references.some(ref => ref.assetId === suit.assetId && ref.localKey === entry.key));
    if (!resource) continue;
    if (new Set(resource.references.map(ref => ref.assetId)).size > 1) {
      sharedResources.push({ key: resource.ueTarget.key, assetIds: [...new Set(resource.references.map(ref => ref.assetId))] });
      appearance.references.push(...resource.references);
    }
    entry.config = globalThis.structuredClone(resource.evidence.config);
    if (entry.materialType !== undefined) materialTypes[entry.key] = entry.materialType = entry.config.materialRole === 'monsterSkin' ? 'skin' : 'cloth';
  }
  const affectedAssets = [];
  for (const ref of new Map(appearance.references.map(ref => [ref.assetId, ref])).values()) {
    const file = await safePath(root, path.resolve(root, ref.metadataPath));
    const meta = JSON.parse((await require('node:fs/promises').readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
    affectedAssets.push({ assetId: ref.assetId, name: meta.name || ref.assetId });
  }
  return { ...shared.projectSharedEntries(registered.state, projected), materialTypes, affectedAssets, sharedResources };
}

function localizeSharedRows(rows, aliases) {
  return shared.expandSharedReceipts(rows, aliases).map(row => ({ ...row,
    ...(row.effectiveDependencies ? { effectiveDependencies: row.effectiveDependencies.map(key =>
      aliases[key]?.find(owner => owner.assetId === row.assetId)?.localKey || aliases[key]?.[0]?.localKey || key) } : {}) }));
}

function projectStatusEntries(entries) {
  const aliases = {};
  const projected = new Map();
  for (const entry of entries) {
    const key = entry.sharedEntryKey || entry.key;
    if (entry.sharedEntryKey) (aliases[key] ||= []).push({ assetId: entry.assetId, localKey: entry.key });
    projected.set(key, { key, path: entry.path, kind: entry.kind });
  }
  return { entries: [...projected.values()], aliases };
}

module.exports = { registerManifestResources, prepareSharedExport, localizeSharedRows, projectStatusEntries };
