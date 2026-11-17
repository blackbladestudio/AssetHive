function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasNonEmptyString(value) {
  return typeof value === "string" && Boolean(value.trim());
}

function looksLikeMegascansBridgeMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return typeof value.mimeType === "string"
    && typeof value.type === "string"
    && typeof value.uri === "string";
}

function hasBridgeDownloadEnvelope(meta) {
  const json = meta?.json;
  const bridgeMarkerCount = ["previews", "environment", "meta", "references", "referencePreviews", "properties", "points", "id", "physicalSize"]
    .filter((key) => meta?.[key] !== undefined)
    .length;
  return isPlainObject(json)
    && hasNonEmptyString(json.uri)
    && Array.isArray(meta?.categories)
    && meta.categories.length > 0
    && bridgeMarkerCount >= 1;
}

function hasBridgeContent(meta) {
  const maps = Array.isArray(meta?.maps) ? meta.maps : [];
  const meshes = Array.isArray(meta?.meshes) ? meta.meshes : [];
  const components = Array.isArray(meta?.components) ? meta.components : [];
  const uasset = Array.isArray(meta?.uasset) ? meta.uasset : [];
  return maps.some(looksLikeMegascansBridgeMap)
    || meshes.length > 0
    || components.length > 0
    || uasset.some((item) => isPlainObject(item) && hasNonEmptyString(item.uri));
}

function hasSemanticAssetType(meta) {
  return hasNonEmptyString(meta?.semanticTags?.asset_type);
}

function hasLegacyMetadataSignature(meta) {
  const maps = Array.isArray(meta?.maps) ? meta.maps : [];
  if (!hasSemanticAssetType(meta) || !maps.some(looksLikeMegascansBridgeMap)) {
    return false;
  }
  return Boolean(
    isPlainObject(meta?.assetCategories)
    || Array.isArray(meta?.uasset)
    || isPlainObject(meta?.previews)
  );
}

function hasSmartMaterialSignature(meta) {
  const categories = Array.isArray(meta?.categories)
    ? meta.categories.map((item) => String(item || "").trim().toLowerCase())
    : [];
  const isSmartMaterialCategory = categories.some((item) => (
    item === "smartmaterial" || item === "smartmaterials" || item === "mixer"
  ));
  const maps = Array.isArray(meta?.maps) ? meta.maps : [];
  return isSmartMaterialCategory
    && maps.some((item) => isPlainObject(item) && hasNonEmptyString(item.uri))
    && isPlainObject(meta?.previews);
}

// Quixel Bridge download metadata does not always contain the literal words
// "Megascans" or "Bridge". The downloaded envelope is stable across surfaces,
// 3D assets/plants, atlases and brushes; smart materials use their own smaller
// signature. Folder names stay out of source detection.
function isMegascansBridgeMetadata(meta) {
  if (!isPlainObject(meta)) {
    return false;
  }
  return (hasBridgeDownloadEnvelope(meta) && hasBridgeContent(meta))
    || hasLegacyMetadataSignature(meta)
    || hasSmartMaterialSignature(meta);
}

function detectSourceStandardAssetTags(meta) {
  const sourceText = JSON.stringify(meta || {}).toLowerCase();
  if (sourceText.includes("megascans")
    || sourceText.includes("quixel")
    || sourceText.includes("bridge")
    || isMegascansBridgeMetadata(meta)) {
    return ["Megascans"];
  }
  if (/(?:pbrmax|pbr[\s_-]*max)/i.test(sourceText)) {
    return ["PBRMAX"];
  }
  return [];
}

module.exports = { detectSourceStandardAssetTags, isMegascansBridgeMetadata };
