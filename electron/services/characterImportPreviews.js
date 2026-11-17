const path = require('node:path');
const { characterModelPreviewComponents: listCharacterComponents, characterMeshPreviewRevision } = require('../../shared/characterComponents.mjs');

// Resolve by source file, never by a draft name: the user may correct the
// Chinese name or suit number after scanning without needing another render.
async function saveCharacterImportPreviews({ meta, assetType, destinationDir, previews = [], saveImage, onProgress = () => {} }) {
  if (!['suit', 'monster', 'npc', 'weapon'].includes(assetType) || !previews.length) return;
  const parts = listCharacterComponents({ id: meta.assetID, name: meta.name, assetType, meta });
  const normalized = value => path.resolve(value).toLowerCase();
  const state = meta.characterComponents || { schemaVersion: 1, slots: {} };
  const views = ['front', 'left', 'right', 'back'];
  let done = 0;
  for (const preview of previews) {
    if (!['staticMesh', 'skeletalMesh'].includes(preview.meshKind)) throw new Error('部件预览类型无效');
    const part = parts.find(part => part.files.some(file => file.originalPath && normalized(file.originalPath) === normalized(preview.sourcePath)
      && file.role === preview.meshKind));
    // Standalone root models already use the prepared owner four views.
    // They must not become extra outfit-style component cards.
    if (!part && (assetType !== 'suit' || meta.character?.variant)) {
      const model = meta.characterManifest?.files?.find(file => file.originalPath && normalized(file.originalPath) === normalized(preview.sourcePath) && file.role === preview.meshKind);
      if (!model || views.some(view => !preview.paths?.[view])) throw new Error('预览与导入模型不匹配，请重新检查文件夹');
      if (preview.sourceHash && preview.sourceHash !== model.sha256) throw new Error('模型在扫描后已变化，请重新检查文件夹');
      continue;
    }
    if (!part || views.some(view => !preview.paths?.[view])) throw new Error('部件预览与导入模型不匹配，请重新检查文件夹');
    const model = part.files.find(file => file.originalPath && normalized(file.originalPath) === normalized(preview.sourcePath));
    if (preview.sourceHash && preview.sourceHash !== model.sha256) throw new Error('模型在扫描后已变化，请重新检查文件夹');
    const images = await Promise.all(views.map(async view => {
      const destination = await saveImage(preview.paths[view], `${preview.meshKind}_${part.slot}_${view}`);
      if (!destination) throw new Error('无法保存部件四视图');
      onProgress(++done, previews.length * 4);
      return { uri: path.relative(destinationDir, destination).replace(/\\/g, '/'), tags: ['preview', `view:${view}`, 'origin:auto', ...(view === 'front' ? ['cover'] : [])] };
    }));
    const slot = state.slots[part.slot] || {};
    state.slots[part.slot] = { ...slot, meshPreviews: { ...slot.meshPreviews, [preview.meshKind]: {
      previewUri: images[0].uri, previewImages: images, previewOrigin: 'rendered', previewRevision: characterMeshPreviewRevision(part.files, preview.meshKind)
    } } };
  }
  meta.characterComponents = state;
}
module.exports = { saveCharacterImportPreviews };
