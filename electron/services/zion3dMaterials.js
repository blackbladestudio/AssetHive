const fs = require("node:fs");
const crypto = require("node:crypto");
const { normalizeTextureType } = require("./textureTypes");

// Only syntax is removed. Kit/Props, numbers, and artist variant suffixes
// remain part of the identity; Wood_01 must never match Wood_02 or Wood_01A.
function materialStem(value) {
  return String(value || "").trim().replace(/^(?:MI|M|T)_/i, "")
    .replace(/_(?:1|2|4|8|16)K$/i, "");
}

function materialKey(value) {
  return materialStem(value).toLowerCase();
}

function normalizeMaterialNames(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  for (const [area, name] of Object.entries(value)) {
    if (typeof name === "string" && !name.trim()) continue;
    if (!/^[1-9]\d*$/.test(area) || Number(area) > 9999 || typeof name !== "string"
      || !/^[\p{L}\p{N}_]+$/u.test(name.trim()) || !materialStem(name) || name.trim().length > 128) {
      throw new Error(`材质名称无效（贴图组 ${area}）：${String(name)}`);
    }
  }
  return Object.fromEntries(Object.entries(value).filter(([area, name]) =>
    /^[1-9]\d*$/.test(area) && Number(area) <= 9999 && typeof name === "string"
    && /^[\p{L}\p{N}_]+$/u.test(name.trim()) && name.trim().length <= 128
  ).map(([area, name]) => [area, name.trim()]));
}

function textureMaterial(file) {
  const base = String(file || "").split(/[\\/]/).pop().replace(/\.[^.]+$/, "")
    .replace(/_(?:1|2|4|8|16)K$/i, "");
  if (/(?:^|_)(?:thumb|thumbnail|preview|render)(?:_|$)/i.test(base)) return null;
  const tokens = base.split("_");
  for (let count = Math.min(4, tokens.length - 1); count >= 1; count--) {
    const textureType = normalizeTextureType(tokens.slice(-count).join("_"));
    if (!textureType) continue;
    const name = materialStem(tokens.slice(0, -count).join("_"));
    if (!name || !/^[\p{L}\p{N}_]+$/u.test(name)) return null;
    return { name, key: materialKey(name), textureType };
  }
  return null;
}

function namedTextureMetadata(files) {
  const entries = files.flatMap((filePath) => {
    if (!/\.(?:png|jpe?g|tga|tiff?|bmp|webp|exr)$/i.test(filePath)) return [];
    const parsed = textureMaterial(filePath);
    return parsed ? [{ ...parsed, filePath }] : [];
  });
  const names = new Map(entries.map((entry) => [entry.key, entry.name]));
  const keys = [...names.keys()].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const areas = new Map(keys.map((key, index) => [key, index + 1]));
  return {
    materialNames: Object.fromEntries(keys.map((key) => [areas.get(key), names.get(key)])),
    textureSlots: entries.map(({ filePath, textureType, key }) => ({ filePath, textureType, areaId: areas.get(key) }))
  };
}

// Wind JSON 的材质引用优先于文件名推断，避免把导出器添加的 _Mat 后缀当成另一种材质。
function namedPlantTextureMetadata(files, wind) {
  const materials = (wind?.materials || []).filter((material) => Array.isArray(material.textureFiles) && material.textureFiles.length);
  if (!materials.length) return namedTextureMetadata(files.filter((file) => /^T_Env_/i.test(String(file).split(/[\\/]/).pop())));
  const names = new Map();
  const slots = [];
  for (const material of materials) {
    const key = materialKey(material.name);
    if (names.has(key)) throw new Error(`Wind JSON 存在重名材质：${material.name}`);
    const entries = [];
    for (const reference of material.textureFiles) {
      const normalized = reference.replaceAll("\\", "/").toLowerCase();
      const candidates = [...new Set(files)].filter((file) => {
        const full = String(file).replaceAll("\\", "/").toLowerCase();
        return full === normalized || full.endsWith("/" + normalized);
      });
      if (candidates.length > 1) throw new Error(`材质 ${material.name} 的纹理引用不唯一：${reference}`);
      const parsed = candidates.length === 1 ? textureMaterial(candidates[0]) : null;
      if (parsed) entries.push({ filePath: candidates[0], textureType: parsed.textureType,
        ...(material.materialRole ? { materialRole: material.materialRole } : {}) });
    }
    if (entries.length) {
      names.set(key, material.name);
      slots.push(...entries.map((entry) => ({ ...entry, key })));
    }
  }
  const keys = [...names.keys()].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  return {
    materialNames: Object.fromEntries(keys.map((key, index) => [index + 1, names.get(key)])),
    textureSlots: slots.map(({ key, ...entry }) => ({ ...entry, areaId: keys.indexOf(key) + 1 }))
  };
}

function materialScope(asset) {
  const tags = (asset.standardAssetTags || []).map((tag) => String(tag).trim().toLowerCase().replace(/[\s_-]+/g, "")
    .replace(/^kit$/, "kits").replace(/^prop$/, "props").replace(/^microfoliage$/, "micro"));
  const categoryTags = [...new Set(tags.filter((tag) => /^(?:props|kits|destructible|dressing|mega|tree|bush|grass|micro|herofoliage)$/.test(tag)))].sort();
  const folder = (value) => String(value || "").trim().replaceAll("\\", "/").toLowerCase();
  return JSON.stringify([asset.assetType || "3d", folder(asset.exportRootPath), folder(asset.zionSubfolder), categoryTags,
    asset.assetType === "3dplant" && !categoryTags.some((tag) => /^(?:tree|bush|grass|micro|herofoliage)$/.test(tag))
      ? folder(asset.plantCategory) : "",
    [...tags, ...(asset.tags || [])].some((tag) => /^temp$/i.test(String(tag).trim()))]);
}

// Store each set once in the Job. Models without their own texture copy can
// still bind it, even if they occur before the asset supplying the textures.
function namedMaterialCatalog(assets) {
  const scopes = new Map();
  for (const asset of assets) {
    if (asset.materialMatching !== "name") continue;
    asset.materialScope = crypto.createHash("sha256").update(materialScope(asset)).digest("hex");
    if (!scopes.has(asset.materialScope)) scopes.set(asset.materialScope, new Map());
    const groups = scopes.get(asset.materialScope);
    for (const group of asset.materialGroups) {
      const key = materialKey(group.materialName);
      if (!groups.has(key)) groups.set(key, group);
    }
  }
  const groups = [];
  const failures = new Map();
  for (const [scope, entries] of scopes) {
    [...entries].sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true })).forEach(([, group], index) => {
      const groupId = index + 1;
      groups.push({ ...group, scope, groupId,
        textureSlots: group.textureSlots.map((slot) => ({ ...slot, groupId })) });
    });
  }
  for (const asset of assets) {
    if (asset.materialMatching === "name" && asset.assetType === "3dplant" && Array.isArray(asset.modelLods)) {
      const ids = new Map(groups.filter((group) => group.scope === asset.materialScope)
        .map((group) => [materialKey(group.materialName), group.groupId]));
      asset.modelLods = asset.modelLods.map((lod) => {
        let name = lod.materialName || asset.materialGroups.find((group) => group.groupId === lod.materialGroupId)?.materialName;
        if (!name && lod.materialRole === "billboard") {
          const billboards = groups.filter((group) => group.scope === asset.materialScope && group.materialRole === "billboard");
          if (billboards.length === 1) name = billboards[0].materialName;
          else failures.set(String(asset.id), "Billboard LOD 在当前批次没有唯一的命名纹理组");
        }
        return name && ids.has(materialKey(name)) ? { ...lod, materialName: name, materialGroupId: ids.get(materialKey(name)) } : lod;
      });
    }
    if (asset.materialMatching === "name" && !scopes.get(asset.materialScope)?.size) {
      // 老植被可只含模型和风数据；没有任何命名套组时保留原有父材质默认纹理路径。
      if (asset.assetType === "3dplant" && !asset.materialGroups.length && asset.materialMatchingOptional === true) {
        delete asset.materialMatching;
        delete asset.materialScope;
        continue;
      }
      failures.set(String(asset.id), "当前批次没有可对应的命名纹理套组，请补齐材质名称与纹理");
    }
  }
  return { groups, failures };
}

// Called after processing all assets, before dispatch. A batch name is reusable
// only if the actual exported texture bytes, normal convention, and parent
// family agree. Renamed library copies of the same texture still reuse one MI.
async function prepareNamedMaterialBatch(assets) {
  const byName = new Map();
  const hashes = new Map();
  const failures = new Map();
  const fileHash = (file) => {
    if (!hashes.has(file)) hashes.set(file, new Promise((resolve, reject) => {
      const hash = crypto.createHash("sha256");
      const stream = fs.createReadStream(file);
      stream.on("data", (bytes) => hash.update(bytes));
      stream.on("error", reject);
      stream.on("end", () => resolve(hash.digest("hex")));
    }));
    return hashes.get(file);
  };
  for (const asset of assets) {
    if (asset.materialMatching !== "name") continue;
    for (const group of asset.materialGroups) {
      const name = materialKey(group.materialName);
      const scope = materialScope(asset);
      const identity = `${scope}|${name}`;
      try {
        const textures = await Promise.all(group.textureSlots.map(async (slot) =>
          [slot.slot.toLowerCase(), slot.normalMapFormat || "dx", slot.resolution || "", await fileHash(slot.file)]));
        textures.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        const signature = [group.materialRole || "", textures];
        if (group.opacityInDiffuseAlpha) signature.push("diffuseAlpha");
        group.textureSignature = crypto.createHash("sha256").update(JSON.stringify(signature)).digest("hex");
        const existing = byName.get(identity);
        if (existing && (existing.conflicted || existing.signature !== group.textureSignature)) {
          const message = `同名材质 ${group.materialName} 对应不同纹理套组，未合并导出`;
          existing.conflicted = true;
          for (const id of [...existing.assetIds, asset.id]) failures.set(String(id), message);
          existing.assetIds.add(asset.id);
        } else if (existing) {
          existing.assetIds.add(asset.id);
        } else {
          byName.set(identity, { signature: group.textureSignature, assetIds: new Set([asset.id]) });
        }
      } catch (error) {
        failures.set(String(asset.id), `材质 ${group.materialName} 的纹理不可读取：${error.message}`);
      }
    }
  }
  return failures;
}

module.exports = { materialStem, materialKey, normalizeMaterialNames, textureMaterial, namedTextureMetadata, namedPlantTextureMetadata,
  namedMaterialCatalog, prepareNamedMaterialBatch };
