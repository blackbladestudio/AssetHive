const crypto = require("node:crypto");
const fs = require("node:fs");

const IDENTITY_SCHEMA_VERSION = 1;
const FINGERPRINT_VERSION = "sha256-v1";

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeLookupText(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeSourceToken(value) {
  return normalizeLookupText(value)
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/(?:[_\-\s]+(?:1k|2k|4k|8k|16k))+$/i, "")
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function hasTag(tags, expected) {
  const target = normalizeLookupText(expected);
  return (Array.isArray(tags) ? tags : []).some((tag) => {
    const normalized = normalizeLookupText(tag);
    return normalized === target || normalized.includes(target);
  });
}

function inferSourceKind({ sourceIdentity, standardAssetTags, tags, explicitKind }) {
  const explicit = normalizeLookupText(sourceIdentity?.sourceKind || sourceIdentity?.kind || explicitKind);
  if (explicit === "megascans" || explicit === "pbrmax" || explicit === "zion") {
    return explicit;
  }
  const combined = [...(Array.isArray(standardAssetTags) ? standardAssetTags : []), ...(Array.isArray(tags) ? tags : [])];
  if (hasTag(combined, "megascans") || hasTag(combined, "quixel")) return "megascans";
  if (hasTag(combined, "pbrmax") || hasTag(combined, "pbr max")) return "pbrmax";
  return "zion";
}

function deriveSourceIdentity(input = {}) {
  const sourceIdentity = input.sourceIdentity && typeof input.sourceIdentity === "object" && !Array.isArray(input.sourceIdentity)
    ? input.sourceIdentity
    : {};
  const assetName = normalizeText(input.assetName);
  const assetType = normalizeSourceToken(input.assetType || "asset");
  const sourceKind = inferSourceKind({ ...input, sourceIdentity });
  const sourceAssetId = normalizeText(
    sourceIdentity.sourceAssetId
      || sourceIdentity.assetId
      || sourceIdentity.id
      || input.sourceAssetId
  );
  const explicitSourceKey = normalizeText(sourceIdentity.sourceKey);
  const fallbackName = normalizeSourceToken(sourceIdentity.coreName || sourceIdentity.name || assetName);
  let sourceKey = explicitSourceKey;

  if (!sourceKey && sourceKind === "megascans") {
    sourceKey = sourceAssetId
      ? `megascans:${normalizeSourceToken(sourceAssetId)}`
      : `megascans:name:${fallbackName}`;
  } else if (!sourceKey && sourceKind === "pbrmax") {
    sourceKey = `pbrmax:${normalizeSourceToken(sourceAssetId || fallbackName)}`;
  } else if (!sourceKey) {
    sourceKey = `zion:${assetType}:${fallbackName}`;
  }

  return {
    schemaVersion: IDENTITY_SCHEMA_VERSION,
    sourceKind,
    sourceKey,
    sourceAssetId: sourceAssetId || undefined,
    sourceVersion: normalizeText(sourceIdentity.sourceVersion || sourceIdentity.version) || undefined,
    sourceRevision: normalizeText(sourceIdentity.sourceRevision || sourceIdentity.revision) || undefined
  };
}

function withDigestPrefix(value) {
  return `${value.startsWith("sha256:") ? "" : "sha256:"}${value}`;
}

function hashString(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

async function hashFile(filePath) {
  const resolved = normalizeText(filePath);
  if (!resolved) {
    throw new Error("asset identity requires a file path");
  }
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(resolved, { highWaterMark: 1024 * 1024 });
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function normalizeModelSlotEntries(modelSlots) {
  const entries = [];
  if (Array.isArray(modelSlots)) {
    for (const item of modelSlots) {
      if (!item || typeof item !== "object") continue;
      const slot = normalizeText(item.suffix || item.slot || item.name);
      const source = normalizeText(item.source || item.filePath || item.path || item.file);
      if (slot && source) entries.push({ suffix: slot, source });
    }
    return entries;
  }
  for (const [slot, value] of Object.entries(modelSlots && typeof modelSlots === "object" ? modelSlots : {})) {
    const source = typeof value === "string"
      ? value
      : normalizeText(value?.source || value?.filePath || value?.path || value?.file);
    if (normalizeText(slot) && normalizeText(source)) {
      entries.push({ suffix: normalizeText(slot), source: normalizeText(source) });
    }
  }
  return entries;
}

function normalizeModelLodEntries(modelLodFiles) {
  const entries = new Map();
  const visit = (slot, items) => {
    const normalizedSlot = normalizeText(slot).toLowerCase();
    if (!normalizedSlot) return;
    const list = Array.isArray(items) ? items : [];
    const normalized = list.map((item) => {
      const source = normalizeText(typeof item === "string" ? item : item?.source || item?.filePath || item?.path || item?.file);
      const lod = Math.max(0, Math.floor(Number(item?.lod) || 0));
      return source ? { source, lod } : null;
    }).filter(Boolean).sort((left, right) => left.lod - right.lod || left.source.localeCompare(right.source, undefined, { numeric: true, sensitivity: "base" }));
    if (normalized.length > 0) entries.set(normalizedSlot, normalized);
  };
  if (modelLodFiles instanceof Map) {
    for (const [slot, items] of modelLodFiles.entries()) visit(slot, items);
  } else if (modelLodFiles && typeof modelLodFiles === "object") {
    for (const [slot, items] of Object.entries(modelLodFiles)) visit(slot, items);
  }
  return entries;
}

function normalizeTextureSlotEntries(textureSlots) {
  const entries = [];
  if (Array.isArray(textureSlots)) {
    for (const item of textureSlots) {
      if (!item || typeof item !== "object") continue;
      const suffix = normalizeText(item.suffix || item.textureType || item.slot);
      const source = normalizeText(item.source || item.filePath || item.path || item.file);
      if (!suffix || !source) continue;
      entries.push({
        suffix,
        source,
        materialRole: normalizeText(item.materialRole || item.role),
        areaIndex: Math.max(1, Number(item.areaIndex ?? item.areaId) || 1)
      });
    }
    return entries;
  }
  for (const [key, value] of Object.entries(textureSlots && typeof textureSlots === "object" ? textureSlots : {})) {
    if (typeof value !== "string" || !normalizeText(value)) continue;
    const [suffix, role = ""] = normalizeText(key).split("|");
    entries.push({
      suffix,
      source: normalizeText(value),
      materialRole: normalizeText(role),
      areaIndex: 1
    });
  }
  return entries;
}

async function computeContentIdentity(input = {}) {
  const modelEntries = normalizeModelSlotEntries(input.modelSlots);
  const lodEntries = normalizeModelLodEntries(input.modelLodFiles);
  const textureEntries = normalizeTextureSlotEntries(input.textureSlots);
  const sourcePaths = [...new Set([
    ...modelEntries.map((entry) => entry.source),
    ...modelEntries.flatMap((entry) => (lodEntries.get(entry.suffix.toLowerCase()) || []).map((lod) => lod.source)),
    ...textureEntries.map((entry) => entry.source)
  ])];
  const fileDigests = new Map();
  // Hash a few independent files at once without decoding images or opening
  // an unbounded number of large files from a shared library path.
  for (let start = 0; start < sourcePaths.length; start += 3) {
    const batch = sourcePaths.slice(start, start + 3);
    const digests = await Promise.all(batch.map((source) => (input.hashFile || hashFile)(source)));
    batch.forEach((source, index) => fileDigests.set(source, withDigestPrefix(digests[index])));
  }
  const modelFingerprints = {};
  const modelManifest = [];

  for (const entry of modelEntries.sort((left, right) => left.suffix.localeCompare(right.suffix, undefined, { sensitivity: "base" }))) {
    const lodItems = lodEntries.get(entry.suffix.toLowerCase()) || [];
    const descriptor = {
      suffix: entry.suffix,
      file: fileDigests.get(entry.source),
      lods: []
    };
    for (const lod of lodItems) {
      descriptor.lods.push({
        lod: lod.lod,
        file: fileDigests.get(lod.source)
      });
    }
    const slotFingerprint = withDigestPrefix(hashString(JSON.stringify(descriptor)));
    modelFingerprints[entry.suffix] = slotFingerprint;
    modelManifest.push([entry.suffix, slotFingerprint]);
  }

  const textureDescriptors = [];
  for (const entry of textureEntries.sort((left, right) =>
    left.suffix.localeCompare(right.suffix, undefined, { sensitivity: "base" })
    || left.materialRole.localeCompare(right.materialRole, undefined, { sensitivity: "base" })
    || left.source.localeCompare(right.source, undefined, { sensitivity: "base" })
  )) {
    textureDescriptors.push({
      suffix: entry.suffix,
      materialRole: entry.materialRole || undefined,
      areaIndex: entry.areaIndex,
      file: fileDigests.get(entry.source)
    });
  }

  const textureFingerprint = withDigestPrefix(hashString(JSON.stringify(textureDescriptors)));
  const contentFingerprint = withDigestPrefix(hashString(JSON.stringify({
    fingerprintVersion: FINGERPRINT_VERSION,
    models: modelManifest,
    textures: textureDescriptors,
    textureFingerprint
  })));

  return {
    fingerprintVersion: FINGERPRINT_VERSION,
    contentFingerprint,
    modelFingerprints,
    textureFingerprint
  };
}

module.exports = {
  IDENTITY_SCHEMA_VERSION,
  FINGERPRINT_VERSION,
  deriveSourceIdentity,
  computeContentIdentity,
  hashFile,
  normalizeSourceToken
};
