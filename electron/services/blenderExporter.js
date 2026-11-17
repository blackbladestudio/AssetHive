const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { detectTextureTypeFromFileName, normalizeTextureType } = require("./textureTypes");
const { sendToBlender } = require("./blenderIntegration");

const MODEL_EXTENSIONS = new Set([".fbx", ".obj", ".gltf", ".glb", ".abc"]);
const PIXELS = { "1k": 1024, "2k": 2048, "4k": 4096, "8k": 8192 };
const MODEL_TEXTURE_SLOTS = new Map([["albedo", "Basecolor"], ["roughness", "Roughness"], ["normal", "Normal"]]);

function normalizeBlenderDecimationRatio(value) {
  const ratio = Number(value);
  return [1, 0.75, 0.5, 0.25, 0.1].includes(ratio) ? ratio : 1;
}

function normalizeBlenderPath(file, basePath) {
  const resolved = path.isAbsolute(file) ? file : path.resolve(basePath, file);
  // Blender treats a leading // as blend-relative, even when it names a Windows share.
  return path.normalize(resolved);
}

async function resizeTexture(file, pixels) {
  if (!/\.(png|jpe?g|webp|tiff?)$/i.test(file)) return file;
  const sharp = require("sharp");
  const info = await sharp(file).metadata();
  if (Math.max(info.width || 0, info.height || 0) <= pixels) return file;
  const stat = await fs.stat(file);
  const hash = crypto.createHash("sha256").update(`${file}|${stat.size}|${stat.mtimeMs}|${pixels}`).digest("hex");
  const directory = path.join(os.tmpdir(), "assethive", "blender-textures");
  await fs.mkdir(directory, { recursive: true });
  const target = path.join(directory, `${hash}.png`);
  try { await fs.access(target); } catch {
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    try {
      await sharp(file).resize({ width: pixels, height: pixels, fit: "inside", withoutEnlargement: true }).png().toFile(temporary);
      await fs.rename(temporary, target);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  return target;
}

async function buildBlenderAsset(asset, options = {}) {
  if (asset.exportUnavailable) throw new Error(asset.exportError || "资产不存在或无法读取");
  const meta = asset.metaPath ? JSON.parse(await fs.readFile(asset.metaPath, "utf8")) : asset.meta || {};
  const assetType = String(asset.assetType || "").toLowerCase();
  if (!["3d", "3dasset", "3dplant", "surface", "decal"].includes(assetType)) throw new Error(`Blender 暂不支持资产类型：${assetType}`);
  const { buildExportModelPlan, collectTextureGroupsForExport } = require("./unrealExporter");
  const resolveFile = value => normalizeBlenderPath(value, asset.path);
  const basicModelMaterial = assetType === "3d" || assetType === "3dasset";
  let models = [];
  if (["3d", "3dasset", "3dplant"].includes(assetType)) {
    models = buildExportModelPlan(asset, meta, "lod").modelVariants.map(item => ({ ...item, file: resolveFile(item.file) }));
  }
  const unsupported = models.filter(item => !MODEL_EXTENSIONS.has(path.extname(item.file).toLowerCase()));
  if (unsupported.length) throw new Error(`Blender 不支持此模型格式：${path.extname(unsupported[0].file)}；请使用 FBX / OBJ / glTF / Alembic`);
  if (["3d", "3dasset", "3dplant"].includes(assetType) && !models.length) throw new Error("缺少可供 Blender 导入的模型");
  for (const item of models) await fs.access(item.file);
  const pixels = PIXELS[options.exportResolution] || 4096;
  const entries = [...(Array.isArray(meta.textureEntries) ? meta.textureEntries : []),
    ...(Array.isArray(meta.components) ? meta.components.filter(item => item.type === "texture") : [])];
  const materials = [];
  for (const group of collectTextureGroupsForExport(asset, assetType, meta, pixels)) {
    const textures = [];
    const seen = new Set();
    for (const [slot, source] of group.bySlot) {
      if (basicModelMaterial && !MODEL_TEXTURE_SLOTS.has(slot)) continue;
      if (seen.has(source)) continue;
      seen.add(source);
      const nativeSource = resolveFile(source);
      await fs.access(nativeSource);
      const entry = entries.find(item => path.basename(item.file || item.uri || item.path || "").toLowerCase() === path.basename(source).toLowerCase());
      const textureType = basicModelMaterial ? MODEL_TEXTURE_SLOTS.get(slot)
        : normalizeTextureType(entry?.textureType || entry?.slot || entry?.name) || detectTextureTypeFromFileName(source);
      textures.push({ slot, textureType, file: resolveFile(await resizeTexture(nativeSource, pixels)) });
    }
    materials.push({ groupId: group.groupId, areaIndex: group.areaIndex, materialRole: group.materialRole,
      normalMapFormat: group.normalMapFormat, textures });
  }
  if (!models.length && !materials.some(group => group.textures.length)) throw new Error("没有可供 Blender 导入的贴图");
  return { id: asset.id, name: asset.name, assetType, models, materials,
    decimationRatio: basicModelMaterial ? normalizeBlenderDecimationRatio(options.blenderDecimationRatio) : 1,
    baseTiling: Number(meta.baseTiling || asset.baseTiling) || 1 };
}

async function exportToBlender(assets, options, onProgress, transport = sendToBlender) {
  const results = [];
  const prepared = [];
  for (const [i, asset] of assets.entries()) {
    onProgress?.({ percent: Math.round(i / assets.length * 35), message: `准备 Blender 资产 ${i + 1}/${assets.length}` });
    try {
      prepared.push(await buildBlenderAsset(asset, options));
      results.push({ assetId: asset.id, name: asset.name, status: "pending", message: "" });
    } catch (error) { results.push({ assetId: asset.id, name: asset.name, status: "failed", message: error.message }); }
  }
  if (prepared.length) {
    try {
      const receipt = await transport(options.blenderExecutablePath, { assets: prepared }, progress => onProgress?.({ ...progress, percent: 35 + Math.round(Number(progress.percent || 0) * 0.65) }));
      const byId = new Map((receipt.results || []).map(item => [item.assetId, item]));
      for (const item of results.filter(item => item.status === "pending")) {
        const received = byId.get(item.assetId);
        item.status = ["success", "failed"].includes(received?.status) ? received.status : "unconfirmed";
        item.message = received?.message || "Blender 导入结果未确认，请先检查场景";
      }
    } catch (error) {
      for (const item of results.filter(item => item.status === "pending")) {
        item.status = error.accepted ? "unconfirmed" : "failed";
        item.message = error.message;
      }
    }
  }
  const exportedAssetIds = results.filter(item => item.status === "success").map(item => item.assetId);
  const ok = exportedAssetIds.length > 0;
  const partial = ok && exportedAssetIds.length < results.length;
  onProgress?.({ percent: 100, message: ok ? "Blender 导入完成" : "Blender 导入失败" });
  return { ok, partial, results, exportedAssetIds,
    message: partial ? "部分资产未导出到 Blender" : ok ? "Blender 导入完成" : results.map(item => `${item.name}：${item.message}`).join("；") || "未选择资产" };
}

module.exports = { normalizeBlenderPath, normalizeBlenderDecimationRatio, buildBlenderAsset, exportToBlender };
