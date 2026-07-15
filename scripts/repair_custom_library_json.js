const fs = require("node:fs");
const path = require("node:path");

const MODEL_EXTENSIONS = new Set([".fbx", ".obj", ".abc", ".gltf", ".glb", ".ztl"]);
const TEXTURE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".tif", ".tiff", ".exr", ".tga", ".webp", ".bmp"]);

function normalizeTextureType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "";
  if (["albedo", "diffuse", "basecolor", "base_color"].includes(normalized)) return "Albedo";
  if (["normal", "normalbump", "normal_gl", "nrm", "nor"].includes(normalized)) return "Normal";
  if (["roughness", "gloss"].includes(normalized)) return "Roughness";
  if (["ao", "ambientocclusion", "ambient_occlusion", "cavity"].includes(normalized)) return "AO";
  if (["displacement", "height", "bump"].includes(normalized)) return "Displacement";
  if (["opacity", "alpha"].includes(normalized)) return "Opacity";
  if (["metalness", "metallic"].includes(normalized)) return "Metalness";
  if (["fuzz"].includes(normalized)) return "Fuzz";
  if (["ordp", "orm"].includes(normalized)) return "ORDP";
  return "";
}

function inferTextureTypeByFileName(filePath) {
  const base = path.basename(String(filePath || ""), path.extname(String(filePath || ""))).toLowerCase();
  if (!base) return "";
  if (/(^|[_\-.])(albedo|basecolor|base_color|diffuse|d)($|[_\-.])/.test(base)) return "Albedo";
  if (/(^|[_\-.])(normal|nrm|nor|n)($|[_\-.])/.test(base)) return "Normal";
  if (/(^|[_\-.])(roughness|rough|r)($|[_\-.])/.test(base)) return "Roughness";
  if (/(^|[_\-.])ao($|[_\-.])|ambientocclusion|ambient_occlusion/.test(base)) return "AO";
  if (/(^|[_\-.])(displacement|height|disp|h)($|[_\-.])/.test(base)) return "Displacement";
  if (/(^|[_\-.])(opacity|alpha|o)($|[_\-.])|transparency/.test(base)) return "Opacity";
  if (/(^|[_\-.])(metal|metalness|metallic|m)($|[_\-.])/.test(base)) return "Metalness";
  if (/(^|[_\-.])fuzz($|[_\-.])/.test(base)) return "Fuzz";
  if (/(^|[_\-.])(ordp|orm)($|[_\-.])/.test(base)) return "ORDP";
  return "";
}

function normalizeNormalMapFormat(value, fallback = "dx") {
  const nextFallback = String(fallback || "dx").trim().toLowerCase() === "opengl" ? "opengl" : "dx";
  return String(value || "").trim().toLowerCase() === "opengl" ? "opengl" : nextFallback;
}

function inferNormalMapFormatByName(fileName, fallback = "dx") {
  const normalized = String(fileName || "").toLowerCase();
  if (normalized.includes("opengl") || normalized.includes("_ogl") || normalized.includes("normalgl")) return "opengl";
  if (normalized.includes("directx") || normalized.includes("_dx") || normalized.includes("normaldx")) return "dx";
  return normalizeNormalMapFormat("", fallback);
}

function resolveLocalPath(rootDir, rawPath) {
  const raw = String(rawPath || "").trim();
  if (!raw) return "";
  const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(rootDir, raw);
  return absolute;
}

function listAssetJsonFiles(rootDir) {
  const result = [];
  const typeDirs = fs.existsSync(rootDir) ? fs.readdirSync(rootDir, { withFileTypes: true }) : [];
  for (const typeEntry of typeDirs) {
    if (!typeEntry.isDirectory()) continue;
    const typeDir = path.join(rootDir, typeEntry.name);
    const assetEntries = fs.readdirSync(typeDir, { withFileTypes: true });
    for (const assetEntry of assetEntries) {
      if (!assetEntry.isDirectory()) continue;
      const assetDir = path.join(typeDir, assetEntry.name);
      const jsonCandidates = fs.readdirSync(assetDir).filter((name) => name.toLowerCase().endsWith(".json") && name.toLowerCase() !== "asset_info.json");
      if (jsonCandidates.length === 0) continue;
      jsonCandidates.sort((a, b) => a.length - b.length);
      result.push(path.join(assetDir, jsonCandidates[0]));
    }
  }
  return result;
}

function repairOne(jsonPath) {
  const raw = fs.readFileSync(jsonPath, "utf8");
  const meta = JSON.parse(raw);
  if (!meta || typeof meta !== "object") {
    return { changed: false, reason: "invalid-object" };
  }
  const assetDir = path.dirname(jsonPath);
  const diskFiles = fs.readdirSync(assetDir);
  const diskModelPaths = diskFiles
    .filter((name) => MODEL_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .map((name) => path.resolve(assetDir, name));
  const diskTexturePaths = diskFiles
    .filter((name) => TEXTURE_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .map((name) => path.resolve(assetDir, name));
  const diskModelSet = new Set(diskModelPaths.map((p) => p.toLowerCase()));
  const diskTextureSet = new Set(diskTexturePaths.map((p) => p.toLowerCase()));

  const modelPathSet = new Set();
  const addModelRef = (value) => {
    const resolved = resolveLocalPath(assetDir, value);
    if (!resolved) return;
    if (!diskModelSet.has(resolved.toLowerCase())) return;
    modelPathSet.add(resolved);
  };
  if (meta.modelSlots && typeof meta.modelSlots === "object" && !Array.isArray(meta.modelSlots)) {
    for (const value of Object.values(meta.modelSlots)) addModelRef(value);
  }
  if (Array.isArray(meta.modelFiles)) {
    for (const value of meta.modelFiles) addModelRef(value);
  }
  if (Array.isArray(meta.components)) {
    for (const item of meta.components) {
      if (!item || String(item.type || "").toLowerCase() !== "model") continue;
      addModelRef(item.uri || item.path);
    }
  }
  if (modelPathSet.size === 0) {
    for (const modelPath of diskModelPaths) modelPathSet.add(modelPath);
  }
  const sortedModelPaths = [...modelPathSet].sort();

  const textureEntriesMap = new Map();
  const normalMapFormats = {};
  const fallbackNormal = normalizeNormalMapFormat(meta.normalMapFormat, "dx");
  const persistedNormalMapFormats = meta.normalMapFormats && typeof meta.normalMapFormats === "object" ? meta.normalMapFormats : {};
  const addTextureRef = (textureTypeRaw, value, areaRaw, normalMapFormatRaw) => {
    const resolved = resolveLocalPath(assetDir, value);
    if (!resolved) return;
    if (!diskTextureSet.has(resolved.toLowerCase())) return;
    const textureType = normalizeTextureType(textureTypeRaw) || normalizeTextureType(inferTextureTypeByFileName(resolved));
    if (!textureType) return;
    const areaId = Math.max(1, Number(areaRaw) || 1);
    const key = `${areaId}:${textureType.toLowerCase()}`;
    if (!textureEntriesMap.has(key)) {
      textureEntriesMap.set(key, { textureType, areaIndex: areaId, uri: path.basename(resolved) });
    }
    if (textureType === "Normal") {
      const currentFormat = normalMapFormats[areaId] || persistedNormalMapFormats[areaId] || persistedNormalMapFormats[String(areaId)] || fallbackNormal;
      normalMapFormats[areaId] = normalizeNormalMapFormat(normalMapFormatRaw || inferNormalMapFormatByName(path.basename(resolved), currentFormat), currentFormat);
    }
  };

  if (Array.isArray(meta.textureEntries)) {
    for (const item of meta.textureEntries) {
      if (!item || typeof item !== "object") continue;
      addTextureRef(item.textureType || item.slot, item.uri || item.path, item.areaIndex, item.normalMapFormat);
    }
  }
  if (Array.isArray(meta.components)) {
    for (const item of meta.components) {
      if (!item || String(item.type || "").toLowerCase() !== "texture") continue;
      addTextureRef(item.textureType || item.slot, item.uri || item.path, item.areaIndex, item.normalMapFormat);
    }
  }
  if (meta.textureSlots && typeof meta.textureSlots === "object" && !Array.isArray(meta.textureSlots)) {
    for (const [slot, value] of Object.entries(meta.textureSlots)) {
      addTextureRef(slot, value, 1, "");
    }
  }
  if (Array.isArray(meta.textureFiles)) {
    for (const value of meta.textureFiles) {
      addTextureRef("", value, 1, "");
    }
  }

  if (textureEntriesMap.size === 0) {
    for (const texturePath of diskTexturePaths) {
      addTextureRef("", texturePath, 1, "");
    }
  }

  const textureEntries = [...textureEntriesMap.values()].sort((a, b) => {
    if (a.areaIndex !== b.areaIndex) return a.areaIndex - b.areaIndex;
    return String(a.textureType || "").localeCompare(String(b.textureType || ""));
  });
  const areaIds = [...new Set(textureEntries.map((entry) => Math.max(1, Number(entry.areaIndex) || 1)))];
  if (areaIds.length === 0) areaIds.push(1);
  const normalizedNormalMapFormats = {};
  for (const areaId of areaIds) {
    const current = normalMapFormats[areaId] || persistedNormalMapFormats[areaId] || persistedNormalMapFormats[String(areaId)] || fallbackNormal;
    normalizedNormalMapFormats[areaId] = normalizeNormalMapFormat(current, fallbackNormal);
  }
  if (!normalizedNormalMapFormats[1]) {
    normalizedNormalMapFormats[1] = fallbackNormal;
  }

  const baseComponents = Array.isArray(meta.components)
    ? meta.components.filter((item) => item && String(item.type || "").toLowerCase() !== "model" && String(item.type || "").toLowerCase() !== "texture")
    : [];
  const modelComponents = sortedModelPaths.map((modelPath, index) => {
    const slot = index === 0 ? "Mesh" : `Mesh${String(index + 1).padStart(2, "0")}`;
    return { type: "model", slot, modelType: slot, uri: path.basename(modelPath), path: path.basename(modelPath) };
  });
  const textureComponents = textureEntries.map((entry) => {
    const areaId = Math.max(1, Number(entry.areaIndex) || 1);
    const item = {
      type: "texture",
      slot: entry.textureType,
      textureType: entry.textureType,
      areaIndex: areaId,
      uri: entry.uri,
      path: entry.uri
    };
    if (String(entry.textureType || "").toLowerCase() === "normal") {
      item.normalMapFormat = normalizedNormalMapFormats[areaId] || fallbackNormal;
    }
    return item;
  });

  meta.modelFiles = sortedModelPaths.map((p) => path.basename(p));
  meta.modelSlots = Object.fromEntries(sortedModelPaths.map((p, index) => [index === 0 ? "Mesh" : `Mesh${String(index + 1).padStart(2, "0")}`, path.basename(p)]));
  meta.textureFiles = textureEntries.map((entry) => entry.uri);
  meta.textureSlots = Object.fromEntries(
    textureEntries
      .filter((entry) => Math.max(1, Number(entry.areaIndex) || 1) === 1)
      .map((entry) => [entry.textureType, entry.uri])
  );
  meta.textureEntries = textureEntries.map((entry) => {
    const areaId = Math.max(1, Number(entry.areaIndex) || 1);
    const item = {
      textureType: entry.textureType,
      areaIndex: areaId,
      uri: entry.uri
    };
    if (String(entry.textureType || "").toLowerCase() === "normal") {
      item.normalMapFormat = normalizedNormalMapFormats[areaId] || fallbackNormal;
    }
    return item;
  });
  meta.normalMapFormat = normalizedNormalMapFormats[1] || fallbackNormal;
  meta.normalMapFormats = normalizedNormalMapFormats;
  meta.components = [...baseComponents, ...modelComponents, ...textureComponents];
  meta.assetID = String(meta.assetID || meta.id || "").trim() || path.basename(jsonPath, ".json");
  if ("id" in meta) delete meta.id;
  if ("uniqueId" in meta) delete meta.uniqueId;
  if (!meta.json || typeof meta.json !== "object") meta.json = {};
  meta.json.uri = path.basename(jsonPath);
  const next = JSON.stringify(meta, null, 2);
  if (next === raw) {
    return { changed: false, reason: "unchanged" };
  }
  fs.writeFileSync(jsonPath, next, "utf8");
  return { changed: true, reason: "rewritten", size: next.length };
}

function main() {
  const root = path.resolve(process.argv[2] || "F:/ArkLibrayData");
  const files = listAssetJsonFiles(root);
  let changed = 0;
  let failed = 0;
  let unchanged = 0;
  for (const file of files) {
    try {
      const result = repairOne(file);
      if (result.changed) {
        changed += 1;
        process.stdout.write(`UPDATED ${file}\n`);
      } else {
        unchanged += 1;
      }
    } catch (error) {
      failed += 1;
      process.stdout.write(`FAILED ${file} ${String(error.message || error)}\n`);
    }
  }
  process.stdout.write(`DONE total=${files.length} changed=${changed} unchanged=${unchanged} failed=${failed}\n`);
}

main();
