const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

let sharp = null;
try {
  sharp = require("sharp");
} catch {
  sharp = null;
}

const TEXTURE_ANALYSIS_VERSION = 1;
const LARGE_OBJECT_LIMIT_METERS = 5;
const FOUR_K_THRESHOLD_PIXELS = 4096;
const TEXTURE_METADATA_CONCURRENCY = 2;
const MAX_REPORTED_TEXTURES = 20;
const MODEL_ASSET_TYPES = new Set(["3d", "3dplant"]);

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeComparePath(filePath) {
  try {
    return path.resolve(String(filePath || "")).replaceAll("\\", "/").toLowerCase();
  } catch {
    return String(filePath || "").replaceAll("\\", "/").toLowerCase();
  }
}

function toFinitePositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizeDimensions(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const x = toFinitePositiveNumber(input.x);
  const y = toFinitePositiveNumber(input.y);
  const z = toFinitePositiveNumber(input.z);
  return x !== null && y !== null && z !== null ? { x, y, z } : null;
}

function isPlaceholderDimensions(dimensions) {
  const normalized = normalizeDimensions(dimensions);
  return Boolean(
    normalized &&
    normalized.x === 1 &&
    normalized.y === 1 &&
    normalized.z === 1
  );
}

function getReliableDimensions(dimensions, source = "") {
  const normalized = normalizeDimensions(dimensions);
  if (!normalized) {
    return null;
  }
  const normalizedSource = normalizeString(source).toLowerCase();
  if (normalizedSource === "measured") {
    return normalized;
  }
  // Older 3D assets may carry the scanner's 1x1x1 fallback. Treat only that
  // exact placeholder as unknown unless metadata explicitly says it was measured.
  return isPlaceholderDimensions(normalized) ? null : normalized;
}

function isSmallAssetSize(dimensions, source = "") {
  const normalized = getReliableDimensions(dimensions, source);
  if (!normalized) {
    return null;
  }
  return Math.max(normalized.x, normalized.y, normalized.z) < LARGE_OBJECT_LIMIT_METERS;
}

function isModelAssetType(assetType) {
  return MODEL_ASSET_TYPES.has(normalizeString(assetType).toLowerCase());
}

function isPreviewLikeTexture(filePath) {
  const base = path.basename(normalizeString(filePath)).toLowerCase();
  if (!base) {
    return true;
  }
  return (
    /(^|[_\-.])(thumb|thumbnail|preview)([_\-.]|$)/i.test(base) ||
    /_thumb(?:\.[^.]+)?$/i.test(base) ||
    base.startsWith("thumb_") ||
    base.startsWith("preview_")
  );
}

function normalizeTextureFiles(textureFiles) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(textureFiles) ? textureFiles : []) {
    const filePath = normalizeString(value);
    if (!filePath || isPreviewLikeTexture(filePath)) {
      continue;
    }
    const key = normalizeComparePath(filePath);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(filePath);
  }
  return result;
}

function normalizeReportedFiles(values) {
  return (Array.isArray(values) ? values : [])
    .map((value) => path.basename(normalizeString(value)))
    .filter(Boolean)
    .slice(0, MAX_REPORTED_TEXTURES);
}

function normalizeTextureAnalysis(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const version = Number(input.version);
  if (version !== TEXTURE_ANALYSIS_VERSION) {
    return null;
  }
  const dimensions = normalizeDimensions(input.dimensions);
  const maxDimensionMeters = Number(input.maxDimensionMeters);
  const maxTextureDimension = Math.max(0, Number(input.maxTextureDimension) || 0);
  const textureCount = Math.max(0, Number(input.textureCount) || 0);
  const inspectedTextureCount = Math.max(0, Number(input.inspectedTextureCount) || 0);
  const unreadableTextureCount = Math.max(0, Number(input.unreadableTextureCount) || 0);
  const fourKTextureCount = Math.max(0, Number(input.fourKTextureCount) || 0);
  return {
    version: TEXTURE_ANALYSIS_VERSION,
    status: normalizeString(input.status) || "unknown",
    smallAsset: typeof input.smallAsset === "boolean" ? input.smallAsset : null,
    uses4KTexture: Boolean(input.uses4KTexture),
    requiresReview: Boolean(input.requiresReview),
    dimensions,
    dimensionsSource: normalizeString(input.dimensionsSource),
    maxDimensionMeters: Number.isFinite(maxDimensionMeters) ? maxDimensionMeters : null,
    sizeThresholdMeters: LARGE_OBJECT_LIMIT_METERS,
    textureThresholdPixels: FOUR_K_THRESHOLD_PIXELS,
    maxTextureDimension,
    textureCount,
    inspectedTextureCount,
    unreadableTextureCount,
    fourKTextureCount,
    fourKTextureFiles: normalizeReportedFiles(input.fourKTextureFiles),
    textureFingerprint: normalizeString(input.textureFingerprint),
    dimensionFingerprint: normalizeString(input.dimensionFingerprint),
    analyzedAt: normalizeString(input.analyzedAt)
  };
}

function isTextureAnalysisCurrent(input) {
  return Boolean(normalizeTextureAnalysis(input));
}

async function statFile(filePath) {
  return fs.stat(filePath);
}

async function buildTextureFingerprint(textureFiles, options = {}) {
  const stat = typeof options.statFile === "function" ? options.statFile : statFile;
  const files = normalizeTextureFiles(textureFiles);
  const parts = [];
  for (const filePath of files.sort((a, b) => normalizeComparePath(a).localeCompare(normalizeComparePath(b)))) {
    const stats = await Promise.resolve(stat(filePath)).catch(() => null);
    if (!stats || (typeof stats.isFile === "function" && !stats.isFile())) {
      continue;
    }
    const size = Math.max(0, Number(stats.size) || 0);
    const modified = Math.max(0, Math.round(Number(stats.mtimeMs) || 0));
    parts.push(`${normalizeComparePath(filePath)}|${size}|${modified}`);
  }
  const fingerprint = crypto.createHash("sha1").update(parts.join("\n")).digest("hex");
  return { fingerprint, fileCount: files.length };
}

function dimensionFingerprint(dimensions) {
  if (!dimensions) {
    return "";
  }
  return `${dimensions.x}|${dimensions.y}|${dimensions.z}`;
}

async function inspectTextureMetadata(filePath, options = {}) {
  const inspector = typeof options.inspectTexture === "function"
    ? options.inspectTexture
    : async (target) => {
      try {
        const { imageDimensions } = require("./imageDimensions");
        const size = await imageDimensions(target, { sharp });
        if (Number(size?.width) > 0 && Number(size?.height) > 0) {
          return { width: size.width, height: size.height };
        }
      } catch {
        void 0;
      }
      if (!sharp) {
        throw new Error("sharp is unavailable");
      }
      const metadata = await sharp(target, { failOn: "none", sequentialRead: true }).metadata();
      return { width: Number(metadata?.width) || 0, height: Number(metadata?.height) || 0 };
    };
  return inspector(filePath);
}

async function runWithConcurrency(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(Number(limit) || 1, list.length || 1));
  const runNext = async () => {
    while (nextIndex < list.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(list[index], index);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => runNext()));
  return results;
}

async function analyzeAssetTextureUsage(input = {}, options = {}) {
  const dimensions = getReliableDimensions(input.dimensions, input.dimensionsSource);
  const dimensionsSource = normalizeString(input.dimensionsSource);
  const smallAsset = dimensions ? Math.max(dimensions.x, dimensions.y, dimensions.z) < LARGE_OBJECT_LIMIT_METERS : null;
  const dimensionToken = dimensionFingerprint(dimensions);
  const now = new Date().toISOString();

  if (smallAsset !== true) {
    return {
      version: TEXTURE_ANALYSIS_VERSION,
      status: dimensions ? "large" : "unknown",
      smallAsset,
      uses4KTexture: false,
      requiresReview: false,
      dimensions,
      dimensionsSource,
      maxDimensionMeters: dimensions ? Math.max(dimensions.x, dimensions.y, dimensions.z) : null,
      sizeThresholdMeters: LARGE_OBJECT_LIMIT_METERS,
      textureThresholdPixels: FOUR_K_THRESHOLD_PIXELS,
      maxTextureDimension: 0,
      textureCount: 0,
      inspectedTextureCount: 0,
      unreadableTextureCount: 0,
      fourKTextureCount: 0,
      fourKTextureFiles: [],
      textureFingerprint: "",
      dimensionFingerprint: dimensionToken,
      analyzedAt: now
    };
  }

  const textureFiles = normalizeTextureFiles(input.textureFiles);
  const fingerprintResult = await buildTextureFingerprint(textureFiles, options);
  const previous = normalizeTextureAnalysis(input.previousAnalysis);
  if (
    !options.force &&
    previous &&
    previous.smallAsset === true &&
    previous.dimensionFingerprint === dimensionToken &&
    previous.textureFingerprint === fingerprintResult.fingerprint
  ) {
    return previous;
  }

  const inspections = await runWithConcurrency(textureFiles, TEXTURE_METADATA_CONCURRENCY, async (filePath) => {
    try {
      const metadata = await inspectTextureMetadata(filePath, options);
      const width = Math.max(0, Number(metadata?.width) || 0);
      const height = Math.max(0, Number(metadata?.height) || 0);
      return width > 0 && height > 0 ? { filePath, width, height } : null;
    } catch {
      return null;
    }
  });

  const readable = inspections.filter(Boolean);
  const fourKTextures = readable.filter((item) =>
    item.width >= FOUR_K_THRESHOLD_PIXELS || item.height >= FOUR_K_THRESHOLD_PIXELS
  );
  const maxTextureDimension = readable.reduce(
    (maximum, item) => Math.max(maximum, item.width, item.height),
    0
  );
  const fourKTextureFiles = fourKTextures
    .sort((a, b) => Math.max(b.width, b.height) - Math.max(a.width, a.height))
    .map((item) => item.filePath)
    .slice(0, MAX_REPORTED_TEXTURES);
  const uses4KTexture = fourKTextures.length > 0;

  return {
    version: TEXTURE_ANALYSIS_VERSION,
    status: textureFiles.length > 0 && readable.length === 0 ? "unreadable" : "analyzed",
    smallAsset: true,
    uses4KTexture,
    requiresReview: uses4KTexture,
    dimensions,
    dimensionsSource,
    maxDimensionMeters: Math.max(dimensions.x, dimensions.y, dimensions.z),
    sizeThresholdMeters: LARGE_OBJECT_LIMIT_METERS,
    textureThresholdPixels: FOUR_K_THRESHOLD_PIXELS,
    maxTextureDimension,
    textureCount: fingerprintResult.fileCount,
    inspectedTextureCount: readable.length,
    unreadableTextureCount: Math.max(0, textureFiles.length - readable.length),
    fourKTextureCount: fourKTextures.length,
    fourKTextureFiles: normalizeReportedFiles(fourKTextureFiles),
    textureFingerprint: fingerprintResult.fingerprint,
    dimensionFingerprint: dimensionToken,
    analyzedAt: now
  };
}

module.exports = {
  TEXTURE_ANALYSIS_VERSION,
  LARGE_OBJECT_LIMIT_METERS,
  FOUR_K_THRESHOLD_PIXELS,
  MAX_REPORTED_TEXTURES,
  MODEL_ASSET_TYPES,
  normalizeDimensions,
  getReliableDimensions,
  isSmallAssetSize,
  isModelAssetType,
  normalizeTextureFiles,
  normalizeTextureAnalysis,
  isTextureAnalysisCurrent,
  analyzeAssetTextureUsage
};
