const { isMaskAsset } = require("../../shared/maskMaterials.mjs");
const path = require("node:path");
const { normalizeAssetTag, normalizeStandardAssetTag } = require("./assetTags");

const METADATA_UPDATE_VERSION = 2;
const ENVIRONMENT_ASSET_TYPES = new Set(["3d", "3dplant", "surface", "decal", "atlas", "imperfection", "displacement", "hdri"]);
const STANDARD_ASSET_TAGS_BY_TYPE = {
  "3d": ["Props", "Destructible", "Dressing", "ThirdParty", "Kits"],
  "3dplant": ["Tree", "Bush", "Grass", "Micro", "HeroFoliage", "ThirdParty"],
  surface: ["ThirdParty"],
  decal: ["ThirdParty"],
  atlas: ["ThirdParty"],
  imperfection: ["ThirdParty"],
  displacement: ["ThirdParty"],
  hdri: []
};
const CANONICAL_STANDARD_TAG_BY_KEY = new Map([
  ["props", "Props"],
  ["prop", "Props"],
  ["destructible", "Destructible"],
  ["dressing", "Dressing"],
  ["megascans", "Megascans"],
  ["quixel", "Megascans"],
  ["bridge", "Megascans"],
  ["pbrmax", "PBRMAX"],
  ["pbr max", "PBRMAX"],
  ["thirdparty", "ThirdParty"],
  ["tile", "Tile"],
  ["kit", "Kits"],
  ["kits", "Kits"],
  ["tree", "Tree"],
  ["bush", "Bush"],
  ["grass", "Grass"],
  ["micro", "Micro"],
  ["microfoliage", "Micro"],
  ["micro foliage", "Micro"],
  ["herofoliage", "HeroFoliage"],
  ["hero foliage", "HeroFoliage"]
]);

function normalizeToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function normalizeAssetType(value) {
  const token = normalizeToken(value);
  if (!token) return "";
  if (["3d", "3dasset", "3dassets", "asset3d"].includes(token)) return "3d";
  if (["3dplant", "3dplants", "plant3d", "foliage", "plants"].includes(token)) return "3dplant";
  if (["surface", "surfaces", "material", "materials"].includes(token)) return "surface";
  if (["atlas", "atlases"].includes(token)) return "atlas";
  if (["displacement", "displacements"].includes(token)) return "displacement";
  if (["imperfection", "imperfections", "surfaceimperfection"].includes(token)) return "imperfection";
  if (["decal", "decals"].includes(token)) return "decal";
  if (["hdri", "hdr"].includes(token)) return "hdri";
  if (token === "animation") return "animation";
  return token;
}

function normalizeTopCategory(value) {
  return String(value || "").trim().toLowerCase();
}

function pathLooksLikeAnimation(assetPath) {
  const normalized = String(assetPath || "").replace(/\\/g, "/").toLowerCase();
  return normalized.split("/").filter(Boolean).includes("animation");
}

function isAnimationLibraryAsset(asset = {}, meta = {}) {
  const assetType = normalizeAssetType(asset.assetType || meta.assetType || meta.asset_type);
  const topCategory = normalizeTopCategory(asset.topCategory || meta.topCategory);
  return assetType === "animation"
    || topCategory === "animation"
    || pathLooksLikeAnimation(asset.path || asset.metaPath || meta.path);
}

function hasCurrentMetadataUpdateMarker(meta = {}) {
  return Number(meta?.metadataUpdate?.version) === METADATA_UPDATE_VERSION;
}

function buildMetadataUpdateMarker(now = new Date().toISOString()) {
  return {
    version: METADATA_UPDATE_VERSION,
    updatedAt: String(now || "").trim() || new Date().toISOString()
  };
}

function getSyncedTopCategory(assetType, fallback = "") {
  const normalized = normalizeAssetType(assetType);
  if (ENVIRONMENT_ASSET_TYPES.has(normalized)) return "environment";
  if (normalized === "animation") return "animation";
  return String(fallback || "").trim();
}

function normalizeStandardAssetTagsForSync(values, assetType) {
  const source = Array.isArray(values) ? values : (values ? [values] : []);
  const normalizedType = normalizeAssetType(assetType);
  const allowed = STANDARD_ASSET_TAGS_BY_TYPE[normalizedType];
  const allowedSet = Array.isArray(allowed) ? new Set(allowed) : null;
  const result = [];
  for (const raw of source) {
    const text = String(raw || "").trim();
    if (!text) continue;
    const key = text.replace(/[\s_-]+/g, " ").trim().toLowerCase();
    const compactKey = normalizeToken(key);
    const canonical = normalizeStandardAssetTag(CANONICAL_STANDARD_TAG_BY_KEY.get(key)
      || CANONICAL_STANDARD_TAG_BY_KEY.get(compactKey)
      || text);
    if (!canonical) continue;
    if (allowedSet && !allowedSet.has(canonical)) continue;
    if (!result.includes(canonical)) result.push(canonical);
  }
  return result;
}

function normalizeTagList(values) {
  const source = Array.isArray(values) ? values : [];
  return [...new Set(source
    .map((value) => normalizeAssetTag(String(value || "").trim()))
    .filter(Boolean))];
}

function collectRegularTags(meta, context) {
  const automaticKeys = new Set([
    context.assetType,
    context.previousAssetType,
    context.topCategory,
    context.previousTopCategory,
    context.category,
    context.animationAffiliation,
    ...context.standardAssetTags,
    ...context.previousStandardAssetTags,
    ...context.zionTags
  ].map((value) => String(value || "").trim().toLowerCase()).filter(Boolean));
  return normalizeTagList(meta?.tags).filter((tag) => !automaticKeys.has(tag.toLowerCase()));
}

function buildSyncedAssetMetadataFields(input = {}) {
  const asset = input.asset && typeof input.asset === "object" ? input.asset : {};
  const meta = input.meta && typeof input.meta === "object" ? input.meta : {};
  const assetType = normalizeAssetType(input.assetType || asset.assetType || meta.assetType || meta.asset_type);
  const previousAssetType = normalizeAssetType(meta.assetType || meta.asset_type || asset.assetType);
  const category = String(meta.category || asset.category || assetType || "custom").trim() || "custom";
  const previousTopCategory = String(meta.topCategory || asset.topCategory || "").trim();
  const topCategory = getSyncedTopCategory(assetType, previousTopCategory);
  const previousStandardAssetTags = normalizeStandardAssetTagsForSync(
    (Array.isArray(meta.standardAssetTags) && meta.standardAssetTags.length > 0 ? meta.standardAssetTags : meta.subType || asset.standardAssetTags),
    previousAssetType || assetType
  );
  const standardAssetTags = normalizeStandardAssetTagsForSync(
    (Array.isArray(meta.standardAssetTags) && meta.standardAssetTags.length > 0
      ? meta.standardAssetTags
      : (Array.isArray(asset.standardAssetTags) && asset.standardAssetTags.length > 0 ? asset.standardAssetTags : meta.subType)),
    assetType
  );
  const zionTags = normalizeTagList(meta.zionTags || asset.zionTags).slice(0, 1);
  const animationAffiliation = assetType === "animation"
    ? String(meta.animationAffiliation || asset.animationAffiliation || "").trim()
    : "";
  const regularTags = collectRegularTags(meta, {
    assetType,
    previousAssetType,
    topCategory,
    previousTopCategory,
    category,
    animationAffiliation,
    standardAssetTags,
    previousStandardAssetTags,
    zionTags
  });
  const tags = normalizeTagList([
    ...regularTags.filter(tag => assetType !== "3d" || !/^(mega|mask)$/i.test(tag)),
    ...[...(meta.standardAssetTags || []), ...(asset.standardAssetTags || []), meta.subType]
      .filter((tag) => /^(megascans|pbrmax)$/i.test(String(tag || ""))),
    assetType,
    category.toLowerCase(),
    animationAffiliation,
    ...standardAssetTags,
    ...zionTags
  ]);
  const categories = [...new Set([
    topCategory,
    assetType,
    category.toLowerCase(),
    animationAffiliation
  ].map((value) => String(value || "").trim()).filter(Boolean))];
  const semanticTags = {
    ...(meta.semanticTags && typeof meta.semanticTags === "object" && !Array.isArray(meta.semanticTags)
      ? meta.semanticTags
      : {}),
    name: String(meta.name || asset.name || path.basename(String(asset.path || "")) || "").trim(),
    asset_type: assetType,
    contains: tags,
    theme: [...new Set([category, animationAffiliation].filter(Boolean))]
  };

  return {
    assetID: String(asset.id || meta.assetID || meta.id || "").trim(),
    name: String(meta.name || asset.name || path.basename(String(asset.path || "")) || "").trim(),
    slug: String(meta.slug || asset.slug || path.basename(String(asset.path || "")) || "").trim(),
    source: "custom",
    assetType,
    asset_type: assetType,
    textureGroupMode: assetType === "3d" ? (isMaskAsset({ ...asset, ...meta, assetType }) ? "channel" : "texture") : undefined,
    topCategory,
    standardAssetTags,
    category,
    zionTags,
    animationAffiliation: animationAffiliation || undefined,
    tags,
    categories,
    semanticTags
  };
}

module.exports = {
  METADATA_UPDATE_VERSION,
  ENVIRONMENT_ASSET_TYPES,
  STANDARD_ASSET_TAGS_BY_TYPE,
  normalizeAssetType,
  getSyncedTopCategory,
  isAnimationLibraryAsset,
  hasCurrentMetadataUpdateMarker,
  buildMetadataUpdateMarker,
  normalizeStandardAssetTagsForSync,
  buildSyncedAssetMetadataFields
};
