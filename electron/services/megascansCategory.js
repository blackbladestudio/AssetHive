const CATEGORY_OPTIONS = Object.freeze({
  "3d": Object.freeze(["Building", "Food", "Historical", "Industrial", "Interior", "Nature", "Props", "Street"]),
  "3dplant": Object.freeze(["Aquatic", "Climber", "Crop", "Fern", "Flowering Plant", "Garden Plant", "Grass", "Ground Cover", "Herb", "Houseplant", "Shrub", "Succulent", "Weed"]),
  surface: Object.freeze(["Asphalt", "Bark", "Branch", "Brick", "Coal", "Concrete", "Debris", "Fabric", "Grass", "Gravel", "Ground", "Historical", "Marble", "Metal", "Moss", "Plaster", "Rock", "Roofing", "Sand", "Snow", "Soil", "Stone", "Tile", "Wood", "Other"]),
  decal: Object.freeze(["Blood", "Commercial", "Concrete", "Debris", "Door", "Fabric", "Graffiti", "Leakage", "Metal", "Moss", "Mud", "Stone", "Street", "Tree", "Trim", "Vegetation", "Wood", "Other"]),
  atlas: Object.freeze(["Debris", "Fern", "Fresh Water", "Grass", "Herb", "Moss", "Ocean", "Other", "Plant", "Shrub", "Tree", "Vine", "Weed"]),
  displacement: Object.freeze([]),
  imperfection: Object.freeze(["Damage", "Dirt", "Fingerprint", "Frost", "Grain", "Grunge", "Leakage", "Metal", "Rubber", "Stain", "Stone", "Wipe Mark", "Other"]),
  hdri: Object.freeze(["Outdoor", "Skies", "Indoor", "Studio", "Sunrise/Sunset", "Night", "Nature", "Urban"])
});

const CATEGORY_ALIASES = Object.freeze({
  "3d": Object.freeze({
    concrete: "Building",
    pillar: "Building",
    beam: "Building",
    wall: "Building",
    castle: "Historical",
    medieval: "Historical",
    storage: "Industrial",
    furniture: "Interior",
    decoration: "Interior",
    rock: "Nature",
    cliff: "Nature",
    bone: "Nature",
    sandstone: "Nature",
    prop: "Props",
    hardware: "Props",
    weapon: "Props",
    weaponry: "Props",
    container: "Props",
    barrel: "Props",
    tank: "Props",
    antique: "Props",
    sculpture: "Props",
    wood: "Props"
  }),
  "3dplant": Object.freeze({
    plant: "Garden Plant",
    plants: "Garden Plant",
    flora: "Garden Plant"
  }),
  surface: Object.freeze({
    imperfection: "Other",
    imperfections: "Other",
    grunge: "Other",
    damage: "Other",
    dust: "Other",
    stain: "Other",
    stains: "Other",
    leakage: "Other",
    varnish: "Other",
    frost: "Other",
    fingerprint: "Other",
    "finger prints": "Other",
    scratches: "Other",
    "micro scratches": "Other",
    spangle: "Other",
    "wipe mark": "Other",
    "wipe marks": "Other",
    "whipe marks": "Other",
    grain: "Other",
    rubber: "Other",
    plastic: "Other",
    paper: "Other",
    lavafield: "Other",
    misc: "Other",
    miscellaneous: "Other",
    other: "Other",
    road: "Other",
    wall: "Plaster",
    mud: "Soil"
  }),
  decal: Object.freeze({
    plant: "Vegetation",
    plants: "Vegetation",
    fern: "Vegetation",
    road: "Street",
    curb: "Street",
    gutter: "Street",
    "manhole cover": "Street",
    damage: "Concrete",
    crack: "Concrete",
    patch: "Concrete"
  }),
  imperfection: Object.freeze({
    dust: "Dirt",
    fingerprints: "Fingerprint",
    "finger prints": "Fingerprint",
    "wipe marks": "Wipe Mark",
    wipemark: "Wipe Mark",
    "whipe marks": "Wipe Mark"
  }),
  hdri: Object.freeze({
    sky: "Skies",
    clouds: "Skies",
    interior: "Indoor",
    outside: "Outdoor"
  })
});

const CATEGORY_ROOTS = Object.freeze({
  "3d": Object.freeze(["3d", "3dasset", "3dassets", "asset3d"]),
  "3dplant": Object.freeze(["3dplant", "3dplants", "plant3d", "3dplantasset"]),
  surface: Object.freeze(["surface", "surfaces", "material", "materials"]),
  displacement: Object.freeze(["displacement", "displacements"]),
  decal: Object.freeze(["decal", "decals"]),
  atlas: Object.freeze(["atlas", "atlases"]),
  imperfection: Object.freeze(["imperfection", "imperfections", "surfaceimperfection"]),
  hdri: Object.freeze(["hdri", "hdr", "sky", "environment"])
});

const SOURCE_CATEGORY_TOKENS = new Set([
  "3d", "3dasset", "3dassets", "asset3d",
  "3dplant", "3dplants", "plant3d", "3dplantasset",
  "surface", "surfaces", "material", "materials", "tile", "tiles", "tiling", "imperfection", "imperfections", "displacement", "displacements",
  "atlas", "atlases", "decal", "decals", "hdri", "hdr", "environment", "sky",
  "brush", "brushes", "smartmaterial", "smartmaterials", "mixer"
]);

function normalizeAssetType(value) {
  const token = String(value || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (["3d", "3dasset", "3dassets", "asset3d"].includes(token)) return "3d";
  if (["3dplant", "3dplants", "plant3d"].includes(token)) return "3dplant";
  if (["surface", "surfaces", "material", "materials", "tile", "tiles", "tiling"].includes(token)) return "surface";
  if (["displacement", "displacements"].includes(token)) return "displacement";
  if (["atlas", "atlases"].includes(token)) return "atlas";
  if (["imperfection", "imperfections", "surfaceimperfection"].includes(token)) return "imperfection";
  if (["decal", "decals"].includes(token)) return "decal";
  if (["hdri", "hdr", "environment", "sky"].includes(token)) return "hdri";
  return token;
}

function normalizeCategoryText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function compactCategoryText(value) {
  return normalizeCategoryText(value).replace(/\s+/g, "");
}

function findOption(assetType, value) {
  const options = CATEGORY_OPTIONS[assetType] || [];
  const normalized = normalizeCategoryText(value);
  if (!normalized) return "";
  return options.find((option) => normalizeCategoryText(option) === normalized) || "";
}

function resolveCategoryToken(assetType, value, rootName = "") {
  const normalized = normalizeCategoryText(value);
  if (!normalized) return "";
  if (assetType === "surface" && ["imperfection", "imperfections"].includes(compactCategoryText(rootName))) {
    return findOption(assetType, "Other");
  }
  const direct = findOption(assetType, normalized);
  if (direct) return direct;
  const aliased = CATEGORY_ALIASES[assetType]?.[normalized] || "";
  return aliased ? findOption(assetType, aliased) : "";
}

function isCompatibleCategoryRoot(assetType, rootName) {
  const roots = CATEGORY_ROOTS[assetType] || [];
  const token = compactCategoryText(rootName);
  return roots.includes(token);
}

function collectStringValues(value, result, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) result.push(trimmed);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, result, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) collectStringValues(item, result, depth + 1);
  }
}

function collectCategoryHints(meta, assetType) {
  const rawValues = [];
  for (const key of ["categories", "category"]) {
    collectStringValues(meta?.[key], rawValues);
  }
  collectStringValues(meta?.semanticTags?.category, rawValues);
  return rawValues.map((raw, index) => {
    const normalized = normalizeCategoryText(raw);
    return {
      index,
      raw: normalized,
      source: SOURCE_CATEGORY_TOKENS.has(compactCategoryText(normalized)),
      category: resolveCategoryToken(assetType, normalized)
    };
  });
}

function collectAssetCategoryCandidates(meta, assetType) {
  const roots = meta?.assetCategories;
  if (!roots || typeof roots !== "object" || Array.isArray(roots)) return [];
  const candidates = [];
  for (const [rootName, children] of Object.entries(roots)) {
    if (!isCompatibleCategoryRoot(assetType, rootName)) continue;
    if (!children || typeof children !== "object" || Array.isArray(children)) continue;
    for (const [rawKey] of Object.entries(children)) {
      const category = resolveCategoryToken(assetType, rawKey, rootName);
      if (!category) continue;
      candidates.push({
        category,
        key: normalizeCategoryText(rawKey),
        order: candidates.length
      });
    }
  }
  return candidates;
}

function scoreCandidate(candidate, hints) {
  let score = 100 - candidate.order;
  const exactHint = hints.find((hint) => !hint.source && hint.raw === candidate.key);
  if (exactHint) {
    return score + 1000 - exactHint.index;
  }
  const canonicalHint = hints.find((hint) => !hint.source && hint.category === candidate.category);
  if (canonicalHint) {
    score += 500 - canonicalHint.index;
  }
  if (candidate.category === "Other") {
    score -= 25;
  }
  return score;
}

function resolveMegascansCategory(meta, assetType) {
  const normalizedType = normalizeAssetType(assetType);
  if (!CATEGORY_OPTIONS[normalizedType]) return "";
  const hints = collectCategoryHints(meta, normalizedType);
  const candidates = collectAssetCategoryCandidates(meta, normalizedType);
  if (candidates.length > 0) {
    return candidates
      .map((candidate) => ({ ...candidate, score: scoreCandidate(candidate, hints) }))
      .sort((a, b) => b.score - a.score)[0].category;
  }
  for (const hint of hints) {
    if (!hint.source && hint.category) return hint.category;
  }
  const directCategory = resolveCategoryToken(normalizedType, meta?.category);
  return directCategory || (normalizedType === "imperfection" ? "Other" : "");
}

module.exports = {
  CATEGORY_OPTIONS,
  normalizeAssetType,
  resolveMegascansCategory
};
