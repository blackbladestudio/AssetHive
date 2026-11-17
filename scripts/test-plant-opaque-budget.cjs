"use strict";

// _OPAQUE 裁切档的回归测试。
//
// 背景：裁切网格用几何表达遮罩本来免费提供的外轮廓，面数需求由轮廓精度决定，
// 与 masked 档不是同一个量。两边（软件生成侧 / 插件导入侧）必须给出同一个数字 ——
// 生成侧超出插件的部分会被 Nanite 的保留百分比裁掉，文件按全量变大而渲染精度不变。
// 实测 Beech Fern：插件 keepPercentTriangles = 0.05002，20 万面只渲染 10,692 面。
//
// 因此除了本模块的档位解析，这里还直接比对插件源码，防止两边的数字漂移。

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const {
  FOLIAGE_TIER_BUDGETS,
  OPAQUE_REDUCTION_RATIO,
  normalizeAssetTagToken,
  resolveFoliageTier,
  resolveFloatedOpaqueBudget,
  resolvePlantOpaqueBudgetRange,
  resolvePlantOpaqueFaceBudget
} = require("../electron/services/plantOpaqueBudget");

test("grass picks the grass cutout tier range", () => {
  assert.equal(resolveFoliageTier(["Grass"], ""), "Grass");
  const range = resolvePlantOpaqueBudgetRange({ tags: ["Grass"], category: "" });
  // Grass 下限已被钉在上限（操作者要求 grass 一律给到 15 万）。
  assert.deepEqual(range, { floor: 150000, ceiling: 150000 });
  assert.equal(resolvePlantOpaqueFaceBudget({ tags: ["Grass"], category: "" }), 150000,
    "兼容入口返回下限（不浮动时的固定目标）");
});

test("bush picks the bush cutout tier range", () => {
  const range = resolvePlantOpaqueBudgetRange({ tags: ["Bush"], category: "" });
  // Bush 下限钉在上限（操作者要求 bush 一律给到 30 万）。
  assert.deepEqual(range, { floor: 300000, ceiling: 300000 });
});

test("shrub category is treated as bush, before any tag", () => {
  // Megascans 的类别词是 Shrub；standardAssetTags 通常只有 Megascans，
  // 分档信息只在 category 里，所以类别必须优先于 tag。
  assert.equal(resolveFoliageTier(["Megascans", "Grass"], "Shrub"), "Bush");
  assert.deepEqual(resolvePlantOpaqueBudgetRange({ tags: ["Megascans"], category: "Shrub" }),
    { floor: 300000, ceiling: 300000 });
  assert.equal(resolveFoliageTier(["Megascans"], "shrubbery"), "Bush");
});

test("a tagged tier wins over a plain library category", () => {
  // Fern 这类没有细分 tag 的 Megascans 植被落 Grass 档；有 Tree tag 的必须仍是 Tree。
  assert.equal(resolveFoliageTier(["Tree"], "Fern"), "Tree");
  assert.deepEqual(resolvePlantOpaqueBudgetRange({ tags: ["Megascans"], category: "Fern" }),
    { floor: 150000, ceiling: 150000 });
});

test("tiers without a dedicated cutout budget inherit the masked one", () => {
  for (const tier of ["Tree", "MicroFoliage", "HeroFoliage"]) {
    assert.equal(FOLIAGE_TIER_BUDGETS[tier].opaqueCeiling, FOLIAGE_TIER_BUDGETS[tier].masked,
      `${tier} 没有单独的裁切档时应沿用 masked 档（区间退化为一个点）`);
    assert.equal(FOLIAGE_TIER_BUDGETS[tier].opaqueFloor, FOLIAGE_TIER_BUDGETS[tier].opaqueCeiling);
  }
  const range = resolvePlantOpaqueBudgetRange({ tags: ["MicroFoliage"], category: "" });
  assert.deepEqual(range, { floor: 500, ceiling: 500 });
});

test("unclassified plants resolve to no budget", () => {
  // 无库分类的 st9：插件不设 Nanite 预算，多生成的面会全部参与渲染，不会变成死重。
  assert.equal(resolveFoliageTier([], ""), "");
  assert.equal(resolvePlantOpaqueBudgetRange({ tags: [], category: "" }), null);
  assert.equal(resolvePlantOpaqueBudgetRange({}), null);
});

test("tag and category normalization matches the plugin token rules", () => {
  // 与插件 NormalizeAssetTagToken 一致：去空格/下划线/连字符后小写。
  assert.equal(normalizeAssetTagToken("  Hero_Foliage "), "herofoliage");
  assert.equal(normalizeAssetTagToken("micro-foliage"), "microfoliage");
  assert.equal(resolveFoliageTier(["Micro_Foliage"], ""), "MicroFoliage");
  assert.equal(resolveFoliageTier([], "flowering-plant"), "Grass");
});

test("complexity float keeps the reduction ratio at or below the quality bar", () => {
  const grass = resolvePlantOpaqueBudgetRange({ tags: ["Grass"], category: "" });
  // 实测 itx1dbp 各变体在 step 4 下的生成面数（见 wind/recut 回归）。
  const measured = {
    "_01": 4734339, "_02": 4670766, "_03": 4603778, "_04": 4986551,
    "_05": 3268683, "_06": 2154638, "_07": 2754579, "_08": 1092260,
    "_09": 939257, "_10": 13413, "_11": 18510, "_12": 51901
  };
  for (const [variant, generated] of Object.entries(measured)) {
    const budget = resolveFloatedOpaqueBudget(grass, generated);
    assert.ok(budget >= grass.floor && budget <= grass.ceiling,
      `${variant}: 目标 ${budget} 必须落在档位区间内`);
    // 质量基准只在"未被上限截断"时成立：撞到上限说明复杂度已经超出该子类的
    // 规范允许，此时上限优先（_04：4.99M 候选 → 15 万，减面比 33.2:1）。
    if (budget > grass.floor && budget < grass.ceiling) {
      assert.ok(generated / budget <= OPAQUE_REDUCTION_RATIO + 0.5,
        `${variant}: 减面比 ${(generated / budget).toFixed(1)}:1 不应超过质量基准`);
    }
  }
  // 结构最复杂的变体应吃到上限于附近（用户诉求：这类资产可以到 15 万面）。
  // Grass 下限已钉在上限（150000），所以任何复杂度都落在 150000：
  assert.equal(resolveFloatedOpaqueBudget(grass, measured._01), grass.floor);
  assert.equal(resolveFloatedOpaqueBudget(grass, measured._04), grass.ceiling);
  // 简单资产落在下限，不因浮动而降级。
  assert.equal(resolveFloatedOpaqueBudget(grass, measured._08), grass.floor);
  // 没开启自动档（上限 0）时返回 0，调用方沿用固定值。
  assert.equal(resolveFloatedOpaqueBudget(null, 4000000), 0);
  assert.equal(resolveFloatedOpaqueBudget({ floor: 0, ceiling: 0 }, 4000000), 0);
});

// ---- 跨仓库比对：软件表 vs 插件 ResolvePlantAssetProfile ----

const PLUGIN_SOURCE_CANDIDATES = [
  path.join(__dirname, "..", "..", "AssetHivePlugin", "AssetHive", "Source", "AssetHive", "Private", "AssetHiveImportCommandlet.cpp"),
  "D:\\Secure\\AssetHivePlugin\\AssetHive\\Source\\AssetHive\\Private\\AssetHiveImportCommandlet.cpp",
  "D:\\P4Root\\Project\\Plugins\\AssetHive\\Source\\AssetHive\\Private\\AssetHiveImportCommandlet.cpp"
];

function readPluginSource() {
  for (const candidate of PLUGIN_SOURCE_CANDIDATES) {
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, "utf8").replace(/\r\n/g, "\n");
  }
  return "";
}

// 从 ResolvePlantAssetProfile 里抽出每个分支的 masked / opaque 档位。
// 分支用 `if (<条件>) {` 起始，档位赋值形如 Profile.MaxLOD0Triangles = 35000;
// 返回 { tag: {masked, opaque} }，键取条件里的字面量（Tree / Bush / Grass / …）。
function parsePluginPlantBudgets(source) {
  const start = source.indexOf("static FPlantAssetProfile ResolvePlantAssetProfile(");
  assert.ok(start >= 0, "插件源码里必须能找到 ResolvePlantAssetProfile");
  // 函数体到下一个顶层 `}` 之前的注释块为止：用括号配平找结尾。
  const bodyStart = source.indexOf("{", start);
  let depth = 0, end = bodyStart;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  const body = source.slice(bodyStart, end + 1);
  const budgets = {};
  const marker = /Profile\.SubtypeFolder = TEXT\("([A-Za-z]+)"\);/g;
  const matches = [...body.matchAll(marker)];
  matches.forEach((match) => {
    const key = match[1] === "Micro" ? "MicroFoliage" : match[1];
    // 分支块必须在自己 return 处截止：否则最后一个 if 分支会把后面的兜底块
    // （Grass 档）一起吃进来，把兜底的裁切档误当成该分支的值。
    const branchEnd = body.indexOf("return Profile;", match.index);
    const chunk = body.slice(match.index, branchEnd >= 0 ? branchEnd : body.length);
    const masked = /Profile\.MaxLOD0Triangles = (\d+);/.exec(chunk);
    const opaque = /Profile\.MaxLOD0TrianglesOpaque = (\d+);/.exec(chunk);
    const budget = {
      masked: masked ? Number(masked[1]) : 0,
      opaque: opaque ? Number(opaque[1]) : 0
    };
    if (budgets[key]) assert.deepEqual(budget, budgets[key], key + " 显式和回退预算应一致");
    budgets[key] = budget;
  });
  // 最后一个分支（无 tag 的 Grass 兜底）没有 if 条件，单独取函数尾部。
  const tail = body.slice(body.lastIndexOf("Profile.SubtypeFolder = TEXT(\"Grass\");"));
  const tailMasked = /Profile\.MaxLOD0Triangles = (\d+);/.exec(tail);
  const tailOpaque = /Profile\.MaxLOD0TrianglesOpaque = (\d+);/.exec(tail);
  budgets.GrassFallback = {
    masked: tailMasked ? Number(tailMasked[1]) : 0,
    opaque: tailOpaque ? Number(tailOpaque[1]) : 0
  };
  return budgets;
}

test("app tiers match the plugin plant profile", (t) => {
  const source = readPluginSource();
  if (!source) {
    t.skip("未找到插件源码，跳过跨仓库档位比对");
    return;
  }
  const plugin = parsePluginPlantBudgets(source);
  // 插件只认上限：它的 MaxLOD0TrianglesOpaque 是 Nanite 保留百分比的预算基线，
  // 生成侧在上限以内分配 -> 保留百分比恒为 100%（生成多少渲染多少）。
  // 因此插件的值必须等于软件表的 opaqueCeiling；0 表示该子类没有单独放宽。
  for (const [tier, branch] of Object.entries(plugin)) {
    const key = tier === "GrassFallback" ? "Grass" : tier;
    const declared = FOLIAGE_TIER_BUDGETS[key];
    assert.ok(declared, `软件表缺少 ${key} 档`);
    assert.equal(branch.masked, declared.masked, `${tier} 的 masked 档与插件不一致`);
    const expectedCeiling = branch.opaque > 0 ? branch.opaque : branch.masked;
    assert.equal(expectedCeiling, declared.opaqueCeiling, `${tier} 的裁切档上限与插件不一致`);
    assert.ok(declared.opaqueFloor <= declared.opaqueCeiling,
      `${key} 的区间下限不能高于上限`);
    assert.ok(declared.opaqueFloor >= declared.masked,
      `${key} 的裁切档下限不应低于 masked 档`);
  }
  // 用户指定的两个上限必须真的落在插件里（Grass 15 万 / Bush 30 万）。
  assert.equal(plugin.Grass.opaque, 150000);
  assert.equal(plugin.Bush.opaque, 300000);
  assert.equal(plugin.GrassFallback.opaque, 150000);
});
