"use strict";

// 资产库内「重新 Opaque 裁切」：把导入侧的 _OPAQUE 裁切管线复用到已入库的植被资产上。
// 导入侧（main.js → buildFoliageOpaqueVariants）只在导入时执行一次；本模块负责：
//   1. 从元数据还原模型 / 贴图条目，按导入同一套优先级挑选透贴；
//   2. 备份并移除旧的 _OPAQUE 裁切文件，重新裁切不会叠加出 _OPAQUE2 / _OPAQUE3；
//   3. 用与导入侧相同的命名（SM_<名称>_<资产ID>_<变体>_OPAQUE.fbx）重新生成；
//   4. 回写 modelVariants / components / modelFiles / modelSlots，其余元数据保持不动。
// 失败安全策略：全部失败 → 恢复旧文件并原样返回元数据；部分失败 → 未重新生成的变体恢复旧文件与旧记录。

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { parseModelVariantKey, normalizeModelVariantKey, modelVariantNumberFromKey } = require("./modelVariants");
const { resolveFoliageMaskSource, describeFoliageMaskSource } = require("./foliageOpaque");
const { buildFoliageOpaqueVariants } = require("./foliageOpaqueVariants");

const OPAQUE_SUFFIX_RE = /OPAQUE$/i;

function normalizePathToken(value) {
  return String(value || "").replace(/\\/g, "/");
}

function basenameOf(value) {
  const raw = String(value || "").replace(/\\/g, "/");
  return raw.slice(raw.lastIndexOf("/") + 1);
}

function fileStemOf(value) {
  const base = basenameOf(value);
  const extension = path.extname(base);
  return extension ? base.slice(0, -extension.length) : base;
}

function resolveAssetPath(assetDir, value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const normalized = raw.replace(/\\/g, path.sep).replace(/\//g, path.sep);
  return path.resolve(path.isAbsolute(normalized) ? normalized : path.join(String(assetDir || ""), normalized));
}

function isPathInside(rootPath, candidatePath) {
  const normalize = (value) => String(value || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const root = normalize(rootPath);
  const candidate = normalize(candidatePath);
  if (!root || !candidate) return false;
  return candidate === root || candidate.startsWith(root + "/");
}

// 与 opaqueFilenameMigration 保持一致：词干以 OPAQUE 结尾、且能解析出以 OPAQUE 结尾的变体键。
// SM_x_01_OPAQUE.fbx / SM_x_01OPAQUE.fbx / SM_x_A_OPAQUE.fbx 都识别为裁切文件。
function isOpaqueModelFile(value) {
  const base = basenameOf(value);
  if (!/\.fbx$/i.test(base)) return false;
  if (!OPAQUE_SUFFIX_RE.test(fileStemOf(base))) return false;
  return OPAQUE_SUFFIX_RE.test(String(parseModelVariantKey(base) || ""));
}

function isOpaqueModelRecord(record) {
  const file = record?.file || record?.uri || record?.path || "";
  if (file && isOpaqueModelFile(file)) return true;
  return OPAQUE_SUFFIX_RE.test(String(record?.variantKey || ""));
}

function variantMetadataFields(value) {
  const variantKey = normalizeModelVariantKey(value, "01");
  const variantNumber = modelVariantNumberFromKey(variantKey);
  return { variantKey, ...(variantNumber > 0 ? { variantNumber } : {}) };
}

// 还原模型条目：优先 components（带 variantKey），再用 modelSlots 补齐缺槽。
function collectModelSlotEntries(meta, assetDir) {
  const entries = new Map();
  const variantKeyByBase = new Map();
  for (const record of Array.isArray(meta?.modelVariants) ? meta.modelVariants : []) {
    const base = basenameOf(record?.file || record?.uri || record?.path || "");
    if (base) variantKeyByBase.set(base.toLowerCase(), String(record?.variantKey || "").trim());
  }
  const pushEntry = (slot, filePath, variantKey) => {
    const slotName = String(slot || "").trim();
    if (!slotName || entries.has(slotName.toLowerCase())) return;
    const resolved = resolveAssetPath(assetDir, filePath);
    if (!resolved) return;
    const base = basenameOf(resolved);
    const key = normalizeModelVariantKey(
      variantKey || variantKeyByBase.get(base.toLowerCase()) || parseModelVariantKey(base),
      "01"
    );
    entries.set(slotName.toLowerCase(), { suffix: slotName, path: resolved, variantKey: key });
  };
  for (const record of Array.isArray(meta?.components) ? meta.components : []) {
    if (String(record?.type || "").trim().toLowerCase() !== "model") continue;
    pushEntry(record.slot, record.uri || record.file, record.variantKey);
  }
  const slotMap = meta?.modelSlots && typeof meta.modelSlots === "object" && !Array.isArray(meta.modelSlots)
    ? meta.modelSlots
    : {};
  for (const [slot, filePath] of Object.entries(slotMap)) {
    pushEntry(slot, filePath, "");
  }
  return [...entries.values()];
}

// 还原贴图条目：textureEntries 是入库时的规范列表，缺失时回退 components / textureSlots。
function collectTextureSlotEntries(meta, assetDir) {
  const entries = [];
  const pushEntry = (textureType, filePath, areaIndex, materialRole) => {
    const resolved = resolveAssetPath(assetDir, filePath);
    if (!resolved) return;
    entries.push({
      textureType: String(textureType || "").trim(),
      path: resolved,
      areaIndex: Math.max(1, Math.floor(Number(areaIndex) || 1)),
      ...(materialRole ? { materialRole: String(materialRole) } : {})
    });
  };
  for (const record of Array.isArray(meta?.textureEntries) ? meta.textureEntries : []) {
    pushEntry(record?.textureType || record?.slot, record?.uri || record?.file || record?.path, record?.areaIndex ?? record?.areaId, record?.materialRole);
  }
  if (entries.length === 0) {
    for (const record of Array.isArray(meta?.components) ? meta.components : []) {
      if (String(record?.type || "").trim().toLowerCase() !== "texture") continue;
      pushEntry(record.slot, record.uri, record.areaIndex, record.materialRole);
    }
  }
  if (entries.length === 0) {
    const slotMap = meta?.textureSlots && typeof meta.textureSlots === "object" && !Array.isArray(meta.textureSlots)
      ? meta.textureSlots
      : {};
    for (const [slot, filePath] of Object.entries(slotMap)) {
      pushEntry(slot, filePath, 1, "");
    }
  }
  return entries;
}

// 旧的 LOD 裁切文件（modelLods 里的 *OPAQUE 记录）不再被重新生成：
// opaque 导出不带 LOD，这些文件在重新裁切时一并清理，避免残留无人引用的孤儿文件。
function collectOpaqueLodEntries(meta, assetDir) {
  const entries = [];
  const seen = new Set();
  for (const record of Array.isArray(meta?.modelLods) ? meta.modelLods : []) {
    const file = record?.file || record?.uri || record?.path || "";
    if (!file) continue;
    const resolved = resolveAssetPath(assetDir, file);
    if (!resolved || seen.has(resolved) || !fs.existsSync(resolved)) continue;
    // 以元数据里的变体键为准：历史版本可能生成过 *OPAQUE 的 LOD 裁切文件，
    // 其文件名（…_LOD1_OPAQUE.fbx）无法通过 parseModelVariantKey 反解。
    const recordVariantKey = String(record?.variantKey || "").trim();
    if (!OPAQUE_SUFFIX_RE.test(recordVariantKey)) continue;
    const variantKey = normalizeModelVariantKey(recordVariantKey);
    if (!variantKey) continue;
    seen.add(resolved);
    entries.push({ path: resolved, variantKey });
  }
  return entries;
}

function pruneOpaqueModelRecords(meta) {
  let removed = 0;
  for (const key of ["modelVariants", "modelLods", "components"]) {
    if (!Array.isArray(meta?.[key])) continue;
    meta[key] = meta[key].filter((record) => {
      if (key === "components" && String(record?.type || "").trim().toLowerCase() !== "model") return true;
      if (!isOpaqueModelRecord(record)) return true;
      removed += 1;
      return false;
    });
  }
  return removed;
}

function snapshotOpaqueRecords(meta) {
  const snapshot = { components: [], modelVariants: [], modelLods: [] };
  for (const key of Object.keys(snapshot)) {
    for (const record of Array.isArray(meta?.[key]) ? meta[key] : []) {
      if (key === "components" && String(record?.type || "").trim().toLowerCase() !== "model") continue;
      if (!isOpaqueModelRecord(record)) continue;
      const file = record?.file || record?.uri || record?.path || "";
      const variantKey = normalizeModelVariantKey(record?.variantKey || parseModelVariantKey(file));
      if (!variantKey) continue;
      snapshot[key].push({ variantKey, record: JSON.parse(JSON.stringify(record)) });
    }
  }
  return snapshot;
}

function restoreOpaqueRecordsForKeys(meta, snapshot, restoredKeys) {
  if (!restoredKeys || restoredKeys.size === 0) return 0;
  let restored = 0;
  for (const key of Object.keys(snapshot)) {
    const items = snapshot[key].filter((item) => restoredKeys.has(item.variantKey));
    if (items.length === 0) continue;
    if (!Array.isArray(meta[key])) meta[key] = [];
    for (const item of items) meta[key].push(item.record);
    restored += items.length;
  }
  return restored;
}

function mergeRegeneratedModelEntries(meta, assetDir, generatedEntries) {
  if (!Array.isArray(meta.components)) meta.components = [];
  if (!Array.isArray(meta.modelVariants)) meta.modelVariants = [];
  for (const entry of generatedEntries) {
    const resolved = resolveAssetPath(assetDir, entry?.path);
    if (!resolved) continue;
    const fields = variantMetadataFields(entry?.variantKey);
    meta.components.push({
      type: "model",
      slot: String(entry?.suffix || "").trim(),
      uri: path.basename(resolved),
      ...fields
    });
    meta.modelVariants.push({ file: normalizePathToken(resolved), ...fields });
  }
}

function rebuildModelAggregates(meta, assetDir) {
  const components = Array.isArray(meta.components) ? meta.components : [];
  const modelComponents = components.filter((record) => String(record?.type || "").trim().toLowerCase() === "model");
  const files = [];
  const slots = {};
  if (modelComponents.length > 0) {
    for (const record of modelComponents) {
      const resolved = resolveAssetPath(assetDir, record.uri || record.file || record.path);
      if (!resolved) continue;
      if (!files.includes(resolved)) files.push(resolved);
      const slot = String(record.slot || "").trim();
      if (slot) slots[slot] = resolved;
    }
  } else {
    // 兼容没有 components 的旧元数据：直接过滤既有列表里的裁切条目。
    for (const file of Array.isArray(meta.modelFiles) ? meta.modelFiles : []) {
      const resolved = resolveAssetPath(assetDir, file);
      if (resolved && !isOpaqueModelFile(resolved)) files.push(resolved);
    }
    const slotMap = meta.modelSlots && typeof meta.modelSlots === "object" && !Array.isArray(meta.modelSlots)
      ? meta.modelSlots
      : {};
    for (const [slot, filePath] of Object.entries(slotMap)) {
      const resolved = resolveAssetPath(assetDir, filePath);
      if (resolved && !isOpaqueModelFile(resolved)) slots[slot] = resolved;
    }
  }
  meta.modelFiles = files.map((file) => normalizePathToken(file));
  meta.modelSlots = Object.fromEntries(Object.entries(slots).map(([slot, file]) => [slot, normalizePathToken(file)]));
}

async function restoreOpaqueBackups(backups) {
  for (const backup of backups) {
    await fsp.copyFile(backup.backup, backup.original).catch(() => {});
  }
}

/**
 * 重新生成某个资产的全部 _OPAQUE 裁切变体。调用方（主进程）需先完成资产类型与
 * Megascans 归属校验，并保证裁切处理器可用。
 *
 * options:
 *   assetDir / assetId / assetName  资产目录、ID、名称（命名与导入侧一致）
 *   meta                            已读取的元数据对象（本函数在内存中改写并回传）
 *   cutOptions                      { contourPrecisionTexels, maskErodeTexels, fillHoles, holeMaxAreaTexels,
 *                                     faceBudget, cleanupPercent, subdivideTexels, traceStepTexels, simplifyTarget }
 *   isMeshSlot / meshSlotNameForOrder / nameForModel  与导入侧相同的槽位与命名规则
 *   generateVariants                可注入的裁切执行器（测试用），默认 buildFoliageOpaqueVariants
 *   onLog                           日志回调
 */
async function regenerateFoliageOpaqueVariants(options = {}) {
  const assetDir = String(options.assetDir || "").trim();
  const assetId = String(options.assetId || "").trim();
  const assetName = String(options.assetName || "").trim() || assetId;
  const meta = options.meta && typeof options.meta === "object" ? options.meta : null;
  const cutOptions = options.cutOptions && typeof options.cutOptions === "object" ? options.cutOptions : {};
  const isMeshSlot = typeof options.isMeshSlot === "function"
    ? options.isMeshSlot
    : (value) => /^mesh(?:\d+)?$/i.test(String(value || "").trim());
  const meshSlotNameForOrder = typeof options.meshSlotNameForOrder === "function"
    ? options.meshSlotNameForOrder
    : (order) => (order <= 1 ? "Mesh" : `Mesh${String(order).padStart(2, "0")}`);
  const nameForModel = typeof options.nameForModel === "function"
    ? options.nameForModel
    : (variantKey) => `SM_${assetName}_${assetId}_${variantKey}`;
  const generateVariants = typeof options.generateVariants === "function" ? options.generateVariants : buildFoliageOpaqueVariants;
  const onLog = typeof options.onLog === "function" ? options.onLog : () => {};

  const result = {
    ok: false,
    message: "",
    meta: null,
    generated: 0,
    removedFiles: 0,
    restoredVariants: 0,
    warnings: []
  };
  if (!assetDir || !assetId || !meta) {
    result.message = "重新裁切缺少资产目录、资产 ID 或元数据";
    return result;
  }

  const modelEntries = collectModelSlotEntries(meta, assetDir);
  const sourceMeshEntries = modelEntries.filter((entry) => isMeshSlot(entry.suffix) && !isOpaqueModelFile(entry.path));
  if (sourceMeshEntries.length === 0 || sourceMeshEntries.some((entry) => !/\.fbx$/i.test(entry.path))) {
    result.message = "重新裁切仅支持原始模型全部为 FBX 的植被";
    return result;
  }
  const textureEntries = collectTextureSlotEntries(meta, assetDir);
  // 与入库同一条解析：OpacityMasked（分辨率最高）→ Albedo/Diffuse/Basecolor 的 alpha
  // （必须真的有 alpha）→ 都没有则不可重切。
  const maskSource = await resolveFoliageMaskSource(textureEntries);
  if (!maskSource) {
    result.message = `${describeFoliageMaskSource(null)}，无法重新裁切`;
    return result;
  }
  if (!fs.existsSync(maskSource.filePath)) {
    result.message = `透贴贴图不存在：${basenameOf(maskSource.filePath)}`;
    return result;
  }

  const opaqueEntries = modelEntries.filter((entry) => isOpaqueModelFile(entry.path));
  const sourceEntries = modelEntries.filter((entry) => !isOpaqueModelFile(entry.path));
  const meshSourceEntries = sourceEntries.filter((entry) => isMeshSlot(entry.suffix) && /\.fbx$/i.test(entry.path));
  if (meshSourceEntries.length === 0) {
    result.message = "未找到可裁切的 FBX 模型变体";
    return result;
  }

  // 备份集合以「文件」为单位；variantKey 用于在部分失败时决定是否恢复该变体（连同它的 LOD 裁切文件）。
  const opaqueLodEntries = collectOpaqueLodEntries(meta, assetDir);
  const backupDir = await fsp.mkdtemp(path.join(os.tmpdir(), "assethive-opaque-backup-"));
  const backups = [];
  const backedPaths = new Set();
  const backupAndRemove = async (filePath, variantKey) => {
    const resolved = path.resolve(filePath);
    if (backedPaths.has(resolved) || !isPathInside(assetDir, resolved) || !fs.existsSync(resolved)) return;
    const backupPath = path.join(backupDir, `${backups.length}_${path.basename(resolved)}`);
    await fsp.copyFile(resolved, backupPath);
    await fsp.rm(resolved, { force: true });
    backups.push({ variantKey, original: resolved, backup: backupPath });
    backedPaths.add(resolved);
    result.removedFiles += 1;
  };
  try {
    for (const entry of opaqueEntries) {
      const variantKey = normalizeModelVariantKey(entry.variantKey || parseModelVariantKey(entry.path));
      if (!variantKey) continue;
      await backupAndRemove(entry.path, variantKey);
    }
    for (const entry of opaqueLodEntries) {
      await backupAndRemove(entry.path, entry.variantKey);
    }
    onLog(`regenerate: mask=${basenameOf(maskSource.filePath)} variants=${meshSourceEntries.length} replaced=${result.removedFiles}`);

    let batch = null;
    try {
      batch = await generateVariants({
        destinationDir: assetDir,
        modelEntries: sourceEntries,
        textureEntries,
        contourPrecisionTexels: cutOptions.contourPrecisionTexels,
        maskErodeTexels: cutOptions.maskErodeTexels,
        // 孔洞填充（含面积上限）：同 maskErodeTexels，必须逐项下发，否则重新裁切
        // 会退回处理器默认值，与入库时切出来的边缘口径不一致。
        fillHoles: cutOptions.fillHoles,
        holeMaxAreaTexels: cutOptions.holeMaxAreaTexels,
        faceBudget: cutOptions.faceBudget,
        // 自动档的浮动区间：重新裁切与入库走同一套复杂度浮动（见 plantOpaqueBudget），
        // 少下发就会退回固定档、复杂资产边缘重新被压得不规整。
        faceBudgetFloor: cutOptions.faceBudgetFloor,
        faceBudgetCeiling: cutOptions.faceBudgetCeiling,
        cleanupPercent: cutOptions.cleanupPercent,
        // 这三项必须一并下发，否则界面选了 Trace（或细分）却仍走老的裁切路线：
        // Trace/细分决定边界精度。导出不再自动减面（simplifyTarget 恒为 0），
        // 自然面数原样导出，收敛交给 UE 侧 Nanite。
        // 少下发时不会报错，只是结果悄悄退回低精度裁切 —— 排查成本极高。
        subdivideTexels: cutOptions.subdivideTexels,
        traceStepTexels: cutOptions.traceStepTexels,
        // Trace 生成阶段的面数上限：同样必须下发，否则重切会退回处理器默认值，
        // 与入库时的密度不一致。
        traceMaxFaces: cutOptions.traceMaxFaces,
        simplifyTarget: cutOptions.simplifyTarget,
        // 逐任务进度回调：重新裁切同样是最长的阶段（12 变体约 6 分钟），
        // 静默期间界面看起来已经完成，与入库路径同一问题。
        onProgress: typeof options.onProgress === "function" ? options.onProgress : undefined,
        isMeshSlot,
        meshSlotNameForOrder,
        nameForModel,
        variantFields: variantMetadataFields,
        onLog
      });
    } catch (error) {
      batch = { ok: false, message: error?.message || String(error), added: [], warnings: [] };
    }
    const generated = Array.isArray(batch?.added) ? batch.added : [];
    result.generated = generated.length;
    result.warnings = Array.isArray(batch?.warnings) ? batch.warnings : [];

    if (generated.length === 0) {
      await restoreOpaqueBackups(backups);
      result.message = batch?.message || "不透明裁切失败，已恢复原有裁切变体";
      return result;
    }

    const generatedKeys = new Set(generated.map((entry) => normalizeModelVariantKey(entry?.variantKey)));
    const restoredKeys = new Set();
    for (const backup of backups) {
      if (generatedKeys.has(backup.variantKey)) continue;
      await fsp.copyFile(backup.backup, backup.original).catch(() => {});
      restoredKeys.add(backup.variantKey);
    }
    result.restoredVariants = restoredKeys.size;

    const previousOpaqueRecords = snapshotOpaqueRecords(meta);
    pruneOpaqueModelRecords(meta);
    mergeRegeneratedModelEntries(meta, assetDir, generated);
    restoreOpaqueRecordsForKeys(meta, previousOpaqueRecords, restoredKeys);
    rebuildModelAggregates(meta, assetDir);

    result.ok = true;
    result.meta = meta;
    result.message = generated.length < meshSourceEntries.length
      ? `已重新生成 ${generated.length}/${meshSourceEntries.length} 个不透明裁切变体，失败项已保留原裁切`
      : `已重新生成 ${generated.length} 个不透明裁切变体`;
    return result;
  } finally {
    await fsp.rm(backupDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  collectModelSlotEntries,
  collectTextureSlotEntries,
  collectOpaqueLodEntries,
  isOpaqueModelFile,
  isOpaqueModelRecord,
  pruneOpaqueModelRecords,
  rebuildModelAggregates,
  regenerateFoliageOpaqueVariants
};
