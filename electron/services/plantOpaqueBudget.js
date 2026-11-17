"use strict";

// _OPAQUE 裁切变体的面数档。
//
// 这里决定"生成多少面"（区间），插件侧的 ResolvePlantAssetProfile 决定
// "最多渲染多少面"（上限）。分工：
//   生成侧：按结构复杂度在 下限..上限 之间分配 —— 生成的候选面数就是复杂度的
//           直接度量，固定一个点会把复杂资产的减面比推高（实测 itx1dbp_01：
//           4.73M 候选 → 10 万，减面比 47:1，轮廓边缘被压得不规整）。
//   插件侧：MaxLOD0TrianglesOpaque = 上限。生成不超过上限时 Nanite 保留百分比
//           恒为 100% —— 生成多少渲染多少，既不裁剪也不浪费；两侧因此不需要
//           对齐复杂度公式，只需要对齐**上限**这一个数字
//           （scripts/test-plant-opaque-budget.cjs 直接比对插件源码锁定）。
//
// 历史包袱（为什么要有档位区间而不是一个数）：早期两侘认同一个固定值，但生成
// 侧超出插件预算时 Nanite 保留百分比会等比例缩小 —— 实测（Beech Fern，插件侧
// keepPercentTriangles 0.05002）200,000 面只渲染 10,692 面，资产 18 MB FBX /
// 12 MB uasset 里 95% 的几何存了却不参与渲染，表现是"体积莫名其妙地大 + 精度很低"。
//
// 为什么裁切档要远高于 masked 档：裁切网格用几何表达遮罩本来免费提供的外轮廓，
// 面数需求跟轮廓长度走，与被裁切变体的表面预算不是同一个量。Beech Fern 4096² 遮罩
// 实测不透明区 4.47M 纹素、轮廓 46.6 万纹素；只给 masked 档的 1 万面相当于约 21 纹素
// 的轮廓步长，叶缘必然是台阶状。

// masked 档与裁切档（下限..上限区间）。
// Grass / Bush 的下限已被操作者要求钉在上限（grass 15 万、bush 30 万）：
// 结构复杂到能撑起该面数的资产一律给到满档；简单资产因候选面数本身不足，
// 减面无从谈起，输出仍是候选本身 —— 所以钉平不会让简单资产膨胀，只是
// 不再把复杂资产压回低档。Tree / Micro / Hero 区间本来就退化为一个点。
const FOLIAGE_TIER_BUDGETS = Object.freeze({
  Tree: { masked: 100000, opaqueFloor: 100000, opaqueCeiling: 100000 },
  Bush: { masked: 35000, opaqueFloor: 300000, opaqueCeiling: 300000 },
  Grass: { masked: 10000, opaqueFloor: 150000, opaqueCeiling: 150000 },
  MicroFoliage: { masked: 500, opaqueFloor: 500, opaqueCeiling: 500 },
  HeroFoliage: { masked: 200000, opaqueFloor: 200000, opaqueCeiling: 200000 }
});

// 灌木类别词：插件接受 Megascans 词表的 Shrub，以及引擎目录约定的 Bush。
const SHRUB_CATEGORY_TOKENS = new Set(["shrub", "bush", "shrubbery"]);

// 与插件 NormalizeAssetTagToken 完全一致（去空格/下划线/连字符后小写）。
// tag 与 category 共用这一套归一化，否则 "Flowering Plant" / "flowering-plant"
// 这类写法差异会让两边算出不同档位。
function normalizeAssetTagToken(value) {
  return String(value ?? "").trim().replace(/[\s_-]+/g, "").toLowerCase();
}

// 子类判定必须与插件同序：类别优先于 tag（Megascans 植被的 standardAssetTags 通常
// 只有 "Megascans"，分档信息只在 category 里）。
// tags 需传入 standardAssetTags 与 tags 的并集 —— 插件 CollectAssetTags 同时收这两个字段。
function resolveFoliageTier(tags, category) {
  const tokens = (Array.isArray(tags) ? tags : [tags])
    .map(normalizeAssetTagToken)
    .filter(Boolean);
  if (tokens.includes("micro") || tokens.includes("microfoliage")) return "MicroFoliage";
  if (SHRUB_CATEGORY_TOKENS.has(normalizeAssetTagToken(category))) return "Bush";
  if (tokens.includes("tree")) return "Tree";
  if (tokens.includes("bush")) return "Bush";
  if (tokens.includes("grass")) return "Grass";

  if (tokens.includes("herofoliage")) return "HeroFoliage";
  // 有库分类但没有细分 tag：Megascans 植被的常规情况，套用 Grass 档。
  if (String(category ?? "").trim()) return "Grass";
  // 无库分类（st9 等原生资产）：插件不套用分档，这里同样不给数字，
  // 由调用方回退到通用默认值。
  return "";
}

// 裁切面数区间；null = 无法从分类推导（调用方自行决定默认）。
// 下限是档位兜底（简单资产落在下限），上限与插件的 MaxLOD0TrianglesOpaque 对齐。
function resolvePlantOpaqueBudgetRange({ tags, category } = {}) {
  const tier = resolveFoliageTier(tags, category);
  const budgets = tier ? FOLIAGE_TIER_BUDGETS[tier] : null;
  if (!budgets) return null;
  return { floor: budgets.opaqueFloor, ceiling: budgets.opaqueCeiling };
}

// 减面比上限（质量基准）：生成面数 / 目标面数 不超过该比值。
//
// 取 32 的依据：itx1dbp_01（结构最复杂的变体）在固定 10 万档下的减面比是 47:1
// （4,734,339 候选 → 100,000），用户实测轮廓边缘被压得不规整；放开到 15 万档
// 时回到 31:1、边缘规整。简单资产（如 _08：1,092,260 候选）整除后落在下限，
// 维持原档位不降级。
const OPAQUE_REDUCTION_RATIO = 32;

// 在档位区间内按结构复杂度定目标面数：生成的候选面数就是复杂度的直接度量
// （同一条轮廓精度基准下，复杂资产的候选远多于简单资产）。
// 上限 <= 0（未开启自动档）时返回 0，调用方沿用固定值。
function resolveFloatedOpaqueBudget(range, generatedFaces, ratio = OPAQUE_REDUCTION_RATIO) {
  const ceiling = Math.max(0, Math.floor(Number(range?.ceiling) || 0));
  if (!(ceiling > 0)) return 0;
  const floor = Math.min(ceiling, Math.max(1, Math.floor(Number(range?.floor) || 1)));
  const generated = Math.max(0, Math.floor(Number(generatedFaces) || 0));
  const step = Math.max(1, Math.floor(Number(ratio) || OPAQUE_REDUCTION_RATIO));
  return Math.min(ceiling, Math.max(floor, Math.round(generated / step)));
}

// 兼容入口：返回档位下限（= 不浮动时的固定目标）。新调用方一律用
// resolvePlantOpaqueBudgetRange + resolveFloatedOpaqueBudget。
function resolvePlantOpaqueFaceBudget({ tags, category } = {}) {
  const range = resolvePlantOpaqueBudgetRange({ tags, category });
  return range ? range.floor : 0;
}

module.exports = {
  FOLIAGE_TIER_BUDGETS,
  OPAQUE_REDUCTION_RATIO,
  normalizeAssetTagToken,
  resolveFoliageTier,
  resolveFloatedOpaqueBudget,
  resolvePlantOpaqueBudgetRange,
  resolvePlantOpaqueFaceBudget
};
