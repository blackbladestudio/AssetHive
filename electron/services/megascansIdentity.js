const path = require("node:path");
const { deriveSourceIdentity } = require("./assetIdentity");
const { isMegascansBridgeMetadata } = require("./sourceDetection");

const GENERIC_METADATA_STEMS = new Set([
  "asset_info",
  "asset-info",
  "metadata",
  "meta",
  "manifest",
  "index"
]);
const IDENTITY_KEYS = [
  "sourceAssetId",
  "source_asset_id",
  "assetId",
  "assetID",
  "asset_id",
  "id"
];
const VERSION_KEYS = ["sourceVersion", "source_version", "assetVersion", "asset_version", "version"];
const REVISION_KEYS = ["sourceRevision", "source_revision", "assetRevision", "asset_revision", "revision"];

function normalizeLookupKey(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeIdentityToken(value) {
  return String(value ?? "").trim();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pickMetadataValueByPriority(meta, keys) {
  const expected = keys.map(normalizeLookupKey).filter(Boolean);
  if (!isPlainObject(meta) || expected.length === 0) return "";

  const queue = [{ value: meta, depth: 0 }];
  const seen = new Set();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.depth > 4 || !isPlainObject(current.value) || seen.has(current.value)) continue;
    seen.add(current.value);

    for (const expectedKey of expected) {
      for (const [key, value] of Object.entries(current.value)) {
        if (normalizeLookupKey(key) !== expectedKey) continue;
        if (typeof value === "string" || typeof value === "number") {
          const normalized = normalizeIdentityToken(value);
          if (normalized) return normalized;
        }
      }
    }

    for (const value of Object.values(current.value)) {
      if (isPlainObject(value)) {
        queue.push({ value, depth: current.depth + 1 });
      }
    }
  }
  return "";
}

function metadataUriStem(meta) {
  if (!isPlainObject(meta) || !isPlainObject(meta.json)) return "";
  const uri = normalizeIdentityToken(meta.json.uri);
  if (!uri) return "";
  const stem = path.basename(uri, path.extname(uri)).trim();
  if (!stem || GENERIC_METADATA_STEMS.has(stem.toLowerCase())) return "";
  return stem;
}

function metadataFileStem(metadataFilePath) {
  const normalized = normalizeIdentityToken(metadataFilePath);
  if (!normalized) return "";
  const stem = path.basename(normalized, path.extname(normalized)).trim();
  if (!stem || GENERIC_METADATA_STEMS.has(stem.toLowerCase())) return "";
  return stem;
}

// Quixel Bridge Surface / 3D Plant JSON normally stores the native ID at the
// root as "id" and repeats the metadata filename in json.uri. Some exports
// omit the explicit ID, so use the Bridge metadata filename as a conservative
// fallback only after source detection has already confirmed Megascans.
function resolveMegascansSourceIdentity(input = {}) {
  const metadata = isPlainObject(input.metadata) ? input.metadata : {};
  const sourceTokens = [
    ...(Array.isArray(input.standardAssetTags) ? input.standardAssetTags : []),
    ...(Array.isArray(input.tags) ? input.tags : [])
  ].map((value) => normalizeLookupKey(value));
  const isMegascansSource = isMegascansBridgeMetadata(metadata)
    || sourceTokens.some((value) => value === "megascans" || value === "quixel" || value.includes("megascans"));
  const sourceAssetId = pickMetadataValueByPriority(metadata, IDENTITY_KEYS)
    || (isMegascansSource ? metadataUriStem(metadata) || metadataFileStem(input.metadataFilePath) : "");

  return deriveSourceIdentity({
    assetName: input.assetName,
    assetType: input.assetType,
    standardAssetTags: input.standardAssetTags,
    tags: input.tags,
    sourceIdentity: {
      sourceAssetId,
      sourceVersion: pickMetadataValueByPriority(metadata, VERSION_KEYS),
      sourceRevision: pickMetadataValueByPriority(metadata, REVISION_KEYS)
    }
  });
}

module.exports = {
  resolveMegascansSourceIdentity,
  pickMetadataValueByPriority
};
