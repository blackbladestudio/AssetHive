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

function normalizeAnimationIdentityRecord(value) {
  if (!isPlainObject(value) || !isPlainObject(value.identity)) return null;
  const identity = value.identity;
  if (!normalizeText(identity.contentFingerprint)) return null;
  return {
    schemaVersion: Math.max(1, Math.floor(Number(value.schemaVersion) || IDENTITY_SCHEMA_VERSION)),
    identity,
    ...(value.importQueueId ? { importQueueId: value.importQueueId } : {}),
    revision: Math.max(1, Math.floor(Number(value.revision) || 1)),
    importHistory: Array.isArray(value.importHistory)
      ? value.importHistory.filter((item) => isPlainObject(item)).slice(-50)
      : [],
    createdAt: normalizeText(value.createdAt) || undefined,
    updatedAt: normalizeText(value.updatedAt) || undefined
  };
}

function applyAnimationIdentityMetadata(meta, persisted) {
  const normalized = normalizeAnimationIdentityRecord(persisted);
  if (!normalized || !isPlainObject(meta)) return meta;
  return {
    ...meta,
    identity: normalized.identity,
    revision: normalized.revision,
    importHistory: normalized.importHistory
  };
}

async function writeAnimationIdentitySidecar(modelPath, meta) {
  const sidecarPath = getAnimationIdentitySidecarPath(modelPath);
  if (!sidecarPath) throw new Error("animation identity sidecar requires a model path");
  const identity = isPlainObject(meta?.identity) ? meta.identity : null;
  if (!identity || !normalizeText(identity.contentFingerprint)) {
    throw new Error("animation identity sidecar requires a content fingerprint");
  }
  const payload = {
    schemaVersion: IDENTITY_SCHEMA_VERSION,
    identity,
    ...(meta.importQueueId ? { importQueueId: meta.importQueueId } : {}),
    revision: Math.max(1, Math.floor(Number(meta?.revision) || 1)),
    importHistory: Array.isArray(meta?.importHistory)
      ? meta.importHistory.filter((item) => isPlainObject(item)).slice(-50)
      : [],
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
  applyAnimationIdentityMetadata,
  getAnimationIdentitySidecarPath,
  normalizeAnimationIdentityRecord,
  readAnimationIdentitySidecar,
  writeAnimationIdentitySidecar
};
