const path = require('node:path');
const { createHash } = require('node:crypto');
const shared = require('./characterSharedResources');
const { characterTextureChannel } = require('../../shared/characterFilePolicy.mjs');
const stem = name => path.basename(name, path.extname(name)).replace(/_[^_]+$/, '').toLowerCase();

// An added mask extends an existing shared material. Match through recorded
// texture references, then copy the mask to every owner's matching group.
function planSharedMaskAdditions(input, parent, files, changes) {
  let state = input;
  const operations = [], textures = [], removedTextures = [], references = [];
  const added = new Set(changes.filter(change => change.status === 'added').map(change => change.name.toLowerCase()));
  for (const file of files.filter(file => file.role === 'texture' && added.has(file.normalizedName.toLowerCase()) && characterTextureChannel(file.normalizedName) === 'ShadingMask')) {
    const materials = Object.values(state.resources).filter(resource => resource.evidence.kind === 'material'
      && resource.references.some(owner => owner.assetId === parent.id
        && Object.values(resource.evidence.textures).some(id => state.resources[id].references.some(ref => ref.assetId === parent.id
          && ref.localKey.startsWith(owner.localKey.replace(':material:', ':texture:') + ':')
          && ref.sourceName && stem(ref.sourceName) === stem(file.normalizedName)))));
    if (!materials.length) continue;
    if (materials.length !== 1) throw new Error('新增 ShadingMask 对应多个共享材质组，请美术确认贴图所属组');
    const material = materials[0];
    if (material.evidence.textures.ShadingMask) throw new Error('该共享材质已有 ShadingMask，请通过更新原贴图替换');
    const id = createHash('sha256').update(JSON.stringify([state.revision, parent.id, file.normalizedName, file.sha256])).digest('hex');
    let textureId;
    const targets = [];
    for (const owner of material.references) {
      const prefix = owner.localKey.replace(':material:', ':texture:') + ':';
      const anchors = Object.values(material.evidence.textures).flatMap(key => state.resources[key].references
        .filter(ref => ref.assetId === owner.assetId && ref.localKey.startsWith(prefix) && ref.sourceName)
        .map(ref => ({ ref, resource: state.resources[key] })));
      if (!anchors.length) throw new Error('共享材质的贴图来源记录缺失，请联系 TA：' + owner.localKey);
      const anchor = anchors[0];
      const sourceName = anchor.ref.sourceName.replace(/_[^_]+\.[^.]+$/, '_ShadingMask' + path.extname(file.normalizedName));
      const config = { ...anchor.resource.evidence.config };
      if (!config.heroPart) delete config.normalFormat;
      const request = {
        resourceId: id, scopeId: material.scopeId,
        reference: { assetId: owner.assetId, localKey: prefix + 'ShadingMask', metadataPath: owner.metadataPath, sourceName },
        evidence: { kind: 'texture', channel: 'ShadingMask', sourceHash: file.sha256, config },
        ueTarget: { key: prefix + 'ShadingMask', path: anchor.resource.ueTarget.path.replace(/_[^_/]+$/, '_ShadingMask') }
      };
      const registered = shared.registerResource(state, request);
      state = registered.state;
      textureId = registered.resource.id;
      operations.push({ type: 'register', request });
      targets.push({ ...request.reference, anchorName: anchor.ref.sourceName });
    }
    const plan = shared.planResourceUpdate(state, material.id, { ...material.evidence, textures: { ...material.evidence.textures, ShadingMask: textureId } });
    state = shared.applyResourceUpdate(state, plan);
    operations.push({ type: 'update', plan });
    references.push(...plan.references);
    textures.push({ resourceId: textureId, sourcePath: file.sourcePath, sourceHash: file.sha256, initiatingNames: [file.normalizedName.toLowerCase()], targets });
  }
  const removed = new Set(changes.filter(change => change.status === 'removed').map(change => change.name.toLowerCase()));
  for (const resource of Object.values(state.resources).filter(resource => resource.evidence.kind === 'material' && resource.evidence.textures.ShadingMask)) {
    const maskId = resource.evidence.textures.ShadingMask;
    const mask = state.resources[maskId];
    const targets = mask.references.filter(ref => resource.references.some(owner => owner.assetId === ref.assetId && ref.localKey === owner.localKey.replace(':material:', ':texture:') + ':ShadingMask'));
    if (!targets.some(ref => ref.assetId === parent.id && removed.has(String(ref.sourceName || '').toLowerCase()))) continue;
    const nextTextures = { ...resource.evidence.textures };
    delete nextTextures.ShadingMask;
    const plan = shared.planResourceUpdate(state, resource.id, { ...resource.evidence, textures: nextTextures });
    state = shared.applyResourceUpdate(state, plan);
    operations.push({ type: 'update', plan });
    state = shared.removeResourceReferences(state, maskId, targets);
    operations.push({ type: 'detach', resourceId: maskId, references: targets });
    references.push(...plan.references);
    removedTextures.push(...targets);
  }
  return { state, operations, textures, removedTextures, references };
}

module.exports = { planSharedMaskAdditions };
