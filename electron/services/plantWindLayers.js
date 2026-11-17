const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { PLANT_WIND_FORMS, fitsMicroSizeCm } = require("./plantWindPreset");
const { createHash, randomUUID } = require("node:crypto");

async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function assetSizeSummary(manifest) {
  const declared = manifest.assetSizeSummary;
  if (declared && typeof declared.fitsMicroSize === "boolean" &&
      Number.isInteger(declared.variantCount) && declared.variantCount >= Object.keys(manifest.variants).length) return declared;
  const sizes = Object.values(manifest.variants).map(({ frame }) =>
    frame?.up === "Z" && frame.units === "cm" ? fitsMicroSizeCm(frame.sizeCm) : undefined);
  const fitsMicroSize = sizes.includes(false) ? false : sizes.length && sizes.every(v => v === true) ? true : undefined;
  return { fitsMicroSize, variantCount: sizes.length };
}

// The original LOD0 supplies the card hierarchy for both the atlas and its
// outline cut. Export only a small reference per variant in the UE job.
async function inspectPlantLayerSource(asset, meta, models, modelLods = []) {
  const roots = new Set([asset.path, asset.metaPath && path.dirname(asset.metaPath)]);
  for (const { file } of models) {
    const folder = path.dirname(file);
    roots.add(folder);
    roots.add(path.dirname(folder));
  }
  const ids = [meta?.sourceIdentity?.sourceAssetId, meta?.identity?.sourceAssetId, asset?.sourceIdentity?.sourceAssetId,
    asset?.identity?.sourceAssetId, meta?.id, asset.id].filter(Boolean).map(id => String(id).toLowerCase());
  let file;
  for (const root of roots) {
    if (!root) continue;
    const candidate = path.join(root, "_layer.json");
    try {
      await fs.promises.access(candidate);
      file = candidate;
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (!file) {
    // A managed ThirdParty copy has its own directory and FBX names. Locate the
    // matching original Bridge sidecar through the detector's per-user index.
    const indexFile = path.join(process.env.LOCALAPPDATA || os.homedir(), "AssetHive", "plant-wind-layers", "index.json");
    try {
      const index = JSON.parse(await fs.promises.readFile(indexFile, "utf8"));
      file = ids.map(id => index.assets?.[id]).find(Boolean);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (!file) return null;
  const manifest = JSON.parse((await fs.promises.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
  if (manifest.schemaVersion !== 1 || !ids.includes(String(manifest.assetId).toLowerCase())) {
    throw new Error(`植被层级文件版本或资产 ID 不匹配：${file}`);
  }
  if (manifest.lodWindMode != null && manifest.lodWindMode !== "lod0-uv0-surface") {
    throw new Error(`不支持的植被 LOD 风动复用模式：${manifest.lodWindMode}`);
  }
  const sourceByVariant = {};
  let hasSecondary = false, hasTerminal = false, hasCantileverWeights = false;
  const root = path.dirname(file);
  const hashes = new Map();
  for (const model of models) {
    const variantName = `Var${model.variantNumber || 1}`;
    const entry = manifest.variants?.[variantName];
    if (!entry) throw new Error(`植被层级缺少 ${variantName}：${file}`);
    for (const axis of entry.primaryAxes || []) {
      if (Object.hasOwn(axis, "weightProfile") && !["smoothstep", "cantilever"].includes(axis.weightProfile)) {
        throw new Error(`不支持的一级枝权重曲线：${file} ${variantName}`);
      }
      hasCantileverWeights ||= axis.weightProfile === "cantilever";
    }
    if (!entry.source || !/^[a-f0-9]{64}$/i.test(entry.sha256 || "")) {
      throw new Error(`植被层级缺少原始 FBX 指纹：${file} ${variantName}`);
    }
    const original = path.resolve(root, entry.source);
    const relative = path.relative(root, original);
    if (relative.startsWith(".." + path.sep) || path.isAbsolute(relative) || !/\.fbx$/i.test(original)) {
      throw new Error(`植被层级 FBX 路径无效：${entry.source}`);
    }
    if (!hashes.has(original)) hashes.set(original, await digest(original));
    if (hashes.get(original) !== entry.sha256.toLowerCase()) {
      throw new Error(`原始网格已变化，请重新检测层级：${original}`);
    }
    sourceByVariant[model.variantKey] = { name: variantName, original };
    if (manifest.lodWindMode === "lod0-uv0-surface") {
      const lods = {};
      for (const lod of modelLods.filter(item => item.variantKey === model.variantKey && item.lod > 0)) {
        const declared = Object.entries(entry.lodSources || {});
        const named = path.parse(lod.file).name.match(/(?:^|[_ .-])lod[_ .-]*(\d+)(?:$|[_ .-])/i);
        const sourceLevel = named ? Number(named[1]) : lod.lod;
        let found = declared.find(([, value]) => path.resolve(root, value.source).toLowerCase() === path.resolve(lod.file).toLowerCase())
          || declared.find(([key]) => key === `LOD${sourceLevel}`);
        if (!hashes.has(lod.file)) hashes.set(lod.file, await digest(lod.file));
        const actual = hashes.get(lod.file);
        if (!found || found[1].sha256 !== actual) {
          const matching = declared.filter(([, value]) => value.sha256 === actual);
          found = matching.length === 1 ? matching[0] : null;
        }
        if (!found || found[1].windSource !== "LOD0") {
          throw new Error(`植被层级缺少匹配的低 LOD 来源：${variantName} ${lod.file}`);
        }
        const [name, record] = found;
        const source = path.resolve(root, record.source);
        const relativeLod = path.relative(root, source);
        if (relativeLod === ".." || relativeLod.startsWith(".." + path.sep) || path.isAbsolute(relativeLod) ||
            !/^LOD[1-9]\d*$/.test(name) || !/\.fbx$/i.test(source) || !/^[a-f0-9]{64}$/.test(record.sha256)) {
          throw new Error(`植被低 LOD 来源无效：${record.source}`);
        }
        if (!hashes.has(source)) hashes.set(source, await digest(source));
        if (hashes.get(source) !== record.sha256) throw new Error(`低 LOD 网格已变化，请重新检测层级：${source}`);
        if (lods[lod.lod]) throw new Error(`植被层级重复 LOD：${variantName} ${lod.lod}`);
        if (record.representation === "billboard" &&
            (!Array.isArray(record.layers) || record.layers.length !== 1 || record.layers[0] !== "Shared")) {
          throw new Error(`Billboard 层级必须仅保留 Shared：${source}`);
        }
        lods[lod.lod] = { file: lod.file, sha256: actual, sourceLod: Number(name.slice(3)), windSource: variantName,
          ...(record.representation === "billboard" ? { representation: "billboard", layers: ["Shared"] } : {}) };
      }
      if (Object.keys(lods).length) sourceByVariant[model.variantKey].lods = lods;
    }
  }
  // Subset re-exports may update the very same MI as other variants.
  for (const entry of Object.values(manifest.variants || {})) {
    if (entry.bindingChunks) {
      hasSecondary ||= entry.hasSecondary === true;
      hasTerminal ||= entry.hasTerminal === true;
    }
    for (const binding of entry.bindings || []) {
      if (binding.influence === false || binding.review === true) continue;
      if (binding.secondary != null && binding.secondary !== -1) hasSecondary = true;
      if (binding.terminal === true) hasTerminal = true;
      if (hasSecondary && hasTerminal) break;
    }
    if (hasSecondary && hasTerminal) break;
  }
  const layers = { file, sourceByVariant, hasSecondary, hasTerminal };
  if (hasCantileverWeights) layers.hasCantileverWeights = true;
  const { fitsMicroSize, variantCount } = assetSizeSummary(manifest);
  if (manifest.form === "" || PLANT_WIND_FORMS.includes(manifest.form)) layers.form = manifest.form;
  return { layers, fitsMicroSize, variantCount };
}

async function resolvePlantLayerSource(asset, meta, models, modelLods = []) {
  return (await inspectPlantLayerSource(asset, meta, models, modelLods))?.layers ?? null;
}

// Managed assets have a new ID and renamed FBXs. Keep the Bridge ID inside the
// sidecar and publish the manifest after every referenced immutable chunk exists.
async function importPlantLayers(sourceId, models, destination, modelLods = []) {
  if (!sourceId || !models.length || models.some(model => !/\.fbx$/i.test(model.source))) return;
  const roots = new Set(models.flatMap(model => {
    const directory = path.dirname(model.source);
    return [directory, path.dirname(directory)];
  }));
  for (const root of roots) {
    let manifest;
    try {
      manifest = JSON.parse((await fs.promises.readFile(path.join(root, "_layer.json"), "utf8")).replace(/^\uFEFF/, ""));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (String(manifest.assetId).toLowerCase() !== String(sourceId).toLowerCase()) continue;
    if (manifest.schemaVersion !== 1) throw new Error("Unsupported plant layer schema");
    const variants = {};
    for (const model of models) {
      const name = `Var${model.variantNumber || 1}`;
      const entry = manifest.variants?.[name];
      if (!entry || variants[name] || typeof entry.source !== "string" ||
          path.resolve(root, entry.source).toLowerCase() !== path.resolve(model.source).toLowerCase() ||
          await digest(model.path) !== entry.sha256) throw new Error(`Plant layer source mismatch: ${sourceId} ${name}`);
      for (const [index, file] of (entry.bindingChunks || []).entries()) {
        const match = /^(Var\d+)_(\d{4})_([a-f0-9]{64})\.json$/.exec(file);
        if (!match || match[1] !== name || Number(match[2]) !== index) throw new Error(`Invalid plant layer chunk: ${name}`);
        const bytes = await fs.promises.readFile(path.join(root, "_layer_data", file));
        if (createHash("sha256").update(bytes).digest("hex") !== match[3]) throw new Error(`Plant layer chunk fingerprint mismatch: ${file}`);
        await fs.promises.mkdir(path.join(destination, "_layer_data"), { recursive: true });
        const target = path.join(destination, "_layer_data", file);
        const temp = target + "." + randomUUID() + ".tmp";
        try {
          await fs.promises.writeFile(temp, bytes);
          await fs.promises.rename(temp, target);
        } finally { await fs.promises.rm(temp, { force: true }); }
      }
      variants[name] = { ...entry, source: path.basename(model.path) };
      if (manifest.lodWindMode === "lod0-uv0-surface") {
        const records = {};
        for (const lod of modelLods.filter(item => item.variantKey === model.variantKey && item.lod > 0)) {
          const found = Object.entries(entry.lodSources || {}).find(([, record]) =>
            path.resolve(root, record.source).toLowerCase() === path.resolve(lod.source).toLowerCase());
          if (!found || found[1].windSource !== "LOD0" || await digest(lod.path) !== found[1].sha256) {
            throw new Error(`Plant LOD layer source mismatch: ${sourceId} ${name} LOD${lod.lod}`);
          }
          records[found[0]] = { ...found[1], source: path.basename(lod.path) };
        }
        variants[name].lodSources = records;
      }
    }
    const target = path.join(destination, "_layer.json");
    const temp = target + "." + randomUUID() + ".tmp";
    try {
      await fs.promises.writeFile(temp, JSON.stringify({ ...manifest, assetSizeSummary: assetSizeSummary(manifest), variants }));
      await fs.promises.rename(temp, target);
    } finally { await fs.promises.rm(temp, { force: true }); }
    return;
  }
}

module.exports = { resolvePlantLayerSource, inspectPlantLayerSource, importPlantLayers };
