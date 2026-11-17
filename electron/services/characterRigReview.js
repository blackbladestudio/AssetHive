const { withFileTransaction } = require('./assetFileTransaction');
const { withRecycleLock } = require('./libraryRecycle');
const { updateAssetMetadataFile } = require('./assetMetadata');
const { loadParent } = require('./characterComponents');
const { appendCharacterUpdateHistory } = require('./characterUpdateHistory');
const { characterModelGroups, characterRigReviewSignature } = require('../../shared/characterComponents.mjs');

async function reviewCharacterRig(options) {
  if (typeof options.needsRigging !== 'boolean') throw new Error('请选择是否需要重新绑定');
  const { root, parent } = await loadParent(options.root, options.asset, ['suit', 'monster', 'npc', 'weapon']);
  return withRecycleLock(root, () => withFileTransaction({ root, owner: 'character-components', key: parent.metaPath }, async () => {
    await updateAssetMetadataFile(parent.metaPath, meta => {
      const current = { ...parent, meta };
      const groups = characterModelGroups(current).filter(group => !options.slot || group.slot === options.slot);
      if (!groups.length) throw new Error('模型记录已变化，请刷新后确认');
      const scoped = options.slot ? { ...current, meta: { ...meta, componentView: { slot: options.slot }, characterManifest: { files: groups.flatMap(group => group.files) } } } : current;
      if (characterRigReviewSignature(scoped) !== options.expectedRevision) throw new Error('模型在确认前已更新，请重新查看后确认');
      const paths = new Set(groups.flatMap(group => group.files.filter(file => file.rigReviewPending).map(file => file.storedPath)));
      if (!paths.size) return meta;
      const update = file => paths.has(file.storedPath) ? { ...file, rigNeedsUpdate: options.needsRigging, rigReviewPending: false,
        rigReviewDecision: options.needsRigging ? 'required' : 'not-required', rigReviewedAt: new Date().toISOString() } : file;
      meta.characterManifest.files = meta.characterManifest.files.map(update);
      for (const state of Object.values(meta.characterComponents?.slots || {})) {
        for (const revision of state.revisions || []) if (revision.id === state.activeRevision) revision.files = revision.files.map(update);
      }
      appendCharacterUpdateHistory(meta, { label: options.needsRigging ? '确认需要重新绑定' : '确认无需重新绑定',
        details: { slot: options.slot || '', needsRigging: options.needsRigging }, files: groups.flatMap(group => group.files).filter(file => paths.has(file.storedPath)) });
      return meta;
    });
    return { ok: true, parentId: parent.id };
  }));
}
module.exports = { reviewCharacterRig };
