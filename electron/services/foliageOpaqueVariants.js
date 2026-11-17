const path = require("node:path");
const { resolveFoliageMaskSource, describeFoliageMaskSource, generateFoliageOpaqueTasks } = require("./foliageOpaque");

const OPAQUE_VARIANT_SUFFIX = "OPAQUE";

function opaqueVariantKeyFor(sourceVariantKey) {
  const base = String(sourceVariantKey || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "") || "01";
  return `${base}${OPAQUE_VARIANT_SUFFIX}`;
}

function isOpaqueVariantKey(value) {
  return /OPAQUE$/i.test(String(value || "").trim());
}

function meshSlotOrderOf(suffix, isMeshSlot) {
  const normalized = String(suffix || "").trim();
  if (typeof isMeshSlot === "function" && !isMeshSlot(normalized)) return 0;
  if (/^mesh$/i.test(normalized)) return 1;
  const matched = normalized.match(/^mesh(\d+)$/i);
  if (!matched) return 1;
  const parsed = Number(matched[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function defaultMeshSlotName(order) {
  const value = Math.max(1, Math.floor(Number(order) || 1));
  return value <= 1 ? "Mesh" : `Mesh${String(value).padStart(2, "0")}`;
}

function baseNameOf(filePath) {
  return path.basename(String(filePath || ""));
}

/**
 * Generates the optional `_OPAQUE` foliage variant: the source mesh is cut with
 * the transparency mask and the result is stored as an additional mesh variant of
 * the same library asset. UV sets stay untouched (UV0 identical to the source);
 * no bake UV is generated.
 *
 * Only LOD0 of every variant is processed: the cut variant exists to drop the
 * masked geometry, while LOD1+ keep the masked material. All variants of one
 * asset are handled by a single processor worker.
 *
 * `contourPrecisionTexels` / `maskErodeTexels` drive the trace-based cut,
 * `fillHoles` / `holeMaxAreaTexels` control the mask hole filling that keeps the
 * outer contour clean (black areas fully enclosed by the white region are filled
 * before the contour is traced; 0 texels = no area limit), and
 * `faceBudget` is the caller supplied face ceiling (the import UI resolves the
 * spec default); 0 disables the face ceiling.
 *
 * `cleanupPercent` drives the optional loose-part cleanup that runs right after the
 * cut: it is the region-size-ratio threshold (fragment bounding-box diagonal over
 * the model diagonal, in percent); 0 turns the cleanup off (default).
 */
async function buildFoliageOpaqueVariants(options = {}) {
  const destinationDir = String(options.destinationDir || "").trim();
  const modelEntries = Array.isArray(options.modelEntries) ? options.modelEntries : [];
  const textureEntries = Array.isArray(options.textureEntries) ? options.textureEntries : [];
  const isMeshSlot = typeof options.isMeshSlot === "function" ? options.isMeshSlot : () => true;
  const meshSlotNameForOrder = typeof options.meshSlotNameForOrder === "function"
    ? options.meshSlotNameForOrder
    : defaultMeshSlotName;
  const nameForModel = typeof options.nameForModel === "function" ? options.nameForModel : (key) => `OPAQUE_${key}`;
  const variantFields = typeof options.variantFields === "function" ? options.variantFields : () => ({});
  const onLog = typeof options.onLog === "function" ? options.onLog : () => {};

  const result = {
    ok: false,
    added: [],
    lodAdded: [],
    warnings: [],
    message: "",
    durationMs: 0,
    stats: null
  };
  if (!destinationDir) {
    result.message = "缺少资产归档目录";
    return result;
  }

  // 裁切前先解析透明度来源：OpacityMasked（取分辨率最高的一张）→ 退到
  // Albedo/Diffuse/Basecolor 的 alpha（必须真的有 alpha）→ 都没有则不透明裁切不可用。
  const maskSource = await resolveFoliageMaskSource(textureEntries);
  if (!maskSource) {
    result.message = `${describeFoliageMaskSource(null)}，已跳过不透明变体生成`;
    return result;
  }

  const targets = modelEntries.filter((entry) => (
    isMeshSlot(entry?.suffix) && /\.fbx$/i.test(String(entry?.path || ""))
  ));
  if (targets.length === 0) {
    result.message = "没有可处理的 FBX 模型，已跳过不透明变体生成";
    return result;
  }

  let nextSlotOrder = 1 + modelEntries
    .filter((entry) => isMeshSlot(entry?.suffix))
    .map((entry) => meshSlotOrderOf(entry?.suffix, isMeshSlot))
    .filter((value) => Number.isFinite(value))
    .reduce((max, value) => Math.max(max, value), 1);

  const plans = [];
  const usedNames = new Set();
  for (const target of targets) {
    const sourceVariantKey = String(target?.variantKey || "01").trim() || "01";
    const opaqueVariantKey = opaqueVariantKeyFor(sourceVariantKey);
    let baseName = String(nameForModel(opaqueVariantKey) || "").trim();
    let suffixIndex = 2;
    while (usedNames.has(baseName.toLowerCase())) {
      baseName = `${String(nameForModel(opaqueVariantKey) || "").trim()}${suffixIndex}`;
      suffixIndex += 1;
    }
    usedNames.add(baseName.toLowerCase());
    const slot = meshSlotNameForOrder(nextSlotOrder);
    nextSlotOrder += 1;
    // LOD0 only: every variant contributes exactly one cut mesh, so an asset
    // with 12 variants x 5 LODs produces 12 opaque files instead of 60.
    plans.push({
      kind: "model",
      slot,
      sourceSlot: String(target.suffix || ""),
      variantKey: opaqueVariantKey,
      input: String(target.path),
      output: path.join(destinationDir, `${baseName}.fbx`)
    });
  }

  onLog(`mask=${baseNameOf(maskSource.filePath)} (${maskSource.textureType}/${maskSource.channel}) jobs=${plans.length}`);
  const batch = await generateFoliageOpaqueTasks(
    plans.map((plan) => ({ input: plan.input, output: plan.output })),
    {
      mask: maskSource.filePath,
      maskChannel: maskSource.channel,
      faceBudget: options.faceBudget,
      // 自动档的浮动区间：处理器生成后按复杂度在 下限..上限 之间定目标（见 plantOpaqueBudget）。
      faceBudgetFloor: Number.isFinite(Number(options.faceBudgetFloor)) ? Number(options.faceBudgetFloor) : undefined,
      faceBudgetCeiling: Number.isFinite(Number(options.faceBudgetCeiling)) ? Number(options.faceBudgetCeiling) : undefined,
      threshold: options.threshold,
      contourPrecisionTexels: options.contourPrecisionTexels,
      maskErodeTexels: options.maskErodeTexels,
      // 孔洞填充与它的面积上限：必须一并下发，否则重新裁切会退回处理器默认值，
      // 与入库时的边缘口径不一致（少下发不报错，只是结果悄悄变了）。
      fillHoles: options.fillHoles,
      holeMaxAreaTexels: options.holeMaxAreaTexels,
      cleanupPercent: options.cleanupPercent,
      contourMinAreaTexels: options.contourMinAreaTexels,
      subdivideTexels: options.subdivideTexels,
      simplifyTarget: options.simplifyTarget,
      traceStepTexels: options.traceStepTexels,
      traceMaxFaces: options.traceMaxFaces,
      timeoutMs: options.timeoutMs,
      attempts: options.attempts,
      runtime: options.runtime,
      onLog,
      // 逐任务进度回调（done/total）：入库把它映射成进度环与任务栏进度。
      onProgress: typeof options.onProgress === "function" ? options.onProgress : undefined
    }
  );
  result.durationMs = Number(batch.durationMs) || 0;
  result.stats = {
    planned: plans.length,
    succeeded: Number.isFinite(Number(batch.succeeded)) ? Number(batch.succeeded) : 0,
    failed: Number.isFinite(Number(batch.failed)) ? Number(batch.failed) : 0
  };

  const outcomes = Array.isArray(batch.results) ? batch.results : [];
  plans.forEach((plan, index) => {
    const outcome = outcomes[index];
    if (!outcome?.ok) {
      result.warnings.push(`${baseNameOf(plan.input)}：不透明变体生成失败（${outcome?.message || batch.message || "未知原因"}）`);
      return;
    }
    const shared = {
      path: plan.output,
      variantKey: plan.variantKey,
      generated: "foliageOpaque",
      ...variantFields(plan.variantKey)
    };
    if (plan.kind === "lod") {
      result.lodAdded.push({ slot: plan.slot, lod: plan.lod, opaqueSourceSlot: plan.sourceSlot, ...shared });
    } else {
      result.added.push({ suffix: plan.slot, opaqueSourceSlot: plan.sourceSlot, ...shared });
    }
    for (const warning of Array.isArray(outcome.warnings) ? outcome.warnings : []) {
      result.warnings.push(`${baseNameOf(plan.output)}：${warning}`);
    }
    onLog(`generated ${baseNameOf(plan.output)} from ${baseNameOf(plan.input)}`);
  });

  result.ok = result.added.length > 0;
  if (!result.ok && !result.message) {
    result.message = result.warnings[0] || batch.message || "不透明变体生成失败";
  }
  return result;
}

module.exports = {
  OPAQUE_VARIANT_SUFFIX,
  buildFoliageOpaqueVariants,
  isOpaqueVariantKey,
  opaqueVariantKeyFor
};
