const path = require("node:path");
const fs = require("node:fs/promises");
const Fuse = require("fuse.js");
const searchIndex = require("./searchIndex");
const chokidar = require("chokidar");

let app = null;
let nativeImage = null;
try {
  const electron = require("electron");
  app = electron.app;
  nativeImage = electron.nativeImage;
} catch {
  // We're likely in a WorkerThread or UtilityProcess
}

let sharp = null;
try {
  sharp = require("sharp");
} catch {
  sharp = null;
}

const JSON_EXTENSIONS = new Set([".json", ".jason"]);
const MODEL_EXTENSIONS = new Set([".fbx", ".obj", ".abc", ".gltf", ".glb"]);
const TEXTURE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".tif", ".tiff", ".exr", ".hdr", ".tga", ".webp", ".bmp"]);
const PREVIEW_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".tif", ".tiff", ".tga", ".webp", ".bmp"]);
const NESTED_FILE_PROPAGATION_MAX_DEPTH = 3;
const QUIXEL_META_JSON_MAX_BYTES = 8 * 1024 * 1024;
const CUSTOM_META_JSON_MAX_BYTES = 64 * 1024 * 1024;
const CUSTOM_LIBRARY_INDEX_DIR = ".assethive";
const CUSTOM_LIBRARY_INDEX_FILE = "custom-index.json";
const CUSTOM_LIBRARY_INDEX_MAX_BYTES = 128 * 1024 * 1024;
const SKIP_DIRECTORY_NAMES = new Set([
  "$recycle.bin",
  "system volume information",
  "windows",
  "program files",
  "program files (x86)",
  "programdata",
  "appdata",
  "node_modules",
  ".git",
  ".svn",
  ".assethive",
  "plugins",
  "support",
  ".bridge",
  "uassets"
]);
const SKIP_FILE_NAMES = new Set(["desktop.ini", "thumbs.db", "assetsdata.json", "arkhive_data.json", "index.json", "custom-index.json"]);
const COLOR_BACKFILL_MAX_ASSETS_PER_SCAN = 24;
const COLOR_BACKFILL_TIMEOUT_MS = 280;
const COLOR_LABELS = [
  { name: "black", rgb: [24, 24, 24] },
  { name: "brown", rgb: [123, 82, 52] },
  { name: "blue", rgb: [74, 114, 196] },
  { name: "gray", rgb: [128, 128, 128] },
  { name: "green", rgb: [76, 140, 72] },
  { name: "orange", rgb: [215, 136, 56] },
  { name: "pink", rgb: [220, 140, 174] },
  { name: "purple", rgb: [132, 96, 172] },
  { name: "red", rgb: [189, 68, 62] },
  { name: "white", rgb: [225, 225, 225] },
  { name: "yellow", rgb: [210, 194, 78] }
];
const COLOR_LABEL_SET = new Set(COLOR_LABELS.map((item) => item.name));

function normalizePath(filePath) {
  return filePath.replaceAll("\\", "/");
}

function normalizeComparePath(filePath) {
  return normalizePath(path.resolve(String(filePath || ""))).toLowerCase();
}

function isUnderRoot(rootPath, targetPath) {
  const root = String(rootPath || "").trim();
  const target = String(targetPath || "").trim();
  if (!root || !target) {
    return false;
  }
  const normalizedRoot = normalizeComparePath(root);
  const normalizedTarget = normalizeComparePath(target);
  if (normalizedTarget === normalizedRoot) {
    return true;
  }
  return normalizedTarget.startsWith(`${normalizedRoot}/`);
}

function isQuixelLikeMeta(meta) {
  if (!meta || typeof meta !== "object") {
    return false;
  }
  const joined = JSON.stringify(meta).toLowerCase();
  return joined.includes("megascans") || joined.includes("quixel") || joined.includes("bridge");
}

function collectJsonDeepStrings(value, collector, depth = 0) {
  if (depth > 10) {
    return;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) {
      collector.push(trimmed);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectJsonDeepStrings(entry, collector, depth + 1);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) {
      collectJsonDeepStrings(entry, collector, depth + 1);
    }
  }
}

function normalizeMegascanAssetDirFromToken(rawToken, megascanRoot) {
  const token = String(rawToken || "").trim();
  if (!token) {
    return "";
  }
  const root = String(megascanRoot || "").trim();
  if (!root) {
    return "";
  }
  const resolvedRoot = path.resolve(root);
  const downloadedRoot = path.join(resolvedRoot, "Downloaded");
  const cleaned = token.replace(/\//g, path.sep);
  const withoutQuotes = cleaned.replace(/^"|"$/g, "");
  const maybePath = withoutQuotes.toLowerCase().endsWith(".json") ? path.dirname(withoutQuotes) : withoutQuotes;
  const resolved = path.isAbsolute(maybePath)
    ? path.resolve(maybePath)
    : path.resolve(
        maybePath.toLowerCase().startsWith(`downloaded${path.sep.toLowerCase()}`)
          ? path.join(resolvedRoot, maybePath)
          : path.join(downloadedRoot, maybePath)
      );
  if (!isUnderRoot(downloadedRoot, resolved)) {
    return "";
  }
  const base = path.basename(resolved).trim();
  if (!base || base.toLowerCase() === "downloaded") {
    return "";
  }
  return resolved;
}

function withTimeout(taskPromise, timeoutMs) {
  const durationMs = Math.max(50, Number(timeoutMs) || 0);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return taskPromise;
  }
  let timeoutId = 0;
  const timeoutPromise = new Promise((resolve) => {
    timeoutId = globalThis.setTimeout(() => resolve(null), durationMs);
  });
  return Promise.race([taskPromise, timeoutPromise]).finally(() => {
    if (timeoutId) {
      globalThis.clearTimeout(timeoutId);
    }
  });
}

async function collectMegascanAssetDirsFromAssetsData(megascanRoot) {
  const root = String(megascanRoot || "").trim();
  if (!root) {
    return [];
  }
  const resolvedRoot = path.resolve(root);
  const signalPath = path.join(resolvedRoot, "Downloaded", "assetsData.json");
  const stats = await fs.stat(signalPath).catch(() => null);
  if (!stats?.isFile()) {
    return [];
  }
  try {
    const raw = await fs.readFile(signalPath, "utf-8");
    const parsed = JSON.parse(raw);
    const strings = [];
    collectJsonDeepStrings(parsed, strings);
    const dirs = new Set();
    for (const entry of strings) {
      const resolved = normalizeMegascanAssetDirFromToken(entry, resolvedRoot);
      if (resolved) {
        dirs.add(resolved);
      }
    }
    return [...dirs];
  } catch {
    return [];
  }
}

async function collectMegascanAssetDirsFromFolderListing(megascanRoot) {
  const root = String(megascanRoot || "").trim();
  if (!root) {
    return [];
  }
  const downloadedRoot = path.join(path.resolve(root), "Downloaded");
  const stats = await fs.stat(downloadedRoot).catch(() => null);
  if (!stats?.isDirectory()) {
    return [];
  }
  const dirs = new Set();
  const topEntries = await fs.readdir(downloadedRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of topEntries) {
    if (!entry.isDirectory()) continue;
    if (shouldSkipDirectory(entry.name)) continue;
    const typeDir = path.join(downloadedRoot, entry.name);
    const children = await fs.readdir(typeDir, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      if (!child.isDirectory()) continue;
      if (shouldSkipDirectory(child.name)) continue;
      dirs.add(path.join(typeDir, child.name));
    }
  }
  return [...dirs];
}

async function collectMegascanAssetFiles(assetDir) {
  const resolvedDir = path.resolve(assetDir);
  const dirFiles = [];
  const stack = [resolvedDir];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) {
      continue;
    }
    const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipDirectory(entry.name)) {
          stack.push(fullPath);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!JSON_EXTENSIONS.has(ext) && !MODEL_EXTENSIONS.has(ext) && !TEXTURE_EXTENSIONS.has(ext)) {
        continue;
      }
      dirFiles.push(fullPath);
    }
  }
  return [...new Set(dirFiles)];
}

async function collectCustomAssetEntriesFromFolderListing(customRoot) {
  const root = String(customRoot || "").trim();
  if (!root) {
    return [];
  }
  const resolvedRoot = path.resolve(root);
  const rootStats = await fs.stat(resolvedRoot).catch(() => null);
  if (!rootStats?.isDirectory()) {
    return [];
  }
  const stack = [resolvedRoot];
  const results = [];
  const metaNames = new Set(["asset_info.json", "asset_info.jason"]);

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    let metaPath = "";
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      if (metaNames.has(lower)) {
        metaPath = path.join(current, entry.name);
        break;
      }
    }
    if (metaPath) {
      results.push({ assetDir: current, metaPath });
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (shouldSkipDirectory(entry.name)) continue;
      stack.push(path.join(current, entry.name));
    }
  }
  return results;
}

async function collectCustomAssetFiles(assetDir, meta) {
  const resolvedDir = path.resolve(assetDir);
  const dirFiles = [];
  const entries = await fs.readdir(resolvedDir, { withFileTypes: true }).catch(() => []);
  const directoryNames = [];
  for (const entry of entries) {
    const fullPath = path.join(resolvedDir, entry.name);
    if (entry.isDirectory()) {
      directoryNames.push(entry.name);
      continue;
    }
    if (!entry.isFile()) continue;
    if (SKIP_FILE_NAMES.has(entry.name.toLowerCase())) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!JSON_EXTENSIONS.has(ext) && !MODEL_EXTENSIONS.has(ext) && !TEXTURE_EXTENSIONS.has(ext)) {
      continue;
    }
    dirFiles.push(fullPath);
  }

  const previewDirCandidates = directoryNames.filter((name) => {
    const lower = String(name || "").trim().toLowerCase();
    return lower === "preview" || lower === "previews";
  });
  for (const folderName of previewDirCandidates) {
    const folderPath = path.join(resolvedDir, folderName);
    const previewEntries = await fs.readdir(folderPath, { withFileTypes: true }).catch(() => []);
    for (const entry of previewEntries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!TEXTURE_EXTENSIONS.has(ext)) continue;
      dirFiles.push(path.join(folderPath, entry.name));
    }
  }

  if (meta && typeof meta === "object") {
    const referenced = [
      ...collectJsonFiles(meta, resolvedDir, "model"),
      ...collectJsonFiles(meta, resolvedDir, "texture")
    ];
    for (const filePath of referenced) {
      const resolved = path.resolve(String(filePath || ""));
      const stats = await fs.stat(resolved).catch(() => null);
      if (!stats?.isFile()) continue;
      dirFiles.push(resolved);
    }
  }

  return [...new Set(dirFiles)];
}

function shouldSkipDirectory(dirName) {
  const lower = dirName.toLowerCase();
  return lower.startsWith(".") || lower.startsWith("$") || SKIP_DIRECTORY_NAMES.has(lower);
}

function normalizeAssetType(value) {
  if (typeof value !== "string") {
    return "";
  }
  const lower = value.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (!lower) {
    return "";
  }
  if (lower === "3dasset" || lower === "asset3d") {
    return "3d";
  }
  if (lower === "3dplants" || lower === "plant3d") {
    return "3dplant";
  }
  if (lower === "imperfections") {
    return "imperfection";
  }
  if (lower === "atlases") {
    return "atlas";
  }
  if (lower === "displacements") {
    return "displacement";
  }
  if (lower === "decals") {
    return "decal";
  }
  return lower;
}

function normalizeTheme(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function mapFolderTypeToAssetType(folderType) {
  if (folderType === "atlas") {
    return "decal";
  }
  return folderType;
}

function getAssetTypeFromPath(assetDir, source = "") {
  const segments = normalizePath(assetDir).toLowerCase().split("/").filter(Boolean);
  const known = new Set(["3d", "3dplant", "surface", "decal", "atlas", "imperfection", "displacement", "brush"]);
  const parentFolder = segments.length >= 2 ? normalizeAssetType(segments[segments.length - 2]) : "";
  if ((source === "quixel" || source === "custom") && known.has(parentFolder)) {
    return mapFolderTypeToAssetType(parentFolder);
  }
  for (const segment of segments) {
    const normalized = normalizeAssetType(segment);
    if (known.has(normalized)) {
      return mapFolderTypeToAssetType(normalized);
    }
  }
  return "";
}

function getAssetType(meta, assetDir = "", source = "") {
  const fromPath = getAssetTypeFromPath(assetDir, source);
  if (fromPath) {
    return fromPath;
  }
  const fromJson = normalizeAssetType(meta?.asset_type || meta?.assetType || meta?.type);
  if (fromJson) {
    return mapFolderTypeToAssetType(fromJson);
  }
  return "";
}

function isInUAssetsPath(filePath) {
  return normalizePath(filePath).toLowerCase().split("/").includes("uassets");
}

async function readDirSafe(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function readJsonSafe(filePath, options = {}) {
  const maxBytes = Number(options?.maxBytes || 0);
  try {
    if (maxBytes > 0) {
      const stats = await fs.stat(filePath).catch(() => null);
      if (stats && stats.size > maxBytes) {
        return null;
      }
    }
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getCustomLibraryIndexPath(customRoot) {
  const root = String(customRoot || "").trim();
  if (!root) {
    return "";
  }
  return path.join(path.resolve(root), CUSTOM_LIBRARY_INDEX_DIR, CUSTOM_LIBRARY_INDEX_FILE);
}

async function writeJsonAtomic(filePath, data) {
  const target = String(filePath || "").trim();
  if (!target) return false;
  const dir = path.dirname(target);
  try {
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = `${target}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(data));
    await fs.rm(target, { force: true }).catch(() => {});
    await fs.rename(tmpPath, target);
    return true;
  } catch {
    return false;
  }
}

function extractTags(meta, folderName, assetDir = "", source = "") {
  const tags = new Set();
  if (folderName) {
    tags.add(folderName.toLowerCase());
  }
  if (Array.isArray(meta?.tags)) {
    for (const tag of meta.tags) {
      if (typeof tag === "string" && tag.trim()) {
        tags.add(tag.toLowerCase());
      }
    }
  }
  // Parse semanticTags
  if (meta?.semanticTags && typeof meta.semanticTags === "object") {
    const semantic = meta.semanticTags;
    if (Array.isArray(semantic.contains)) {
      semantic.contains.forEach(t => typeof t === "string" && tags.add(t.toLowerCase()));
    }
    if (Array.isArray(semantic.theme)) {
      semantic.theme.forEach(t => typeof t === "string" && tags.add(t.toLowerCase()));
    }
    if (Array.isArray(semantic.descriptive)) {
      semantic.descriptive.forEach(t => typeof t === "string" && tags.add(t.toLowerCase()));
    }
    if (Array.isArray(semantic.environment)) {
      semantic.environment.forEach(t => typeof t === "string" && tags.add(t.toLowerCase()));
    }
    if (semantic.subject_matter) {
      tags.add(semantic.subject_matter.toLowerCase());
    }
  }

  const assetType = getAssetType(meta, assetDir, source);
  if (assetType) {
    tags.add(assetType);
  }
  for (const key of ["category", "asset_type", "assetType", "type", "biome", "theme"]) {
    const value = meta?.[key];
    if (typeof value === "string" && value.trim()) {
      const normalizedValue = normalizeAssetType(value);
      if (normalizedValue) {
        tags.add(normalizedValue);
      }
    }
  }
  return [...tags];
}

function extractThemes(meta) {
  const themes = new Set();
  const addTheme = (value) => {
    const normalized = normalizeTheme(value);
    if (normalized) {
      themes.add(normalized);
    }
  };
  if (typeof meta?.theme === "string") {
    addTheme(meta.theme);
  }
  if (Array.isArray(meta?.theme)) {
    meta.theme.forEach(addTheme);
  }
  if (Array.isArray(meta?.semanticTags?.theme)) {
    meta.semanticTags.theme.forEach(addTheme);
  }
  return [...themes];
}

function normalizeColorTag(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return COLOR_LABEL_SET.has(normalized) ? normalized : "";
}

function collectColorTagsFromMeta(meta) {
  const colorTags = new Set();
  const add = (value) => {
    const normalized = normalizeColorTag(value);
    if (normalized) {
      colorTags.add(normalized);
    }
  };
  if (Array.isArray(meta?.colorTags)) {
    meta.colorTags.forEach(add);
  }
  if (Array.isArray(meta?.colors)) {
    meta.colors.forEach(add);
  }
  if (typeof meta?.semanticTags?.color === "string") {
    add(meta.semanticTags.color);
  }
  if (Array.isArray(meta?.semanticTags?.color)) {
    meta.semanticTags.color.forEach(add);
  }
  if (Array.isArray(meta?.semanticTags?.colors)) {
    meta.semanticTags.colors.forEach(add);
  }
  return [...colorTags];
}

function colorDistanceSq(rgbA, rgbB) {
  const dr = rgbA[0] - rgbB[0];
  const dg = rgbA[1] - rgbB[1];
  const db = rgbA[2] - rgbB[2];
  return dr * dr + dg * dg + db * db;
}

function nearestColorTag(rgb) {
  let best = COLOR_LABELS[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const item of COLOR_LABELS) {
    const distance = colorDistanceSq(rgb, item.rgb);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = item;
    }
  }
  return best.name;
}

function looksLikeAlbedoFile(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  if (!TEXTURE_EXTENSIONS.has(ext) || ext === ".exr") {
    return false;
  }
  const name = path.basename(String(filePath || "")).toLowerCase();
  if (!/(albedo|basecolor|diffuse|color)/i.test(name)) {
    return false;
  }
  return !/(normal|roughness|metal|ao|opacity|mask|displacement|height|specular|gloss)/i.test(name);
}

async function getImageArea(filePath) {
  if (sharp) {
    try {
      const metadata = await sharp(String(filePath || "")).metadata();
      return (metadata.width || 0) * (metadata.height || 0);
    } catch {
      return 0;
    }
  }
  if (!nativeImage) {
    return 0;
  }
  try {
    const image = nativeImage.createFromPath(String(filePath || ""));
    const size = image.getSize();
    return (size.width || 0) * (size.height || 0);
  } catch {
    return 0;
  }
}

async function countImageColorBuckets(filePath, counts) {
  if (sharp) {
    try {
      const { data, info } = await sharp(String(filePath || ""))
        .resize(32, 32, { fit: "cover" })
        .raw()
        .toBuffer({ resolveWithObject: true });
      for (let i = 0; i < data.length; i += info.channels) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const label = nearestColorTag([r, g, b]);
        counts.set(label, (counts.get(label) || 0) + 1);
      }
      return true;
    } catch {
      return false;
    }
  }
  if (!nativeImage) {
    return false;
  }
  try {
    const rawImage = nativeImage.createFromPath(String(filePath || ""));
    if (rawImage.isEmpty()) {
      return false;
    }
    const resized = rawImage.resize({ width: 32, height: 32 });
    const buffer = resized.getBitmap();
    for (let i = 0; i < buffer.length; i += 4) {
      const b = buffer[i];
      const g = buffer[i + 1];
      const r = buffer[i + 2];
      const label = nearestColorTag([r, g, b]);
      counts.set(label, (counts.get(label) || 0) + 1);
    }
    return true;
  } catch {
    return false;
  }
}

async function inferColorTagsFromTextureFiles(textureFiles, options = {}) {
  const minColorTags = Math.max(1, Number(options?.minColorTags) || 2);
  const maxColorTags = Math.max(minColorTags, Number(options?.maxColorTags) || 4);
  const maxCandidateImages = Math.max(1, Number(options?.maxCandidateImages) || 4);
  const uniqueFiles = [...new Set((Array.isArray(textureFiles) ? textureFiles : []).map((filePath) => String(filePath || "").trim()).filter(Boolean))];
  const albedoCandidates = uniqueFiles.filter((filePath) => looksLikeAlbedoFile(filePath));
  if (albedoCandidates.length === 0) {
    return [];
  }
  const sized = await Promise.all(albedoCandidates.map(async (filePath) => ({ filePath, area: await getImageArea(filePath) })));
  const topImages = sized
    .sort((a, b) => b.area - a.area)
    .slice(0, maxCandidateImages)
    .map((item) => item.filePath);
  const counts = new Map();
  for (const filePath of topImages) {
    await countImageColorBuckets(filePath, counts);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tag);
  if (sorted.length === 0) {
    return [];
  }
  if (sorted.length < minColorTags) {
    return sorted;
  }
  return sorted.slice(0, maxColorTags);
}

async function inferColorTagsWithTimeout(textureFiles, options = {}) {
  const timeoutMs = Math.max(120, Number(options?.timeoutMs) || COLOR_BACKFILL_TIMEOUT_MS);
  return await Promise.race([
    inferColorTagsFromTextureFiles(textureFiles, options),
    new Promise((resolve) => {
      globalThis.setTimeout(() => resolve([]), timeoutMs);
    })
  ]).catch(() => []);
}

async function backfillColorTagsMeta(metaPath, meta, colorTags) {
  if (!metaPath || !meta || !Array.isArray(colorTags) || colorTags.length === 0) {
    return;
  }
  const uniqueTags = [...new Set(colorTags.map((tag) => normalizeColorTag(tag)).filter(Boolean))];
  if (uniqueTags.length === 0) {
    return;
  }
  const semanticTags = meta.semanticTags && typeof meta.semanticTags === "object" && !Array.isArray(meta.semanticTags)
    ? meta.semanticTags
    : {};
  semanticTags.color = uniqueTags;
  const nextMeta = {
    ...meta,
    colorTags: uniqueTags,
    semanticTags
  };
  await fs.writeFile(metaPath, JSON.stringify(nextMeta, null, 2), "utf8");
  meta.colorTags = uniqueTags;
  meta.semanticTags = semanticTags;
}

function hasAssetLikeMeta(meta) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return false;
  }
  if (typeof meta.name === "string" || typeof meta.assetName === "string") {
    return true;
  }
  if (typeof meta.id === "string" || typeof meta.assetID === "string") {
    return true;
  }
  if (Array.isArray(meta.tags) && meta.tags.length > 0) {
    return true;
  }
  if (typeof meta.category === "string" || typeof meta.assetType === "string" || typeof meta.asset_type === "string") {
    return true;
  }
  return isQuixelLikeMeta(meta);
}

function resolveMetaFilePath(assetDir, value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(assetDir, raw);
  return normalizePath(resolved);
}

function collectJsonFiles(meta, assetDir, kind) {
  const extensions = kind === "model" ? MODEL_EXTENSIONS : TEXTURE_EXTENSIONS;
  const unique = new Set();
  const pushIfValid = (value) => {
    const normalized = resolveMetaFilePath(assetDir, value);
    if (!normalized) {
      return;
    }
    const ext = path.extname(normalized).toLowerCase();
    if (!extensions.has(ext)) {
      return;
    }
    unique.add(normalized);
  };
  if (kind === "model" && meta?.modelSlots && typeof meta.modelSlots === "object" && !Array.isArray(meta.modelSlots)) {
    for (const filePath of Object.values(meta.modelSlots)) {
      pushIfValid(filePath);
    }
  }
  const fileField = kind === "model" ? meta?.modelFiles : meta?.textureFiles;
  if (Array.isArray(fileField)) {
    for (const filePath of fileField) {
      pushIfValid(filePath);
    }
  }
  if (Array.isArray(meta?.components)) {
    for (const item of meta.components) {
      if (!item || typeof item !== "object") {
        continue;
      }
      if (String(item.type || "").trim().toLowerCase() !== kind) {
        continue;
      }
      pushIfValid(item.path || item.uri);
    }
  }
  return [...unique];
}

function parseDimensionValue(input) {
  if (typeof input === "number" && Number.isFinite(input)) {
    // If it's a raw number, we assume it's Centimeters (standard in UE/3D), so convert to Meters.
    // Unless it's very small? No, standardizing on Meters means we should be consistent.
    // Legacy behavior was: return numeric. And SizeComparison guessed.
    // New behavior: Always return Meters.
    // If input was 200 (cm), return 2.
    // If input was 2 (m), return 0.02? No.
    // Ambiguity exists. But usually raw numbers in 3D are cm.
    return input / 100;
  }
  const text = String(input || "").trim().toLowerCase();
  if (!text) {
    return null;
  }
  const matched = text.match(/-?\d+(\.\d+)?/);
  if (!matched) {
    return null;
  }
  const numeric = Number(matched[0]);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  if (text.endsWith("m") && !text.endsWith("cm") && !text.endsWith("mm")) {
      return numeric;
  }
  if (text.includes("cm")) {
    return numeric / 100;
  }
  if (text.includes("mm")) {
    return numeric / 1000;
  }
  // Default no unit: assume cm
  return numeric / 100;
}

function extractDimensions(meta) {
  const fromScan = meta?.scanInformation?.dimensions;
  if (fromScan && typeof fromScan === "object") {
    const x = Number(fromScan.x);
    const y = Number(fromScan.y);
    const z = Number(fromScan.z);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      return { x, y, z };
    }
  }
  const entries = Array.isArray(meta?.meta) ? meta.meta : [];
  let length = null;
  let width = null;
  let height = null;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const key = String(entry.key || "").trim().toLowerCase();
    if (key === "length") {
      length = parseDimensionValue(entry.value);
    } else if (key === "width") {
      width = parseDimensionValue(entry.value);
    } else if (key === "height") {
      height = parseDimensionValue(entry.value);
    }
  }
  if (length === null || width === null || height === null) {
    return null;
  }
  return { x: length, y: height, z: width };
}

function getFallbackDimensions(assetType) {
  const normalizedType = String(assetType || "").toLowerCase();
  if (normalizedType === "3d" || normalizedType === "3dplant") {
    return { x: 1, y: 1, z: 1 };
  }
  return null;
}

async function backfillDimensionsMeta(metaPath, meta, dimensions) {
  if (!metaPath || !meta || !dimensions) {
    return;
  }
  const scanInformation = meta.scanInformation && typeof meta.scanInformation === "object" && !Array.isArray(meta.scanInformation)
    ? meta.scanInformation
    : {};
  scanInformation.dimensions = dimensions;
  const nextMeta = {
    ...meta,
    scanInformation
  };
  await fs.writeFile(metaPath, JSON.stringify(nextMeta, null, 2), "utf8");
}

async function collectFiles(root, options = {}) {
  const onProgress = typeof options?.onProgress === "function" ? options.onProgress : null;
  const source = String(options?.source || "").trim().toLowerCase();
  const stack = [root];
  const filesByDirectory = new Map();
  const nestedFilesByDirectory = new Map();
  const metaFiles = [];
  const rootWithSep = `${root}${path.sep}`;
  let visitedDirectoryCount = 0;
  let lastProgress = 0;
  let lastEmitAt = 0;
  while (stack.length) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const entries = await readDirSafe(current);
    visitedDirectoryCount += 1;
    if (onProgress) {
      const now = Date.now();
      if (now - lastEmitAt >= 200) {
        const estimatedTotal = Math.max(visitedDirectoryCount, visitedDirectoryCount + stack.length);
        const ratio = estimatedTotal > 0 ? visitedDirectoryCount / estimatedTotal : 0;
        const targetProgress = Math.max(0, Math.min(5, ratio * 5));
        const progress = Math.max(lastProgress, targetProgress);
        lastProgress = progress;
        lastEmitAt = now;
        onProgress({ source, phase: "collect", processed: visitedDirectoryCount, total: estimatedTotal, progress });
      }
    }
    if (visitedDirectoryCount % 24 === 0) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (shouldSkipDirectory(entry.name)) {
          continue;
        }
        stack.push(fullPath);
      } else {
        if (SKIP_FILE_NAMES.has(entry.name.toLowerCase())) {
          continue;
        }
        const ext = path.extname(fullPath).toLowerCase();
        if (!JSON_EXTENSIONS.has(ext) && !MODEL_EXTENSIONS.has(ext) && !TEXTURE_EXTENSIONS.has(ext)) {
          continue;
        }
        const directory = path.dirname(fullPath);
        const list = filesByDirectory.get(directory) || [];
        list.push(fullPath);
        filesByDirectory.set(directory, list);
        let ancestor = directory;
        let depthSegment = 1;
        while (ancestor && depthSegment <= NESTED_FILE_PROPAGATION_MAX_DEPTH) {
          if (!(ancestor === root || ancestor.startsWith(rootWithSep))) {
            break;
          }
          const nestedList = nestedFilesByDirectory.get(ancestor) || [];
          nestedList.push(fullPath);
          nestedFilesByDirectory.set(ancestor, nestedList);
          if (ancestor === root) {
            break;
          }
          const parent = path.dirname(ancestor);
          if (!parent || parent === ancestor) {
            break;
          }
          ancestor = parent;
          depthSegment += 1;
        }
        if (JSON_EXTENSIONS.has(ext)) {
          metaFiles.push(fullPath);
        }
      }
    }
  }
  if (onProgress) {
    onProgress({ source, phase: "collect", processed: visitedDirectoryCount, total: visitedDirectoryCount, progress: 5 });
  }
  return {
    filesByDirectory,
    nestedFilesByDirectory,
    metaFiles,
    rootPath: root
  };
}

function findPreviewImages(files, meta, assetDir, options = {}) {
  const source = String(options?.source || "").trim().toLowerCase();
  const assetType = String(options?.assetType || "").trim().toLowerCase();
  const assetId = String(options?.assetId || "").trim();
  if (source === "quixel") {
    return findMegascanPreviewImages(files, assetDir, assetId, assetType);
  }
  return findCustomPreviewImages(files, meta, assetDir);
}

function findMegascanPreviewImages(files, assetDir, assetId, assetType) {
  const textureFiles = files.filter((file) => PREVIEW_IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase()));
  const resolvedAssetDir = path.resolve(assetDir).toLowerCase();
  const normalizedId = String(assetId || "").trim().toLowerCase();
  const folderBase = path.basename(String(assetDir || "")).trim();
  const folderBaseLower = folderBase.toLowerCase();
  const lastUnderscoreToken = folderBaseLower.includes("_") ? folderBaseLower.split("_").pop() : "";
  const lastUnderscoreId = /^[a-z0-9]{4,20}$/i.test(lastUnderscoreToken || "") ? lastUnderscoreToken : "";
  const sanitizedFolderToken = folderBaseLower
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  const prefixCandidates = [
    normalizedId,
    lastUnderscoreId,
    folderBaseLower,
    sanitizedFolderToken
  ]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);

  if (prefixCandidates.length === 0) {
    return { previewImage: null, detailImage: null };
  }

  const pickByExtPriority = (candidates) => {
    const priority = new Map([[".png", 5], [".jpg", 4], [".jpeg", 3], [".webp", 2], [".bmp", 1]]);
    return [...candidates]
      .map((filePath) => ({ filePath, score: priority.get(path.extname(filePath).toLowerCase()) || 0 }))
      .sort((a, b) => b.score - a.score)[0]?.filePath || null;
  };

  const rootFiles = textureFiles.filter((filePath) => path.resolve(path.dirname(filePath)).toLowerCase() === resolvedAssetDir);
  let previewImage = null;
  for (const prefix of prefixCandidates) {
    const candidates = rootFiles.filter((filePath) => path.basename(filePath).toLowerCase().startsWith(`${prefix}_preview.`));
    const picked = pickByExtPriority(candidates);
    if (picked) {
      previewImage = picked;
      break;
    }
  }

  return { previewImage, detailImage: previewImage };
}

function findCustomPreviewImages(files, meta, assetDir) {
  const textureFiles = files.filter((file) => PREVIEW_IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase()));
  let previewImage = null;

  const normalizeFileToken = (value) =>
    String(value || "")
      .toLowerCase()
      .replace(/\\/g, "/")
      .replace(/^\.?\//, "");

  const isPreviewFolderFile = (filePath) => {
    const token = normalizeFileToken(filePath);
    return token.includes("/previews/") || token.includes("/preview/");
  };

  const resolveByMetaUri = (uriValue) => {
    const token = normalizeFileToken(uriValue);
    if (!token) {
      return null;
    }
    if (!token.includes("preview/") && !token.includes("previews/")) {
      return null;
    }
    const baseName = path.basename(token);
    const exactByUri = textureFiles.find((filePath) => normalizeFileToken(filePath).endsWith(token));
    if (exactByUri) {
      return exactByUri;
    }
    const exactByBase = textureFiles.find((filePath) => path.basename(filePath).toLowerCase() === baseName);
    if (exactByBase) {
      return exactByBase;
    }
    return null;
  };

  const scoreDetailPreview = (filePath) => {
    const name = path.basename(filePath).toLowerCase();
    let score = 0;

    if (name.includes("normal") || name.includes("roughness") || name.includes("metalness") || name.includes("ao") || name.includes("displacement")) return -100;
    if (name.includes("billboard") || name.includes("lod")) return -50;
    if (name.endsWith("_preview.png")) score += 50;
    if (name.includes("popup")) score += 40;
    if (name.includes("thumb")) score += 30;
    if (name.includes("preview")) score += 20;
    if (name.endsWith("_sp.jpg") || name.endsWith("_sp.jpeg")) score += 20;
    if (name.includes("highpoly")) score += 10;
    if (name.includes("render")) score += 8;
    if (name.includes("retina")) score += 5;
    return score;
  };

  const scoreCardPreview = (filePath) => {
    const name = path.basename(filePath).toLowerCase();
    let score = scoreDetailPreview(filePath);
    if (name.endsWith("_preview.png") || name.endsWith("_preview.jpg") || name.endsWith("_preview.jpeg")) score += 80;
    if (name.includes("_sp.") || name.includes("sidepanel")) score -= 40;
    return score;
  };

  const previewsFolderFiles = textureFiles.filter((filePath) => isPreviewFolderFile(filePath));

  let metaPreview = null;
  if (meta?.previews?.images && Array.isArray(meta.previews.images)) {
    for (const img of meta.previews.images) {
      if (!img?.uri) continue;
      metaPreview = resolveByMetaUri(img.uri);
      if (metaPreview) break;
    }
  }
  metaPreview = metaPreview || resolveByMetaUri(meta?.previewImage) || resolveByMetaUri(meta?.detailImage);
  if (metaPreview) {
    previewImage = metaPreview;
  } else if (previewsFolderFiles.length > 0) {
    previewImage = [...previewsFolderFiles].sort((a, b) => scoreCardPreview(b) - scoreCardPreview(a))[0];
  }

  const detailImage = previewImage ? previewImage : null;
  return { previewImage, detailImage };
}

function buildLightMeta(meta) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return {};
  }
  const light = {};
  if (typeof meta.name === "string") light.name = meta.name;
  if (typeof meta.assetName === "string") light.assetName = meta.assetName;
  if (typeof meta.assetID === "string") light.assetID = meta.assetID;
  if (typeof meta.id === "string") light.id = meta.id;
  if (typeof meta.assetType === "string") light.assetType = meta.assetType;
  if (typeof meta.asset_type === "string") light.asset_type = meta.asset_type;
  if (typeof meta.category === "string") light.category = meta.category;
  if (typeof meta.previewImage === "string") light.previewImage = meta.previewImage;
  if (typeof meta.detailImage === "string") light.detailImage = meta.detailImage;
  if (meta.previews && typeof meta.previews === "object" && !Array.isArray(meta.previews)) {
    const relativeSize = String(meta.previews.relativeSize || "").trim();
    if (relativeSize) {
      light.previews = { relativeSize };
    }
  }
  if (typeof meta.normalMapFormat === "string") light.normalMapFormat = meta.normalMapFormat;
  if (meta.normalMapFormats && typeof meta.normalMapFormats === "object" && !Array.isArray(meta.normalMapFormats)) {
    light.normalMapFormats = Object.fromEntries(
      Object.entries(meta.normalMapFormats)
        .filter(([key, value]) => String(key).trim() && typeof value === "string" && value.trim())
    );
  }
  if (Array.isArray(meta.textureEntries)) {
    light.textureEntries = meta.textureEntries
      .filter((item) => item && typeof item === "object")
      .map((item) => {
        const next = {};
        if (typeof item.textureType === "string") next.textureType = item.textureType;
        if (typeof item.slot === "string") next.slot = item.slot;
        if (typeof item.uri === "string") next.uri = item.uri;
        if (typeof item.path === "string") next.path = item.path;
        if (Number.isFinite(Number(item.areaIndex))) next.areaIndex = Math.max(1, Number(item.areaIndex) || 1);
        if (typeof item.normalMapFormat === "string") next.normalMapFormat = item.normalMapFormat;
        return next;
      })
      .filter((item) => Object.keys(item).length > 0);
  }
  if (Array.isArray(meta.tags)) light.tags = meta.tags.filter((tag) => typeof tag === "string");
  const colorTags = collectColorTagsFromMeta(meta);
  if (colorTags.length > 0) {
    light.colorTags = colorTags;
  }
  if (meta.modelSlots && typeof meta.modelSlots === "object" && !Array.isArray(meta.modelSlots)) {
    light.modelSlots = Object.fromEntries(
      Object.entries(meta.modelSlots).filter(([, value]) => typeof value === "string" && value.trim())
    );
  }
  if (Array.isArray(meta.components)) {
    light.components = meta.components
      .filter((item) => item && typeof item === "object")
      .map((item) => {
        const next = {};
        if (typeof item.type === "string") next.type = item.type;
        if (typeof item.slot === "string") next.slot = item.slot;
        if (typeof item.uri === "string") next.uri = item.uri;
        if (typeof item.path === "string") next.path = item.path;
        if (Number.isFinite(Number(item.areaIndex))) next.areaIndex = Math.max(1, Number(item.areaIndex) || 1);
        if (typeof item.normalMapFormat === "string") next.normalMapFormat = item.normalMapFormat;
        return next;
      })
      .filter((item) => Object.keys(item).length > 0);
  }

  const semanticTags = meta.semanticTags && typeof meta.semanticTags === "object" && !Array.isArray(meta.semanticTags)
    ? meta.semanticTags
    : null;
  if (semanticTags) {
    const slimSemantic = {};
    if (typeof semanticTags.asset_type === "string") slimSemantic.asset_type = semanticTags.asset_type;
    if (typeof semanticTags.subject_matter === "string") slimSemantic.subject_matter = semanticTags.subject_matter;
    if (Array.isArray(semanticTags.theme)) slimSemantic.theme = semanticTags.theme.filter((item) => typeof item === "string");
    if (Object.keys(slimSemantic).length > 0) {
      light.semanticTags = slimSemantic;
    }
  }

  const rawDimensions = meta?.scanInformation?.dimensions;
  if (rawDimensions && typeof rawDimensions === "object") {
    const x = Number(rawDimensions.x);
    const y = Number(rawDimensions.y);
    const z = Number(rawDimensions.z);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      light.scanInformation = { dimensions: { x, y, z } };
    }
  }

  if (Array.isArray(meta.meta)) {
    const dimensionMeta = meta.meta
      .filter((entry) => entry && typeof entry === "object")
      .filter((entry) => {
        const key = String(entry.key || "").trim().toLowerCase();
        return key === "length" || key === "width" || key === "height";
      })
      .map((entry) => ({
        key: entry.key,
        name: entry.name,
        value: entry.value
      }));
    if (dimensionMeta.length > 0) {
      light.meta = dimensionMeta;
    }
  }

  return light;
}

function createAssetRecord(assetDir, metaPath, meta, files, forcedSource) {
  const rawAssetId =
    (typeof meta?.assetID === "string" && meta.assetID.trim()) ? meta.assetID :
    (typeof meta?.id === "string" && meta.id.trim()) ? meta.id :
    normalizePath(assetDir);
  const previewKeyId =
    (typeof meta?.assetID === "string" && meta.assetID.trim()) ? meta.assetID.trim() :
    (typeof meta?.id === "string" && meta.id.trim()) ? meta.id.trim() :
    path.basename(String(metaPath || ""), path.extname(String(metaPath || "")));
  const displayName = meta?.name || meta?.assetName || path.basename(assetDir);
  const source = forcedSource || (isQuixelLikeMeta(meta) || /megascans|quixel/i.test(assetDir) ? "quixel" : "custom");
  const scannedModelFiles = files.filter((file) => MODEL_EXTENSIONS.has(path.extname(file).toLowerCase())).map(normalizePath);
  const scannedTextureFiles = files.filter((file) => TEXTURE_EXTENSIONS.has(path.extname(file).toLowerCase())).map(normalizePath);
  const modelFilesFromJson = source === "custom" ? collectJsonFiles(meta, assetDir, "model") : scannedModelFiles;
  const textureFilesFromJson = source === "custom" ? collectJsonFiles(meta, assetDir, "texture") : scannedTextureFiles;
  const scannedModelSet = new Set(scannedModelFiles.map((filePath) => String(filePath || "").toLowerCase()));
  const scannedTextureSet = new Set(scannedTextureFiles.map((filePath) => String(filePath || "").toLowerCase()));
  const modelFiles =
    source === "custom"
      ? modelFilesFromJson.filter((filePath) => scannedModelSet.has(String(filePath || "").toLowerCase()))
      : modelFilesFromJson;
  const textureFiles =
    source === "custom"
      ? textureFilesFromJson.filter((filePath) => scannedTextureSet.has(String(filePath || "").toLowerCase()))
      : textureFilesFromJson;
  const finalModelFiles = modelFiles.length > 0 ? modelFiles : scannedModelFiles;
  const finalTextureFiles = textureFiles.length > 0 ? textureFiles : scannedTextureFiles;
  if (finalModelFiles.length === 0 && finalTextureFiles.length === 0) {
    return null;
  }
  if (!hasAssetLikeMeta(meta)) {
    return null;
  }
  
  const assetType = getAssetType(meta, assetDir, source);
  const { previewImage, detailImage } = findPreviewImages(files, meta, assetDir, { source, assetType, assetId: source === "quixel" ? String(previewKeyId) : String(rawAssetId) });
  const themes = extractThemes(meta);
  
  const extractedDimensions = (assetType === "3d" || assetType === "3dplant") ? extractDimensions(meta) : null;
  const dimensions = extractedDimensions || getFallbackDimensions(assetType);
  const lightMeta = buildLightMeta(meta);
  if (dimensions) {
    lightMeta.scanInformation = lightMeta.scanInformation && typeof lightMeta.scanInformation === "object" ? lightMeta.scanInformation : {};
    lightMeta.scanInformation.dimensions = dimensions;
  } else if (lightMeta?.scanInformation && typeof lightMeta.scanInformation === "object" && "dimensions" in lightMeta.scanInformation) {
    delete lightMeta.scanInformation.dimensions;
  }

  return {
    id: String(rawAssetId),
    assetID: String(rawAssetId),
    name: displayName,
    source,
    path: assetDir,
    metaPath,
    meta: lightMeta,
    assetType,
    themes,
    colorTags: collectColorTagsFromMeta(meta),
    tags: extractTags(meta, path.basename(path.dirname(assetDir)), assetDir, source),
    modelFiles: finalModelFiles,
    textureFiles: finalTextureFiles,
    preview: previewImage ? normalizePath(previewImage) : null,
    previewImage: previewImage ? normalizePath(previewImage) : null,
    detailImage: detailImage ? normalizePath(detailImage) : null,
    createdAt: meta?.createdAt || null,
    shouldBackfillDimensions: Boolean(!extractedDimensions && dimensions)
  };
}

async function scanPath(rootPath, source, options = {}) {
  if (!rootPath) return [];
  const index = [];
  const maxMetaBytes = source === "custom" ? CUSTOM_META_JSON_MAX_BYTES : QUIXEL_META_JSON_MAX_BYTES;
  const onProgress = typeof options?.onProgress === "function" ? options.onProgress : null;
  const onRecord = typeof options?.onRecord === "function" ? options.onRecord : null;
  if (source === "quixel") {
    const normalizedRootPath = path.resolve(String(rootPath || ""));
    const megascanRoot = path.basename(normalizedRootPath).toLowerCase() === "downloaded"
      ? path.dirname(normalizedRootPath)
      : normalizedRootPath;
    if (onProgress) {
      onProgress({ source, phase: "collect", processed: 0, total: 0, progress: 0 });
    }
    const fromAssetsData = await collectMegascanAssetDirsFromAssetsData(megascanRoot);
    const fromListing = await collectMegascanAssetDirsFromFolderListing(megascanRoot);
    const merged = [...new Set([...fromAssetsData, ...fromListing].map((value) => path.resolve(value)))];
    const totalDirs = merged.length;
    if (onProgress) {
      onProgress({ source, phase: "scan", processed: 0, total: totalDirs, progress: totalDirs > 0 ? 5 : 100 });
    }
    let processedDirs = 0;
    for (const assetDir of merged) {
      processedDirs += 1;
      if (processedDirs % 6 === 0) {
        await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
      }
      if (isInUAssetsPath(assetDir)) {
        continue;
      }
      const dirEntries = await fs.readdir(assetDir, { withFileTypes: true }).catch(() => []);
      const jsonFiles = dirEntries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .filter((name) => path.extname(name).toLowerCase() === ".json")
        .filter((name) => !SKIP_FILE_NAMES.has(name.toLowerCase()))
        .map((name) => path.join(assetDir, name));
      let metaPath = "";
      let meta = null;
      for (const candidate of jsonFiles) {
        if (isInUAssetsPath(candidate)) continue;
        const parsed = await readJsonSafe(candidate, { maxBytes: maxMetaBytes });
        if (!parsed) continue;
        if (!hasAssetLikeMeta(parsed)) continue;
        metaPath = candidate;
        meta = parsed;
        break;
      }
      if (!meta || !metaPath) {
        if (onProgress && (processedDirs % 16 === 0 || processedDirs === totalDirs)) {
          const progress = totalDirs > 0 ? 5 + (processedDirs / totalDirs) * 95 : 100;
          onProgress({ source, phase: "scan", processed: processedDirs, total: totalDirs, progress });
        }
        continue;
      }
      const dirFiles = await collectMegascanAssetFiles(assetDir);
      const record = createAssetRecord(assetDir, metaPath, meta, dirFiles, source);
      if (record) {
        delete record.shouldBackfillDimensions;
        index.push(record);
        if (onRecord) {
          onRecord(record);
        }
      }
      if (onProgress && (processedDirs % 8 === 0 || processedDirs === totalDirs)) {
        const progress = totalDirs > 0 ? 5 + (processedDirs / totalDirs) * 95 : 100;
        onProgress({ source, phase: "scan", processed: processedDirs, total: totalDirs, progress });
      }
    }
    return index;
  }

  if (source === "custom") {
    const customRoot = path.resolve(String(rootPath || ""));
    if (onProgress) {
      onProgress({ source, phase: "collect", processed: 0, total: 0, progress: 0 });
    }
    const customIndexPath = getCustomLibraryIndexPath(customRoot);
    const cachedIndex = customIndexPath
      ? await readJsonSafe(customIndexPath, { maxBytes: CUSTOM_LIBRARY_INDEX_MAX_BYTES })
      : null;
    const cachedEntries = Array.isArray(cachedIndex?.assets) ? cachedIndex.assets : [];
    const cachedPairs = [];
    for (const entry of cachedEntries) {
      if (!entry || typeof entry !== "object") continue;
      const metaPath = String(entry.metaPath || "").trim();
      if (!metaPath) continue;
      cachedPairs.push([normalizeComparePath(metaPath), entry]);
    }
    const cachedByMetaPath = new Map(cachedPairs);
    let discovered = await collectCustomAssetEntriesFromFolderListing(customRoot);
    if (discovered.length === 0 && cachedByMetaPath.size > 0) {
      discovered = [...cachedByMetaPath.values()]
        .map((entry) => {
          const metaPath = String(entry?.metaPath || "").trim();
          const recordPath = String(entry?.record?.path || "").trim();
          const assetDir = recordPath || (metaPath ? path.dirname(metaPath) : "");
          return { metaPath, assetDir };
        })
        .filter((entry) => entry.metaPath && entry.assetDir);
    }
    if (discovered.length > 0) {
      const totalDirs = discovered.length;
      if (onProgress) {
        onProgress({ source, phase: "scan", processed: 0, total: totalDirs, progress: 5 });
      }
      let processedDirs = 0;
      const nextIndexEntries = [];
      for (const entry of discovered) {
        processedDirs += 1;
        if (processedDirs % 8 === 0) {
          await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
        }
        const metaPath = String(entry?.metaPath || "").trim();
        const assetDir = String(entry?.assetDir || "").trim();
        if (!metaPath || !assetDir) {
          continue;
        }
        if (isInUAssetsPath(metaPath)) {
          continue;
        }
        const metaStats = await fs.stat(metaPath).catch(() => null);
        if (!metaStats?.isFile()) {
          continue;
        }
        const cached = cachedByMetaPath.get(normalizeComparePath(metaPath));
        const cachedRecord = cached?.record;
        const cachedMetaMtimeMs = Number(cached?.metaMtimeMs) || 0;
        
        // Disable timeout warning spam in development
        const isDev = !app?.isPackaged && typeof process !== 'undefined' && process.env.NODE_ENV !== 'production';
        const timeoutScale = isDev ? 5 : 1; // Give it 5x more time in dev before logging
        
        if (cachedRecord && cachedMetaMtimeMs >= Number(metaStats.mtimeMs)) {
          index.push(cachedRecord);
          nextIndexEntries.push({ metaPath, metaMtimeMs: cachedMetaMtimeMs, record: cachedRecord });
          if (onRecord) {
            onRecord(cachedRecord);
          }
          if (onProgress && (processedDirs % 8 === 0 || processedDirs === totalDirs)) {
            const progress = totalDirs > 0 ? 5 + (processedDirs / totalDirs) * 95 : 100;
            onProgress({ source, phase: "scan", processed: processedDirs, total: totalDirs, progress });
          }
          continue;
        }
        const progress = totalDirs > 0 ? 5 + (processedDirs / totalDirs) * 95 : 100;
        if (onProgress && (processedDirs <= 3 || processedDirs % 80 === 0)) {
          onProgress({ source, phase: "scan", processed: processedDirs, total: totalDirs, progress, message: assetDir });
        }
        const startedAt = Date.now();
        const meta = await withTimeout(readJsonSafe(metaPath, { maxBytes: maxMetaBytes }), 8000 * timeoutScale);
        if (!meta) {
          if (onProgress && Date.now() - startedAt >= 8000 * timeoutScale) {
            onProgress({ source, phase: "scan", processed: processedDirs, total: totalDirs, progress, message: `timeout meta ${metaPath}` });
          }
          continue;
        }
        const dirFiles = await withTimeout(collectCustomAssetFiles(assetDir, meta), 12000 * timeoutScale);
        if (!dirFiles) {
          if (onProgress && Date.now() - startedAt >= 12000 * timeoutScale) {
            onProgress({ source, phase: "scan", processed: processedDirs, total: totalDirs, progress, message: `timeout files ${assetDir}` });
          }
          continue;
        }
        const record = createAssetRecord(assetDir, metaPath, meta, dirFiles, source);
        if (record) {
          if (record.shouldBackfillDimensions && record?.meta?.scanInformation?.dimensions) {
            const written = await withTimeout(backfillDimensionsMeta(metaPath, meta, record.meta.scanInformation.dimensions), 8000 * timeoutScale);
            if (written === null && onProgress) {
              onProgress({ source, phase: "scan", processed: processedDirs, total: totalDirs, progress, message: `timeout write ${metaPath}` });
            }
          }
          delete record.shouldBackfillDimensions;
          index.push(record);
          nextIndexEntries.push({ metaPath, metaMtimeMs: Number(metaStats.mtimeMs) || 0, record });
          if (onRecord) {
            onRecord(record);
          }
        }
        const elapsedMs = Date.now() - startedAt;
        if (onProgress && elapsedMs >= 2500 * timeoutScale) {
          onProgress({ source, phase: "scan", processed: processedDirs, total: totalDirs, progress, message: `slow ${elapsedMs}ms ${assetDir}` });
        }
        if (onProgress && (processedDirs % 8 === 0 || processedDirs === totalDirs)) {
          onProgress({ source, phase: "scan", processed: processedDirs, total: totalDirs, progress });
        }
      }
      if (customIndexPath) {
        await writeJsonAtomic(customIndexPath, {
          version: 1,
          generatedAt: new Date().toISOString(),
          root: customRoot,
          assets: nextIndexEntries
        });
      }
      return index;
    }
  }

  if (onProgress) {
    onProgress({ source, phase: "collect", processed: 0, total: 0, progress: 0 });
  }
  const collected = await collectFiles(rootPath, { onProgress, source });
  const { metaFiles, filesByDirectory, nestedFilesByDirectory } = collected;
  const totalMeta = metaFiles.length;
  let colorBackfilledCount = 0;
  if (onProgress) {
    onProgress({ source, phase: "scan", processed: 0, total: totalMeta, progress: totalMeta > 0 ? 5 : 100 });
  }
  let processedMeta = 0;
  for (const metaPath of metaFiles) {
    processedMeta += 1;
    if (processedMeta % 8 === 0) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    }
    if (isInUAssetsPath(metaPath)) {
      if (onProgress && (processedMeta % 16 === 0 || processedMeta === totalMeta)) {
        const progress = totalMeta > 0 ? 5 + (processedMeta / totalMeta) * 95 : 100;
        onProgress({ source, phase: "scan", processed: processedMeta, total: totalMeta, progress });
      }
      continue;
    }
    const meta = await readJsonSafe(metaPath, { maxBytes: maxMetaBytes });
    if (!meta) {
      continue;
    }
    const assetDir = path.dirname(metaPath);
    const directFiles = filesByDirectory.get(assetDir) || [];
    const nestedFiles = nestedFilesByDirectory.get(assetDir) || [];
    const dirFiles = [...new Set([...directFiles, ...nestedFiles])];
    if (source === "custom") {
      const existingColorTags = collectColorTagsFromMeta(meta);
      if (existingColorTags.length === 0 && colorBackfilledCount < COLOR_BACKFILL_MAX_ASSETS_PER_SCAN) {
        // Skip slow image processing in dev environment to speed up scanning
        const isDev = !app?.isPackaged && typeof process !== 'undefined' && process.env.NODE_ENV !== 'production';
        if (!isDev) {
          const textureFiles = dirFiles
            .filter((filePath) => TEXTURE_EXTENSIONS.has(path.extname(String(filePath || "")).toLowerCase()))
            .map(normalizePath);
          const inferredColorTags = await inferColorTagsWithTimeout(textureFiles, {
            minColorTags: 1,
            maxColorTags: 4,
            maxCandidateImages: 2,
            timeoutMs: COLOR_BACKFILL_TIMEOUT_MS
          });
          if (inferredColorTags.length > 0) {
            await backfillColorTagsMeta(metaPath, meta, inferredColorTags).catch(() => {});
            colorBackfilledCount += 1;
          }
        }
      }
    }
    const record = createAssetRecord(assetDir, metaPath, meta, dirFiles, source);
    if (record) {
      if (record.shouldBackfillDimensions && record?.meta?.scanInformation?.dimensions) {
        await backfillDimensionsMeta(metaPath, meta, record.meta.scanInformation.dimensions).catch(() => {});
      }
      delete record.shouldBackfillDimensions;
      index.push(record);
      if (onRecord) {
        onRecord(record);
      }
    }
    if (onProgress && (processedMeta % 4 === 0 || processedMeta === totalMeta)) {
      const progress = totalMeta > 0 ? 5 + (processedMeta / totalMeta) * 95 : 100;
      onProgress({ source, phase: "scan", processed: processedMeta, total: totalMeta, progress });
    }
  }
  return index;
}

const { Worker } = require("node:worker_threads");

async function scanLibraryInWorker(megascanPath, customPath, options = {}) {
  return new Promise((resolve, reject) => {
    const onProgress = typeof options?.onProgress === "function" ? options.onProgress : null;
    const onRecord = typeof options?.onRecord === "function" ? options.onRecord : null;
    
    const worker = new Worker(path.join(__dirname, "scanWorker.js"), {
      workerData: { megascanPath, customPath, options: { ...options, onProgress: null, onRecord: null } }
    });

    worker.on("message", (message) => {
      if (message.type === "progress" && onProgress) {
        onProgress(message.payload);
      } else if (message.type === "record" && onRecord) {
        onRecord(message.payload);
      } else if (message.type === "done") {
        resolve(message.payload);
      } else if (message.type === "error") {
        reject(new Error(message.payload));
      }
    });

    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Worker stopped with exit code ${code}`));
      }
    });
  });
}

async function scanLibrary(megascanPath, customPath, options = {}) {
  const forceFullScan = Boolean(options?.forceFullScan);
  const cacheOnly = Boolean(options?.cacheOnly);
  const onProgress = typeof options?.onProgress === "function" ? options.onProgress : null;
  const onRecord = typeof options?.onRecord === "function" ? options.onRecord : null;
  
  if (cacheOnly && !forceFullScan) {
    return [];
  }
  
  if (onProgress) {
    onProgress({ phase: "start", source: "all", progress: 0, message: "准备扫描..." });
  }

  // 1. 预估阶段：快速统计资产数量，用于计算平滑进度
  if (onProgress) {
    onProgress({ phase: "collect", source: "all", progress: 0, message: "正在收集文件信息..." });
  }

  const scannedMegascan = megascanPath
    ? await scanPath(megascanPath, "quixel", {
        onProgress: (payload) => {
          if (!onProgress) return;
          // 动态进度：Megascan 占据前 45%
          const stageProgress = Math.max(0, Math.min(100, Number(payload?.progress) || 0));
          onProgress({ ...payload, progress: stageProgress * 0.45, message: `扫描 Megascan: ${payload.processed || 0}` });
        },
        onRecord
      })
    : [];

  const scannedCustom = customPath
    ? await scanPath(customPath, "custom", {
        onProgress: (payload) => {
          if (!onProgress) return;
          // 动态进度：Custom 占据 45% - 90%
          const stageProgress = Math.max(0, Math.min(100, Number(payload?.progress) || 0));
          onProgress({ ...payload, progress: 45 + stageProgress * 0.45, message: `扫描自定义库: ${payload.processed || 0}` });
        },
        onRecord
      })
    : [];

  if (onProgress) {
    onProgress({ phase: "dedup", source: "all", progress: 95, message: "正在合并资产列表..." });
  }

  const combined = [...scannedMegascan, ...scannedCustom];
  const dedup = new Map();
  for (const asset of combined) {
    if (!dedup.has(asset.id)) {
      dedup.set(asset.id, asset);
    }
  }
  const result = [...dedup.values()];
  
  if (onProgress) {
    onProgress({ phase: "done", source: "all", progress: 100, processed: result.length, total: result.length, message: "扫描完成" });
  }
  return result;
}

async function updateAssetFavorite(assetId, isFavorite, currentIndex) {
  const normalizedId = String(assetId || "").trim();
  if (!normalizedId || !Array.isArray(currentIndex)) {
    return false;
  }
  const target = currentIndex.find((asset) => String(asset?.id || "").trim() === normalizedId);
  if (!target) {
    return false;
  }
  target.favorite = Boolean(isFavorite);
  return true;
}

function searchAssets(index, query) {
  const text = query?.text || "";
  const requiredTags = (query?.tags || []).map((tag) => tag.toLowerCase());
  const requiredAssetTypes = (query?.assetTypes || []).map((assetType) => normalizeAssetType(assetType)).filter(Boolean);
  const requiredThemes = (query?.themes || []).map((theme) => normalizeTheme(theme)).filter(Boolean);
  const sourceFilter = query?.source || "all";

  searchIndex.ensureBaseline(index);
  const cacheKey = searchIndex.buildCacheKey(Array.isArray(index) ? index.length : 0, {
    text,
    requiredTags,
    requiredAssetTypes,
    requiredThemes,
    sourceFilter
  });
  const cached = searchIndex.lruGet(cacheKey);
  if (cached) {
    return cached;
  }

  const hasTagFilter = requiredTags.length > 0;
  const hasTypeFilter = requiredAssetTypes.length > 0;
  const hasThemeFilter = requiredThemes.length > 0;
  const themeFilterSet = hasThemeFilter ? new Set(requiredThemes) : null;
  const sourceFiltered = sourceFilter !== "all";

  let candidate;
  if (!sourceFiltered && !hasTagFilter && !hasTypeFilter && !hasThemeFilter) {
    candidate = index;
  } else {
    candidate = [];
    for (const asset of index) {
      if (sourceFiltered && asset.source !== sourceFilter) continue;
      if (hasTagFilter) {
        let ok = true;
        for (const tag of requiredTags) {
          if (!asset.tags || !asset.tags.includes(tag)) { ok = false; break; }
        }
        if (!ok) continue;
      }
      if (hasTypeFilter && !requiredAssetTypes.includes(asset.assetType)) continue;
      if (hasThemeFilter) {
        const assetThemes = asset.themes;
        const assetTags = asset.tags;
        let matched = 0;
        const seen = new Set();
        if (Array.isArray(assetThemes)) {
          for (const t of assetThemes) {
            if (themeFilterSet.has(t) && !seen.has(t)) {
              seen.add(t);
              matched++;
            }
          }
        }
        if (matched < requiredThemes.length && Array.isArray(assetTags)) {
          for (const t of assetTags) {
            const norm = normalizeTheme(t);
            if (themeFilterSet.has(norm) && !seen.has(norm)) {
              seen.add(norm);
              matched++;
              if (matched >= requiredThemes.length) break;
            }
          }
        }
        if (matched < requiredThemes.length) continue;
      }
      candidate.push(asset);
    }
  }

  let result;
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    result = candidate;
  } else {
    const normalizedText = trimmed.toLowerCase();
    const idMatched = candidate.filter((asset) => {
      const assetId = String(asset?.id || "").trim().toLowerCase();
      const metaId = String(asset?.meta?.id || "").trim().toLowerCase();
      const metaAssetId = String(asset?.meta?.assetID || "").trim().toLowerCase();
      const slug = String(asset?.slug || "").trim().toLowerCase();
      return assetId === normalizedText
        || metaId === normalizedText
        || metaAssetId === normalizedText
        || slug === normalizedText
        || assetId.includes(normalizedText)
        || metaId.includes(normalizedText)
        || metaAssetId.includes(normalizedText)
        || slug.includes(normalizedText);
    });
    if (idMatched.length > 0) {
      result = idMatched;
    } else {
      result = searchIndex.fuseSearch(trimmed, candidate, index);
    }
  }

  searchIndex.lruSet(cacheKey, result);
  return result;
}

let watcher = null;
let debounceTimer = null;

function watchLibrary(libraryPaths, onKeyChange, options = {}) {
  if (watcher) {
    watcher.close();
  }
  const WATCHABLE_EXTENSIONS = new Set([".json", ".jason"]);
  const WATCHABLE_PREVIEW_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp"]);
  const megascanRoot = String(options?.megascanRoot || "").trim();
  const normalizedMegascanRoot = megascanRoot ? path.resolve(megascanRoot).toLowerCase() : "";
  const normalizedMegascanRootWithSep = normalizedMegascanRoot ? `${normalizedMegascanRoot}${path.sep.toLowerCase()}` : "";
  const explicitWatchSet = new Set(
    (Array.isArray(options?.explicitWatchFiles) ? options.explicitWatchFiles : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .map((value) => path.resolve(value).toLowerCase())
  );
  const normalizedRoots = new Set(
    (Array.isArray(libraryPaths) ? libraryPaths : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .map((value) => path.resolve(value).toLowerCase())
  );
  const shouldIgnoreWatchEventPath = (entryPath) => {
    const raw = String(entryPath || "").trim();
    if (!raw) {
      return true;
    }
    const resolvedLower = path.resolve(raw).toLowerCase();
    const isUnderMegascan = normalizedMegascanRoot
      ? (resolvedLower === normalizedMegascanRoot || resolvedLower.startsWith(normalizedMegascanRootWithSep))
      : false;
    if (explicitWatchSet.has(resolvedLower)) {
      return false;
    }
    const baseName = path.basename(raw).toLowerCase();
    if (SKIP_FILE_NAMES.has(baseName)) {
      return true;
    }
    const ext = path.extname(raw).toLowerCase();
    if (!WATCHABLE_EXTENSIONS.has(ext)) {
      if (!WATCHABLE_PREVIEW_IMAGE_EXTENSIONS.has(ext)) {
        return true;
      }
      const token = normalizePath(raw).toLowerCase();
      if (token.includes("/preview/") || token.includes("/previews/")) {
        return false;
      }
      if (isUnderMegascan) {
        const name = path.basename(raw).toLowerCase();
        if (!name.includes("preview")) {
          return true;
        }
        return false;
      }
      return true;
    }
    if (normalizedRoots.has(resolvedLower)) {
      return true;
    }
    return false;
  };

  watcher = chokidar.watch(libraryPaths, {
    ignored: (entryPath, stats) => {
      const resolvedLower = path.resolve(String(entryPath || "")).toLowerCase();
      if (explicitWatchSet.has(resolvedLower)) {
        return false;
      }
      const baseName = String(entryPath || "").split(/[\\/]/).pop().toLowerCase();
      if (stats?.isDirectory() && SKIP_DIRECTORY_NAMES.has(baseName)) {
        return true;
      }
      if (!stats?.isDirectory() && SKIP_FILE_NAMES.has(baseName)) {
        return true;
      }
      return false;
    },
    persistent: true,
    ignoreInitial: true,
    depth: Math.max(1, Number(options?.depth) || 4),
    useFsEvents: false, // Prevents excessive native bridge overhead in some dev environments
    disableGlobbing: true // We only pass raw paths
  });

  const debounceMs = Math.max(200, Number(options?.debounceMs) || 1200);
  const pending = new Map();
  const debouncedScan = () => {
    if (debounceTimer) globalThis.clearTimeout(debounceTimer);
    debounceTimer = globalThis.setTimeout(() => {
      const changes = [...pending.values()];
      pending.clear();
      onKeyChange({ changes });
    }, debounceMs);
  };

  const onWatchEvent = (eventType, entryPath) => {
    if (shouldIgnoreWatchEventPath(entryPath)) {
      return;
    }
    const resolved = path.resolve(String(entryPath || "")).toLowerCase();
    pending.set(resolved, { event: String(eventType || ""), path: String(entryPath || "") });
    debouncedScan();
  };
  watcher.on("add", (entryPath) => onWatchEvent("add", entryPath));
  watcher.on("unlink", (entryPath) => onWatchEvent("unlink", entryPath));
  watcher.on("change", (entryPath) => onWatchEvent("change", entryPath));
  watcher.on("unlinkDir", (entryPath) => {
    const baseName = String(entryPath || "").split(/[\\/]/).pop().toLowerCase();
    if (SKIP_DIRECTORY_NAMES.has(baseName)) {
      return;
    }
    const resolved = path.resolve(String(entryPath || "")).toLowerCase();
    pending.set(resolved, { event: "unlinkDir", path: String(entryPath || "") });
    debouncedScan();
  });
}

async function updateAssetMetadata(assetPath, newMetadata) {
  try {
    const jsonPath = path.join(assetPath, "asset_info.json");
    // Check if exists
    try {
      await fs.access(jsonPath);
    } catch {
      // If not exists, maybe it's a different file name?
      // For custom assets we standardized on asset_info.json
      return false;
    }

    const content = await fs.readFile(jsonPath, "utf-8");
    const json = JSON.parse(content);
    
    // Merge updates
    const updated = { ...json, ...newMetadata };
    
    await fs.writeFile(jsonPath, JSON.stringify(updated, null, 2));
    return true;
  } catch (e) {
    console.error("Failed to update asset metadata:", e);
    return false;
  }
}

async function getAssetDetails(assetDir, source = "custom") {
  try {
    const stat = await fs.stat(assetDir);
    if (!stat.isDirectory()) return null;

    if (String(source || "").trim().toLowerCase() === "quixel") {
      const entries = await fs.readdir(assetDir, { withFileTypes: true });
      const fileNames = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
      const metaFiles = fileNames.filter((f) => path.extname(f).toLowerCase() === ".json" && !f.toLowerCase().includes("index.json") && !f.toLowerCase().includes("hivedata.json") && !f.toLowerCase().includes("hivecache.json"));
      if (metaFiles.length === 0) return null;
      const metaPath = path.join(assetDir, metaFiles[0]);
      const maxMetaBytes = QUIXEL_META_JSON_MAX_BYTES;
      const meta = await readJsonSafe(metaPath, { maxBytes: maxMetaBytes });
      if (!meta) return null;
      const dirFiles = await collectMegascanAssetFiles(assetDir);
      return createAssetRecord(assetDir, metaPath, meta, dirFiles, source);
    }

    const entries = await fs.readdir(assetDir, { withFileTypes: true });
    const fileNames = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    const directoryNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    const metaFiles = fileNames.filter((f) => path.extname(f).toLowerCase() === ".json" && !f.toLowerCase().includes("index.json") && !f.toLowerCase().includes("hivedata.json") && !f.toLowerCase().includes("hivecache.json"));
    if (metaFiles.length === 0) return null;

    // Use the first JSON file as meta (most likely the correct one)
    const metaPath = path.join(assetDir, metaFiles[0]);
    const maxMetaBytes = source === "custom" ? CUSTOM_META_JSON_MAX_BYTES : QUIXEL_META_JSON_MAX_BYTES;
    const meta = await readJsonSafe(metaPath, { maxBytes: maxMetaBytes });
    if (!meta) return null;

    const dirFiles = fileNames.map((f) => path.join(assetDir, f));
    const previewDirCandidates = directoryNames.filter((name) => {
      const lower = String(name || "").trim().toLowerCase();
      return lower === "preview" || lower === "previews";
    });
    for (const folderName of previewDirCandidates) {
      const folderPath = path.join(assetDir, folderName);
      const previewEntries = await fs.readdir(folderPath, { withFileTypes: true }).catch(() => []);
      for (const entry of previewEntries) {
        if (!entry.isFile()) continue;
        dirFiles.push(path.join(folderPath, entry.name));
      }
    }
    return createAssetRecord(assetDir, metaPath, meta, dirFiles, source);
  } catch (e) {
    console.error("Failed to get asset details:", e);
    return null;
  }
}

async function getAssetDetailsByMetaPath(metaPath, source = "custom") {
  try {
    const resolvedMetaPath = String(metaPath || "").trim();
    if (!resolvedMetaPath) {
      return null;
    }
    const metaStats = await fs.stat(resolvedMetaPath).catch(() => null);
    if (!metaStats?.isFile()) {
      return null;
    }
    const assetDir = path.dirname(resolvedMetaPath);
    const maxMetaBytes = source === "custom" ? CUSTOM_META_JSON_MAX_BYTES : QUIXEL_META_JSON_MAX_BYTES;
    const meta = await readJsonSafe(resolvedMetaPath, { maxBytes: maxMetaBytes });
    if (!meta) {
      return null;
    }
    if (String(source || "").trim().toLowerCase() === "quixel") {
      const dirFiles = await collectMegascanAssetFiles(assetDir);
      return createAssetRecord(assetDir, resolvedMetaPath, meta, dirFiles, source);
    }
    const collected = await collectFiles(assetDir);
    const { filesByDirectory, nestedFilesByDirectory } = collected;
    const directFiles = filesByDirectory.get(assetDir) || [];
    const nestedFiles = nestedFilesByDirectory.get(assetDir) || [];
    const dirFiles = [...new Set([...directFiles, ...nestedFiles])];
    return createAssetRecord(assetDir, resolvedMetaPath, meta, dirFiles, source);
  } catch {
    return null;
  }
}

module.exports = {
  scanLibrary,
  scanLibraryInWorker,
  searchAssets,
  getAssetDetails,
  getAssetDetailsByMetaPath,
  watchLibrary,
  updateAssetFavorite,
  updateAssetMetadata,
  inferColorTagsFromTextureFiles,
  collectColorTagsFromMeta,
  rebuildSearchIndex: searchIndex.setIndex,
  invalidateSearchIndex: searchIndex.invalidate,
  notifySearchIndexMutation: searchIndex.notifyMutation
};
