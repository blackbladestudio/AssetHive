const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { execFile } = require("child_process");
const sharp = require("sharp");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const TEXTURE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".exr", ".tif", ".tiff", ".tga", ".bmp", ".webp"]);
const MODEL_EXTENSIONS = new Set([".fbx", ".obj", ".abc", ".gltf", ".glb"]);
const DEFAULT_LIBRARY_PATH = "";
const ASSET_TYPE_OPTIONS = ["3d", "surface", "decal", "plant", "3dplant"];
const CATEGORY_OPTIONS = ["3dassets", "nature", "building", "street", "props", "custom"];
const COLOR_LABELS = [
  { name: "red", rgb: [220, 60, 60] },
  { name: "orange", rgb: [230, 140, 60] },
  { name: "yellow", rgb: [210, 194, 78] },
  { name: "green", rgb: [80, 160, 80] },
  { name: "cyan", rgb: [80, 170, 180] },
  { name: "blue", rgb: [70, 110, 200] },
  { name: "purple", rgb: [150, 90, 200] },
  { name: "pink", rgb: [220, 120, 170] },
  { name: "brown", rgb: [140, 100, 70] },
  { name: "white", rgb: [225, 225, 225] },
  { name: "gray", rgb: [140, 140, 140] },
  { name: "black", rgb: [35, 35, 35] }
];
const COLOR_LABEL_SET = new Set(COLOR_LABELS.map((item) => item.name));

function withTimeout(taskPromise, timeoutMs, fallbackValue) {
  const durationMs = Math.max(50, Number(timeoutMs) || 0);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return taskPromise;
  }
  let timeoutId = 0;
  const timeoutPromise = new Promise((resolve) => {
    timeoutId = globalThis.setTimeout(() => resolve(fallbackValue), durationMs);
  });
  return Promise.race([taskPromise, timeoutPromise]).finally(() => {
    if (timeoutId) {
      globalThis.clearTimeout(timeoutId);
    }
  });
}

function normalizeColorTag(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return COLOR_LABEL_SET.has(normalized) ? normalized : "";
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
  const base = path.basename(String(filePath || ""), ext).toLowerCase();
  if (!base) return false;
  return /(albedo|basecolor|base_color|diffuse|colou?r)/i.test(base);
}

async function getImageArea(filePath) {
  try {
    const meta = await sharp(filePath, { failOn: "none" }).metadata();
    const width = Number(meta?.width || 0);
    const height = Number(meta?.height || 0);
    if (!width || !height) {
      return 0;
    }
    return width * height;
  } catch {
    return 0;
  }
}

async function inferColorTagsFromTextureFiles(textureFiles, options = {}) {
  const maxColorTags = Math.max(1, Math.min(6, Number(options?.maxColorTags) || 4));
  const maxCandidateImages = Math.max(1, Math.min(6, Number(options?.maxCandidateImages) || 2));
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
    try {
      const size = Math.max(24, Math.min(96, Number(options?.sampleSize) || 48));
      const { data, info } = await sharp(filePath, { failOn: "none" })
        .rotate()
        .resize(size, size, { fit: "fill" })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const width = Number(info?.width || 0);
      const height = Number(info?.height || 0);
      if (!width || !height) {
        continue;
      }
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      let count = 0;
      for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3] || 0;
        if (a < 40) {
          continue;
        }
        rSum += data[i] || 0;
        gSum += data[i + 1] || 0;
        bSum += data[i + 2] || 0;
        count += 1;
      }
      if (count <= 0) {
        continue;
      }
      const rgb = [Math.round(rSum / count), Math.round(gSum / count), Math.round(bSum / count)];
      const tag = nearestColorTag(rgb);
      counts.set(tag, (counts.get(tag) || 0) + 1);
    } catch {
      continue;
    }
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tag);
  return sorted.slice(0, maxColorTags).map(normalizeColorTag).filter(Boolean);
}

function readJsonFileOrNull(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function resolveAssetHiveCustomLibraryPathFromSettings() {
  const candidates = [];
  const appData = String(process.env.APPDATA || "").trim();
  if (appData) {
    candidates.push(path.join(appData, "AssetHive", "settings.json"));
    candidates.push(path.join(appData, "assethive", "settings.json"));
  }
  const home = os.homedir();
  if (home) {
    candidates.push(path.join(home, "AppData", "Roaming", "AssetHive", "settings.json"));
    candidates.push(path.join(home, "AppData", "Roaming", "assethive", "settings.json"));
  }
  for (const filePath of candidates) {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) continue;
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) continue;
    const settings = readJsonFileOrNull(resolved);
    const customLibraryPath = String(settings?.customLibraryPath || "").trim();
    if (customLibraryPath) {
      return customLibraryPath;
    }
  }
  return "";
}

function makeUniqueId() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 7; i += 1) {
    result += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return result;
}

function normalizeNormalMapFormat(value) {
  return String(value || "").trim().toLowerCase() === "opengl" ? "opengl" : "dx";
}

function sanitizeToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeImportedAssetName(rawName) {
  const source = String(rawName || "").trim();
  if (!source) return source;
  return source
    .replace(/yanshikuai/ig, "Natue_Rock")
    .replace(/yan_shi_kuai/ig, "Natue_Rock")
    .replace(/岩石块/g, "Natue_Rock");
}

function makeCustomModelBaseName(slot, assetName, assetId) {
  const assetNameToken = sanitizeToken(assetName) || "asset";
  const normalizedSlot = String(slot || "").trim().toLowerCase();
  if (!normalizedSlot || normalizedSlot === "mesh" || normalizedSlot === "highpoly") {
    return `SM_${assetNameToken}_${assetId}_Var01`;
  }
  if (normalizedSlot.startsWith("lod")) {
    return `SM_${assetNameToken}_${assetId}_${normalizedSlot.toUpperCase()}`;
  }
  return `SM_${assetNameToken}_${assetId}_${sanitizeToken(slot).toUpperCase()}`;
}

function makeCustomTextureBaseName(textureType, areaIndex, assetName, assetId) {
  const assetNameToken = sanitizeToken(assetName) || "asset";
  const normalizedType = String(textureType || "").trim() || "Albedo";
  const suffix = areaIndex > 1 ? `${String(areaIndex).padStart(3, "0")}_${normalizedType}` : normalizedType;
  return `T_${assetNameToken}_${assetId}_${suffix}`;
}

function normalizePath(filePath) {
  return String(filePath || "").replace(/\\/g, "/");
}

function identifyTextureSlot(filename) {
  const name = filename.toLowerCase();
  if (name.includes("albedo") || name.includes("diffuse") || name.includes("basecolor") || name.includes("base_color") || name.includes("color")) return "Albedo";
  if (name.includes("normal") || name.includes("nrm") || name.includes("nor")) return "Normal";
  if (name.includes("displacement") || name.includes("disp") || name.includes("height")) return "Displacement";
  if (name.includes("roughness") || name.includes("rough") || name.includes("rgh")) return "Roughness";
  if (name.includes("ao") || name.includes("ambientocclusion") || name.includes("occlusion")) return "AO";
  if (name.includes("specular") || name.includes("spec")) return "Specular";
  if (name.includes("metalness") || name.includes("metallic") || name.includes("metal")) return "Metalness";
  if (name.includes("opacity") || name.includes("alpha")) return "Opacity";
  if (name.includes("mask")) return "Mask";
  if (name.includes("fuzz")) return "Fuzz";
  return "";
}

function detectTextureAreaIndex(filename) {
  const lower = String(filename || "").toLowerCase();
  const udimMatch = lower.match(/(?:^|[_\-.])(1\d{3})(?=[_\-.]|$)/);
  if (!udimMatch) return 1;
  const udim = Number(udimMatch[1]);
  if (!Number.isFinite(udim) || udim < 1001) return 1;
  return udim - 1000;
}

function pickLargestFbx(fileRecords) {
  const fbxRecords = fileRecords.filter((item) => path.extname(item.name).toLowerCase() === ".fbx");
  if (fbxRecords.length === 0) return null;
  return [...fbxRecords].sort((a, b) => b.size - a.size)[0];
}

function pickSmallestJpg(fileRecords) {
  const jpgRecords = fileRecords.filter((item) => {
    const ext = path.extname(item.name).toLowerCase();
    return ext === ".jpg" || ext === ".jpeg";
  });
  if (jpgRecords.length === 0) return "";
  return [...jpgRecords].sort((a, b) => a.size - b.size)[0].name;
}

function ensureUniqueFolder(baseDir, preferredName) {
  let candidate = preferredName;
  let index = 1;
  while (fs.existsSync(path.join(baseDir, candidate))) {
    candidate = `${preferredName}_${index}`;
    index += 1;
  }
  return candidate;
}

function buildTextureEntries(textureRecords, normalMapFormat) {
  const grouped = new Map();
  for (const file of textureRecords) {
    const areaIndex = detectTextureAreaIndex(file.name);
    if (!grouped.has(areaIndex)) grouped.set(areaIndex, []);
    grouped.get(areaIndex).push(file);
  }

  const areaIds = [...grouped.keys()].sort((a, b) => a - b);
  const textureEntries = [];
  const textureSlots = {};
  const textureFiles = [];

  for (const areaIndex of areaIds) {
    const areaFiles = (grouped.get(areaIndex) || []).slice().sort((a, b) => {
      const aExt = path.extname(String(a?.name || "")).toLowerCase();
      const bExt = path.extname(String(b?.name || "")).toLowerCase();
      const score = (ext) => {
        if (ext === ".png") return 6;
        if (ext === ".jpg" || ext === ".jpeg") return 5;
        if (ext === ".tif" || ext === ".tiff") return 4;
        if (ext === ".bmp") return 3;
        if (ext === ".webp") return 2;
        if (ext === ".exr") return 1;
        return 0;
      };
      return score(bExt) - score(aExt);
    });
    const usedSlotInArea = new Set();
    const usedDisplacementFormatInArea = new Set();
    const unknown = [];
    for (const file of areaFiles) {
      const slot = identifyTextureSlot(file.name);
      if (!slot) {
        unknown.push(file);
        continue;
      }
      const slotKey = slot.toLowerCase();
      if (slot === "Displacement") {
        const ext = path.extname(String(file?.name || "")).toLowerCase();
        const displacementFormat = ext === ".exr" ? "exr" : "nonexr";
        if (usedDisplacementFormatInArea.has(displacementFormat)) {
          continue;
        }
        usedDisplacementFormatInArea.add(displacementFormat);
      } else if (usedSlotInArea.has(slotKey)) {
        continue;
      }
      usedSlotInArea.add(slotKey);
      textureEntries.push({
        textureType: slot,
        areaIndex,
        uri: file.name,
        sourcePath: file.fullPath,
        ...(slot === "Normal" ? { normalMapFormat } : {})
      });
      textureFiles.push(file);
      if (areaIndex === 1 && !textureSlots[slot]) {
        textureSlots[slot] = file.fullPath;
      }
    }
    if (!usedSlotInArea.has("albedo") && unknown.length > 0) {
      const fallback = unknown[0];
      textureEntries.push({ textureType: "Albedo", areaIndex, uri: fallback.name, sourcePath: fallback.fullPath });
      textureFiles.push(fallback);
      if (areaIndex === 1 && !textureSlots.Albedo) {
        textureSlots.Albedo = fallback.fullPath;
      }
    }
  }

  const uniqueTextureFiles = [];
  const seenTexturePath = new Set();
  for (const file of textureFiles) {
    const key = String(file?.fullPath || "").toLowerCase();
    if (!key || seenTexturePath.has(key)) continue;
    seenTexturePath.add(key);
    uniqueTextureFiles.push(file);
  }
  return { textureEntries, textureSlots, textureFiles: uniqueTextureFiles, areaIds: areaIds.length > 0 ? areaIds : [1] };
}

function parseArgs(argv) {
  const result = {};
  for (let i = 2; i < argv.length; i += 1) {
    const current = String(argv[i] || "");
    if (!current.startsWith("--")) continue;
    const key = current.slice(2);
    const value = i + 1 < argv.length ? String(argv[i + 1]) : "";
    if (value && !value.startsWith("--")) {
      result[key] = value;
      i += 1;
    } else {
      result[key] = "1";
    }
  }
  return result;
}

function parseBool(value) {
  const token = String(value || "").trim().toLowerCase();
  if (!token) return false;
  if (token === "0" || token === "false" || token === "no" || token === "off") return false;
  return true;
}

function collectFilesRecursive(rootDir) {
  const result = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else {
        const size = fs.statSync(fullPath).size;
        result.push({ name: entry.name, fullPath, size });
      }
    }
  }
  return result;
}

function collectJsonFilesRecursive(rootDir) {
  const resolvedRoot = path.resolve(rootDir);
  if (!fs.existsSync(resolvedRoot)) return [];
  const rootStat = fs.statSync(resolvedRoot);
  if (!rootStat.isDirectory()) return [];

  const files = [];
  const stack = [resolvedRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (path.extname(entry.name).toLowerCase() !== ".json") continue;
      files.push(fullPath);
    }
  }
  return files;
}

function buildExistingAssetKey(assetType, assetName) {
  const typeToken = String(assetType || "").trim().toLowerCase();
  const nameToken = String(assetName || "").trim();
  if (!typeToken || !nameToken) return "";
  const normalizedName = normalizeImportedAssetName(nameToken);
  const rawName = String(normalizedName || "").trim().toLowerCase();
  const sanitized = sanitizeToken(normalizedName);
  const keys = [];
  if (rawName) keys.push(`${typeToken}|${rawName}`);
  if (sanitized) keys.push(`${typeToken}|@${sanitized}`);
  return keys;
}

function collectExistingAssetKeys(libraryPath) {
  const skipNames = new Set([
    "hivecache.json",
    "hivedata.json",
    "index_cache.json",
    "arkhive_data.json",
    "favorites.json",
    "assetsdata.json"
  ]);
  const keys = new Set();
  const jsonFiles = collectJsonFilesRecursive(libraryPath);
  for (const jsonPath of jsonFiles) {
    if (skipNames.has(path.basename(jsonPath).toLowerCase())) continue;
    let parsed = null;
    try {
      const raw = fs.readFileSync(jsonPath, "utf-8");
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed !== "object") continue;
    if (String(parsed.source || "").trim().toLowerCase() !== "custom") continue;
    const assetType = String(parsed.assetType || parsed.asset_type || "").trim();
    const name = String(parsed.name || "").trim();
    const keyList = buildExistingAssetKey(assetType, name);
    for (const key of keyList) {
      if (key) keys.add(key);
    }
  }
  return keys;
}

function shouldSkipZipByNameBeforeExtract(zipName, options) {
  if (!options?.skipExisting || !(options?.existingAssetKeys instanceof Set)) {
    return false;
  }
  const assetName = normalizeImportedAssetName(zipName);
  const keyList = [...buildExistingAssetKey("3d", assetName), ...buildExistingAssetKey("surface", assetName)];
  for (const key of keyList) {
    if (key && options.existingAssetKeys.has(key)) return true;
  }
  return false;
}

function runWithConcurrency(items, limit, worker) {
  const tasks = Array.isArray(items) ? items : [];
  const safeLimit = Math.max(1, Number(limit) || 1);
  let index = 0;
  const runners = Array.from({ length: Math.min(safeLimit, tasks.length) }, async () => {
    while (index < tasks.length) {
      const currentIndex = index;
      index += 1;
      const item = tasks[currentIndex];
      await worker(item);
    }
  });
  return Promise.all(runners);
}

function resolve7zBinary(options) {
  const explicit = String(options?.sevenZipPath || options?.["7zPath"] || "").trim();
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      return resolved;
    }
  }
  const pathEnv = String(process.env.PATH || "").trim();
  if (pathEnv) {
    const parts = pathEnv.split(";").map((p) => p.trim()).filter(Boolean);
    for (const dir of parts) {
      const exe = path.join(dir, "7z.exe");
      try {
        if (fs.existsSync(exe) && fs.statSync(exe).isFile()) {
          return exe;
        }
      } catch {
        continue;
      }
    }
  }
  const candidates = [
    path.join(process.env["ProgramFiles"] || "C:\\Program Files", "7-Zip", "7z.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "7-Zip", "7z.exe")
  ];
  for (const candidate of candidates) {
    try {
      const resolved = path.resolve(candidate);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        return resolved;
      }
    } catch {
      continue;
    }
  }
  return "";
}

function extractZipToTemp(zipPath, options = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "assethive-batch-"));
  const extractor = String(options?.extractor || "auto").trim().toLowerCase();
  const shouldPrefer7z = extractor === "7z" || extractor === "auto";
  const shouldUsePowershell = extractor === "powershell";
  const sevenZipBinary = shouldPrefer7z ? resolve7zBinary(options) : "";

  if (shouldPrefer7z && sevenZipBinary) {
    return new Promise((resolve, reject) => {
      execFile(
        sevenZipBinary,
        ["x", "-y", `-o${tempDir}`, "-bso0", "-bsp0", zipPath],
        { windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
        (error) => {
          if (error) {
            if (extractor === "auto") {
              const escapedZipPath = zipPath.replace(/'/g, "''");
              const escapedTempDir = tempDir.replace(/'/g, "''");
              const command = `$ProgressPreference='SilentlyContinue'; Expand-Archive -Path '${escapedZipPath}' -DestinationPath '${escapedTempDir}' -Force`;
              execFile(
                "powershell.exe",
                ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
                { windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
                (fallbackError) => {
                  if (fallbackError) {
                    reject(error);
                    return;
                  }
                  resolve(tempDir);
                }
              );
              return;
            }
            reject(error);
            return;
          }
          resolve(tempDir);
        }
      );
    });
  }

  if (extractor === "7z" && !sevenZipBinary) {
    return Promise.reject(new Error("7z not found. Provide --7zPath or install 7-Zip."));
  }

  if (!shouldUsePowershell && extractor !== "auto") {
    return Promise.reject(new Error(`Unsupported extractor: ${extractor}`));
  }

  const escapedZipPath = zipPath.replace(/'/g, "''");
  const escapedTempDir = tempDir.replace(/'/g, "''");
  const command = `$ProgressPreference='SilentlyContinue'; Expand-Archive -Path '${escapedZipPath}' -DestinationPath '${escapedTempDir}' -Force`;
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
      { windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(tempDir);
      }
    );
  });
}

function copyWithUniqueName(srcPath, destinationDir) {
  const originalName = path.basename(srcPath);
  const ext = path.extname(originalName);
  const base = path.basename(originalName, ext);
  let finalName = originalName;
  let index = 1;
  while (fs.existsSync(path.join(destinationDir, finalName))) {
    finalName = `${base}_${index}${ext}`;
    index += 1;
  }
  fs.copyFileSync(srcPath, path.join(destinationDir, finalName));
  return finalName;
}

function makeUniquePreviewName(assetId) {
  return `${assetId}_preview.png`;
}

async function optimizePreviewImage(filePath, options = {}) {
  const target = String(filePath || "").trim();
  if (!target) return;
  const maxSize = Math.max(64, Math.min(4096, Number(options.previewMax) || 1024));
  const minSizeToProcessBytes = Math.max(0, Number(options.previewMinBytes) || 0);
  const stat = fs.existsSync(target) ? fs.statSync(target) : null;
  if (!stat?.isFile()) return;
  if (minSizeToProcessBytes > 0 && stat.size < minSizeToProcessBytes) {
    return;
  }
  const metadata = await sharp(target).metadata();
  const width = Number(metadata?.width || 0);
  const height = Number(metadata?.height || 0);
  if (!width || !height) return;
  const shouldResize = width > maxSize || height > maxSize;
  const tmpPath = `${target}.${Date.now()}.tmp`;
  let pipeline = sharp(target).rotate();
  if (shouldResize) {
    pipeline = pipeline.resize(maxSize, maxSize, { fit: "inside", withoutEnlargement: true });
  }
  await pipeline.png({ compressionLevel: 9, palette: true, effort: 7 }).toFile(tmpPath);
  const tmpStat = fs.existsSync(tmpPath) ? fs.statSync(tmpPath) : null;
  if (tmpStat?.isFile() && tmpStat.size > 0) {
    fs.copyFileSync(tmpPath, target);
  }
  try {
    fs.unlinkSync(tmpPath);
  } catch {
    void 0;
  }
}

async function keyPreviewImage(inputPath, outputPath, tolerance = 12) {
  const image = sharp(inputPath, { failOn: "none" });
  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const width = Number(info.width || 0);
  const height = Number(info.height || 0);
  if (width <= 0 || height <= 0) {
    throw new Error("invalid preview image size");
  }
  const channels = Number(info.channels || 4);
  const sampleY = Math.max(0, height - 1);
  const sampleX = 0;
  const sampleOffset = (sampleY * width + sampleX) * channels;
  const keyR = data[sampleOffset];
  const keyG = data[sampleOffset + 1];
  const keyB = data[sampleOffset + 2];
  for (let i = 0; i < data.length; i += channels) {
    const dr = Math.abs(data[i] - keyR);
    const dg = Math.abs(data[i + 1] - keyG);
    const db = Math.abs(data[i + 2] - keyB);
    if (dr <= tolerance && dg <= tolerance && db <= tolerance) {
      data[i + 3] = 0;
    }
  }
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * channels;
      const alpha = data[offset + 3];
      if (alpha > 0) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX >= minX && maxY >= minY) {
    const cropWidth = maxX - minX + 1;
    const cropHeight = maxY - minY + 1;
    await sharp(data, { raw: { width, height, channels } })
      .extract({ left: minX, top: minY, width: cropWidth, height: cropHeight })
      .png()
      .toFile(outputPath);
  } else {
    await sharp(data, { raw: { width, height, channels } }).png().toFile(outputPath);
  }
}

async function importFromFileRecords(fileRecords, sourceAssetName, options, stats) {
  const textureRecords = fileRecords.filter((item) => TEXTURE_EXTENSIONS.has(path.extname(item.name).toLowerCase()));
  const largestFbx = pickLargestFbx(fileRecords);
  const selectedModel = largestFbx;
  const modelSlots = {};
  const modelFiles = [];
  if (selectedModel) {
    modelSlots.Mesh = selectedModel.fullPath;
    modelFiles.push(selectedModel);
  }

  const normalMapFormat = normalizeNormalMapFormat(options.normalMapFormat);
  const textureData = buildTextureEntries(textureRecords, normalMapFormat);
  const textureEntries = textureData.textureEntries;
  const textureSlots = textureData.textureSlots;
  const textureFiles = textureData.textureFiles;
  const areaIds = textureData.areaIds;

  if (textureFiles.length > 0 || modelFiles.length > 0) {
    const assetName = normalizeImportedAssetName(sourceAssetName);
    const previewImage = pickSmallestJpg(textureRecords) || "";
    const hasModel = Boolean(selectedModel);
    const normalizedAssetType = hasModel ? "3d" : "surface";
    const existingKeyList = buildExistingAssetKey(normalizedAssetType, assetName);
    if (options?.skipExisting && options?.existingAssetKeys instanceof Set && existingKeyList.some((key) => options.existingAssetKeys.has(key))) {
      stats.skipped = Number(stats.skipped || 0) + 1;
      console.log(`[跳过] 已存在: ${assetName} (${normalizedAssetType})`);
      return;
    }
    const id = makeUniqueId();
    const libraryPath = path.resolve(options.libraryPath || DEFAULT_LIBRARY_PATH);
    const normalizedCategory = String(options.category || (hasModel ? "3dassets" : "custom")).trim() || (hasModel ? "3dassets" : "custom");
    const destinationRoot = path.join(libraryPath, normalizedAssetType);
    fs.mkdirSync(destinationRoot, { recursive: true });
    const folderBase = `${normalizedAssetType}_${sanitizeToken(assetName) || "asset"}_${id}`;
    const destinationDirName = ensureUniqueFolder(destinationRoot, folderBase);
    const destinationDir = path.join(destinationRoot, destinationDirName);
    fs.mkdirSync(destinationDir, { recursive: true });
    const previewDir = path.join(destinationDir, "Preview");
    fs.mkdirSync(previewDir, { recursive: true });

    const copiedModelBySourcePath = new Map();
    const copiedTextureBySourcePath = new Map();
    for (const modelRecord of modelFiles) {
      const modelSlot = "Mesh";
      const ext = path.extname(modelRecord.name).toLowerCase();
      const desiredName = `${makeCustomModelBaseName(modelSlot, assetName, id)}${ext}`;
      const finalModelName = fs.existsSync(path.join(destinationDir, desiredName))
        ? copyWithUniqueName(modelRecord.fullPath, destinationDir)
        : (fs.copyFileSync(modelRecord.fullPath, path.join(destinationDir, desiredName)), desiredName);
      copiedModelBySourcePath.set(modelRecord.fullPath, finalModelName);
    }
    for (const item of textureEntries) {
      const sourcePath = String(item.sourcePath || "").trim();
      if (!sourcePath || copiedTextureBySourcePath.has(sourcePath)) continue;
      const ext = path.extname(sourcePath).toLowerCase();
      const desiredName = `${makeCustomTextureBaseName(item.textureType, item.areaIndex, assetName, id)}${ext}`;
      const finalTextureName = fs.existsSync(path.join(destinationDir, desiredName))
        ? copyWithUniqueName(sourcePath, destinationDir)
        : (fs.copyFileSync(sourcePath, path.join(destinationDir, desiredName)), desiredName);
      copiedTextureBySourcePath.set(sourcePath, finalTextureName);
    }
    let copiedPreviewName = "";
    if (previewImage) {
      const previewRecord = textureRecords.find((item) => item.name === previewImage) || null;
      if (previewRecord) {
        const desiredPreviewName = makeUniquePreviewName(id);
        const previewOutputPath = path.join(previewDir, desiredPreviewName);
        await keyPreviewImage(previewRecord.fullPath, previewOutputPath, 12);
        if (options?.compressPreviews) {
          await optimizePreviewImage(previewOutputPath, options);
        }
        copiedPreviewName = desiredPreviewName;
      }
    }

    const normalMapFormats = Object.fromEntries(areaIds.map((areaIndex) => [areaIndex, normalMapFormat]));
    const rewrittenTextureEntries = textureEntries.map((item) => ({
      textureType: item.textureType,
      areaIndex: item.areaIndex,
      uri: copiedTextureBySourcePath.get(item.sourcePath) || item.uri,
      ...(String(item.textureType).toLowerCase() === "normal" ? { normalMapFormat } : {})
    }));
    const rewrittenTextureSlots = Object.fromEntries(
      Object.entries(textureSlots).map(([slot, sourcePath]) => {
        const nextName = copiedTextureBySourcePath.get(sourcePath) || path.basename(sourcePath);
        return [slot, normalizePath(path.join(destinationDir, nextName))];
      })
    );
    const rewrittenModelSlots = Object.fromEntries(
      Object.entries(modelSlots).map(([slot, sourcePath]) => {
        const nextName = copiedModelBySourcePath.get(sourcePath) || path.basename(sourcePath);
        return [slot, normalizePath(path.join(destinationDir, nextName))];
      })
    );
    const rewrittenModelFiles = modelFiles.map((item) => {
      const nextName = copiedModelBySourcePath.get(item.fullPath) || item.name;
      return normalizePath(path.join(destinationDir, nextName));
    });
    const rewrittenTextureFiles = textureFiles.map((item) => {
      const nextName = copiedTextureBySourcePath.get(item.fullPath) || item.name;
      return normalizePath(path.join(destinationDir, nextName));
    });
    const rewrittenPreview = copiedPreviewName ? `Preview/${copiedPreviewName}` : "";
    const components = [
      ...Object.entries(rewrittenModelSlots).map(([slot, uri]) => ({ type: "model", slot, uri: path.basename(uri) })),
      ...rewrittenTextureEntries.map((item) => ({
        type: "texture",
        slot: item.textureType,
        areaIndex: item.areaIndex,
        uri: item.uri,
        ...(String(item.textureType).toLowerCase() === "normal" ? { normalMapFormat } : {})
      }))
    ];
    const colorTags = options?.inferColorTags
      ? await withTimeout(inferColorTagsFromTextureFiles(rewrittenTextureFiles, { maxColorTags: options.maxColorTags, maxCandidateImages: options.maxCandidateImages, sampleSize: options.colorTagSampleSize }), Number(options.colorTagTimeoutMs) || 900, [])
      : [];
    const assetInfo = {
      assetID: id,
      name: assetName,
      assetType: normalizedAssetType,
      asset_type: normalizedAssetType,
      category: normalizedCategory,
      tags: options.tags || [],
      categories: [normalizedAssetType, String(normalizedCategory).toLowerCase()],
      normalMapFormat,
      normalMapFormats,
      modelSlots: rewrittenModelSlots,
      textureSlots: rewrittenTextureSlots,
      modelFiles: rewrittenModelFiles,
      textureFiles: rewrittenTextureFiles,
      textureEntries: rewrittenTextureEntries,
      components,
      previewImage: rewrittenPreview,
      detailImage: rewrittenPreview,
      previews: rewrittenPreview
        ? {
            images: [
              {
                contentLength: fs.statSync(path.join(destinationDir, rewrittenPreview.replace("/", path.sep))).size,
                resolution: "unknown",
                uri: rewrittenPreview,
                tags: ["preview"]
              }
            ],
            relativeSize: "2x1"
          }
        : { images: [], relativeSize: "2x1" },
      json: {
        contentLength: 0,
        uri: `${id}.json`
      },
      scanInformation: {
        dimensions: hasModel ? { x: 1, y: 1, z: 1 } : { x: 2, y: 0.02, z: 2 }
      },
      source: "custom",
      createdAt: new Date().toISOString(),
      slug: destinationDirName,
      semanticTags: {
        name: assetName,
        asset_type: normalizedAssetType,
        contains: [normalizedAssetType, String(normalizedCategory).toLowerCase(), ...(options.tags || [])],
        theme: [String(normalizedCategory)],
        descriptive: [],
        state: [],
        subject_matter: String(normalizedCategory),
        environment: []
      }
    };
    if (Array.isArray(colorTags) && colorTags.length > 0) {
      assetInfo.colorTags = colorTags;
      assetInfo.semanticTags.color = colorTags[0];
      assetInfo.semanticTags.colors = colorTags;
    }
    const jsonPath = path.join(destinationDir, `${id}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(assetInfo, null, 2), "utf-8");
    assetInfo.json.contentLength = fs.statSync(jsonPath).size;
    fs.writeFileSync(jsonPath, JSON.stringify(assetInfo, null, 2), "utf-8");
    stats.count += 1;
    if (options?.skipExisting && options?.existingAssetKeys instanceof Set) {
      for (const key of existingKeyList) {
        options.existingAssetKeys.add(key);
      }
    }
    console.log(`[生成成功] ${jsonPath}`);
  }
}

async function processDirectory(dirPath, options, stats) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const zipFiles = [];
  const localFiles = [];
  const subdirs = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      subdirs.push(fullPath);
      continue;
    }
    if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".zip") {
      zipFiles.push({ name: entry.name, fullPath });
      continue;
    }
    if (entry.isFile()) {
      localFiles.push({ name: entry.name, fullPath, size: fs.statSync(fullPath).size });
    }
  }

  if (zipFiles.length > 0) {
    const jobs = Math.max(1, Number(options?.jobs) || 2);
    await runWithConcurrency(zipFiles, jobs, async (zip) => {
      const sourceAssetName = path.basename(zip.name, ".zip");
      if (shouldSkipZipByNameBeforeExtract(sourceAssetName, options)) {
        stats.skipped = Number(stats.skipped || 0) + 1;
        console.log(`[跳过] 已存在(未解压): ${normalizeImportedAssetName(sourceAssetName)}`);
        if (typeof options?.onTaskDone === "function") options.onTaskDone();
        return;
      }
      let tempDir = "";
      try {
        tempDir = await extractZipToTemp(zip.fullPath, options);
        const extractedFiles = collectFilesRecursive(tempDir);
        await importFromFileRecords(extractedFiles, sourceAssetName, options, stats);
      } catch (error) {
        console.error(`[错误] 解压失败: ${zip.fullPath} -> ${error?.message || error}`);
      } finally {
        if (tempDir && fs.existsSync(tempDir)) {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
        if (typeof options?.onTaskDone === "function") options.onTaskDone();
      }
    });
  } else {
    await importFromFileRecords(localFiles, path.basename(dirPath), options, stats);
    if (typeof options?.onTaskDone === "function") options.onTaskDone();
  }

  for (const subdir of subdirs) {
    await processDirectory(subdir, options, stats);
  }
}

async function processZipFile(zipPath, options, stats) {
  const sourceAssetName = path.basename(zipPath, ".zip");
  if (shouldSkipZipByNameBeforeExtract(sourceAssetName, options)) {
    stats.skipped = Number(stats.skipped || 0) + 1;
    console.log(`[跳过] 已存在(未解压): ${normalizeImportedAssetName(sourceAssetName)}`);
    if (typeof options?.onTaskDone === "function") options.onTaskDone();
    return;
  }
  let tempDir = "";
  try {
    tempDir = await extractZipToTemp(zipPath, options);
    const extractedFiles = collectFilesRecursive(tempDir);
    await importFromFileRecords(extractedFiles, sourceAssetName, options, stats);
  } catch (error) {
    console.error(`[错误] 解压失败: ${zipPath} -> ${error?.message || error}`);
  } finally {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    if (typeof options?.onTaskDone === "function") options.onTaskDone();
  }
}

function countImportTasksForDirectory(dirPath) {
  let total = 0;
  const stack = [path.resolve(dirPath)];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    const zipCount = entries.filter((e) => e.isFile() && path.extname(e.name).toLowerCase() === ".zip").length;
    if (zipCount > 0) {
      total += zipCount;
    } else {
      const hasImportable = entries.some((e) => {
        if (!e.isFile()) return false;
        const ext = path.extname(e.name).toLowerCase();
        return TEXTURE_EXTENSIONS.has(ext) || MODEL_EXTENSIONS.has(ext);
      });
      if (hasImportable) {
        total += 1;
      }
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        stack.push(path.join(current, e.name));
      }
    }
  }
  return total;
}

function renderOverallProgress(done, total, label) {
  const safeTotal = Math.max(1, Number(total) || 1);
  const safeDone = Math.max(0, Math.min(safeTotal, Number(done) || 0));
  const percent = Math.round((safeDone / safeTotal) * 100);
  const message = String(label || "").trim();
  const line = `[导入进度] ${safeDone}/${safeTotal} (${percent}%)${message ? ` ${message}` : ""}`;
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  process.stdout.write(line);
}

function question(text) {
  return new Promise((resolve) => rl.question(text, resolve));
}

async function chooseByNumber(title, options, fallback) {
  const lines = options.map((item, index) => `  ${index + 1}. ${item}`).join("\n");
  const answer = String(await question(`${title}\n${lines}\n请输入序号或名称(默认 ${fallback}): `)).trim().toLowerCase();
  if (!answer) return fallback;
  if (/^\d+$/.test(answer)) {
    const index = Number(answer) - 1;
    if (index >= 0 && index < options.length) return options[index];
  }
  const byName = options.find((item) => item.toLowerCase() === answer);
  return byName || fallback;
}

async function start() {
  const args = parseArgs(process.argv);
  if (parseBool(args.help) || parseBool(args.h)) {
    const scriptPath = path.basename(process.argv[1] || "batch_import_assets.js");
    process.stdout.write(
      [
        "",
        `用法: node ${scriptPath} --path <源目录或zip> [options]`,
        "",
        "常用参数:",
        "  --path <path>                 要导入的目录或 .zip 文件",
        "  --library <path>              目标库路径(默认读取 AssetHive 设置里的 customLibraryPath)",
        "  --category <name>             写入到 json 的 category 字段(例如 nature/custom)",
        "  --tags <a,b,c>                统一 tags(逗号分隔)",
        "  --normal <dx|opengl>          Normal 格式(默认 opengl)",
        "  --jobs <n>                    并发解压/导入 zip 的数量(默认 2)",
        "  --extractor <auto|7z|powershell> 解压器(默认 auto，优先 7z)",
        "  --7zPath <path>               7z.exe 路径(可选，不填则尝试自动发现)",
        "  --compressPreviews <0|1>      生成 Preview 后进行压缩/缩放(默认 1)",
        "  --previewMax <n>              Preview 最大边长(默认 1024)",
        "  --inferColorTags <0|1>        推断颜色标签(默认 1，基于 Albedo)",
        "  --colorTagTimeoutMs <n>       颜色推断超时(默认 900ms)",
        "  --resume                      断点续导：跳过已存在(按 资产类型+资产名 判定)",
        "",
        "示例:",
        "  scripts\\batch_import_assets.bat --path \"C:\\Assets\\Source\" --library \"D:\\AssetHiveLibrary\" --category nature --tags \"PBR Max,Moss,Ground\" --normal opengl --jobs 4 --extractor 7z --resume",
        ""
      ].join("\n")
    );
    rl.close();
    return;
  }
  let targetDir = String(args.path || "").trim().replace(/^"|"$/g, "");
  let assetType = String(args.assetType || "").trim();
  let category = String(args.category || "").trim();
  let libraryPath = String(args.library || args.customLibraryPath || resolveAssetHiveCustomLibraryPathFromSettings() || DEFAULT_LIBRARY_PATH).trim();
  let tags = String(args.tags || "").split(",").map((item) => item.trim()).filter(Boolean);
  let normalMapFormat = normalizeNormalMapFormat(args.normal || args.normalMapFormat || "opengl");
  const skipExisting = parseBool(args.resume) || parseBool(args.skipExisting);
  const jobs = Math.max(1, Math.min(16, Number(args.jobs || args.concurrency || 2) || 2));
  const extractor = String(args.extractor || "auto").trim();
  const sevenZipPath = String(args["7zPath"] || args.sevenZipPath || "").trim();
  const compressPreviews = args.compressPreviews === undefined ? true : parseBool(args.compressPreviews);
  const previewMax = Math.max(128, Math.min(4096, Number(args.previewMax || 1024) || 1024));
  const previewMinBytes = Math.max(0, Number(args.previewMinBytes || 0) || 0);
  const inferColorTags = args.inferColorTags === undefined ? true : parseBool(args.inferColorTags);
  const colorTagTimeoutMs = Math.max(120, Math.min(10000, Number(args.colorTagTimeoutMs || 900) || 900));
  const maxColorTags = Math.max(1, Math.min(6, Number(args.maxColorTags || 4) || 4));
  const maxCandidateImages = Math.max(1, Math.min(6, Number(args.maxCandidateImages || 2) || 2));
  const colorTagSampleSize = Math.max(16, Math.min(128, Number(args.colorTagSampleSize || 48) || 48));

  if (!targetDir) targetDir = String(await question("请输入要扫描的根目录路径: ")).trim().replace(/^"|"$/g, "");
  if (!assetType) assetType = await chooseByNumber("请选择资产分类", ASSET_TYPE_OPTIONS, "surface");
  if (!category) category = await chooseByNumber("请选择子分类/主题", CATEGORY_OPTIONS, "custom");
  if (!libraryPath) libraryPath = String(await question("请输入目标库路径(可留空读取 AssetHive 设置): ")).trim().replace(/^"|"$/g, "");
  if (!libraryPath) libraryPath = resolveAssetHiveCustomLibraryPathFromSettings();
  if (tags.length === 0) {
    tags = String(await question("请输入统一 Tag (逗号分隔，可空): ")).split(",").map((item) => item.trim()).filter(Boolean);
  }
  if (!args.normal && !args.normalMapFormat) {
    normalMapFormat = normalizeNormalMapFormat(await question("Normal 类型 (dx/opengl，默认 opengl): "));
  }

  if (!targetDir || !fs.existsSync(targetDir)) {
    console.error(`[错误] 路径不存在: ${targetDir}`);
    rl.close();
    return;
  }
  if (!libraryPath) {
    console.error("[错误] 未找到目标库路径，请在软件设置中配置 customLibraryPath，或通过 --library 指定。");
    rl.close();
    return;
  }
  if (!fs.existsSync(libraryPath)) {
    fs.mkdirSync(libraryPath, { recursive: true });
  }

  const stats = { count: 0, skipped: 0 };
  console.log("\n开始扫描并生成 asset_info.json...\n");
  try {
    const existingAssetKeys = skipExisting ? collectExistingAssetKeys(libraryPath) : new Set();
    const targetStat = fs.statSync(targetDir);
    const totalTasks = targetStat.isDirectory() ? countImportTasksForDirectory(targetDir) : 1;
    let doneTasks = 0;
    const onTaskDone = () => {
      doneTasks += 1;
      renderOverallProgress(doneTasks, totalTasks);
      if (doneTasks >= totalTasks) {
        process.stdout.write("\n");
      }
    };
    renderOverallProgress(0, totalTasks);
    if (targetStat.isFile() && path.extname(targetDir).toLowerCase() === ".zip") {
      await processZipFile(targetDir, { assetType, category, tags, normalMapFormat, libraryPath, skipExisting, existingAssetKeys, jobs, extractor, sevenZipPath, compressPreviews, previewMax, previewMinBytes, inferColorTags, colorTagTimeoutMs, maxColorTags, maxCandidateImages, colorTagSampleSize, onTaskDone }, stats);
    } else {
      await processDirectory(targetDir, { assetType, category, tags, normalMapFormat, libraryPath, skipExisting, existingAssetKeys, jobs, extractor, sevenZipPath, compressPreviews, previewMax, previewMinBytes, inferColorTags, colorTagTimeoutMs, maxColorTags, maxCandidateImages, colorTagSampleSize, onTaskDone }, stats);
    }
    const suffix = skipExisting ? `，跳过 ${stats.skipped || 0} 个已存在资产` : "";
    console.log(`\n[完成] 共导入 ${stats.count} 个资产到 ${path.resolve(libraryPath)}${suffix}`);
  } catch (error) {
    console.error("[错误] 处理失败:", error?.message || error);
  }
  rl.close();
}

start();
