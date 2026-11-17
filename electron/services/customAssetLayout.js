const path = require("node:path");

function sanitizeLayoutToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isFlatCustomAssetType(assetType) {
  return sanitizeLayoutToken(assetType) === "animation";
}

function isAnimationLibraryPath(filePath) {
  return /(^|[\\/])animation([\\/]|$)/i.test(String(filePath || ""));
}

function isAnimationModelMetaPath(metaPath) {
  const ext = path.extname(String(metaPath || "")).toLowerCase();
  return ext === ".fbx" || ext === ".abc";
}

function inferAnimationAffiliationFromPath(filePath) {
  const lower = String(filePath || "").replace(/\\/g, "/").toLowerCase();
  if (lower.includes("/hero/")) return "主角";
  if (lower.includes("/monster/")) return "怪物";
  if (/(^|\/)npc(\/|$)/.test(lower)) return "NPC";
  return "";
}

function inferAnimationTypeFromPath(filePath) {
  const lower = String(filePath || "").replace(/\\/g, "/").toLowerCase();
  if (lower.includes("/locomotion/") || lower.includes("/loco/")) return "基础移动";
  if (lower.includes("/combat/") || lower.includes("/attack/")) return "攻击";
  if (lower.includes("/hit/") || lower.includes("/hitreact/")) return "受击";
  return "";
}

function pickPreservedAnimationPreview(cached = {}, meta = {}) {
  const cachedRecord = cached && typeof cached === "object" ? cached : {};
  const cachedMeta = cachedRecord.meta && typeof cachedRecord.meta === "object" ? cachedRecord.meta : {};
  const metaObject = meta && typeof meta === "object" ? meta : {};
  const previewList = metaObject.previews && typeof metaObject.previews === "object" && Array.isArray(metaObject.previews.images)
    ? metaObject.previews.images
    : [];
  const candidates = [
    cachedRecord.previewImage,
    cachedRecord.preview,
    cachedRecord.detailImage,
    cachedMeta.previewImage,
    cachedMeta.detailImage,
    metaObject.previewImage,
    metaObject.detailImage,
    previewList[0]?.uri
  ];
  for (const candidate of candidates) {
    const raw = String(candidate || "").trim();
    if (!raw || !path.isAbsolute(raw) || isAnimationLibraryPath(raw)) {
      continue;
    }
    return raw;
  }
  return "";
}

function applyPreservedAnimationPreview(record, cached = {}) {
  if (!record || typeof record !== "object") {
    return record;
  }
  const preview = pickPreservedAnimationPreview(cached, record.meta);
  if (!preview) {
    return record;
  }
  record.preview = preview;
  record.previewImage = preview;
  record.detailImage = preview;
  if (record.meta && typeof record.meta === "object") {
    record.meta.previewImage = preview;
    record.meta.detailImage = preview;
  }
  return record;
}

function listAnimationArchiveExtras(destinationDir, stem) {
  const root = String(destinationDir || "").trim();
  const token = String(stem || "").trim();
  if (!root) {
    return [];
  }
  const extras = [
    path.join(root, "Preview"),
    path.join(root, "Previews")
  ];
  if (token) {
    extras.push(path.join(root, `${token}.asset_info.json`));
    extras.push(path.join(root, `${token}.asset_info`));
  }
  return extras;
}

function resolveCustomAssetLayout({ assetType, assetName, destinationRoot, uniqueId }) {
  const root = String(destinationRoot || "").trim();
  if (isFlatCustomAssetType(assetType)) {
    return {
      wrapFolder: false,
      uniqueId: String(uniqueId || "").trim(),
      assetFolderName: "",
      destinationDir: root
    };
  }
  const typeToken = sanitizeLayoutToken(assetType) || "asset";
  const assetNameToken = sanitizeLayoutToken(assetName) || "asset";
  const idToken = String(uniqueId || "").trim() || "asset";
  const assetFolderName = `${typeToken}_${assetNameToken}_${idToken}`;
  return {
    wrapFolder: true,
    uniqueId: idToken,
    assetFolderName,
    destinationDir: path.join(root, assetFolderName)
  };
}

function buildAnimationMetaFromModel(modelPath, cached = {}) {
  const resolved = String(modelPath || "").trim();
  const stem = path.basename(resolved, path.extname(resolved)) || "AS_Animation";
  const cachedMeta = cached.meta && typeof cached.meta === "object" ? cached.meta : {};
  const affiliation = String(cached.animationAffiliation || cachedMeta.animationAffiliation || inferAnimationAffiliationFromPath(resolved) || "").trim();
  const category = String(cached.category || cachedMeta.category || inferAnimationTypeFromPath(resolved) || "基础移动").trim();
  const assetID = String(cached.id || cached.assetID || cachedMeta.assetID || cachedMeta.id || stem).trim();
  const name = String(cached.name || cachedMeta.name || stem).trim();
  const preservedPreview = pickPreservedAnimationPreview(cached, cachedMeta);
  return {
    ...cachedMeta,
    name,
    assetID,
    id: assetID,
    slug: stem,
    assetType: "animation",
    asset_type: "animation",
    topCategory: "animation",
    category,
    animationAffiliation: affiliation || undefined,
    ...(preservedPreview ? { previewImage: preservedPreview, detailImage: preservedPreview } : {}),
    zionTags: Array.isArray(cached.zionTags)
      ? cached.zionTags
      : (Array.isArray(cachedMeta.zionTags) ? cachedMeta.zionTags : (category ? [category] : [])),
    tags: [...new Set([
      ...(Array.isArray(cached.tags) ? cached.tags : []),
      ...(Array.isArray(cachedMeta.tags) ? cachedMeta.tags : []),
      "animation",
      category,
      affiliation
    ].filter(Boolean))],
    modelFiles: [resolved],
    modelSlots: { Mesh: resolved },
    textureFiles: [],
    textureSlots: {},
    textureEntries: [],
    components: [{ type: "model", slot: "Mesh", uri: path.basename(resolved) }]
  };
}

module.exports = {
  applyPreservedAnimationPreview,
  buildAnimationMetaFromModel,
  inferAnimationAffiliationFromPath,
  inferAnimationTypeFromPath,
  isAnimationLibraryPath,
  isAnimationModelMetaPath,
  isFlatCustomAssetType,
  listAnimationArchiveExtras,
  pickPreservedAnimationPreview,
  resolveCustomAssetLayout,
  sanitizeLayoutToken
};
