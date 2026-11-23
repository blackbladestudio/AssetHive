const { removeAssetNameTags } = require("../../shared/assetNameTags.mjs");
const { isDisplacementMetadata } = require("./displacementClassification");
const { populatePreviewSize } = require("./previewSize");
const path = require("node:path");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const { readGzipJsonArray, gzipJsonArray } = require("./jsonArrayStream");
const { createScanSeeds } = require("./scanRecordReuse");
const { PROJECTION, getResidentMemoPath, compactScanRecord, compactScanMemoEntry, sameSourceStamp } = require("./residentScanMemo");
const Fuse = require("fuse.js");
const searchIndex = require("./searchIndex");
const { listRecycledAssets } = require("./libraryRecycle");
const { listPermanentlyDeletedAssets } = require("./characterDeletion");
const { watchLibrary } = require("./libraryWatchService");
const { changedDirectories } = require("./libraryChanges");
const { ASSET_METADATA_FILE_NAME, isFolderAssetMetaFileName, isSidecarAssetMetaFileName, getSidecarStemFromMetaFileName, writeAssetMetadata, updateAssetMetadataFile } = require("./assetMetadata");
const { animationIdentityDiffersFromRecord, applyAnimationIdentityMetadata, readAnimationIdentitySidecar } = require("./animationIdentity");
const { resolveAssetModelPath, normalizeAssetModelPaths } = require("./assetModelPaths");
const { activeCharacterFiles } = require("../../shared/characterComponents.mjs");
const { isAllowedCharacterTextureFile } = require("../../shared/characterFilePolicy.mjs");
const {
  applyPreservedAnimationPreview,
  buildAnimationMetaFromModel,
  isAnimationLibraryPath,
  isAnimationModelMetaPath,
  pickPreservedAnimationPreview
} = require("./customAssetLayout");
const {
  FOUR_K_THRESHOLD_PIXELS,
  LARGE_OBJECT_LIMIT_METERS,
  MAX_REPORTED_TEXTURES,
  TEXTURE_ANALYSIS_VERSION,
  analyzeAssetTextureUsage,
  getReliableDimensions,
  isModelAssetType,
  isTextureAnalysisCurrent,
  normalizeTextureAnalysis,
  normalizeTextureFiles
} = require("./textureAnalysis");

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
const MODEL_EXTENSIONS = new Set([".fbx", ".st9", ".obj", ".abc", ".gltf", ".glb"]);
const TEXTURE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".tif", ".tiff", ".exr", ".hdr", ".tga", ".webp", ".bmp"]);
const PREVIEW_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".tif", ".tiff", ".tga", ".webp", ".bmp", ".webm", ".mp4", ".gif"]);
const NESTED_FILE_PROPAGATION_MAX_DEPTH = 3;
const CUSTOM_META_JSON_MAX_BYTES = 64 * 1024 * 1024;
const CUSTOM_LIBRARY_INDEX_DIR = ".assethive";
// 扫描备忘（每资产元数据 mtime + 目录指纹 + 卡片记录）以前是一个未压缩的
// custom-index.json：2 万资产的库会写出一百多 MB，每 5 分钟周期扫描都要在共享盘上
// 整读整写一遍；文件一旦超过 128MB 读取上限就直接作废，于是每轮都退化成全量冷扫。
// 现在改为 gzip 存放（约 1/10 体积），旧的 .json 仍只读兼容一次并迁移。
const CUSTOM_LIBRARY_INDEX_FILE = "custom-index.json";
const CUSTOM_LIBRARY_INDEX_FILE_GZ = "custom-index.json.gz";
const CUSTOM_LIBRARY_INDEX_LEGACY_MAX_BYTES = 512 * 1024 * 1024;
const CUSTOM_LIBRARY_INDEX_GZ_MAX_BYTES = 128 * 1024 * 1024;
const SCAN_MEMO_VERSION = 2;
const { SKIP_DIRECTORY_NAMES, SKIP_FILE_NAMES } = require("./libraryIgnore");
const COLOR_BACKFILL_MAX_ASSETS_PER_SCAN = 24;
const COLOR_BACKFILL_TIMEOUT_MS = 280;
const TEXTURE_RESOLUTION_BACKFILL_MAX_ASSETS_PER_SCAN = 400;
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
// 共享盘上一次 stat 往往就要几毫秒；逐资产两三个串行往返会把 2 万资产的扫描拖到
// 几分钟。多客户端共享库中默认每阶段 4 路，前台最多 8 路；环境变量只能进一步限流。
const configuredScanConcurrency = Number(process.env.ASSETHIVE_SCAN_CONCURRENCY);
const MAX_SCAN_CONCURRENCY = Math.max(1, Math.min(8,
  Number.isFinite(configuredScanConcurrency) && configuredScanConcurrency > 0 ? Math.floor(configuredScanConcurrency) : 8));
function resolveScanConcurrency(options) {
  const requested = Number(options?.concurrency);
  return Math.max(1, Math.min(MAX_SCAN_CONCURRENCY, Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 4));
}
// 自定义库按批扫描并流式上报：批次越小首屏卡片出现越早，批次切换会损失一点
// 并发吞吐，64 是兼顾首屏与吞吐的折中值。可用 ASSETHIVE_SCAN_CHUNK_SIZE 覆盖。
const CUSTOM_SCAN_CHUNK_SIZE = Math.max(MAX_SCAN_CONCURRENCY, Math.min(512, Number(process.env.ASSETHIVE_SCAN_CHUNK_SIZE) || 64));
const POLL_SHARD_COUNT = 6;

function getPollShard(value) {
  let hash = 0;
  for (const char of normalizeComparePath(value)) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return hash % POLL_SHARD_COUNT;
}

function normalizePath(filePath) {
  return filePath.replaceAll("\\", "/");
}

function normalizeComparePath(filePath) {
  return normalizePath(path.resolve(String(filePath || ""))).toLowerCase();
}

function isQuixelLikeMeta(meta) {
  if (!meta || typeof meta !== "object") {
    return false;
  }
  const joined = JSON.stringify(meta).toLowerCase();
  return joined.includes("megascans") || joined.includes("quixel") || joined.includes("bridge");
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

async function runWithConcurrency(items, limit, worker) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }
  const results = new Array(items.length);
  let nextIndex = 0;
  let completed = 0;
  let resolveAll = null;
  const done = new Promise((resolve) => {
    resolveAll = resolve;
  });
  const runNext = async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      try {
        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      } catch (error) {
        results[currentIndex] = { __scanError: error };
      }
      completed += 1;
      if (completed >= items.length && resolveAll) {
        resolveAll();
      }
    }
  };
  const workerCount = Math.max(1, Math.min(Number(limit) || 1, items.length));
  for (let i = 0; i < workerCount; i += 1) {
    runNext();
  }
  await done;
  return results;
}

// Retry transient SMB errors, but never turn a failed listing into an empty folder.
async function scanRead(operation) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= 2 || !["EIO", "EBUSY", "EMFILE", "ENFILE", "ETIMEDOUT", "ECONNRESET", "UNKNOWN"].includes(error?.code)) throw error;
      await new Promise((resolve) => globalThis.setTimeout(resolve, 40 * (attempt + 1)));
    }
  }
}

async function* prefetchScanBatches(iterator) {
  let pending = iterator.next();
  try {
    while (true) {
      const batch = await pending;
      if (batch.done) return;
      // Keep at most one listing batch ahead; overlap directory discovery with
      // metadata reads without collecting the whole library into memory.
      pending = iterator.next();
      pending.catch(() => {});
      yield batch.value;
    }
  } finally {
    await pending.catch(() => {});
    await iterator.return();
  }
}

async function* collectCustomAssetEntriesFromFolderListing(customRoot, options = {}) {
  const root = String(customRoot || "").trim();
  if (!root) {
    return [];
  }
  const onProgress = typeof options?.onProgress === "function" ? options.onProgress : null;
  const resolvedRoot = path.resolve(root);
  const rootStats = await scanRead(() => fs.stat(resolvedRoot));
  if (!rootStats?.isDirectory()) {
    throw new Error(`资产库目录不可用: ${resolvedRoot}`);
  }
  let discoveredCount = 0;
  const cachedFolders = new Map();
  if (options.incrementalScan) {
    for (const cached of options.cachedEntries || []) {
      if (!cached?.record || !Number.isFinite(cached.metaSize)) continue;
      const key = normalizeComparePath(path.dirname(cached.metaPath));
      const folder = cachedFolders.get(key) || { entries: [], leaf: false };
      folder.entries.push(cached);
      folder.leaf ||= isFolderAssetMetaFileName(path.basename(cached.metaPath));
      cachedFolders.set(key, folder);
    }
  }
  let visitedDirs = 0;
  const cachedDirectories = new Set((options.cachedEntries || []).map(entry => normalizeComparePath(path.dirname(entry.metaPath))));
  const targets = Array.isArray(options.changedDirectories) ? changedDirectories(resolvedRoot, options.changedDirectories.map(target => {
    let directory = path.resolve(resolvedRoot, target);
    while (directory !== resolvedRoot) {
      if (cachedDirectories.has(normalizeComparePath(directory))) return directory;
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    return target;
  })) : null;
  let frontier = targets || [resolvedRoot];
  if (targets) {
    const targetSet = new Set(targets.map(normalizeComparePath));
    const rootLength = normalizeComparePath(resolvedRoot).length;
    const untouched = (options.cachedEntries || []).filter(entry => {
      let directory = normalizeComparePath(path.dirname(entry.metaPath));
      while (directory.length >= rootLength) {
        if (targetSet.has(directory)) return false;
        const parent = directory.slice(0, directory.lastIndexOf("/"));
        if (parent === directory) break;
        directory = parent;
      }
      return true;
    });
    for (let i = 0; i < untouched.length; i += CUSTOM_SCAN_CHUNK_SIZE) {
      yield untouched.slice(i, i + CUSTOM_SCAN_CHUNK_SIZE).map(cached => ({ metaPath: cached.metaPath, assetDir: path.dirname(cached.metaPath), cachedOnly: cached }));
    }
  }
  while (frontier.length > 0) {
    const batch = frontier.splice(0, CUSTOM_SCAN_CHUNK_SIZE);
    visitedDirs += batch.length;
    // A cold scan of a large library on a network share can spend minutes in
    // this walk. Report it so the UI never looks idle before the first record.
    if (onProgress && (visitedDirs === 128 || visitedDirs % 1024 === 0)) {
      onProgress({
        phase: "collect",
        processed: visitedDirs,
        total: 0,
        progress: Math.min(4, 1 + visitedDirs / 2048),
        message: `遍历库目录 · 已发现 ${discoveredCount} 个资产`
      });
    }
    const scanned = await runWithConcurrency(batch, resolveScanConcurrency(options), async (current) => {
      const cachedFolder = cachedFolders.get(normalizeComparePath(current));
      if (!targets && cachedFolder?.leaf && getPollShard(current) !== options.pollShard) {
        // The parent listing confirms this folder still exists. Revisit only
        // one shard of known assets per poll; new folders are always inspected.
        return { cachedEntries: cachedFolder.entries, subDirs: [] };
      }
      const entries = await scanRead(() => fs.readdir(current, { withFileTypes: true })).catch(async error => {
        if (targets && error.code === "ENOENT") {
          // A disappearing SMB connection must not look like an asset deletion.
          const availableRoot = await scanRead(() => fs.stat(resolvedRoot));
          if (availableRoot.isDirectory()) return [];
        }
        throw error;
      });
      let folderMetaPath = "";
      const sidecarMetaPaths = [];
      const legacyMetaPaths = [];
      const animationModelPaths = [];
      const subDirs = [];
      // 目录内容指纹：列出直接子项的名字即可判断“有没有增删改名”，
      // 效果和再 stat 一次目录 mtime 相同，但省掉每资产一个共享盘往返。
      const signatureParts = [];
      for (const entry of entries) {
        if (entry.isDirectory()) {
          signatureParts.push(`d:${entry.name.toLowerCase()}`);
        } else if (entry.isFile()) {
          signatureParts.push(`f:${entry.name.toLowerCase()}`);
        }
      }
      const dirSignature = signatureParts.sort().join("\n");
      for (const entry of entries) {
        if (entry.isFile()) {
          if (isFolderAssetMetaFileName(entry.name)) {
            folderMetaPath = path.join(current, entry.name);
          } else if (isSidecarAssetMetaFileName(entry.name)) {
            sidecarMetaPaths.push(path.join(current, entry.name));
          } else if (MODEL_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) && isAnimationLibraryPath(current)) {
            animationModelPaths.push(path.join(current, entry.name));
          } else if (JSON_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) && !SKIP_FILE_NAMES.has(entry.name.toLowerCase())) {
            legacyMetaPaths.push(path.join(current, entry.name));
          }
        } else if (entry.isDirectory()) {
          if (!shouldSkipDirectory(entry.name)) {
            subDirs.push(path.join(current, entry.name));
          }
        }
      }
      if (folderMetaPath) {
        return { metaPaths: [folderMetaPath, ...sidecarMetaPaths], subDirs: [], dirSignature, entries };
      }
      // Animation models are canonical; scanning must not delete old sidecars/previews.
      return { metaPaths: isAnimationLibraryPath(current) ? animationModelPaths : [...sidecarMetaPaths, ...legacyMetaPaths], subDirs, dirSignature, entries };
    });
    const results = [];
    for (const [itemIndex, item] of scanned.entries()) {
      if (item.__scanError) {
        options.onWarning?.({ path: batch[itemIndex], operation: "readdir", message: item.__scanError.message });
        continue;
      }
      for (const cached of item.cachedEntries || []) {
        results.push({ metaPath: cached.metaPath, assetDir: path.dirname(cached.metaPath), cachedOnly: cached });
      }
      for (const metaPath of item.metaPaths || []) {
        results.push({ assetDir: path.dirname(metaPath), metaPath, dirSignature: item.dirSignature, entries: item.entries });
      }
      frontier.push(...item.subDirs);
    }
    discoveredCount += results.length;
    if (results.length) yield results;
  }
}

async function collectCustomAssetFiles(assetDir, meta, metaPath = "", listedEntries = null) {
  const resolvedDir = path.resolve(assetDir);
  const dirFiles = [];
  const entries = listedEntries || await scanRead(() => fs.readdir(resolvedDir, { withFileTypes: true }));
  const directoryNames = [];
  // 目录列表已经告诉我们哪些文件存在，元数据里引用的贴图/模型无需再逐个
  // stat。共享盘上这是每资产近十个往返，2 万资产的冷扫能因此少掉十几万次请求。
  const directFileNames = new Set();
  for (const entry of entries) {
    if (entry.isDirectory()) {
      directoryNames.push(entry.name);
      continue;
    }
    if (!entry.isFile()) continue;
    const lowerName = entry.name.toLowerCase();
    directFileNames.add(lowerName);
    if (SKIP_FILE_NAMES.has(lowerName)) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!JSON_EXTENSIONS.has(ext) && !MODEL_EXTENSIONS.has(ext) && !TEXTURE_EXTENSIONS.has(ext)) {
      continue;
    }
    dirFiles.push(path.join(resolvedDir, entry.name));
  }

  const previewDirCandidates = directoryNames.filter((name) => {
    const lower = String(name || "").trim().toLowerCase();
    return lower === "preview" || lower === "previews";
  });
  const previewFileNames = new Set();
  for (const folderName of previewDirCandidates) {
    const folderPath = path.join(resolvedDir, folderName);
    const previewEntries = await scanRead(() => fs.readdir(folderPath, { withFileTypes: true }));
    const folderLower = folderName.toLowerCase();
    for (const entry of previewEntries) {
      if (!entry.isFile()) continue;
      previewFileNames.add(`${folderLower}/${entry.name.toLowerCase()}`);
      const ext = path.extname(entry.name).toLowerCase();
      if (!TEXTURE_EXTENSIONS.has(ext) && !PREVIEW_IMAGE_EXTENSIONS.has(ext)) continue;
      dirFiles.push(path.join(folderPath, entry.name));
    }
  }

  if (meta && typeof meta === "object") {
    const referenced = [...new Set([
      ...collectJsonFiles(meta, resolvedDir, "model"),
      ...collectJsonFiles(meta, resolvedDir, "texture")
    ])];
    const nestedListings = new Map();
    for (const filePath of referenced) {
      const resolved = path.resolve(String(filePath || ""));
      if (!resolved) continue;
      const relative = normalizePath(path.relative(resolvedDir, resolved)).toLowerCase();
      if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) {
        // 资产目录之外的文件仍按原逻辑 stat 确认存在。
        const stats = await scanRead(() => fs.stat(resolved)).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
        if (stats?.isFile()) dirFiles.push(resolved);
        continue;
      }
      if (directFileNames.has(relative)) {
        dirFiles.push(resolved);
        continue;
      }
      if (previewFileNames.has(relative)) {
        dirFiles.push(resolved);
        continue;
      }
      // Nested texture packs often reference dozens of files in one directory.
      // Enumerate that directory once, instead of serial SMB stat calls per map.
      if (!relative.includes("/")) continue;
      const parent = path.dirname(resolved);
      const key = normalizeComparePath(parent);
      if (!nestedListings.has(key)) {
        const listing = await scanRead(() => fs.readdir(parent, { withFileTypes: true }))
          .catch((error) => { if (error.code === "ENOENT") return []; throw error; });
        nestedListings.set(key, new Set(listing.filter((item) => item.isFile()).map((item) => item.name.toLowerCase())));
      }
      if (nestedListings.get(key).has(path.basename(resolved).toLowerCase())) dirFiles.push(resolved);
    }
  }

  // Legacy JSON packages also allowed media in unreferenced subdirectories.
  // Preserve their old three-level discovery depth when standard metadata is absent.
  const metaName = path.basename(String(metaPath || ""));
  if (metaName && !isFolderAssetMetaFileName(metaName) && !isSidecarAssetMetaFileName(metaName) && !isAnimationModelMetaPath(metaPath)) {
    let nestedDirs = directoryNames.filter((name) => !shouldSkipDirectory(name) && !/^previews?$/i.test(name))
      .map((name) => path.join(resolvedDir, name));
    for (let depth = 1; depth < NESTED_FILE_PROPAGATION_MAX_DEPTH && nestedDirs.length; depth += 1) {
      const nextDirs = [];
      for (const dir of nestedDirs) {
        const nestedEntries = await scanRead(() => fs.readdir(dir, { withFileTypes: true }));
        for (const entry of nestedEntries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory() && !shouldSkipDirectory(entry.name)) nextDirs.push(fullPath);
          else if (entry.isFile() && (MODEL_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) || TEXTURE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))) dirFiles.push(fullPath);
        }
      }
      nestedDirs = nextDirs;
    }
  }
  const uniqueFiles = [...new Set(dirFiles)];
  if (isAnimationModelMetaPath(metaPath)) {
    const resolvedMeta = path.resolve(String(metaPath || ""));
    return uniqueFiles.filter((filePath) => path.resolve(filePath).toLowerCase() === resolvedMeta.toLowerCase());
  }
  const sidecarStem = getSidecarStemFromMetaFileName(path.basename(String(metaPath || "")));
  if (!sidecarStem) {
    return uniqueFiles;
  }
  const allowed = new Set();
  const addAllowed = (filePath) => {
    const resolved = path.resolve(String(filePath || ""));
    if (resolved) allowed.add(normalizeComparePath(resolved));
  };
  if (metaPath) addAllowed(metaPath);
  if (meta && typeof meta === "object") {
    for (const filePath of [
      ...collectJsonFiles(meta, resolvedDir, "model"),
      ...collectJsonFiles(meta, resolvedDir, "texture")
    ]) {
      addAllowed(filePath);
    }
    const previewUris = [
      meta.previewImage,
      meta.detailImage,
      ...(Array.isArray(meta.previews?.images) ? meta.previews.images.map((item) => item?.uri) : [])
    ];
    for (const value of previewUris) {
      const previewUri = String(value || "").trim();
      if (previewUri) addAllowed(path.isAbsolute(previewUri) ? previewUri : path.join(resolvedDir, previewUri));
    }
  }
  const stemLower = sidecarStem.toLowerCase();
  return uniqueFiles.filter((filePath) => {
    if (allowed.has(normalizeComparePath(filePath))) return true;
    const baseName = path.basename(filePath);
    const stem = path.basename(filePath, path.extname(filePath)).toLowerCase();
    return stem === stemLower
      || stem.startsWith(`${stemLower}_preview`)
      || baseName.toLowerCase() === `${stemLower}.asset_info.json`;
  });
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
  if (lower === "3dasset" || lower === "3dassets" || lower === "asset3d") {
    return "3d";
  }
  if (lower === "3dplants" || lower === "plant3d" || lower === "foliage") {
    return "3dplant";
  }
  if (lower === "displacements") return "displacement";
  if (lower === "brush") {
    return "";
  }
  if (lower === "imperfections" || lower === "surfaceimperfection") {
    return "imperfection";
  }
  if (lower === "atlases") {
    return "atlas";
  }
  if (lower === "decals") {
    return "decal";
  }
  if (lower === "surfaces") {
    return "surface";
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
  if (folderType === "foliage") {
    return "3dplant";
  }
  return folderType;
}

function getTopCategoryForAssetType(assetType) {
  if (assetType === "animation") {
    return "animation";
  }
  if (["suit", "monster", "npc", "weapon", "item"].includes(assetType)) {
    return "character";
  }
  return ["3d", "3dplant", "surface", "decal", "atlas", "imperfection", "displacement", "hdri"].includes(assetType) ? "environment" : "";
}

function getSubTypeFromPath(assetDir) {
  const segments = normalizePath(assetDir).split("/").filter(Boolean);
  const lower = segments.map((segment) => normalizeAssetType(segment));
  const typeIndex = lower.findIndex((segment) => ["3d", "3dplant", "surface", "decal", "atlas", "imperfection", "displacement", "hdri"].includes(segment));
  if (typeIndex <= 0 || lower[typeIndex - 1] !== "environment" || typeIndex + 1 >= segments.length) {
    return "";
  }
  const candidate = String(segments[typeIndex + 1] || "").trim();
  return candidate && !candidate.includes(".") ? candidate : "";
}

function getAssetTypeFromPath(assetDir, source = "") {
  const segments = normalizePath(assetDir).toLowerCase().split("/").filter(Boolean);
  const known = new Set(["3d", "3dassets", "3dplant", "foliage", "surface", "surfaces", "decal", "decals", "atlas", "imperfection", "displacement", "hdri", "animation"]);
  const parentFolder = segments.length >= 2 ? normalizeAssetType(segments[segments.length - 2]) : "";
  if (source === "custom" && known.has(parentFolder)) {
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
  if (isDisplacementMetadata(meta, { legacy: true })) return "displacement";
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

function getStandardAssetTags(meta, assetDir, assetType) {
  const fromJson = Array.isArray(meta?.standardAssetTags)
    ? meta.standardAssetTags.map((tag) => String(tag || "").trim()).filter(Boolean)
    : [];
  if (fromJson.length > 0) {
    return fromJson;
  }
  const legacy = String(meta?.subType || "").trim();
  if (legacy) {
    return [legacy];
  }
  if (assetType === "3d" || assetType === "3dplant") {
    const fromPath = getSubTypeFromPath(assetDir);
    return fromPath ? [fromPath] : [];
  }
  return [];
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
  const knownBytes = Number(options?.knownBytes);
  try {
    if (maxBytes > 0) {
      // 调用方刚刚 stat 过这个文件时直接把大小传进来，省掉共享盘上重复的一次
      // stat（2 万资产的库每轮冷扫就是 2 万次往返）。
      const size = Number.isFinite(knownBytes) ? knownBytes : Number((await fs.stat(filePath).catch(() => null))?.size);
      if (Number.isFinite(size) && size > maxBytes) {
        return null;
      }
    }
    const raw = await scanRead(() => fs.readFile(filePath, "utf-8"));
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (error) {
    if (options.strict) throw error;
    return null;
  }
}

function getLibraryIndexFilePath(rootPath, fileName) {
  const root = String(rootPath || "").trim();
  if (!root) {
    return "";
  }
  return path.join(path.resolve(root), CUSTOM_LIBRARY_INDEX_DIR, fileName);
}

function getCustomLibraryIndexPath(customRoot) {
  return getLibraryIndexFilePath(customRoot, CUSTOM_LIBRARY_INDEX_FILE);
}

function getCustomLibraryIndexGzPath(customRoot) {
  return getLibraryIndexFilePath(customRoot, CUSTOM_LIBRARY_INDEX_FILE_GZ);
}

function getCustomLibraryIndexPaths(customRoot) {
  return [getCustomLibraryIndexPath(customRoot), getCustomLibraryIndexGzPath(customRoot)].filter(Boolean);
}

// 备忘的“内容指纹”：只有元数据 mtime、目录文件名集合或记录 ID 变化时才值得
// 重写。共享盘上少写一个一百多 MB 的文件，比任何微优化都更省时间。
function buildScanMemoSignature(entries) {
  const parts = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== "object") continue;
    const metaPath = String(entry.metaPath || "").trim();
    if (!metaPath) continue;
    parts.push([
      normalizeComparePath(metaPath),
      Number(entry.metaMtimeMs) || 0,
      Number(entry.metaSize) || 0,
      String(entry.dirSignature || ""),
      String(entry.record?.id || "")
    ].join("|"));
  }
  parts.sort();
  return crypto.createHash("sha1").update(parts.join("\n")).digest("hex");
}

async function readCustomScanMemo(customRoot, options = {}) {
  const localPath = String(options.scanMemoPath || "").trim();
  const resident = options.residentMemo === true;
  const sourceStats = resident && localPath ? await fs.stat(localPath).catch(() => null) : null;
  const sourceStamp = sourceStats?.isFile() ? { size: sourceStats.size, mtimeMs: sourceStats.mtimeMs } : null;
  const readOptions = { maxBytes: CUSTOM_LIBRARY_INDEX_LEGACY_MAX_BYTES,
    ...(resident ? { mapItem: compactScanMemoEntry } : {}) };
  if (localPath) {
    for (const candidate of resident ? [getResidentMemoPath(localPath), localPath] : [localPath]) {
      try {
        const stats = await fs.stat(candidate);
        if (stats.isFile() && stats.size > 0 && stats.size <= CUSTOM_LIBRARY_INDEX_GZ_MAX_BYTES) {
          const parsed = await readGzipJsonArray(candidate, readOptions);
          if (parsed.version === SCAN_MEMO_VERSION && normalizeComparePath(parsed.root) === normalizeComparePath(customRoot)
            && Array.isArray(parsed.assets)) {
            if (resident && candidate !== localPath
              && (parsed.projection !== PROJECTION || !sameSourceStamp(parsed.sourceStamp, sourceStamp))) continue;
            return { path: candidate, entries: parsed.assets, sourceStamp, version: parsed.version, legacy: false, signature: buildScanMemoSignature(parsed.assets) };
          }
        }
      } catch { /* Missing/corrupt local state may use a legacy read-only hint. */ }
    }
  }
  const gzPath = getCustomLibraryIndexGzPath(customRoot);
  const gzStats = gzPath ? await fs.stat(gzPath).catch(() => null) : null;
  if (gzPath && gzStats?.isFile() && gzStats.size > 0 && gzStats.size <= CUSTOM_LIBRARY_INDEX_GZ_MAX_BYTES) {
    try {
      const parsed = await readGzipJsonArray(gzPath, readOptions);
      const entries = Array.isArray(parsed?.assets) ? parsed.assets : [];
      return { path: gzPath, entries, sourceStamp, version: Number(parsed?.version) || 1, legacy: false, signature: buildScanMemoSignature(entries) };
    } catch {
      // 损坏的 gz 备忘按缺失处理，回退到旧 JSON 或全量扫描。
    }
  }
  const legacyPath = getCustomLibraryIndexPath(customRoot);
  const legacy = legacyPath
    ? await readJsonSafe(legacyPath, { maxBytes: CUSTOM_LIBRARY_INDEX_LEGACY_MAX_BYTES })
    : null;
  const entries = Array.isArray(legacy?.assets) ? (resident ? legacy.assets.map(compactScanMemoEntry) : legacy.assets) : [];
  return { path: legacyPath, entries, sourceStamp, version: Number(legacy?.version) || 1, legacy: true, signature: buildScanMemoSignature(entries) };
}

async function writeCustomScanMemo(customRoot, entries, options = {}) {
  const targets = new Set();
  if (options.scanMemoPath) targets.add(path.resolve(options.residentMemo ? getResidentMemoPath(options.scanMemoPath) : options.scanMemoPath));
  // Shared legacy memo publication is reserved for explicit maintenance.
  if (options.maintenance && options.writeSharedMemo) targets.add(getCustomLibraryIndexGzPath(customRoot));
  if (!targets.size) return false;
  const compressed = await gzipJsonArray({
    version: SCAN_MEMO_VERSION,
    generatedAt: new Date().toISOString(),
    root: path.resolve(customRoot),
    ...(options.residentMemo ? { projection: PROJECTION, sourceStamp: options.sourceStamp ?? null } : {})
  }, Array.isArray(entries) ? entries : []);
  let saved = false;
  for (const target of targets) saved = (await writeBufferAtomic(target, compressed)) || saved;
  return saved;
}

async function writeBufferAtomic(filePath, buffer) {
  const target = String(filePath || "").trim();
  if (!target) return false;
  const dir = path.dirname(target);
  const tmpPath = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tmpPath, buffer);
    await fs.rename(tmpPath, target);
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
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
  if (Array.isArray(meta?.zionTags)) {
    for (const tag of meta.zionTags) {
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
  return removeAssetNameTags([...tags], meta);
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
  if (normalizeAssetType(meta?.assetType || meta?.asset_type) === "imperfection"
    && meta?.sourceClassification?.assetType === "imperfection") {
    const options = require("./megascansCategory").CATEGORY_OPTIONS.imperfection;
    for (const key of Object.keys(meta.sourceClassification.assetCategories?.imperfection || {})) {
      const category = options.find(value => normalizeTheme(value) === normalizeTheme(key));
      if (category) addTheme(category);
    }
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
  const nextMeta = await updateAssetMetadataFile(metaPath, (current) => ({
    ...current,
    colorTags: uniqueTags,
    semanticTags: { ...current.semanticTags, color: uniqueTags }
  }));
  meta.colorTags = uniqueTags;
  meta.semanticTags = nextMeta.semanticTags;
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
  const unique = new Map();
  const pushIfValid = (value) => {
    const normalized = kind === "model" ? resolveAssetModelPath(assetDir, value) : resolveMetaFilePath(assetDir, value);
    if (!normalized) {
      return;
    }
    const ext = path.extname(normalized).toLowerCase();
    if (!extensions.has(ext)) {
      return;
    }
    unique.set(kind === "model" ? normalized.toLowerCase() : normalized, normalized);
  };
  // Managed character files are relative to the published asset directory.
  // Legacy recovery metadata may still contain absolute staging modelFiles.
  if (Array.isArray(meta?.characterManifest?.files)) {
    const roles = kind === "model" ? ["model", "staticMesh", "skeletalMesh"] : ["texture"];
    for (const file of activeCharacterFiles({ assetType: meta.assetType || meta.type, meta })) {
      if (roles.includes(file.role)) pushIfValid(file.storedPath);
    }
    return [...unique.values()];
  }
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
  return [...unique.values()];
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
  if (isModelAssetType(normalizedType)) {
    return { x: 1, y: 1, z: 1 };
  }
  return null;
}

async function backfillDimensionsMeta(metaPath, meta, dimensions) {
  if (!metaPath || !meta || !dimensions) {
    return;
  }
  const nextMeta = await updateAssetMetadataFile(metaPath, (current) => ({
    ...current,
    scanInformation: { ...current.scanInformation, dimensions }
  }));
  meta.scanInformation = nextMeta.scanInformation;
}

// 元数据里的贴图槽已经记录了每张贴图的宽高（导入时测量并持久化）。冷扫时没有
// 备忘可复用，以前仍会为每张贴图读一次图片头（2 万资产的库就是十几万次共享盘
// 读），这里直接用元数据推导同一份分析结果，只在确实缺尺寸时才回退到读图片。
function buildKnownTextureDimensions(meta) {
  const known = new Map();
  const addEntry = (item) => {
    if (!item || typeof item !== "object") return;
    const width = Math.max(0, Number(item.width) || 0);
    const height = Math.max(0, Number(item.height) || 0);
    if (width <= 0 || height <= 0) return;
    const name = path.basename(String(item.uri || item.path || "").trim()).toLowerCase();
    if (!name || known.has(name)) return;
    known.set(name, { width, height });
  };
  for (const item of Array.isArray(meta?.textureEntries) ? meta.textureEntries : []) addEntry(item);
  for (const item of Array.isArray(meta?.components) ? meta.components : []) {
    if (String(item?.type || "").trim().toLowerCase() === "model") continue;
    addEntry(item);
  }
  return known;
}

function deriveTextureAnalysisFromMeta(record, dimensions, dimensionsSource) {
  const textureFiles = normalizeTextureFiles(record?.textureFiles);
  if (textureFiles.length === 0) return null;
  const known = buildKnownTextureDimensions(record?.meta);
  const inspected = [];
  for (const filePath of textureFiles) {
    const dims = known.get(path.basename(filePath).toLowerCase());
    if (!dims) return null;
    inspected.push({ filePath, width: dims.width, height: dims.height });
  }
  const fourKTextures = inspected.filter((item) =>
    item.width >= FOUR_K_THRESHOLD_PIXELS || item.height >= FOUR_K_THRESHOLD_PIXELS
  );
  const maxTextureDimension = inspected.reduce((maximum, item) => Math.max(maximum, item.width, item.height), 0);
  return {
    version: TEXTURE_ANALYSIS_VERSION,
    status: "analyzed",
    smallAsset: true,
    uses4KTexture: fourKTextures.length > 0,
    requiresReview: fourKTextures.length > 0,
    dimensions,
    dimensionsSource: String(dimensionsSource || ""),
    maxDimensionMeters: dimensions ? Math.max(dimensions.x, dimensions.y, dimensions.z) : null,
    sizeThresholdMeters: LARGE_OBJECT_LIMIT_METERS,
    textureThresholdPixels: FOUR_K_THRESHOLD_PIXELS,
    maxTextureDimension,
    textureCount: textureFiles.length,
    inspectedTextureCount: inspected.length,
    unreadableTextureCount: 0,
    fourKTextureCount: fourKTextures.length,
    fourKTextureFiles: fourKTextures
      .slice()
      .sort((a, b) => Math.max(b.width, b.height) - Math.max(a.width, a.height))
      .map((item) => path.basename(item.filePath))
      .slice(0, MAX_REPORTED_TEXTURES)
  };
}

// 除 analyzedAt 外内容一致就认为没变化：避免“只是时间戳不同”导致每次冷扫
// 都把资产元数据重写一遍。
function stripTextureAnalysisTimestamp(analysis) {
  if (!analysis || typeof analysis !== "object") return null;
  const { analyzedAt, ...rest } = analysis;
  return rest;
}

function isSameTextureAnalysis(left, right) {
  return JSON.stringify(stripTextureAnalysisTimestamp(left)) === JSON.stringify(stripTextureAnalysisTimestamp(right));
}

const DERIVED_TEXTURE_ANALYSIS_KEYS = [
  "status",
  "smallAsset",
  "uses4KTexture",
  "requiresReview",
  "dimensions",
  "maxDimensionMeters",
  "sizeThresholdMeters",
  "textureThresholdPixels",
  "maxTextureDimension",
  "textureCount",
  "inspectedTextureCount",
  "unreadableTextureCount",
  "fourKTextureCount",
  "fourKTextureFiles"
];

function matchesDerivedTextureAnalysis(existing, derived) {
  if (!existing || !derived) return false;
  for (const key of DERIVED_TEXTURE_ANALYSIS_KEYS) {
    if (JSON.stringify(existing[key] ?? null) !== JSON.stringify(derived[key] ?? null)) {
      return false;
    }
  }
  return true;
}

async function populateTextureAnalysis(record) {
  if (!record || !isModelAssetType(record.assetType)) {
    return record;
  }
  const existing = normalizeTextureAnalysis(record.textureAnalysis || record.meta?.textureAnalysis);
  const scanInformation = record.meta?.scanInformation && typeof record.meta.scanInformation === "object"
    ? record.meta.scanInformation
    : {};
  const dimensions = getReliableDimensions(scanInformation.dimensions, scanInformation.dimensionsSource);
  const derived = deriveTextureAnalysisFromMeta(record, dimensions, scanInformation.dimensionsSource);
  if (existing && matchesDerivedTextureAnalysis(existing, derived)) {
    // 已持久化的分析与元数据里的贴图尺寸自洽，直接复用，不读任何贴图。
    record.textureAnalysis = existing;
    record.meta = record.meta && typeof record.meta === "object" ? record.meta : {};
    record.meta.textureAnalysis = existing;
    return record;
  }
  const next = await analyzeAssetTextureUsage({
    dimensions,
    dimensionsSource: scanInformation.dimensionsSource,
    textureFiles: record.textureFiles,
    previousAnalysis: existing
  });
  if (!existing || !isSameTextureAnalysis(existing, next)) {
    record.textureAnalysis = next;
    record.meta = record.meta && typeof record.meta === "object" ? record.meta : {};
    record.meta.textureAnalysis = next;
    record.shouldBackfillTextureAnalysis = true;
  }
  return record;
}

async function backfillTextureAnalysisMeta(metaPath, meta, textureAnalysis) {
  const normalized = normalizeTextureAnalysis(textureAnalysis);
  if (!metaPath || !meta || !normalized) {
    return;
  }
  await updateAssetMetadataFile(metaPath, (current) => ({ ...current, textureAnalysis: normalized }));
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

function findPreviewImages(files, meta, assetDir) {
  return findCustomPreviewImages(files, meta, assetDir);
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

  // 一张已经进入纹理槽的贴图不能作为预览图；相对 uri 用文件名兜底，
  // 避免 metadata 里的相对路径与扫描到的绝对路径不一致时漏判。
  const textureSlotPathKeys = new Set();
  const textureSlotBaseKeys = new Set();
  const addTextureSlotPath = (value) => {
    const raw = String(value || "").trim();
    if (!raw) return;
    const absolute = path.isAbsolute(raw) ? raw : path.join(assetDir || "", raw);
    textureSlotPathKeys.add(path.resolve(absolute).toLowerCase());
    const base = path.basename(raw).toLowerCase();
    if (base) textureSlotBaseKeys.add(base);
  };
  const addTextureSlotEntries = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) addTextureSlotEntries(item);
      return;
    }
    if (typeof value === "string") {
      addTextureSlotPath(value);
      return;
    }
    if (typeof value !== "object") return;
    addTextureSlotPath(value.uri);
    addTextureSlotPath(value.filePath);
    addTextureSlotPath(value.path);
    addTextureSlotPath(value.source);
  };
  const addTextureSlotMap = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      addTextureSlotEntries(value);
      return;
    }
    if (typeof value === "object") {
      for (const nested of Object.values(value)) addTextureSlotEntries(nested);
    }
  };
  addTextureSlotEntries(meta?.textureEntries);
  addTextureSlotMap(meta?.textureSlots);
  addTextureSlotEntries(meta?.textureFiles);
  if (Array.isArray(meta?.components)) {
    for (const component of meta.components) {
      if (String(component?.type || "").toLowerCase() === "texture") addTextureSlotEntries(component);
    }
  }
  const isTextureSlotPath = (value) => {
    const raw = String(value || "").trim();
    if (!raw) return false;
    const absolute = path.isAbsolute(raw) ? raw : path.join(assetDir || "", raw);
    if (textureSlotPathKeys.has(path.resolve(absolute).toLowerCase())) return true;
    const base = path.basename(raw).toLowerCase();
    return Boolean(base && textureSlotBaseKeys.has(base));
  };

  const resolveByMetaUri = (uriValue) => {
    const rawUri = String(uriValue || "").trim();
    if (path.isAbsolute(rawUri) && !isAnimationLibraryPath(rawUri)) {
      return isTextureSlotPath(rawUri) ? null : rawUri;
    }
    const token = normalizeFileToken(uriValue);
    if (!token) {
      return null;
    }
    if (!token.includes("preview/") && !token.includes("previews/")) {
      return null;
    }
    const baseName = path.basename(token);
    const exactByUri = textureFiles.find((filePath) => !isTextureSlotPath(filePath)
      && normalizeFileToken(filePath).endsWith(token));
    if (exactByUri) {
      return exactByUri;
    }
    const exactByBase = textureFiles.find((filePath) => !isTextureSlotPath(filePath)
      && path.basename(filePath).toLowerCase() === baseName);
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
    if (name.endsWith("_preview.png") || name.endsWith("_preview.webm") || name.endsWith("_preview.mp4") || name.endsWith("_preview.gif")) score += 50;
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
    if (name.endsWith("_preview.png") || name.endsWith("_preview.jpg") || name.endsWith("_preview.jpeg")
      || name.endsWith("_preview.webm") || name.endsWith("_preview.mp4") || name.endsWith("_preview.gif")) score += 80;
    if (name.includes("_sp.") || name.includes("sidepanel")) score -= 40;
    return score;
  };

  const previewsFolderFiles = textureFiles.filter((filePath) => isPreviewFolderFile(filePath) && !isTextureSlotPath(filePath));

  let metaPreview = null;
  const previewImages = [];
  if (meta?.previews?.images && Array.isArray(meta.previews.images)) {
    for (const img of meta.previews.images) {
      if (!img?.uri) continue;
      const resolved = resolveByMetaUri(img.uri);
      if (!resolved) continue;
      const tags = Array.isArray(img.tags) ? img.tags.map((tag) => String(tag || "").trim()).filter(Boolean) : [];
      previewImages.push({ path: resolved, tags });
    }
    metaPreview = previewImages.find((item) => item.tags.includes("cover"))?.path
      || previewImages.find((item) => item.tags.includes("view:front"))?.path
      || previewImages[0]?.path
      || null;
  }
  metaPreview = metaPreview || resolveByMetaUri(meta?.previewImage) || resolveByMetaUri(meta?.detailImage);
  if (metaPreview && isTextureSlotPath(metaPreview)) {
    metaPreview = null;
  }
  if (metaPreview) {
    previewImage = metaPreview;
  } else if (previewsFolderFiles.length > 0) {
    previewImage = [...previewsFolderFiles].sort((a, b) => scoreCardPreview(b) - scoreCardPreview(a))[0];
  }

  const detailImage = previewImage ? previewImage : null;
  if (previewImage && previewImages.length === 0) previewImages.push({ path: previewImage, tags: ["preview"] });
  return { previewImage, detailImage, previewImages };
}

function formatTextureResolutionLabel(pixels) {
  const normalized = Math.max(0, Math.round(Number(pixels) || 0));
  if (normalized >= 8192) return Math.round(normalized / 1024) + "K";
  if (normalized >= 4096) return "4K";
  if (normalized >= 2048) return "2K";
  if (normalized >= 1024) return "1K";
  return normalized > 0 ? normalized + "px" : "";
}

async function readTextureDimensions(filePath) {
  const resolved = String(filePath || "").trim();
  if (!resolved) return null;
  if (sharp) {
    try {
      const metadata = await sharp(resolved, { failOn: "none" }).metadata();
      const width = Math.max(0, Number(metadata?.width) || 0);
      const height = Math.max(0, Number(metadata?.height) || 0);
      if (width > 0 && height > 0) return { width, height };
    } catch {
      // fall through to nativeImage
    }
  }
  if (nativeImage) {
    try {
      const image = nativeImage.createFromPath(resolved);
      if (image && !image.isEmpty()) {
        const size = image.getSize();
        if (size && size.width > 0 && size.height > 0) return { width: size.width, height: size.height };
      }
    } catch {
      // ignore
    }
  }
  return null;
}

async function backfillTextureResolutionMeta(metaPath, meta, record) {
  if (!metaPath || !meta || typeof meta !== "object" || Array.isArray(meta)) return false;
  const entries = Array.isArray(meta.textureEntries) ? meta.textureEntries : [];
  if (entries.length === 0) return false;

  const pending = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || typeof entry !== "object") continue;
    const width = Number(entry.width) || 0;
    const hasResolution = typeof entry.resolution === "string" && entry.resolution.trim();
    if (width <= 0 && !hasResolution) pending.push(index);
  }
  if (pending.length === 0) return false;

  const textureFiles = Array.isArray(meta.textureFiles) ? meta.textureFiles : [];
  const byUri = new Map();
  for (const filePath of textureFiles) {
    const uri = path.basename(String(filePath || "")).toLowerCase();
    if (uri) byUri.set(uri, filePath);
  }

  const resolved = await Promise.all(pending.map(async (index) => {
    const entry = entries[index];
    const uri = String(entry?.uri || entry?.path || "").trim().toLowerCase();
    const filePath = uri ? (byUri.get(uri) || "") : "";
    if (!filePath) return { index, dims: null };
    return { index, dims: await readTextureDimensions(filePath) };
  }));

  const dimsByIndex = new Map();
  const dimsByUri = new Map();
  for (const { index, dims } of resolved) {
    if (!dims) continue;
    dimsByIndex.set(index, dims);
    const uri = String(entries[index]?.uri || entries[index]?.path || "").trim().toLowerCase();
    if (uri) dimsByUri.set(uri, dims);
  }
  if (dimsByIndex.size === 0) return false;

  const nextMeta = await updateAssetMetadataFile(metaPath, (current) => ({
    ...current,
    textureEntries: (Array.isArray(current.textureEntries) ? current.textureEntries : []).map((entry) => {
      const dims = dimsByUri.get(String(entry?.uri || entry?.path || "").trim().toLowerCase());
      if (!dims) return entry;
      const label = formatTextureResolutionLabel(Math.max(dims.width, dims.height));
      if (!label) return entry;
      return { ...entry, width: dims.width, height: dims.height, resolution: label };
    })
  }));
  meta.textureEntries = nextMeta.textureEntries;

  if (record && record.meta && typeof record.meta === "object" && !Array.isArray(record.meta)) {
    const applyDims = (item) => {
      if (!item || typeof item !== "object") return item;
      const uri = String(item.uri || item.path || "").trim().toLowerCase();
      const dims = dimsByUri.get(uri);
      if (!dims) return item;
      const label = formatTextureResolutionLabel(Math.max(dims.width, dims.height));
      if (!label) return item;
      return { ...item, width: dims.width, height: dims.height, resolution: label };
    };
    if (Array.isArray(record.meta.textureEntries)) {
      record.meta.textureEntries = record.meta.textureEntries.map(applyDims);
    }
    if (Array.isArray(record.meta.components)) {
      record.meta.components = record.meta.components.map(applyDims);
    }
  }
  return true;
}

function copyTextureResolutionFields(source, target) {
  if (!source || typeof source !== "object" || !target || typeof target !== "object") {
    return target;
  }
  const stringFields = new Set(["resolution", "sourceResolution"]);
  const numericFields = new Set(["width", "height", "sourceWidth", "sourceHeight"]);
  for (const key of [...stringFields, ...numericFields, "compressed"]) {
    if (!(key in source)) continue;
    const value = source[key];
    if (key === "compressed") {
      if (typeof value === "boolean") target[key] = value;
      continue;
    }
    if (stringFields.has(key)) {
      if (typeof value === "string" && value.trim()) target[key] = value.trim();
      continue;
    }
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) target[key] = Math.round(numeric);
  }
  return target;
}

function buildLightMeta(meta) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return {};
  }
  const light = {};
  if (typeof meta.createdAt === "string") light.createdAt = meta.createdAt;
  if (typeof meta.updatedAt === "string") light.updatedAt = meta.updatedAt;
  if (meta.materialNames && typeof meta.materialNames === "object" && !Array.isArray(meta.materialNames)) light.materialNames = meta.materialNames;
  if (typeof meta.name === "string") light.name = meta.name;
  if (typeof meta.assetName === "string") light.assetName = meta.assetName;
  if (typeof meta.assetID === "string") light.assetID = meta.assetID;
  if (typeof meta.id === "string") light.id = meta.id;
  if (typeof meta.topCategory === "string") light.topCategory = meta.topCategory;
  if (typeof meta.assetType === "string") light.assetType = meta.assetType;
  if (typeof meta.asset_type === "string") light.asset_type = meta.asset_type;
  if (Array.isArray(meta.standardAssetTags)) light.standardAssetTags = meta.standardAssetTags.filter((tag) => typeof tag === "string" && tag.trim());
  if (Array.isArray(meta.zionTags)) light.zionTags = meta.zionTags.filter((tag) => typeof tag === "string" && tag.trim());
  if (meta.nativePlantWind && typeof meta.nativePlantWind === "object") light.nativePlantWind = meta.nativePlantWind;
  if (Number.isFinite(Number(meta.baseTiling)) && Number(meta.baseTiling) > 0) light.baseTiling = Number(meta.baseTiling);
  const textureAnalysis = normalizeTextureAnalysis(meta.textureAnalysis);
  if (textureAnalysis) light.textureAnalysis = textureAnalysis;
  if (typeof meta.hasCollision === "boolean") light.hasCollision = meta.hasCollision;
  if (typeof meta.subType === "string") light.subType = meta.subType;
  if (typeof meta.category === "string") light.category = meta.category;
  if (typeof meta.animationAffiliation === "string") light.animationAffiliation = meta.animationAffiliation;
  if (Array.isArray(meta.animationLabels)) light.animationLabels = meta.animationLabels.filter((label) => typeof label === "string" && label.trim());
  if (meta.animationGameTag && typeof meta.animationGameTag === "object" && meta.animationGameTag.id) light.animationGameTag = meta.animationGameTag;
  if (meta.character && typeof meta.character === "object" && !Array.isArray(meta.character)) {
    light.characterDisplaySchema = 2;
    if (meta.characterComponents && typeof meta.characterComponents === "object") light.characterComponents = meta.characterComponents;
    if (Array.isArray(meta.characterPackageHistory)) light.characterPackageHistory = meta.characterPackageHistory.map(({ id, createdAt }) => ({ id, createdAt }));
    light.character = Object.fromEntries(
      ["family", "gender", "bodyCode", "suitClass", "suitName", "name", "displayNameZh", "displayNameEn", "ueNameSyncPending", "entityKey", "relatedAssetId", "serial", "variant", "maturity", "confirmed"]
        .filter((key) => typeof meta.character[key] === "string" || typeof meta.character[key] === "boolean")
        .map((key) => [key, meta.character[key]])
    );
    if (Array.isArray(meta.character.formIds)) light.character.formIds = meta.character.formIds.filter((id) => typeof id === "string");
  }
  if (meta.characterManifest && typeof meta.characterManifest === "object" && !Array.isArray(meta.characterManifest)) {
    const manifest = meta.characterManifest;
    light.characterManifest = {
      schemaVersion: String(manifest.schemaVersion || "1.0"),
      family: String(manifest.family || ""),
      completeness: String(manifest.completeness || ""),
      maturity: String(manifest.maturity || ""),
      confirmed: manifest.confirmed === true,
      fileCount: Math.max(0, Number(manifest.fileCount) || 0),
      metrics: manifest.metrics && typeof manifest.metrics === "object" ? manifest.metrics : undefined,
          files: Array.isArray(manifest.files)
        ? manifest.files.filter((item) => item && typeof item === "object").map((item) => ({
            originalName: String(item.originalName || ""),
            normalizedName: String(item.normalizedName || ""),
            storedPath: String(item.storedPath || ""),
            sha256: String(item.sha256 || ""),
            role: String(item.role || "other"),
            formId: String(item.formId || ""),
            unresolvedFormToken: String(item.unresolvedFormToken || ""),
            componentRole: String(item.componentRole || ""),
            componentName: String(item.componentName || ""),
            sharedAcrossForms: item.sharedAcrossForms === true,
            rigNeedsUpdate: item.rigNeedsUpdate === true,
            rigReviewPending: item.rigReviewPending === true,
            rigReviewDecision: String(item.rigReviewDecision || ""),
            materialName: String(item.materialName || ""),
            textureGroup: String(item.textureGroup || ""),
            textureType: String(item.textureType || ""),
            size: Math.max(0, Number(item.size) || 0),
            triangleCount: item.triangleCount === null ? null : (Number.isFinite(Number(item.triangleCount)) ? Math.max(0, Math.floor(Number(item.triangleCount))) : undefined)
          }))
        : []
    };
  }
  if (meta.characterMetrics && typeof meta.characterMetrics === "object" && !Array.isArray(meta.characterMetrics)) {
    light.characterMetrics = meta.characterMetrics;
  }
  if (typeof meta.characterImportGroupId === "string") light.characterImportGroupId = meta.characterImportGroupId;
  if (typeof meta.packageStatus === "string") light.packageStatus = meta.packageStatus;
  if (typeof meta.previewSkeletonPath === "string") light.previewSkeletonPath = meta.previewSkeletonPath;
  if (typeof meta.previewSkeletalMeshPath === "string") light.previewSkeletalMeshPath = meta.previewSkeletalMeshPath;
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
        if (typeof item.materialRole === "string" && item.materialRole.trim()) next.materialRole = item.materialRole.trim();
        if (typeof item.normalMapFormat === "string") next.normalMapFormat = item.normalMapFormat;
        copyTextureResolutionFields(item, next);
        return next;
      })
      .filter((item) => Object.keys(item).length > 0);
  }
  if (Array.isArray(meta.tags)) light.tags = meta.tags.filter((tag) => typeof tag === "string");
  if (meta.identity && typeof meta.identity === "object" && !Array.isArray(meta.identity)) {
    light.identity = meta.identity;
  }
  if (Number.isFinite(Number(meta.revision)) && Number(meta.revision) > 0) {
    light.revision = Math.floor(Number(meta.revision));
  }
  if (Array.isArray(meta.importHistory)) {
    light.importHistory = meta.importHistory.filter((item) => item && typeof item === "object" && !Array.isArray(item)).slice(-20);
  }
  if (Array.isArray(meta.animationOperationHistory)) light.animationOperationHistory = meta.animationOperationHistory.slice(-50);
  if (Array.isArray(meta.animationUEExports)) light.animationUEExports = meta.animationUEExports.slice(-20);
  const colorTags = collectColorTagsFromMeta(meta);
  if (colorTags.length > 0) {
    light.colorTags = colorTags;
  }
  if (meta.modelSlots && typeof meta.modelSlots === "object" && !Array.isArray(meta.modelSlots)) {
    light.modelSlots = Object.fromEntries(
      Object.entries(meta.modelSlots).filter(([, value]) => typeof value === "string" && value.trim())
    );
  }
  if (Array.isArray(meta.modelVariants)) {
    light.modelVariants = meta.modelVariants
      .filter((item) => item && typeof item === "object")
      .map((item) => {
        const next = {};
        if (typeof item.file === "string") next.file = item.file;
        if (typeof item.path === "string") next.path = item.path;
        if (typeof item.uri === "string") next.uri = item.uri;
        if (typeof item.variantKey === "string" && item.variantKey.trim()) next.variantKey = item.variantKey.trim();
        if (Number.isFinite(Number(item.variantNumber)) && Number(item.variantNumber) > 0) {
          next.variantNumber = Math.floor(Number(item.variantNumber));
        }
        return next;
      })
      .filter((item) => Object.keys(item).length > 0);
  }
  if (Array.isArray(meta.modelLods)) {
    light.modelLods = meta.modelLods
      .filter((item) => item && typeof item === "object")
      .map((item) => {
        const next = {};
        if (typeof item.file === "string") next.file = item.file;
        if (typeof item.path === "string") next.path = item.path;
        if (typeof item.uri === "string") next.uri = item.uri;
        if (typeof item.slot === "string" && item.slot.trim()) next.slot = item.slot.trim();
        if (Number.isFinite(Number(item.lod)) && Number(item.lod) >= 0) next.lod = Math.floor(Number(item.lod));
        if (typeof item.variantKey === "string" && item.variantKey.trim()) next.variantKey = item.variantKey.trim();
        if (Number.isFinite(Number(item.variantNumber)) && Number(item.variantNumber) > 0) {
          next.variantNumber = Math.floor(Number(item.variantNumber));
        }
        return next;
      })
      .filter((item) => Object.keys(item).length > 0);
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
        if (typeof item.variantKey === "string" && item.variantKey.trim()) next.variantKey = item.variantKey.trim();
        if (Number.isFinite(Number(item.variantNumber)) && Number(item.variantNumber) > 0) {
          next.variantNumber = Math.floor(Number(item.variantNumber));
        }
        if (typeof item.normalMapFormat === "string") next.normalMapFormat = item.normalMapFormat;
        copyTextureResolutionFields(item, next);
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
      const dimensionsSource = String(meta?.scanInformation?.dimensionsSource || '').trim();
      if (dimensionsSource) light.scanInformation.dimensionsSource = dimensionsSource;
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

function createAssetRecord(assetDir, metaPath, meta, files, forcedSource, includeCharacterDetails = false) {
  meta = normalizeAssetModelPaths(meta, assetDir);
  const rawAssetId =
    (typeof meta?.assetID === "string" && meta.assetID.trim()) ? meta.assetID :
    (typeof meta?.id === "string" && meta.id.trim()) ? meta.id :
    normalizePath(assetDir);
  const displayName = meta?.name || meta?.assetName || path.basename(assetDir);
  const source = String(forcedSource || "custom");
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
  const assetType = getAssetType(meta, assetDir, source);
  const characterAsset = ["suit", "monster", "npc", "weapon", "item"].includes(assetType);
  // An empty character texture manifest is valid (for example a recovered
  // untextured mesh). Never fill it with generated covers and component views.
  const finalTextureFiles = characterAsset
    ? Array.isArray(meta.characterManifest?.files)
      ? [...new Set(activeCharacterFiles({ assetType, meta }).filter(file => file.role === "texture")
        .map(file => resolveMetaFilePath(assetDir, file.storedPath)).filter(file => file && scannedTextureSet.has(file.toLowerCase())))]
      : (textureFiles.length > 0 ? textureFiles : scannedTextureFiles).filter(isAllowedCharacterTextureFile)
    : textureFiles.length > 0 ? textureFiles : scannedTextureFiles;
  if (finalModelFiles.length === 0 && finalTextureFiles.length === 0) {
    return null;
  }
  if (!hasAssetLikeMeta(meta)) {
    return null;
  }
  
  const topCategory = String(meta?.topCategory || getTopCategoryForAssetType(assetType)).trim();
  const standardAssetTags = getStandardAssetTags(meta, assetDir, assetType);
  const baseTiling = Number.isFinite(Number(meta?.baseTiling)) && Number(meta?.baseTiling) > 0 ? Number(meta.baseTiling) : undefined;
  const { previewImage, detailImage, previewImages } = findPreviewImages(files, meta, assetDir);
  const themes = extractThemes(meta);
  
  const extractedDimensions = isModelAssetType(assetType) ? extractDimensions(meta) : null;
  const dimensions = extractedDimensions || getFallbackDimensions(assetType);
  const lightMeta = buildLightMeta(meta);
  if (includeCharacterDetails && ['suit', 'monster', 'npc', 'weapon', 'item'].includes(assetType)) {
    for (const key of ['enginePath', 'characterUnrealExports', 'characterUpdateHistory', 'previews', 'previewImage', 'detailImage']) {
      if (meta[key] !== undefined) lightMeta[key] = meta[key];
    }
  }
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
    topCategory,
    standardAssetTags,
    zionTags: Array.isArray(meta?.zionTags) ? meta.zionTags.map((tag) => String(tag || "").trim()).filter(Boolean) : [],
    // Zion 资产导出目标二级目录（Objects 之后的部分），存在资产元数据里，
    // 由导出面板的按钮弹层写入；这里读进索引供界面与导出使用。
    zionExportSubfolder: String(meta?.zionExportSubfolder || "").trim() || undefined,
    animationAffiliation: String(meta?.animationAffiliation || lightMeta.animationAffiliation || "").trim() || undefined,
    animationLabels: lightMeta.animationLabels?.length ? lightMeta.animationLabels : undefined,
    animationGameTag: lightMeta.animationGameTag,
    baseTiling,
    assetType,
    hasCollision: typeof meta?.hasCollision === "boolean" ? meta.hasCollision : undefined,
    textureAnalysis: normalizeTextureAnalysis(meta?.textureAnalysis) || undefined,
    themes,
    colorTags: collectColorTagsFromMeta(meta),
    tags: extractTags(meta, path.basename(path.dirname(assetDir)), assetDir, source),
    modelFiles: finalModelFiles,
    previewSkeletonPath: String(meta?.previewSkeletonPath || lightMeta.previewSkeletonPath || "").trim() || undefined,
    previewSkeletalMeshPath: String(meta?.previewSkeletalMeshPath || lightMeta.previewSkeletalMeshPath || "").trim() || undefined,
    textureFiles: finalTextureFiles,
    preview: previewImage ? normalizePath(previewImage) : null,
    previewImage: previewImage ? normalizePath(previewImage) : null,
    detailImage: detailImage ? normalizePath(detailImage) : null,
    previewImages: previewImages.map((item) => ({ path: normalizePath(item.path), tags: item.tags })),
    createdAt: meta?.createdAt || null,
    shouldBackfillDimensions: Boolean(!extractedDimensions && dimensions)
  };
}

async function scanPath(rootPath, source, options = {}) {
  if (!rootPath) return [];
  const index = [];
  const maxMetaBytes = CUSTOM_META_JSON_MAX_BYTES;
  const onProgress = typeof options?.onProgress === "function" ? options.onProgress : null;
  const onRecord = typeof options?.onRecord === "function" ? options.onRecord : null;
  const maintenance = options.maintenance === true;
  const concurrency = resolveScanConcurrency(options);
  const backfillFailed = (metaPath, error) => {
    options.onWarning?.({ path: metaPath, operation: "metadata-write", code: error?.code, message: error?.message || String(error) });
    return false;
  };
  if (source === "custom") {
    const customRoot = path.resolve(String(rootPath || ""));
    const recycledIds = new Set([...(await listRecycledAssets(customRoot)), ...(await listPermanentlyDeletedAssets(customRoot))].map(item => item.assetId));
    if (onProgress) {
      onProgress({ source, phase: "collect", processed: 0, total: 0, progress: 0 });
    }
    const memoReadStartedAt = Date.now();
    const memo = options?.preloadedMemo || await readCustomScanMemo(customRoot, options);
    const memoReadMs = options?.preloadedMemo ? Number(options?.memoReadMs) || 0 : Date.now() - memoReadStartedAt;
    // Rebuild records cached under a former merged asset classification.
    // This also removes them from incremental polling's unchanged-folder hints.
    const needsClassificationRefresh = entry => {
      const record = entry?.record;
      const currentType = record && getAssetType(record.meta, record.path, source);
      return record && ["atlas", "imperfection", "displacement"].includes(currentType) && record.assetType !== currentType;
    };
    const cachedEntries = memo.entries.filter(entry => !recycledIds.has(entry.record?.id));
    const walkCachedEntries = cachedEntries.filter(entry => !needsClassificationRefresh(entry));
    const classificationChanged = walkCachedEntries.length !== cachedEntries.length;
    const cachedPairs = [];
    const cachedByModelPath = new Map();
    for (const entry of cachedEntries) {
      if (!entry || typeof entry !== "object") continue;
      const metaPath = String(entry.metaPath || "").trim();
      if (!metaPath) continue;
      cachedPairs.push([normalizeComparePath(metaPath), entry]);
      const record = entry.record;
      for (const modelPath of Array.isArray(record?.modelFiles) ? record.modelFiles : []) {
        const normalizedModel = normalizeComparePath(modelPath);
        if (normalizedModel && !cachedByModelPath.has(normalizedModel)) {
          cachedByModelPath.set(normalizedModel, entry);
        }
      }
    }
    const cachedByMetaPath = new Map(cachedPairs);
    const failedPaths = new Set();
    const warn = (warning) => {
      failedPaths.add(normalizeComparePath(warning.path));
      options.onWarning?.(warning);
    };
    let walkMs = 0;
    {
      let totalDirs = 0;
      if (onProgress) {
        onProgress({ source, phase: "scan", processed: 0, total: totalDirs, progress: 5 });
      }
      const isDev = !app?.isPackaged && typeof process !== 'undefined' && process.env.NODE_ENV !== 'production';
      const timeoutScale = isDev ? 5 : 1;
      let textureResolutionBackfilledCount = 0;
      const scanStats = { cacheHits: 0, reused: 0, rebuilt: 0, skipped: 0, metaWrites: 0 };
      // 目录是否变化：优先比较遍历时拿到的文件名集合（零 I/O）；旧备忘没有
      // 目录指纹时退回目录 mtime 比较，并会在本轮之后写入指纹。
      const resolveDirChange = async (entry, cached, assetDir) => {
        // 没有备忘记录时无所谓“变没变”，不需要为冷扫再多打一次目录 stat。
        if (!cached || typeof cached !== "object" || !cached.record) {
          return { unchanged: false, dirMtimeMs: 0 };
        }
        const cachedSignature = typeof cached?.dirSignature === "string" ? cached.dirSignature : "";
        const currentSignature = typeof entry?.dirSignature === "string" ? entry.dirSignature : "";
        if (cachedSignature && currentSignature) {
          return { unchanged: cachedSignature === currentSignature, dirMtimeMs: 0 };
        }
        const dirStats = await fs.stat(assetDir).catch(() => null);
        const dirMtimeMs = Number(dirStats?.mtimeMs) || 0;
        const cachedDirMtimeMs = Number(cached?.dirMtimeMs) || 0;
        return {
          unchanged: Boolean(cachedDirMtimeMs > 0 && dirMtimeMs > 0 && dirMtimeMs <= cachedDirMtimeMs),
          dirMtimeMs
        };
      };
      const processEntry = async (entry) => {
        const staleCharacterDisplay = record => ["suit", "monster", "npc", "weapon", "item"].includes(String(record?.assetType || "").toLowerCase()) && record?.meta?.characterDisplaySchema !== 2;
        if (entry.cachedOnly && staleCharacterDisplay(entry.cachedOnly.record)) {
          entry = { ...entry.cachedOnly, metaPath: entry.metaPath, assetDir: entry.assetDir, cachedOnly: undefined };
        }
        if (entry.cachedOnly) {
          scanStats.reused += 1;
          return { kind: "cached", ...entry.cachedOnly };
        }
        const metaPath = String(entry?.metaPath || "").trim();
        const assetDir = String(entry?.assetDir || "").trim();
        if (!metaPath || !assetDir || isInUAssetsPath(metaPath)) {
          return { kind: "skip" };
        }
        const metaStats = await scanRead(() => fs.stat(metaPath));
        if (!metaStats?.isFile()) {
          return { kind: "skip" };
        }
        const cached = cachedByMetaPath.get(normalizeComparePath(metaPath))
          || (isAnimationModelMetaPath(metaPath) ? cachedByModelPath.get(normalizeComparePath(metaPath)) : null);
        const cachedRecord = cached?.record;
        const persistedAnimationIdentity = isAnimationModelMetaPath(metaPath)
          ? await readAnimationIdentitySidecar(metaPath)
          : null;
        const cachedMetaMtimeMs = Number(cached?.metaMtimeMs) || 0;
        const dirState = await resolveDirChange(entry, cached, assetDir);
        const dirSignature = typeof entry?.dirSignature === "string" ? entry.dirSignature : "";
        const cachedCharacterMetaCurrent = !["suit", "monster", "npc", "weapon", "item"].includes(String(cachedRecord?.assetType || "").toLowerCase())
          || Boolean(cachedRecord?.meta?.character && cachedRecord?.meta?.characterManifest && !staleCharacterDisplay(cachedRecord));
        const canReuseCache = Boolean(
          !options.refreshMetadata && !Array.isArray(options.changedDirectories) &&
          cachedRecord &&
          cachedCharacterMetaCurrent &&
          !needsClassificationRefresh(cached) &&
          cachedMetaMtimeMs === Number(metaStats.mtimeMs) &&
          Number(cached?.metaSize) === Number(metaStats.size) &&
          dirState.unchanged &&
          !animationIdentityDiffersFromRecord(cachedRecord, persistedAnimationIdentity) &&
          (!isModelAssetType(cachedRecord?.assetType) || isTextureAnalysisCurrent(cachedRecord?.textureAnalysis) || isAnimationModelMetaPath(metaPath))
        );
        if (canReuseCache) {
          scanStats.cacheHits += 1;
          return {
            kind: "cached",
            metaPath: isAnimationModelMetaPath(metaPath) ? metaPath : String(cached?.metaPath || metaPath),
            assetDir,
            metaMtimeMs: Number(metaStats.mtimeMs) || 0,
            metaSize: Number(metaStats.size),
            dirSignature,
            record: isAnimationModelMetaPath(metaPath)
              ? {
                  ...cachedRecord,
                  path: assetDir,
                  metaPath,
                  modelFiles: [normalizePath(metaPath)],
                  meta: applyAnimationIdentityMetadata(cachedRecord.meta || {}, persistedAnimationIdentity)
                }
              : cachedRecord
          };
        }
        scanStats.rebuilt += 1;
        const meta = isAnimationModelMetaPath(metaPath)
          ? applyAnimationIdentityMetadata(buildAnimationMetaFromModel(metaPath, cachedRecord || {}), persistedAnimationIdentity)
          : await readJsonSafe(metaPath, { maxBytes: maxMetaBytes, knownBytes: Number(metaStats.size), strict: true });
        if (!meta) {
          scanStats.skipped += 1;
          throw new Error(`无法读取资产元数据: ${metaPath}`);
        }
        if (!hasAssetLikeMeta(meta)) {
          if (cachedRecord || isFolderAssetMetaFileName(path.basename(metaPath))) throw new Error(`资产元数据不完整: ${metaPath}`);
          return { kind: "skip" };
        }
        const dirFiles = isAnimationModelMetaPath(metaPath)
          ? [path.resolve(metaPath)]
          : await collectCustomAssetFiles(assetDir, meta, metaPath, entry.entries);
        if (!dirFiles) {
          scanStats.skipped += 1;
          return { kind: "skip" };
        }
        const record = await populatePreviewSize(createAssetRecord(assetDir, metaPath, meta, dirFiles, source));
        if (!record) {
          scanStats.skipped += 1;
          if (cachedRecord || isFolderAssetMetaFileName(path.basename(metaPath))) throw new Error(`资产没有可读取的模型或贴图: ${metaPath}`);
          return { kind: "skip" };
        }
        if (isAnimationModelMetaPath(metaPath)) {
          applyPreservedAnimationPreview(record, cachedRecord || {});
        }
        let metaWritten = false;
        if (maintenance && record.shouldBackfillDimensions && record?.meta?.scanInformation?.dimensions && !isAnimationModelMetaPath(metaPath)) {
          metaWritten = await backfillDimensionsMeta(metaPath, meta, record.meta.scanInformation.dimensions).then(() => true).catch((error) => backfillFailed(metaPath, error));
        }
        delete record.shouldBackfillDimensions;

        if (!isAnimationModelMetaPath(metaPath)) {
          // 先回填贴图分辨率：随后贴图分析可以直接用元数据里的宽高，不必再读图片。
          if (maintenance && textureResolutionBackfilledCount < TEXTURE_RESOLUTION_BACKFILL_MAX_ASSETS_PER_SCAN) {
            const didBackfill = await withTimeout(
              backfillTextureResolutionMeta(metaPath, meta, record),
              10000 * timeoutScale
            ).catch((error) => backfillFailed(metaPath, error));
            if (didBackfill === true) {
              textureResolutionBackfilledCount += 1;
              metaWritten = true;
            }
          }
          await withTimeout(populateTextureAnalysis(record), 12000 * timeoutScale).catch(() => {});
          if (maintenance && record.shouldBackfillTextureAnalysis) {
            const written = await backfillTextureAnalysisMeta(metaPath, meta, record.textureAnalysis).then(() => true).catch((error) => backfillFailed(metaPath, error));
            metaWritten ||= written;
          }
        }
        delete record.shouldBackfillTextureAnalysis;
        let metaMtimeMs = Number(metaStats.mtimeMs) || 0;
        let metaSize = Number(metaStats.size);
        if (metaWritten) {
          // 回填改写了 asset_info.json，备忘必须记录改写后的 mtime，否则下一轮
          // 扫描会认为元数据又变了，2 万资产的库会因此永远命中不了缓存。
          scanStats.metaWrites += 1;
          const refreshedStats = await fs.stat(metaPath).catch(() => null);
          if (refreshedStats?.isFile()) {
            metaMtimeMs = Number(refreshedStats.mtimeMs) || metaMtimeMs;
            metaSize = Number(refreshedStats.size);
          }
        }
        return {
          kind: "record",
          metaPath,
          assetDir,
          metaMtimeMs,
          metaSize,
          dirSignature,
          record
        };
      };

      let processedDirs = 0;
      const nextIndexEntries = [];
      // 每批扫描完成就推送记录，而不是等全库扫完再一次性推送。首次安装扫描
      // 上千个网络共享资产时，用户必须能在扫描过程中就看到卡片逐渐出现。
      const discovered = collectCustomAssetEntriesFromFolderListing(customRoot, {
        onProgress, onWarning: warn, cachedEntries: walkCachedEntries,
        concurrency,
        incrementalScan: Boolean(options.incrementalScan) && !options.refreshMetadata,
        changedDirectories: !memo.legacy && !classificationChanged && !options.refreshMetadata ? options.changedDirectories : null,
        pollShard: Math.abs(Math.trunc(Number(options.pollShard) || 0)) % POLL_SHARD_COUNT
      });
      let walkStartedAt = Date.now();
      for await (const chunk of prefetchScanBatches(discovered)) {
        walkMs += Date.now() - walkStartedAt;
        totalDirs += chunk.length;
        const scanResults = await runWithConcurrency(chunk, concurrency, async (entry) => {
          try {
            const result = await processEntry(entry);
            if (result?.record && options.residentMemo) result.record = compactScanRecord(result.record);
            if (result?.record && recycledIds.has(result.record.id)) return { kind: "skip" };
            // Publish each completed asset immediately; one slow file must not
            // hold back the other cards in its batch.
            if (result?.record && onRecord) onRecord(result.record);
            return result;
          } catch (error) {
            warn({ path: entry.metaPath, operation: "asset", message: error.message });
            return { kind: "skip" };
          }
        });
        for (const scanResult of scanResults) {
          processedDirs += 1;
          if (!scanResult || scanResult.kind === "skip" || !scanResult.record) {
            continue;
          }
          const { metaPath, metaMtimeMs, metaSize, dirSignature, record } = scanResult;
          index.push(record);
          nextIndexEntries.push({ metaPath, metaMtimeMs, metaSize, dirSignature: dirSignature || undefined, record });
        }
        if (onProgress) {
          const progress = 5 + 85 * processedDirs / Math.max(processedDirs + CUSTOM_SCAN_CHUNK_SIZE, cachedEntries.length);
          const message = options.incrementalScan
            ? `增量检查 · 缓存复用 ${scanStats.reused} · 已检查 ${processedDirs - scanStats.reused}`
            : `已读取 ${processedDirs} 个资产，继续发现资产…`;
          onProgress({ source, phase: "scan", processed: processedDirs, total: 0, progress, message });
        }
        walkStartedAt = Date.now();
      }
      walkMs += Date.now() - walkStartedAt;
      // Only confirmed deletions disappear. A failed subtree/read retains its
      // last good card and memo, and will be retried on the next scan.
      const seenPaths = new Set(nextIndexEntries.map((entry) => normalizeComparePath(entry.metaPath)));
      for (const cached of cachedEntries) {
        const key = normalizeComparePath(cached.metaPath);
        if (seenPaths.has(key) || !cached.record) continue;
        let parent = key;
        while (parent && !failedPaths.has(parent)) {
          const next = normalizeComparePath(path.dirname(parent));
          if (next === parent) { parent = ""; break; }
          parent = next;
        }
        if (!parent) continue;
        nextIndexEntries.push(cached);
        index.push(cached.record);
        onRecord?.(cached.record);
      }
      // 没有变化就不重写备忘：2 万资产的库在共享盘上就是省掉一百多 MB 的写。
      const memoWriteStartedAt = Date.now();
      const nextSignature = buildScanMemoSignature(nextIndexEntries);
      let memoWritten = false;
      const memoNeedsWrite = memo.legacy || classificationChanged || options.refreshMetadata || options.changedDirectories?.length > 0 || nextSignature !== memo.signature
        || (options.scanMemoPath && (!memo.path || path.resolve(memo.path) !== path.resolve(options.residentMemo ? getResidentMemoPath(options.scanMemoPath) : options.scanMemoPath)));
      if (memoNeedsWrite) {
        memoWritten = await writeCustomScanMemo(customRoot, nextIndexEntries, {
          ...options, sourceStamp: memo.sourceStamp, writeSharedMemo: options.writeSharedMemo && failedPaths.size === 0
        }).catch(() => false);
      }
      const memoWriteMs = Date.now() - memoWriteStartedAt;
      if (memoNeedsWrite && options.scanMemoPath && !memoWritten) {
        warn({ path: customRoot, operation: "scan-memo-write", message: "本机扫描备忘保存失败，将重试本轮变更" });
      }
      if (typeof options?.onTiming === "function") {
        options.onTiming({
          source: "custom",
          total: totalDirs,
          collectMs: walkMs,
          memoReadMs,
          memoWriteMs,
          memoWritten,
          maintenance,
          concurrency,
          cacheHits: scanStats.cacheHits,
          reused: scanStats.reused,
          mode: options.incrementalScan ? "incremental-poll" : "reconcile",
          rebuilt: scanStats.rebuilt,
          skipped: scanStats.skipped,
          metaWrites: scanStats.metaWrites,
          failed: failedPaths.size
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
    if (maintenance && source === "custom") {
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
            await backfillColorTagsMeta(metaPath, meta, inferredColorTags).catch((error) => backfillFailed(metaPath, error));
            colorBackfilledCount += 1;
          }
        }
      }
    }
    const record = await populatePreviewSize(createAssetRecord(assetDir, metaPath, meta, dirFiles, source));
    if (record) {
      if (maintenance && record.shouldBackfillDimensions && record?.meta?.scanInformation?.dimensions) {
        await backfillDimensionsMeta(metaPath, meta, record.meta.scanInformation.dimensions).catch((error) => backfillFailed(metaPath, error));
      }
      delete record.shouldBackfillDimensions;

      await populateTextureAnalysis(record).catch(() => {});
      if (maintenance && record.shouldBackfillTextureAnalysis) {
        await backfillTextureAnalysisMeta(metaPath, meta, record.textureAnalysis).catch((error) => backfillFailed(metaPath, error));
      }
      delete record.shouldBackfillTextureAnalysis;
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
const activeScanWorkers = new Set();
let scanWorkerGeneration = 0;

function stopLibraryScans() {
  scanWorkerGeneration++;
  for (const worker of activeScanWorkers) {
    worker.unref();
    void worker.terminate().catch(() => {});
  }
  activeScanWorkers.clear();
}

async function scanLibraryInWorker(customPath, options = {}) {
  const generation = scanWorkerGeneration;
  const { residentBase = [], ...workerOptions } = options;
  // The local card index can have a newer animation cover than the scan memo.
  const animationPreviews = new Map();
  for (const asset of residentBase) {
    if (asset?.assetType !== "animation" || !isAnimationModelMetaPath(asset.metaPath)) continue;
    const preview = pickPreservedAnimationPreview(asset);
    if (preview) animationPreviews.set(normalizeComparePath(asset.metaPath), preview);
  }
  const reuseSeeds = options.residentIndex ? await createScanSeeds(residentBase) : [];
  if (generation !== scanWorkerGeneration) throw new Error("Scan canceled during preparation");
  return new Promise((resolve, reject) => {
    const onProgress = typeof options?.onProgress === "function" ? options.onProgress : null;
    const onRecord = typeof options?.onRecord === "function" ? options.onRecord : null;
    const onTiming = typeof options?.onTiming === "function" ? options.onTiming : null;
    const onWarning = typeof options?.onWarning === "function" ? options.onWarning : null;

    const worker = new Worker(path.join(__dirname, "scanWorker.js"), {
      workerData: { customPath, reuseSeeds, options: { ...workerOptions, onProgress: null, onRecord: null, onTiming: null, onWarning: null } }
    });
    // 扫描 worker 不能拖住应用退出：窗口关闭后进程应立即结束，
    // 否则会残留主进程 + GPU/网络子进程并占用单实例锁。
    worker.unref();
    activeScanWorkers.add(worker);
    const streamedRecords = new Map();
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      activeScanWorkers.delete(worker);
      if (error) reject(error);
      else resolve(result);
    };

    worker.on("message", (message) => {
      if (message.type === "progress" && onProgress) {
        onProgress(message.payload);
      } else if (message.type === "record") {
        const record = message.payload;
        if (record.assetType === "animation" && isAnimationModelMetaPath(record.metaPath)) {
          const preview = animationPreviews.get(normalizeComparePath(record.metaPath));
          if (preview) applyPreservedAnimationPreview(record, { previewImage: preview });
        }
        if (options.residentIndex) streamedRecords.set(message.token, record);
        onRecord?.(record);
      } else if (message.type === "timing" && onTiming) {
        onTiming(message.payload);
      } else if (message.type === "warning" && onWarning) {
        onWarning(message.payload);
      } else if (message.type === "done") {
        finish(null, message.tokens ? message.tokens.map(token => token < 0 ? residentBase[-token - 1] : streamedRecords.get(token)) : message.payload);
        streamedRecords.clear();
      } else if (message.type === "error") {
        finish(new Error(message.payload));
      }
    });

    worker.on("error", (error) => finish(error));
    worker.on("exit", (code) => {
      finish(new Error(`Worker stopped with exit code ${code}`));
    });
  });
}

async function scanLibrary(customPath, options = {}) {
  const forceFullScan = Boolean(options?.forceFullScan);
  const cacheOnly = Boolean(options?.cacheOnly);
  const onProgress = typeof options?.onProgress === "function" ? options.onProgress : null;
  const onRecord = typeof options?.onRecord === "function" ? options.onRecord : null;
  let scanMemoPath = String(options.scanMemoPath || "").trim();
  if (scanMemoPath && customPath) {
    scanMemoPath = path.resolve(scanMemoPath);
    const relative = path.relative(path.resolve(customPath), scanMemoPath);
    if (!relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
      throw new Error("Local scan memo must be outside the asset library");
    }
  }

  if (cacheOnly && !forceFullScan) {
    return [];
  }

  if (onProgress) {
    onProgress({ phase: "start", source: "all", progress: 0, message: "准备扫描..." });
  }

  const scannedCustom = customPath
    ? await scanPath(customPath, "custom", {
        onProgress,
        onRecord,
        refreshMetadata: Boolean(options?.refreshMetadata),
        changedDirectories: options.changedDirectories,
        maintenance: options?.maintenance === true,
        writeSharedMemo: options?.writeSharedMemo === true,
        scanMemoPath,
        residentMemo: Boolean(options.residentIndex && !options.maintenance),
        concurrency: options?.concurrency,
        incrementalScan: Boolean(options?.incrementalScan),
        pollShard: options?.pollShard,
        onTiming: options?.onTiming,
        onWarning: options?.onWarning
      })
    : [];

  if (onProgress) {
    onProgress({ phase: "dedup", source: "all", progress: 95, message: "正在合并资产列表..." });
  }

  const dedup = new Map();
  for (const asset of scannedCustom) {
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
          if (!asset.tags || !asset.tags.some(value => String(value).toLowerCase() === tag)) { ok = false; break; }
        }
        if (!ok) continue;
      }
      if (hasTypeFilter && !requiredAssetTypes.includes(asset.assetType)) continue;
      if (hasThemeFilter) {
        const assetThemes = asset.assetType === "imperfection"
          ? (asset.themes?.length ? asset.themes : [normalizeTheme(asset.meta?.category || "")])
          : asset.themes;
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
        if (asset.assetType !== "imperfection" && matched < requiredThemes.length && Array.isArray(assetTags)) {
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

async function updateAssetMetadata(assetPath, newMetadata) {
  try {
    const directory = String(assetPath || "").trim();
    if (!directory) {
      return false;
    }
    const entries = await fs.readdir(directory).catch(() => []);
    const preferredMeta = entries.find((name) => isFolderAssetMetaFileName(name))
      || entries.find((name) => isSidecarAssetMetaFileName(name))
      || ASSET_METADATA_FILE_NAME;
    const jsonPath = path.join(directory, preferredMeta);
    try {
      await fs.access(jsonPath);
    } catch {
      return false;
    }

    const content = await fs.readFile(jsonPath, "utf-8");
    const json = JSON.parse(content);
    await writeAssetMetadata(directory, { ...json, ...newMetadata }, { updatedAt: new Date().toISOString(), fileName: path.basename(jsonPath) });
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

    const entries = await fs.readdir(assetDir, { withFileTypes: true });
    const fileNames = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    const metaFiles = fileNames.filter((f) => path.extname(f).toLowerCase() === ".json" && !f.toLowerCase().includes("index.json") && !f.toLowerCase().includes("hivedata.json") && !f.toLowerCase().includes("hivecache.json"));
    if (metaFiles.length === 0) return null;

    const sidecarMetas = metaFiles.filter((name) => isSidecarAssetMetaFileName(name));
    const preferredMeta = metaFiles.find((name) => isFolderAssetMetaFileName(name))
      || (sidecarMetas.length === 1 ? sidecarMetas[0] : "")
      || metaFiles.find((name) => name.toLowerCase() === "asset_info.jason")
      || (sidecarMetas.length === 0 ? metaFiles[0] : "");
    if (!preferredMeta) return null;
    const metaPath = path.join(assetDir, preferredMeta);
    const maxMetaBytes = CUSTOM_META_JSON_MAX_BYTES;
    const meta = await readJsonSafe(metaPath, { maxBytes: maxMetaBytes });
    if (!meta) return null;

    const dirFiles = await collectCustomAssetFiles(assetDir, meta, metaPath);
    return populatePreviewSize(createAssetRecord(assetDir, metaPath, meta, dirFiles, source, true));
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
    if (isAnimationModelMetaPath(resolvedMetaPath)) {
      const meta = applyAnimationIdentityMetadata(
        buildAnimationMetaFromModel(resolvedMetaPath),
        await readAnimationIdentitySidecar(resolvedMetaPath)
      );
      const record = populatePreviewSize(createAssetRecord(assetDir, resolvedMetaPath, meta, [path.resolve(resolvedMetaPath)], source));
      return applyPreservedAnimationPreview(record, {});
    }
    const maxMetaBytes = CUSTOM_META_JSON_MAX_BYTES;
    const meta = await readJsonSafe(resolvedMetaPath, { maxBytes: maxMetaBytes });
    if (!meta) {
      return null;
    }
    const dirFiles = await collectCustomAssetFiles(assetDir, meta, resolvedMetaPath);
    return populatePreviewSize(createAssetRecord(assetDir, resolvedMetaPath, meta, dirFiles, source, true));
  } catch {
    return null;
  }
}

module.exports = {
  scanLibrary,
  scanLibraryInWorker,
  stopLibraryScans,
  searchAssets,
  getAssetDetails,
  getAssetDetailsByMetaPath,
  watchLibrary,
  updateAssetFavorite,
  updateAssetMetadata,
  inferColorTagsFromTextureFiles,
  collectColorTagsFromMeta,
  getCustomLibraryIndexPath,
  getCustomLibraryIndexGzPath,
  getCustomLibraryIndexPaths,
  rebuildSearchIndex: searchIndex.setIndex,
  invalidateSearchIndex: searchIndex.invalidate,
  notifySearchIndexMutation: searchIndex.notifyMutation
};
