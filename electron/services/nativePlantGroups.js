const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { detectNativePlantWind } = require("./nativePlantWind");
const { resolveGroupingRoot } = require("./dropAssetGroups");
const { parseModelVariantKey, stripModelVariantKey, compareModelVariantKeys, modelVariantNumberFromKey } = require("./modelVariants");
const { buildModelLodPlan } = require("./modelLods");
const { namedPlantTextureMetadata, materialKey } = require("./zion3dMaterials");

const decoderNames = ["uv3 remap bounds mode", "xmin", "xmax", "ymin", "ymax", "wmin", "wmax"];
const stable = (value) => Array.isArray(value) ? value.map(stable)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
const within = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

function commonDirectory(files) {
  let root = files.length ? path.dirname(files[0]) : "";
  for (const file of files) while (root && path.dirname(root) !== root && !within(root, file)) root = path.dirname(root);
  return root;
}

// 合并后只有一份默认风参数，因此必须证明每个材质实际使用的 UV3 解码一致。
function decoderKey(profile, material) {
  let declared = typeof profile.useRemappedUV3 === "boolean";
  let remapped = profile.useRemappedUV3 === true;
  const disabled = declared && !remapped;
  const scalars = {};
  for (const source of [profile, material]) {
    const seen = new Set();
    for (const [name, value] of Object.entries(source?.scalarParameters || {})) {
      const key = name.toLowerCase();
      if (!decoderNames.includes(key)) continue;
      if (seen.has(key)) return null;
      seen.add(key);
      scalars[key] = Math.fround(value);
    }
    const value = source?.staticSwitchParameters?.["Use Remapped UV3"];
    if (typeof value === "boolean") {
      declared = true;
      if (!disabled) remapped = value;
    }
  }
  if (!declared || !remapped) return "plain";
  if (!decoderNames.every((name) => Number.isFinite(scalars[name])) || ![1, 2].includes(scalars["uv3 remap bounds mode"])) return null;
  return JSON.stringify(stable([scalars, profile.uv3Encoding || null]));
}

function variantCandidate(asset, metadataGroups) {
  if (!asset.metadata?.nativePlantWind || asset.metadata.nativePlantWindWarnings?.length) return null;
  const models = asset.files.filter((file) => /\.(?:fbx|st9|obj|abc|gltf|glb)$/i.test(file));
  if (!models.length || models.some((file) => !/\.fbx$/i.test(file))) return null;
  if (metadataGroups.some((group) => asset.files.some((file) => within(group.root, file)))) return null;
  const root = resolveGroupingRoot(models[0]);
  if (models.some((file) => resolveGroupingRoot(file).toLowerCase() !== root.toLowerCase())) return null;
  const folder = path.basename(root);
  const variantKey = parseModelVariantKey(folder + ".fbx");
  const family = stripModelVariantKey(folder + ".fbx");
  const parent = path.dirname(root);
  if (!variantKey || family.toLowerCase() !== path.basename(parent).toLowerCase()) return null;
  const plan = buildModelLodPlan(models);
  if (plan.primaryFiles.length !== 1 || plan.primaryFiles.some((file) =>
    stripModelVariantKey(file.replace(/[_-]lod\d+(?=\.fbx$)/i, "")).toLowerCase() !== family.toLowerCase()
      || parseModelVariantKey(file.replace(/[_-]lod\d+(?=\.fbx$)/i, "")) !== variantKey)) return null;
  return { asset, models, plan, root, parent, variantKey };
}

// 普通目录边界先保留；有明确的同系列名称、Wind 引用及内容证明后才合并草稿。
async function mergeVariants(assets, metadataGroups, shouldAbort) {
  const families = new Map();
  for (const asset of assets) {
    const candidate = variantCandidate(asset, metadataGroups);
    if (!candidate) continue;
    const key = candidate.parent.toLowerCase();
    if (!families.has(key)) families.set(key, []);
    families.get(key).push(candidate);
  }
  const hashes = new Map();
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
  const replacements = new Map();
  const removed = new Set();
  for (const entries of families.values()) {
    if (shouldAbort()) return [];
    if (entries.length < 2 || new Set(entries.map((entry) => entry.variantKey)).size !== entries.length
      || new Set(entries.map((entry) => entry.asset.sourceArchivePath || "")).size !== 1) continue;
    entries.sort((a, b) => compareModelVariantKeys(a.variantKey, b.variantKey));
    try {
      let baseline = "";
      for (const entry of entries) {
        const profile = entry.asset.metadata.nativePlantWind;
        entry.named = namedPlantTextureMetadata(entry.asset.files, profile);
        const names = Object.values(entry.named.materialNames).map(materialKey).sort();
        if (!names.length) throw new Error("缺少明确的材质纹理引用");
        const materials = profile.materials || [];
        if (materials.length && (materials.length !== names.length || new Set(materials.map((item) => materialKey(item.name))).size !== names.length
          || materials.some((item) => !names.includes(materialKey(item.name))))) throw new Error("材质不能一一对应");
        const decoding = names.map((name) => decoderKey(profile, materials.find((item) => materialKey(item.name) === name)));
        if (decoding.includes(null)) throw new Error("UV3 解码不完整");
        const textures = await Promise.all(entry.named.textureSlots.map(async (slot) =>
          [materialKey(entry.named.materialNames[slot.areaId]), slot.textureType, slot.materialRole || "atlas", await fileHash(slot.filePath)]));
        textures.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        const signature = JSON.stringify([names, decoding, textures]);
        if (baseline && signature !== baseline) throw new Error("材质纹理或 UV3 解码不一致");
        baseline = signature;
      }
      const first = entries[0];
      const modelFiles = entries.flatMap((entry) => entry.plan.primaryFiles);
      const modelVariants = entries.map((entry) => {
        const number = modelVariantNumberFromKey(entry.variantKey);
        return { file: entry.plan.primaryFiles[0], variantKey: entry.variantKey,
          ...(number > 0 ? { variantNumber: number } : {}) };
      });
      const allModels = entries.flatMap((entry) => entry.models);
      const files = [...new Set([...allModels, ...first.asset.files.filter((file) => !first.models.includes(file))])];
      const merged = { ...first.asset, files, folderName: path.basename(first.parent), preferredName: path.basename(first.parent),
        metadata: { ...first.asset.metadata, ...first.named, modelFiles, modelVariants,
          modelLods: entries.flatMap((entry) => entry.plan.modelLods) } };
      replacements.set(first.asset, merged);
      for (const entry of entries.slice(1)) removed.add(entry.asset);
    } catch {
      // 无法证明兼容时保持原草稿边界，不能用第一份 JSON 覆盖其他模型的解码值。
    }
  }
  return assets.filter((asset) => !removed.has(asset)).map((asset) => replacements.get(asset) || asset);
}

// 拖入解析的原生风阶段：先逐模型目录匹配 sidecar，再合并已证明兼容的变体。
async function resolveNativePlantGroups(assets, { jsonFiles = [], metadataGroups = [], shouldAbort = () => false } = {}) {
  for (const asset of assets) {
    if (shouldAbort()) return [];
    const root = commonDirectory(asset.files);
    const wind = await detectNativePlantWind({ files: [...asset.files, ...jsonFiles.filter((file) => root && within(root, file))],
      modelFiles: asset.files.filter((file) => /\.(fbx|st9)$/i.test(file)) });
    if (wind.profile || wind.warnings.length) {
      asset.metadata = { ...asset.metadata, nativePlantWind: wind.profile, nativePlantWindWarnings: wind.warnings };
      if (wind.profile && !Object.keys(asset.metadata.materialNames || {}).length) {
        try {
          const named = namedPlantTextureMetadata(asset.files, wind.profile);
          if (Object.keys(named.materialNames).length) Object.assign(asset.metadata, named);
        } catch (error) {
          asset.metadata.nativePlantWindWarnings = [...wind.warnings, error.message];
        }
      }
    }
  }
  return mergeVariants(assets, metadataGroups, shouldAbort);
}

module.exports = { resolveNativePlantGroups };
