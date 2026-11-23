const fs = require("node:fs/promises");
const path = require("node:path");
const { IDENTITY_SCHEMA_VERSION } = require("./assetIdentity");
const { writeFileAtomic } = require("./atomicFile");

const ANIMATION_IDENTITY_SIDECAR_SUFFIX = ".assethive.identity.json";

function normalizeText(value) {
  return String(value ?? "").trim();
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getAnimationIdentitySidecarPath(modelPath) {
  const resolved = normalizeText(modelPath);
  if (!resolved) return "";
  return path.join(path.dirname(resolved), `${path.basename(resolved)}${ANIMATION_IDENTITY_SIDECAR_SUFFIX}`);
}

// Flat animations have no asset JSON; the sidecar is the only shared place
// that keeps the asset id and hand-edited fields across rescans and machines.
function pickAnimationAssetFields(meta) {
  if (!isPlainObject(meta)) return null;
  const assetID = normalizeText(meta.assetID || meta.id);
  if (!assetID) return null;
  const gameTag = isPlainObject(meta.animationGameTag) && normalizeText(meta.animationGameTag.id)
    ? {
        kind: normalizeText(meta.animationGameTag.kind),
        id: normalizeText(meta.animationGameTag.id),
        name: normalizeText(meta.animationGameTag.name)
      }
    : undefined;
  return {
    assetID,
    ...(normalizeText(meta.name) ? { name: normalizeText(meta.name) } : {}),
    ...(normalizeText(meta.category) ? { category: normalizeText(meta.category) } : {}),
    ...(normalizeText(meta.animationAffiliation) ? { animationAffiliation: normalizeText(meta.animationAffiliation) } : {}),
    animationLabels: Array.isArray(meta.animationLabels) ? meta.animationLabels.map(normalizeText).filter(Boolean) : [],
    ...(gameTag ? { animationGameTag: gameTag } : {})
  };
}

function normalizeAnimationIdentityRecord(value) {
  if (!isPlainObject(value) || !isPlainObject(value.identity)) return null;
  const identity = value.identity;
  if (!normalizeText(identity.contentFingerprint)) return null;
  const asset = pickAnimationAssetFields(value.asset);
  return {
    schemaVersion: Math.max(1, Math.floor(Number(value.schemaVersion) || IDENTITY_SCHEMA_VERSION)),
    identity,
    ...(value.importQueueId ? { importQueueId: value.importQueueId } : {}),
    ...(asset ? { asset } : {}),
    revision: Math.max(1, Math.floor(Number(value.revision) || 1)),
    importHistory: Array.isArray(value.importHistory)
      ? value.importHistory.filter((item) => isPlainObject(item)).slice(-50)
      : [],
    animationOperationHistory: Array.isArray(value.animationOperationHistory) ? value.animationOperationHistory.filter(isPlainObject).slice(-50) : [],
    animationUEExports: Array.isArray(value.animationUEExports) ? value.animationUEExports.filter(isPlainObject).slice(-20) : [],
    createdAt: normalizeText(value.createdAt) || undefined,
    updatedAt: normalizeText(value.updatedAt) || undefined
  };
}

function applyAnimationIdentityMetadata(meta, persisted) {
  const normalized = normalizeAnimationIdentityRecord(persisted);
  if (!normalized || !isPlainObject(meta)) return meta;
  const asset = normalized.asset;
  return {
    ...meta,
    ...(asset ? {
      id: asset.assetID,
      assetID: asset.assetID,
      ...(asset.name ? { name: asset.name } : {}),
      ...(asset.category ? { category: asset.category } : {}),
      ...(asset.animationAffiliation ? { animationAffiliation: asset.animationAffiliation } : {}),
      animationLabels: asset.animationLabels.length ? asset.animationLabels : undefined,
      animationGameTag: asset.animationGameTag
    } : {}),
    identity: normalized.identity,
    ...(normalized.importQueueId ? { importQueueId: normalized.importQueueId } : {}),
    createdAt: normalized.createdAt || meta.createdAt,
    updatedAt: normalized.updatedAt || meta.updatedAt,
    revision: normalized.revision,
    importHistory: normalized.importHistory,
    animationOperationHistory: normalized.animationOperationHistory,
    animationUEExports: normalized.animationUEExports
  };
}

// Disk metadata is authoritative; recurring list records intentionally omit
// fingerprints and history and must never overwrite the sidecar on refresh.
function mergeAnimationMetadata(cached = {}, full = {}, assetId) {
  return { ...cached, ...full, assetID: assetId, id: assetId };
}

// True when the sidecar holds asset fields that differ from a cached record,
// so the scanner must rebuild instead of reusing the cached record.
function animationIdentityDiffersFromRecord(record, persisted) {
  const normalized = normalizeAnimationIdentityRecord(persisted);
  const asset = normalized?.asset;
  if (!asset || !isPlainObject(record)) return false;
  const current = pickAnimationAssetFields({
    ...(isPlainObject(record.meta) ? record.meta : {}),
    assetID: record.id,
    name: record.name,
    animationAffiliation: record.animationAffiliation ?? record.meta?.animationAffiliation,
    animationLabels: record.animationLabels ?? record.meta?.animationLabels,
    animationGameTag: record.animationGameTag ?? record.meta?.animationGameTag
  });
  if (!current) return true;
  const key = (value) => JSON.stringify([value.assetID, value.name || "", value.animationAffiliation || "", value.animationLabels, value.animationGameTag || null]);
  return key(current) !== key({ ...asset, name: asset.name || current.name })
    || JSON.stringify(record.meta?.animationOperationHistory || []) !== JSON.stringify(normalized.animationOperationHistory)
    || JSON.stringify(record.meta?.animationUEExports || []) !== JSON.stringify(normalized.animationUEExports);
}

async function writeAnimationIdentitySidecar(modelPath, meta) {
  const sidecarPath = getAnimationIdentitySidecarPath(modelPath);
  if (!sidecarPath) throw new Error("animation identity sidecar requires a model path");
  const identity = isPlainObject(meta?.identity) ? meta.identity : null;
  if (!identity || !normalizeText(identity.contentFingerprint)) {
    throw new Error("animation identity sidecar requires a content fingerprint");
  }
  const asset = pickAnimationAssetFields(meta);
  const payload = {
    schemaVersion: IDENTITY_SCHEMA_VERSION,
    identity,
    ...(meta.importQueueId ? { importQueueId: meta.importQueueId } : {}),
    ...(asset ? { asset } : {}),
    revision: Math.max(1, Math.floor(Number(meta?.revision) || 1)),
    importHistory: Array.isArray(meta?.importHistory)
      ? meta.importHistory.filter((item) => isPlainObject(item)).slice(-50)
      : [],
    animationOperationHistory: Array.isArray(meta?.animationOperationHistory) ? meta.animationOperationHistory.filter(isPlainObject).slice(-50) : [],
    animationUEExports: Array.isArray(meta?.animationUEExports) ? meta.animationUEExports.filter(isPlainObject).slice(-20) : [],
    createdAt: normalizeText(meta?.createdAt) || undefined,
    updatedAt: normalizeText(meta?.updatedAt) || new Date().toISOString()
  };
  await writeFileAtomic(sidecarPath, JSON.stringify(payload, null, 2));
  return sidecarPath;
}

async function readAnimationIdentitySidecar(modelPath) {
  const sidecarPath = getAnimationIdentitySidecarPath(modelPath);
  if (!sidecarPath) return null;
  try {
    const parsed = JSON.parse(await fs.readFile(sidecarPath, "utf8"));
    return normalizeAnimationIdentityRecord(parsed);
  } catch {
    return null;
  }
}

module.exports = {
  ANIMATION_IDENTITY_SIDECAR_SUFFIX,
  mergeAnimationMetadata,
  animationIdentityDiffersFromRecord,
  applyAnimationIdentityMetadata,
  getAnimationIdentitySidecarPath,
  normalizeAnimationIdentityRecord,
  readAnimationIdentitySidecar,
  writeAnimationIdentitySidecar
};
