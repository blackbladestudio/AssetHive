const NAMING_KEYS = new Set(['name', 'nameformats', 'nameformat', 'title', 'displayname', 'assetname', 'filename', 'shortname']);
const VARIANT_KEYS = new Set(['variation', 'variant', 'variantkey', 'variantnumber', 'variationnumber']);
const normalizedKey = value => String(value).toLowerCase().replace(/[\s_-]+/g, '');
const { removeAssetNameTags } = require("../../shared/assetNameTags.mjs");

function removeMegascansNameTags(tags, metadata, extraNames = []) {
  return removeAssetNameTags(tags, metadata, extraNames).filter(tag => !/^\p{N}+$/u.test(String(tag).trim()));
}

function collectMegascansTags(metadata) {
  const values = [];
  const visit = (value, depth = 0, skipKeys) => {
    if (depth > 8 || value == null) return;
    if (typeof value === 'string') { if (value.trim()) values.push(value.trim().toLowerCase()); }
    else if (Array.isArray(value)) value.forEach(item => visit(item, depth + 1, skipKeys));
    else if (typeof value === 'object') for (const [key, item] of Object.entries(value)) {
      if (!skipKeys?.has(normalizedKey(key))) visit(item, depth + 1, skipKeys);
    }
  };
  for (const key of ['tags', 'categories', 'assetCategories', 'category', 'asset_type', 'assetType', 'type', 'biome', 'theme']) visit(metadata?.[key]);
  for (const [key, value] of Object.entries(metadata?.semanticTags || {})) {
    const normalized = normalizedKey(key);
    if (!NAMING_KEYS.has(normalized) && !VARIANT_KEYS.has(normalized)) {
      visit(value, 0, normalized === 'namefields' ? new Set([...NAMING_KEYS, ...VARIANT_KEYS]) : undefined);
    }
  }
  return [...new Set(removeMegascansNameTags(values, metadata))].slice(0, 64);
}

module.exports = { collectMegascansTags, removeMegascansNameTags };
