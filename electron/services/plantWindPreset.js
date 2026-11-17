const { resolveMegascansCategory } = require("./megascansCategory");

const PLANT_WIND_FORMS = ["grass", "herb", "groundcover", "bush", "fern", "palm", "tree"];

// LOD0 dimensions in centimeters, in plant-local coordinates with Z up.
function fitsMicroSizeCm(size) {
  if (!Array.isArray(size) || size.length !== 3 || !size.every(n => Number.isFinite(n) && n >= 0)) return undefined;
  const [x, y, height] = size;
  if (height === 0 || Math.max(x, y) === 0) return undefined;
  return height <= 10 && Math.max(x, y) <= 60;
}

function isMicroPlantTag(tag) {
  return typeof tag === "string" && /^micro(?:[\s_-]*foliage)?$/i.test(tag.trim());
}

function isBridgeMicroPlant(metadata, asset = {}) {
  return [metadata?.standardAssetTags, asset.standardAssetTags]
    .flatMap(tags => Array.isArray(tags) ? tags : []).some(isMicroPlantTag);
}

// Bridge's legacy "plants / 3d" category covers everything from loose litter to palms.
// Prefer the named growth form, then the specific taxonomy and descriptive tags.
function classifyBridgePlantWind(metadata, asset = {}) {
  const meta = metadata ?? {};
  const words = (value) => typeof value === "string" ? value.trim().toLowerCase().replace(/[_-]+/g, " ") : "";
  const list = (value) => Array.isArray(value) ? value.map(words).filter(Boolean) : [];
  if ([...list(meta.standardAssetTags), ...list(asset.standardAssetTags)].some(isMicroPlantTag)) return "";
  const name = words(meta.name || asset.name);
  const category = words(meta.category || resolveMegascansCategory(meta, "3dplant") || asset.category);
  const tags = new Set([...list(meta.categories), ...list(meta.tags), ...list(asset.tags)]);
  const has = (...values) => values.some(value => tags.has(value));

  // Species names and aquatic habitat do not imply Micro or a static asset.
  // Auto determines Micro from every original variant's dimensions instead.
  if (/\b(dead leaves|leaf litter|clovers?|sorrel|shamrock|lichens?|moss)\b/.test(name) || has("leaf litter")) return "groundcover";
  if (/\beelgrass\b/.test(name)) return "grass";
  if (/\b(seaweed|water lily|water cabbage)\b/.test(name) || has("floating", "submerged", "seaweed")) return "herb";
  if (/\bpalms?\b/.test(name) || has("palm")) return "palm";
  if (/\b(ferns?|bracken)\b/.test(name) || has("fern", "ferns")) return "fern";
  if (category === "ground cover") return "groundcover";
  if (category === "tree" || category === "trees" || /\bdragon tree\b/.test(name)
      || [...list(meta.standardAssetTags), ...list(asset.standardAssetTags)].some(tag => tag === "tree" || tag === "herofoliage")) return "tree";
  if (/\b(shrubs?|bush|boxwood|saltbush|willow|birch|locust|elderberry|rabbitbrush|hydrangea)\b/.test(name)) return "bush";
  if (/\b(ivy|creeper|ground ?cover|periwinkle|moss|vine)\b/.test(name)) return "groundcover";
  if (/\b(desert cotton|daffodil|willowherb|snake plant|aloe|chamomile)\b/.test(name)) return "herb";
  if (/grass(es)?\b|\b(reeds?|wheat|barley|sedge|rush|bulrush)\b/.test(name)) return "grass";
  if (category === "fern") return "fern";
  if (category === "shrub" || category === "bush") return "bush";
  if (category === "climber" || category === "ground cover") return "groundcover";
  if (category === "grass" || category === "crop") return "grass";
  if (["herb", "weed", "flowering plant", "succulent"].includes(category)) return "herb";
  if (has("ground cover", "groundcover", "climber", "crawler")) return "groundcover";
  if (has("shrub", "bush", "small tree")) return "bush";
  if (has("grass", "sedge", "blades", "cereal")) return "grass";
  return "herb";
}

module.exports = { PLANT_WIND_FORMS, classifyBridgePlantWind, fitsMicroSizeCm, isBridgeMicroPlant, isMicroPlantTag };
