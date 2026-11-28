"use strict";

// Megascans / PBRMAX 等第三方资产的导出分类目录回归测试。
//
// 背景：插件侧 ResolveEnvironmentAssetProfile 按 Asset Tag 决定基础分类目录
// （Dressing/Megascans/PBRMAX → Objects、Kits → Kit、Props → Props、
// Destructible → Destructible、MEGA → MEGA），而且**只在 categoryFolder 为空时**
// 才用这份推导。
//
// 导出侧曾经只对 Zion 资产传空串，其余按 assetType 给出 "3D_Assets"。
// Megascans / PBRMAX 资产的 assetType 就是 "3d"，于是导出侧的 "3D_Assets"
// 覆盖了插件本应推出的 "Objects" —— 实测这两个来源的资产都跑到了
// /Game/Environment/Asset/3D_Assets 下，而它们应该在 Objects 下。

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const sharp = require("sharp");
const ts = require("typescript");
const { buildExportAssets } = require("../electron/services/unrealExporter");

const previewModule = { exports: {} };
new Function("exports", ts.transpileModule(
  fs.readFileSync(path.join(__dirname, "../src/ui/unrealExportPaths.ts"), "utf8"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }
).outputText)(previewModule.exports);
const { resolveZion3DCategoryFolder } = previewModule.exports;

test("Zion subfolder previews follow each selected asset's category", () => {
  const cases = [["Kit", "Kit"], ["Kits", "Kit"], ["Destructible", "Destructible"],
    ["Props", "Props"], ["Dressing", "Objects"], ["MEGA", "Objects"], ["Mask", "Objects"]];
  for (const [tag, expected] of cases) {
    assert.equal(resolveZion3DCategoryFolder({ standardAssetTags: [tag] }), expected);
    assert.equal(resolveZion3DCategoryFolder({ meta: { standardAssetTags: [` ${tag.toLowerCase()} `] } }), expected);
  }
  const batch = cases.map(([tag]) => ({ standardAssetTags: [tag] }));
  assert.deepEqual([...new Set(batch.map(resolveZion3DCategoryFolder))], ["Kit", "Destructible", "Props", "Objects"]);
});

test("category previews honor standard tags, source priority and legacy taxonomy filtering", () => {
  assert.equal(resolveZion3DCategoryFolder({ standardAssetTags: ["Kits", "MEGA"] }), "Kit");
  assert.equal(resolveZion3DCategoryFolder({ standardAssetTags: ["Props", "Destructible"] }), "Destructible");
  assert.equal(resolveZion3DCategoryFolder({ standardAssetTags: ["Kits"], tags: ["Third Party"] }), "Objects");
  assert.equal(resolveZion3DCategoryFolder({ standardAssetTags: ["ThirdParty"], tags: ["Kits"] }), "Objects");
  assert.equal(resolveZion3DCategoryFolder({ tags: ["Kits"], meta: { category: "Kits" } }), "Objects");
  assert.equal(resolveZion3DCategoryFolder({ tags: ["Kit"] }), "Kit");
  assert.equal(resolveZion3DCategoryFolder({}), "Objects");
});

const SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "electron", "services", "unrealExporter.js"), "utf8");

test("all Surface sources use the Tile export pipeline without a Tile standard tag", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "assethive-surface-export-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const textureEntries = [];
  for (const type of ["Diffuse", "Roughness", "Normal", "Metalness", "Emissive"]) {
    const filePath = path.join(root, `Sample_${type}.png`);
    await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 128, g: 128, b: 255 } } }).png().toFile(filePath);
    textureEntries.push({ file: filePath, textureType: type, areaIndex: 1 });
  }
  for (const standardAssetTags of [[], ["Tile"], ["ThirdParty"]]) {
    const id = standardAssetTags[0] || "internal";
    const jobs = await buildExportAssets([{
      id, name: "Sample", assetType: "surface", source: "custom", path: root,
      standardAssetTags, tags: ["surface", "tile", ...(id === "ThirdParty" ? ["ThirdParty", "Megascans"] : [])],
      meta: { category: "Tile", baseTiling: 3.5, textureEntries, standardAssetTags }
    }], null, "4k");
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].meshOverwritePolicy, undefined);
    const job = jobs[0];
    assert.equal(job.exportRootPath, "/Game/Environment/Asset");
    assert.equal(job.categoryFolder, "TilableTex");
    assert.equal(job.assetFolderName, "Sample");
    assert.deepEqual(job.modelFiles, []);
    assert.deepEqual(job.modelVariants, []);
    assert.equal(job.materialParams.baseTiling, 3.5);
    // Surface 固定导出 BCR / N / AO / Dis；Metallic（M）仅在源贴图非空且非全 0 时导出（2026-10-29）。
    assert.deepEqual(job.textureSlots.map((slot) => [slot.slot, slot.resolution]),
      [["BCR", "4K"], ["N", "4K"], ["AO", "2K"], ["M", "2K"]]);
    for (const slot of job.textureSlots) {
      assert.ok(slot.file.endsWith(".tga"));
      assert.equal(slot.objectName, `T_Env_Tile_Sample_${id}_${slot.slot}`);
    }
    assert.ok(!job.tags.some((tag) => /^tile$/i.test(tag)));
    if (id === "ThirdParty") assert.ok(job.tags.includes("Megascans"));
  }
});

// 这两个函数/常量未导出，直接从源码里取出来求值，避免为了测试把它们加进公共 API。
function extractFunction(name) {
  const start = SOURCE.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `源码里找不到 ${name}`);
  // 必须从"参数表结束之后的第一个 {"开始数括号：
  // 直接从 function 之后找 "{" 会命中参数解构（如 `{ tags }`），截出来的函数体是空的。
  const paramsStart = SOURCE.indexOf("(", start);
  let parenDepth = 0, paramsEnd = -1;
  for (let i = paramsStart; i < SOURCE.length; i += 1) {
    if (SOURCE[i] === "(") parenDepth += 1;
    else if (SOURCE[i] === ")") { parenDepth -= 1; if (parenDepth === 0) { paramsEnd = i; break; } }
  }
  assert.ok(paramsEnd > paramsStart, `无法界定 ${name} 的参数表`);
  const bodyStart = SOURCE.indexOf("{", paramsEnd);
  let depth = 0, end = -1;
  for (let i = bodyStart; i < SOURCE.length; i += 1) {
    if (SOURCE[i] === "{") depth += 1;
    else if (SOURCE[i] === "}") { depth -= 1; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end > bodyStart, `无法界定 ${name} 的函数体`);
  return SOURCE.slice(start, end);
}

// 函数依赖模块级常量 PLUGIN_CATEGORY_TAGS，必须一起求值，否则 ReferenceError。
function extractConst(name) {
  const match = SOURCE.match(new RegExp(`const ${name} = Object\\.freeze\\(\\[[^\\]]*\\]\\);`));
  assert.ok(match, `源码里找不到常量 ${name}`);
  return match[0];
}

const HELPER_SOURCE = [
  extractConst("PLUGIN_CATEGORY_TAGS"),
  extractFunction("shouldDelegateCategoryFolderToPlugin"),
  extractFunction("resolveImportCategoryFolder"),
  extractFunction("resolveExportJobTags"),
].join("\n");

const helpers = new Function(`${HELPER_SOURCE}
  return { shouldDelegateCategoryFolderToPlugin, resolveImportCategoryFolder, PLUGIN_CATEGORY_TAGS, resolveExportJobTags };`)();
const shouldDelegate = helpers.shouldDelegateCategoryFolderToPlugin;
const resolveCategory = helpers.resolveImportCategoryFolder;
const resolveExportJobTags = helpers.resolveExportJobTags;
const PLUGIN_CATEGORY_TAGS = helpers.PLUGIN_CATEGORY_TAGS;

test("Megascans and PBRMAX delegate the category to the plugin", () => {
  for (const tag of ["Megascans", "PBRMAX", "ThirdParty", "Dressing", "Kits", "Kit", "Props", "Destructible", "MEGA"]) {
    assert.equal(shouldDelegate([tag]), true, `${tag} 应交给插件推导 → Objects/ThirdParty/Objects/Kit/Props/...`);
  }
});

test("tag matching is case and whitespace insensitive", () => {
  assert.equal(shouldDelegate(["  megascans "]), true);
  assert.equal(shouldDelegate(["pbrmax"]), true);
  // 第三方标签的常见写法都要识别（插件侧同样是归一化比较）
  assert.equal(shouldDelegate(["thirdparty"]), true);
  assert.equal(shouldDelegate(["Third Party"]), true);
});

test("assets without a classification tag keep the exporter's own folder", () => {
  assert.equal(shouldDelegate([]), false);
  assert.equal(shouldDelegate(["Temp"]), false, "Temp 只叠加前缀，不决定分类目录");
  assert.equal(shouldDelegate([""]), false);
  assert.equal(shouldDelegate([null, undefined]), false);
  assert.equal(shouldDelegate(undefined), false);
  // 这类资产仍按 assetType 落目录
  assert.equal(resolveCategory({ assetType: "3d" }), "3D_Assets");
  assert.equal(resolveCategory({ assetType: "surface" }), "Surfaces");
});

test("the exporter never sends 3D_Assets for a Megascans/PBRMAX asset", () => {
  // 模拟调用点：只要 tag 能推导就传空串，否则才给 resolveImportCategoryFolder 的结果
  const categoryFor = (asset) => (shouldDelegate(asset.standardAssetTags)
    ? ""
    : resolveCategory(asset));

  assert.equal(categoryFor({ assetType: "3d", standardAssetTags: ["Megascans"] }), "",
    "Megascans 必须传空串，让插件落到 Objects");
  assert.equal(categoryFor({ assetType: "3d", standardAssetTags: ["PBRMAX"] }), "",
    "PBRMAX 必须传空串，让插件落到 Objects");
  assert.equal(categoryFor({ assetType: "3d", standardAssetTags: ["Dressing"] }), "");
  // 没有分类 tag 的普通 3D 资产保持原行为
  assert.equal(categoryFor({ assetType: "3d", standardAssetTags: [] }), "3D_Assets");
  assert.equal(categoryFor({ assetType: "3d", standardAssetTags: ["Temp"] }), "3D_Assets");
});

test("the export job delegates folders for Zion, explicit Zion plants and classifiable third-party tags", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "assethive-category-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "Sample_01.fbx");
  fs.writeFileSync(file, "folder routing fixture");
  const base = { assetType: "3d", source: "custom", path: root, modelFiles: [file] };
  const [zion, plant, dressing, other] = await buildExportAssets([
    { ...base, id: "a", name: "Module", zionTags: ["Zion"] },
    { ...base, id: "b", name: "Reed", assetType: "3dplant", zionTags: ["Zion"], standardAssetTags: ["ThirdParty"] },
    { ...base, id: "c", name: "Pot", standardAssetTags: ["ThirdParty", "Dressing"] },
    { ...base, id: "d", name: "Other", tags: ["ThirdParty"], standardAssetTags: [] }
  ]);
  assert.deepEqual([zion, plant, dressing, other].map((asset) => asset.categoryFolder), ["", "", "", "3D_Assets"]);
  assert.equal(plant.assetFolderName, "Reed");
  assert.deepEqual([zion, plant, dressing, other].map(asset => asset.meshOverwritePolicy), ["all", "all", "all", "all"]);
});

test("mesh-only is sent per model while keeping the full payload available for a first import", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "assethive-mesh-policy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "Sample_01.fbx");
  fs.writeFileSync(file, "export fixture");
  const assets = ["3d", "3dplant"].map(assetType => ({
    id: assetType, name: "Sample", assetType, source: "custom", path: root, modelFiles: [file]
  }));
  const build = meshOverwritePolicy => buildExportAssets(assets, null, "4k", "decal", "lod", "none", new Map(), { meshOverwritePolicy });
  const initial = await build();
  assert.equal(initial.length, 2);
  const meshOnly = await build("meshOnly");
  assert.deepEqual(meshOnly, initial.map(asset => ({ ...asset, meshOverwritePolicy: "meshOnly" })));
  const targets = ["material", "texture", "mesh"];
  for (let mask = 0; mask < 8; mask++) {
    const selected = targets.filter((_, bit) => mask & (1 << bit));
    const policy = mask === 7 ? "all" : mask === 4 ? "meshOnly" : selected;
    assert.deepEqual(await build(selected), initial.map(asset => ({ ...asset, meshOverwritePolicy: policy })));
  }
  assert.deepEqual(await build("unknown"), initial);
});

test("mesh-only dispatches valid geometry when the material catalog is missing and leaves Common for UE to handle", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "assethive-mesh-dispatch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const model = path.join(root, "Stone_01.fbx");
  fs.writeFileSync(model, "mesh fixture");
  const projectPath = path.join(root, "Test.uproject");
  fs.writeFileSync(projectPath, "{}");
  const plugin = path.join(root, "Plugins", "AssetHive");
  fs.mkdirSync(plugin, { recursive: true });
  fs.writeFileSync(path.join(plugin, "AssetHive.uplugin"), "{}");
  const exporter = require.resolve("../electron/services/unrealExporter");
  const localRequire = require("node:module").createRequire(exporter);
  const jobs = [];
  const receiver = {
    getEditorInfo: async () => ({ projectPath, editorPath: path.join(root, "UnrealEditor.exe") }),
    importAssets: async job => { jobs.push(job); return { requestId: "test" }; }
  };
  const isolated = { exports: {} };
  new Function("module", "require", "__dirname", SOURCE)(isolated, name =>
    name === "electron" ? { app: { getPath: () => root } } :
      name === "./unrealDiscovery" ? { tcpClient: receiver } : localRequire(name), path.dirname(exporter));
  const asset = { id: "stone", name: "Stone", assetType: "3d", source: "custom", zionTags: ["Zion"],
    path: root, modelFiles: [model], meta: { materialNames: { 1: "Wood" } } };
  const { exportToUnreal } = isolated.exports;
  assert.equal((await exportToUnreal([asset], { meshOverwritePolicy: "all" })).ok, false);
  assert.equal(jobs.length, 0);
  assert.equal((await exportToUnreal([asset], { meshOverwritePolicy: "meshOnly" })).ok, true);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].prepareCommonOnFirstImport, true);
  assert.match(jobs[0].assets[0].firstImportError, /命名纹理套组/);
  assert.deepEqual(jobs[0].assets[0].modelFiles, [model]);
  assert.equal(fs.existsSync(path.join(root, "Content", "Common")), false);
});

test("classification tags and the exporter folder table stay in sync with the plugin", () => {
  // 插件 ResolveEnvironmentAssetProfile 里的 tag → 目录映射。
  // 这里校验"插件能识别的 tag 导出侧全都认得"，防止新增映射时漏掉。
  const pluginTags = ["mega", "kits", "kit", "destructible", "props", "dressing", "megascans", "pbrmax"];
  for (const tag of pluginTags) {
    assert.ok(PLUGIN_CATEGORY_TAGS.includes(tag), `${tag} 在插件里有映射，导出侧必须列进 PLUGIN_CATEGORY_TAGS`);
    assert.equal(shouldDelegate([tag]), true, `${tag} 应判定为"交给插件推导"`);
  }
});

test("a single resolved tag list feeds both the category and the job field", () => {
  // 同一份 tag 值必须同时用于分类判定与 job.standardAssetTags，避免两处分歧
  assert.ok(SOURCE.includes("const resolvedStandardAssetTags ="),
    "应先解析出一份标准 Asset Tag");
  const uses = SOURCE.split("resolvedStandardAssetTags").length - 1;
  assert.ok(uses >= 3, `resolvedStandardAssetTags 应被定义并使用（当前出现 ${uses} 次）`);
});

test("job tags drop assetType/category derived words", () => {
  // 库内 tagsJson 混入了 assetType / subType / category 派生词（3D 资产的 "props"），
  // 插件合并后会把 Megascans/PBRMAX 误判成 Props 档（后果：预算降档、命名带 Prop、
  // ORM <2048 无法开 VT）。导出 job 的 tags 必须在源头剔除这些派生词。
  const pbrMaxAsset = {
    assetType: "3d",
    standardAssetTags: ["PBRMAX"],
    tags: ["3d assets", "3d", "props", "pbrmax", "nature"],
  };
  const jobTags = resolveExportJobTags(pbrMaxAsset, { category: "Props" });
  assert.deepEqual(jobTags, ["pbrmax", "nature"],
    "派生词 3d assets/3d/props 必须剔除，真标签与用户标签保留");

  // 真的打了 Props 标准标签的资产，props 要保留（否则分类会丢）。
  const realPropsAsset = {
    assetType: "3d",
    standardAssetTags: ["Props"],
    tags: ["3d assets", "3d", "props"],
  };
  assert.deepEqual(resolveExportJobTags(realPropsAsset, { category: "Nature" }), ["props"]);

  // Legacy Tile is retired; Surface export no longer needs it as a tag.
  const tileSurface = {
    assetType: "surface",
    standardAssetTags: ["Tile"],
    tags: ["surfaces", "surface", "tile", "trim"],
  };
  assert.deepEqual(resolveExportJobTags(tileSurface, { category: "Trim" }), []);

  // Decal：assetType / category 派生词剔除。
  const pbrMaxDecal = {
    assetType: "decal",
    standardAssetTags: ["PBRMAX"],
    tags: ["decals", "decal", "trim", "pbrmax"],
  };
  assert.deepEqual(resolveExportJobTags(pbrMaxDecal, { category: "Trim" }), ["pbrmax"]);

  // 3D Plants 整包保留：category 派生词是插件判定 Tree/Bush/Grass 子类的语义信号。
  const plantAsset = {
    assetType: "3dplant",
    standardAssetTags: ["Megascans"],
    tags: ["foliage", "3dplant", "grass", "megascans"],
  };
  assert.deepEqual(resolveExportJobTags(plantAsset, { category: "Grass" }),
    ["foliage", "3dplant", "grass", "megascans"]);
});
