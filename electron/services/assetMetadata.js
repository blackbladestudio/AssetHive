const { normalizeMaskGroups, isMaskAsset } = require("../../shared/maskMaterials.mjs");
const { removeAssetNameTags } = require("../../shared/assetNameTags.mjs");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const { Buffer } = require("node:buffer");
const { writeFileAtomic, writeFileAtomicSync } = require("./atomicFile");
const { normalizeStandardAssetTag } = require("./assetTags");
const { normalizeOpacityTextureSlot } = require("./textureTypes");
const { normalizeNativePlantWind } = require("./nativePlantWind");
const { normalizeMaterialNames } = require("./zion3dMaterials");

const ASSET_METADATA_FILE_NAME = "asset_info.json";
const ASSET_METADATA_SIDECAR_SUFFIX = ".asset_info.json";
const ASSET_METADATA_SCHEMA_VERSION = "1.0";
const ASSET_METADATA_REQUIRED_FIELDS = Object.freeze([
  "schemaVersion",
  "assetID",
  "id",
  "name",
  "slug",
  "source",
  "assetType",
  "asset_type",
  "topCategory",
  "standardAssetTags",
  "category",
  "tags",
  "categories",
  "components",
  "modelFiles",
  "modelSlots",
  "textureFiles",
  "textureSlots",
  "textureEntries",
  "normalMapFormat",
  "normalMapFormats",
  "previews",
  "createdAt",
  "updatedAt",
  "json"
]);

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeStringArray(values) {
  const source = Array.isArray(values) ? values : [];
  return [...new Set(source.map((value) => normalizeString(value)).filter(Boolean))];
}

// Empty references are placeholders; a nonempty path remains meaningful even
// when its file is offline or missing. Never stat files to decide what to keep.
function pruneEmptyAssetSlots(input) {
  const next = { ...input };
  const hasPath = entry => isPlainObject(entry) && ["uri", "filePath", "path", "file", "source"]
    .some(field => normalizeString(entry[field]));
  for (const field of ["modelSlots", "textureSlots"]) {
    if (isPlainObject(input[field])) {
      next[field] = Object.fromEntries(Object.entries(input[field]).filter(([, value]) => normalizeString(value)));
    }
  }
  for (const field of ["modelFiles", "textureFiles"]) {
    if (Array.isArray(input[field])) next[field] = input[field].filter(value => normalizeString(value));
  }
  for (const field of ["textureEntries", "modelVariants", "modelLods"]) {
    if (Array.isArray(input[field])) next[field] = input[field].filter(hasPath);
  }
  if (Array.isArray(input.components)) {
    next.components = input.components.filter(entry =>
      !["model", "texture"].includes(normalizeString(entry?.type).toLowerCase()) || hasPath(entry));
  }
  return next;
}

function normalizeTimestamp(value, fallback = "") {
  const raw = normalizeString(value);
  if (!raw) {
    return fallback;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function inferTopCategory(assetType) {
  const normalized = normalizeString(assetType).toLowerCase();
  if (normalized === "3d") return "3D Assets";
  if (normalized === "3dplant" || normalized === "plant") return "3D Plants";
  if (normalized === "surface") return "Surfaces";
  if (normalized === "decal") return "Decals";
  if (normalized === "atlas") return "Atlases";
  if (normalized === "imperfection") return "Imperfections";
  if (normalized === "displacement") return "Displacements";
  if (normalized === "hdri") return "HDRI";
  if (normalized === "animation") return "animation";
  if (["suit", "monster", "npc", "weapon", "item"].includes(normalized)) return "character";
  return normalizeString(assetType);
}

function isFolderAssetMetaFileName(name) {
  const lower = normalizeString(name).toLowerCase();
  return lower === ASSET_METADATA_FILE_NAME || lower === "asset_info.jason";
}

function isSidecarAssetMetaFileName(name) {
  const lower = normalizeString(name).toLowerCase();
  return lower.endsWith(ASSET_METADATA_SIDECAR_SUFFIX) && !isFolderAssetMetaFileName(name);
}

function isValidAssetMetaFileName(name) {
  return isFolderAssetMetaFileName(name) || isSidecarAssetMetaFileName(name);
}

function getSidecarStemFromMetaFileName(name) {
  const raw = normalizeString(name);
  if (!isSidecarAssetMetaFileName(raw)) {
    return "";
  }
  return raw.slice(0, -ASSET_METADATA_SIDECAR_SUFFIX.length);
}

function createAssetMetadata(input = {}, options = {}) {
  if (!isPlainObject(input)) {
    throw new TypeError("asset metadata must be an object");
  }
  input = pruneEmptyAssetSlots(input);
  const now = normalizeTimestamp(options.now, new Date().toISOString());
  const fileName = normalizeString(options.fileName) || ASSET_METADATA_FILE_NAME;
  const assetID = normalizeString(input.assetID || input.id || options.assetID);
  const name = normalizeString(input.name || input.assetName);
  const assetType = normalizeString(input.assetType || input.asset_type || options.assetType).toLowerCase();
  if (!assetID) {
    throw new Error("asset metadata requires assetID or id");
  }
  if (!name) {
    throw new Error("asset metadata requires name");
  }
  if (!assetType) {
    throw new Error("asset metadata requires assetType or asset_type");
  }

  const category = normalizeString(input.category) || assetType || "custom";
  const animationAffiliation = normalizeString(input.animationAffiliation);
  const topCategory = normalizeString(input.topCategory) || inferTopCategory(assetType);
  const inputStandardAssetTags = normalizeStringArray(
    Array.isArray(input.standardAssetTags) && input.standardAssetTags.length > 0
      ? input.standardAssetTags
      : (input.subType ? [input.subType] : [])
  );
  const sourceTags = inputStandardAssetTags.filter((tag) => /^(megascans|pbrmax)$/i.test(tag));
  const standardAssetTags = normalizeStringArray(inputStandardAssetTags.map(normalizeStandardAssetTag));
  const zionTags = normalizeStringArray(input.zionTags);
  const tags = normalizeStringArray([...removeAssetNameTags(input.tags, input).filter(tag => assetType !== "3d" || !/^(mega|mask)$/i.test(tag)), ...sourceTags, assetType, category, animationAffiliation, ...standardAssetTags, ...zionTags]);
  const categories = normalizeStringArray([
    ...(Array.isArray(input.categories) ? input.categories : []),
    topCategory,
    assetType,
    category.toLowerCase(),
    animationAffiliation
  ]);
  const normalizeTextureEntry = (entry) => {
    if (!isPlainObject(entry)) return entry;
    const result = { ...entry };
    for (const field of ["slot", "textureType"]) {
      if (typeof result[field] === "string") result[field] = normalizeOpacityTextureSlot(result[field]);
    }
    return result;
  };
  const components = (Array.isArray(input.components) ? input.components : []).map((entry) =>
    String(entry?.type || "").toLowerCase() === "texture" ? normalizeTextureEntry(entry) : entry
  );
  const modelFiles = normalizeStringArray(input.modelFiles);
  const modelSlots = isPlainObject(input.modelSlots) ? input.modelSlots : {};
  const textureFiles = normalizeStringArray(input.textureFiles);
  const textureSlots = {};
  for (const [slot, filePath] of Object.entries(isPlainObject(input.textureSlots) ? input.textureSlots : {})) {
    const normalizedSlot = normalizeOpacityTextureSlot(slot);
    if (!textureSlots[normalizedSlot] || (slot === normalizedSlot && filePath)) textureSlots[normalizedSlot] = filePath;
  }
  const textureEntries = (Array.isArray(input.textureEntries) ? input.textureEntries : []).map(normalizeTextureEntry);
  const semanticTags = isPlainObject(input.semanticTags) ? input.semanticTags : {};
  const previews = isPlainObject(input.previews) ? input.previews : {};
  const normalMapFormats = isPlainObject(input.normalMapFormats) ? input.normalMapFormats : {};
  const normalMapFormat = normalizeString(input.normalMapFormat) || "dx";
  const json = isPlainObject(input.json) ? input.json : {};

  return {
    ...input,
    materialNames: normalizeMaterialNames(input.materialNames),
    maskGroups: assetType === "3d" ? normalizeMaskGroups(input.maskGroups) : undefined,
    textureGroupMode: assetType === "3d" ? (isMaskAsset(input) ? "channel" : "texture") : undefined,
    schemaVersion: ASSET_METADATA_SCHEMA_VERSION,
    id: assetID,
    assetID,
    name,
    slug: normalizeString(input.slug),
    source: normalizeString(input.source) || "custom",
    assetType,
    asset_type: assetType,
    nativePlantWind: assetType === "3dplant" ? normalizeNativePlantWind(input.nativePlantWind) || undefined : undefined,
    topCategory,
    standardAssetTags,
    zionTags,
    category,
    animationAffiliation,
    tags,
    categories,
    semanticTags: {
      ...semanticTags,
      name,
      asset_type: assetType,
      contains: normalizeStringArray([...removeAssetNameTags(semanticTags.contains, input), ...tags]),
      theme: normalizeStringArray([...(Array.isArray(semanticTags.theme) ? semanticTags.theme : []), category, animationAffiliation]),
      descriptive: Array.isArray(semanticTags.descriptive) ? semanticTags.descriptive : [],
      state: Array.isArray(semanticTags.state) ? semanticTags.state : [],
      subject_matter: normalizeString(semanticTags.subject_matter) || category,
      environment: Array.isArray(semanticTags.environment) ? semanticTags.environment : []
    },
    previews: {
      ...previews,
      images: Array.isArray(previews.images) ? previews.images : [],
      relativeSize: normalizeString(previews.relativeSize) || (assetType === "hdri" ? "2x1" : "1x1")
    },
    components,
    previewSkeletonPath: normalizeString(input.previewSkeletonPath),
    previewSkeletalMeshPath: normalizeString(input.previewSkeletalMeshPath),
    modelFiles,
    modelSlots,
    textureFiles,
    textureSlots,
    textureEntries,
    normalMapFormat,
    normalMapFormats,
    createdAt: normalizeTimestamp(options.createdAt, normalizeTimestamp(input.createdAt, now)),
    updatedAt: normalizeTimestamp(options.updatedAt, normalizeTimestamp(input.updatedAt, now)),
    json: {
      ...json,
      uri: fileName,
      contentLength: Math.max(0, Number(json.contentLength) || 0)
    }
  };
}

function serializeAssetMetadata(metadata, options = {}) {
  const normalized = createAssetMetadata(metadata, options);
  return serializeMetadataJson(normalized);
}

function serializeMetadataJson(metadata) {
  const normalized = { ...metadata };
  if (!isPlainObject(normalized.json)) return { meta: normalized, text: JSON.stringify(normalized, null, 2) };
  normalized.json = { ...normalized.json };
  let contentLength = Math.max(0, Number(normalized.json.contentLength) || 0);
  let text = "";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    normalized.json.contentLength = contentLength;
    text = JSON.stringify(normalized, null, 2);
    const actualLength = Buffer.byteLength(text, "utf8");
    if (actualLength === contentLength) {
      return { meta: normalized, text };
    }
    contentLength = actualLength;
  }
  normalized.json.contentLength = Buffer.byteLength(text, "utf8");
  text = JSON.stringify(normalized, null, 2);
  return { meta: normalized, text };
}

function validateAssetMetadata(metadata) {
  const errors = [];
  if (!isPlainObject(metadata)) {
    return { ok: false, errors: ["metadata must be an object"] };
  }
  for (const field of ASSET_METADATA_REQUIRED_FIELDS) {
    if (!(field in metadata)) {
      errors.push(`missing required field: ${field}`);
    }
  }
  if (metadata.schemaVersion !== ASSET_METADATA_SCHEMA_VERSION) {
    errors.push(`unsupported schemaVersion: ${normalizeString(metadata.schemaVersion) || "(empty)"}`);
  }
  if (Array.isArray(metadata.components) === false) errors.push("components must be an array");
  if (Array.isArray(metadata.standardAssetTags) === false) errors.push("standardAssetTags must be an array");
  if (metadata.zionTags != null && Array.isArray(metadata.zionTags) === false) errors.push("zionTags must be an array when present");
  if (Array.isArray(metadata.tags) === false) errors.push("tags must be an array");
  if (Array.isArray(metadata.categories) === false) errors.push("categories must be an array");
  if (Array.isArray(metadata.modelFiles) === false) errors.push("modelFiles must be an array");
  if (Array.isArray(metadata.textureFiles) === false) errors.push("textureFiles must be an array");
  if (Array.isArray(metadata.textureEntries) === false) errors.push("textureEntries must be an array");
  if (isPlainObject(metadata.modelSlots) === false) errors.push("modelSlots must be an object");
  if (isPlainObject(metadata.textureSlots) === false) errors.push("textureSlots must be an object");
  if (isPlainObject(metadata.normalMapFormats) === false) errors.push("normalMapFormats must be an object");
  if (isPlainObject(metadata.previews) === false) errors.push("previews must be an object");
  if (isPlainObject(metadata.json) === false) errors.push("json must be an object");
  if (!isValidAssetMetaFileName(metadata.json?.uri)) {
    errors.push("json.uri must be asset_info.json or a *.asset_info.json sidecar");
  }
  return { ok: errors.length === 0, errors };
}

async function writeAssetMetadata(assetDir, metadata, options = {}) {
  const directory = normalizeString(assetDir);
  if (!directory) {
    throw new Error("asset metadata requires an asset directory");
  }
  const fileName = normalizeString(options.fileName) || ASSET_METADATA_FILE_NAME;
  const { meta, text } = serializeAssetMetadata(metadata, { ...options, fileName });
  if (/(^|[\\/])animation([\\/]|$)/i.test(directory)) {
    return { meta, metaPath: "", fileName };
  }
  const metaPath = path.join(directory, fileName);
  await fs.mkdir(directory, { recursive: true });
  await writeFileAtomic(metaPath, text);
  return { meta, metaPath, fileName };
}

function writeAssetMetadataSync(assetDir, metadata, options = {}) {
  const directory = normalizeString(assetDir);
  if (!directory) {
    throw new Error("asset metadata requires an asset directory");
  }
  const fileName = normalizeString(options.fileName) || ASSET_METADATA_FILE_NAME;
  const { meta, text } = serializeAssetMetadata(metadata, { ...options, fileName });
  if (/(^|[\\/])animation([\\/]|$)/i.test(directory)) {
    return { meta, metaPath: "", fileName };
  }
  const metaPath = path.join(directory, fileName);
  fsSync.mkdirSync(directory, { recursive: true });
  writeFileAtomicSync(metaPath, text);
  return { meta, metaPath, fileName };
}

const metadataUpdates = new Map();

// Read again inside the per-file queue: a timed-out optional backfill may still
// finish later, and must merge with fields written by the next backfill.
function updateAssetMetadataFile(metaPath, update) {
  const target = path.resolve(metaPath);
  const key = process.platform === "win32" ? target.toLowerCase() : target;
  const previous = metadataUpdates.get(key) || Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    const current = JSON.parse((await fs.readFile(target, "utf8")).replace(/^\uFEFF/, ""));
    if (!isPlainObject(current)) throw new Error(`Invalid asset metadata: ${target}`);
    const next = await update(current);
    if (!isPlainObject(next)) throw new Error(`Invalid metadata update: ${target}`);
    const serialized = serializeMetadataJson(next);
    await writeFileAtomic(target, serialized.text);
    return serialized.meta;
  });
  metadataUpdates.set(key, pending);
  const cleanup = () => { if (metadataUpdates.get(key) === pending) metadataUpdates.delete(key); };
  void pending.then(cleanup, cleanup);
  return pending;
}

module.exports = {
  ASSET_METADATA_FILE_NAME,
  ASSET_METADATA_SIDECAR_SUFFIX,
  ASSET_METADATA_SCHEMA_VERSION,
  ASSET_METADATA_REQUIRED_FIELDS,
  isFolderAssetMetaFileName,
  isSidecarAssetMetaFileName,
  isValidAssetMetaFileName,
  getSidecarStemFromMetaFileName,
  pruneEmptyAssetSlots,
  createAssetMetadata,
  serializeAssetMetadata,
  validateAssetMetadata,
  writeAssetMetadata,
  writeAssetMetadataSync,
  updateAssetMetadataFile
};
