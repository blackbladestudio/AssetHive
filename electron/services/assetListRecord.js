// Keep texture inventories and editing metadata out of recurring renderer updates.
// Details are loaded separately through assets:getById before editing/exporting.
function toAssetListRecord(asset) {
  if (!asset || typeof asset.id !== "string" || !asset.id.trim()) return null;
  const meta = asset.meta || {};
  const analysis = asset.textureAnalysis || meta.textureAnalysis;
  return {
    id: asset.id,
    assetID: asset.assetID,
    name: asset.name,
    source: asset.source,
    path: asset.path,
    metaPath: asset.metaPath,
    assetType: asset.assetType,
    topCategory: asset.topCategory || meta.topCategory,
    standardAssetTags: asset.standardAssetTags || meta.standardAssetTags,
    zionTags: asset.zionTags || meta.zionTags,
    zionExportSubfolder: asset.zionExportSubfolder,
    baseTiling: asset.baseTiling,
    subType: asset.subType,
    hasCollision: asset.hasCollision,
    animationAffiliation: asset.animationAffiliation || meta.animationAffiliation,
    previewSkeletonPath: asset.previewSkeletonPath,
    previewSkeletalMeshPath: asset.previewSkeletalMeshPath,
    // Batch plant export options inspect the original model extensions.
    modelFiles: asset.modelFiles,
    textureAnalysis: analysis ? { maxTextureDimension: analysis.maxTextureDimension } : undefined,
    tags: asset.tags,
    themes: asset.themes,
    categories: asset.categories,
    colorTags: asset.colorTags,
    preview: asset.preview,
    previewImage: asset.previewImage,
    detailImage: asset.detailImage,
    createdAt: asset.createdAt,
    favorite: asset.favorite,
    meta: {
      // Character cards need their component inventory, not only environment tags.
      ...(["monster", "suit", "npc", "weapon", "item"].includes(asset.assetType) ? {
        character: meta.character,
        characterManifest: meta.characterManifest,
        characterMetrics: meta.characterMetrics,
        characterImportGroupId: meta.characterImportGroupId,
        characterComponents: meta.characterComponents,
        characterPackageHistory: meta.characterPackageHistory
      } : {}),
      assetID: meta.assetID,
      slug: meta.slug,
      category: meta.category,
      tags: meta.tags,
      categories: meta.categories,
      themes: meta.themes,
      standardAssetTags: meta.standardAssetTags,
      zionTags: meta.zionTags,
      identity: meta.identity ? { sourceKind: meta.identity.sourceKind, sourceAssetId: meta.identity.sourceAssetId } : undefined,
      sourceKind: meta.sourceKind,
      nativePlantWind: Boolean(meta.nativePlantWind),
      previews: { relativeSize: meta.previews?.relativeSize || asset.relativeSize },
      scanInformation: { dimensions: meta.scanInformation?.dimensions },
      meta: Array.isArray(meta.meta) ? meta.meta
        .filter(entry => /^(length|width|height)$/i.test(String(entry?.key || "").trim()))
        .map(({ key, value }) => ({ key, value })) : undefined,
      semanticTags: {
        subject_matter: meta.semanticTags?.subject_matter,
        theme: meta.semanticTags?.theme,
        contains: meta.semanticTags?.contains,
        descriptive: meta.semanticTags?.descriptive,
        environment: meta.semanticTags?.environment,
        asset_type: meta.semanticTags?.asset_type,
        color: meta.semanticTags?.color
      },
      colorTags: meta.colorTags,
      colors: meta.colors
    }
  };
}

// The resident index keeps file inventories for HDRI fallback and legacy
// identity calculation, but does not retain whole source JSON documents. Full
// details still come from getAssetDetailsByMetaPath before editing/exporting.
function toAssetIndexRecord(asset) {
  const list = toAssetListRecord(asset);
  if (!list) return asset;
  // Flat animation records have no JSON sidecar: their metadata is authoritative.
  if (["animation", "hdri"].includes(String(asset.assetType).toLowerCase()) || /\.(fbx|abc)$/i.test(asset.metaPath || "")) return asset;
  const meta = asset.meta || {};
  const summary = list.meta;
  summary.identity = meta.identity;
  for (const key of ["id", "name", "assetName", "assetType", "asset_type", "topCategory", "animationAffiliation"]) {
    if (meta[key] !== undefined) summary[key] = meta[key];
  }
  // Share the analysis already kept at the top level rather than retaining a
  // second normalized copy; metadata-only legacy records still need theirs.
  summary.textureAnalysis = asset.textureAnalysis || meta.textureAnalysis;
  // Old assets without a saved fingerprint need the original slot/LOD semantics
  // for duplicate detection. Do not replace them with filename inference.
  if (!meta.identity?.contentFingerprint) {
    for (const key of ["modelSlots", "modelFiles", "modelLods", "textureEntries"]) {
      if (meta[key] !== undefined) summary[key] = meta[key];
    }
  }
  return { ...asset, meta: summary };
}

module.exports = { toAssetListRecord, toAssetIndexRecord };
