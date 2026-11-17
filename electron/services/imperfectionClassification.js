const token = value => String(value || "").trim().toLowerCase().replace(/[\s_-]+/g, "");

function isImperfectionMetadata(meta = {}, { legacy = false } = {}) {
  const types = [meta.assetType, meta.asset_type, meta.type, meta.semanticTags?.asset_type];
  if (types.some(value => ["imperfection", "imperfections", "surfaceimperfection"].includes(token(value)))) return true;
  if (Object.keys(meta.assetCategories || {}).some(value => /^(imperfections?|surfaceimperfection)$/.test(token(value)))) return true;
  if ((Array.isArray(meta.categories) ? meta.categories : []).some(value => /^(imperfections?|surfaceimperfection)$/.test(token(value)))) return true;
  // Older Bridge imports retained the source type in tags after merging it into
  // Surfaces. The plural descriptive tag alone also appears on ordinary PBRs.
  if (!legacy || meta.identity?.sourceKind !== "megascans" || token(meta.assetType || meta.asset_type) !== "surface") return false;
  const tags = (Array.isArray(meta.tags) ? meta.tags : []).map(token);
  if (tags.includes("surfaceimperfection")) return true;
  const slots = (Array.isArray(meta.textureEntries) ? meta.textureEntries : []).map(entry => token(entry.textureType));
  return tags.includes("imperfection") && slots.includes("roughness")
    && slots.every(slot => ["roughness", "gloss", "mask"].includes(slot));
}

module.exports = { isImperfectionMetadata };
