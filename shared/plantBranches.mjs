// USDA/Wind is an alternate representation of the same library asset.
export function plantBranches(asset, metadata = asset?.meta || {}) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) metadata = {};
  const files = new Set();
  const add = value => {
    const file = typeof value === "string" ? value : value?.file || value?.uri || value?.path || "";
    if (file) files.add(file);
  };
  for (const source of [asset?.modelFiles, metadata.modelFiles, metadata.modelVariants, metadata.modelLods]) {
    if (Array.isArray(source)) source.forEach(add);
  }
  Object.values(metadata.modelSlots || {}).forEach(add);
  if (Array.isArray(metadata.components)) {
    for (const component of metadata.components) if (component?.type === "model") add(component);
  }
  return {
    standard: metadata.plantBranches?.standard === true || [...files].some(file => /\.(fbx|st9|obj|abc|gltf|glb|ztl)$/i.test(file)),
    naniteFoliage: metadata.plantBranches?.naniteFoliage === true || Boolean(metadata.naniteFoliage?.variants?.length) || [...files].some(file => /\.usda$/i.test(file))
  };
}

export function useNaniteFoliageBranch(asset, metadata, requestedMode) {
  const branches = plantBranches(asset, metadata);
  return asset?.assetType === "3dplant" && branches.naniteFoliage
    && (requestedMode === "naniteFoliage" || !branches.standard);
}
