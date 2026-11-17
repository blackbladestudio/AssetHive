const token = value => String(value || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
const isDisplacement = value => ["displacement", "displacements"].includes(token(value));

// Bridge also includes "surface" in categories for displacement-only assets.
// Read the source classification, never infer an asset type from a map slot.
function isDisplacementMetadata(meta = {}, { legacy = false } = {}) {
  const explicit = [meta.assetType, meta.asset_type, meta.type, meta.semanticTags?.asset_type].some(isDisplacement)
    || Object.keys(meta.assetCategories || {}).some(isDisplacement)
    || (Array.isArray(meta.categories) && meta.categories.some(isDisplacement));
  if (explicit) return true;
  // Older imports merged this Bridge type into Surface but retained its exact
  // source tag. This is not the generic "displacement" tag or a texture slot.
  return legacy && meta.identity?.sourceKind === "megascans"
    && token(meta.assetType || meta.asset_type) === "surface"
    && (Array.isArray(meta.tags) && meta.tags.some(value => token(value) === "tileabledisplacement"));
}

module.exports = { isDisplacementMetadata };
