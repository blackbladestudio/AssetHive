"use strict";

// 资产库内「重新 Opaque 裁切」的回归测试：验证变体替换幂等、失败恢复与透贴缺失保护。

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");
const { isOpaqueModelFile, regenerateFoliageOpaqueVariants } = require("../electron/services/foliageOpaqueRegenerate");

const nameForModel = (variantKey) => `SM_fern_ab12_${variantKey}`.replace(/OPAQUE$/i, "_OPAQUE");

function makeMeta(assetDir) {
  const file = (name) => path.join(assetDir, name).replace(/\\/g, "/");
  return {
    assetID: "ab12",
    name: "fern",
    assetType: "3dplant",
    identity: { sourceKind: "megascans" },
    standardAssetTags: ["Megascans"],
    tags: ["3dplant", "megascans"],
    components: [
      { type: "model", slot: "Mesh", uri: "SM_fern_ab12_01.fbx", variantKey: "01", variantNumber: 1 },
      { type: "model", slot: "Mesh02", uri: "SM_fern_ab12_02.fbx", variantKey: "02", variantNumber: 2 },
      { type: "model", slot: "Mesh03", uri: "SM_fern_ab12_01_OPAQUE.fbx", variantKey: "01OPAQUE" },
      { type: "model", slot: "Mesh04", uri: "SM_fern_ab12_02_OPAQUE.fbx", variantKey: "02OPAQUE" },
      { type: "texture", slot: "AlbedoOpacityMasked", uri: "T_fern_ab12_Alpha.png", areaIndex: 1 }
    ],
    modelVariants: [
      { file: file("SM_fern_ab12_01.fbx"), variantKey: "01", variantNumber: 1 },
      { file: file("SM_fern_ab12_02.fbx"), variantKey: "02", variantNumber: 2 },
      { file: file("SM_fern_ab12_01_OPAQUE.fbx"), variantKey: "01OPAQUE" },
      { file: file("SM_fern_ab12_02_OPAQUE.fbx"), variantKey: "02OPAQUE" }
    ],
    modelLods: [
      { file: file("SM_fern_ab12_01_LOD1.fbx"), slot: "Mesh", lod: 1, variantKey: "01", variantNumber: 1 },
      { file: file("SM_fern_ab12_01_LOD1_OPAQUE.fbx"), slot: "Mesh03", lod: 1, variantKey: "01OPAQUE" }
    ],
    modelFiles: [
      file("SM_fern_ab12_01.fbx"),
      file("SM_fern_ab12_02.fbx"),
      file("SM_fern_ab12_01_OPAQUE.fbx"),
      file("SM_fern_ab12_02_OPAQUE.fbx")
    ],
    modelSlots: {
      Mesh: file("SM_fern_ab12_01.fbx"),
      Mesh02: file("SM_fern_ab12_02.fbx"),
      Mesh03: file("SM_fern_ab12_01_OPAQUE.fbx"),
      Mesh04: file("SM_fern_ab12_02_OPAQUE.fbx")
    },
    textureEntries: [{ textureType: "AlbedoOpacityMasked", areaIndex: 1, uri: "T_fern_ab12_Alpha.png" }],
    textureFiles: [file("T_fern_ab12_Alpha.png")],
    textureSlots: { AlbedoOpacityMasked: file("T_fern_ab12_Alpha.png") }
  };
}

async function setupAssetDir() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "assethive-regen-test-"));
  await fsp.writeFile(path.join(dir, "SM_fern_ab12_01.fbx"), "source-01");
  await fsp.writeFile(path.join(dir, "SM_fern_ab12_02.fbx"), "source-02");
  await fsp.writeFile(path.join(dir, "SM_fern_ab12_01_OPAQUE.fbx"), "old-cut-01");
  await fsp.writeFile(path.join(dir, "SM_fern_ab12_02_OPAQUE.fbx"), "old-cut-02");
  await fsp.writeFile(path.join(dir, "SM_fern_ab12_01_LOD1.fbx"), "lod-01");
  await fsp.writeFile(path.join(dir, "SM_fern_ab12_01_LOD1_OPAQUE.fbx"), "lod-cut-01");
  await fsp.writeFile(path.join(dir, "T_fern_ab12_Alpha.png"), "mask");
  return dir;
}

function meshOrderOf(slot) {
  const normalized = String(slot || "").trim().toLowerCase();
  if (normalized === "mesh") return 1;
  const matched = normalized.match(/^mesh(\d+)$/);
  return matched ? Number(matched[1]) : 1;
}

// 模拟真实的 buildFoliageOpaqueVariants：为每个源模型变体生成一个 _OPAQUE 文件，
// 并使用紧邻现有槽位之后的新 Mesh 槽位（与导入侧一致）。
function fakeGenerator(options = {}) {
  const only = options.only || null;
  return async (args) => {
    let nextOrder = 1 + Math.max(1, ...args.modelEntries.map((entry) => meshOrderOf(entry.suffix)));
    const added = [];
    for (const entry of args.modelEntries) {
      if (!args.isMeshSlot(entry.suffix)) continue;
      if (only && !only.includes(entry.variantKey)) continue;
      const variantKey = `${entry.variantKey}OPAQUE`;
      const output = path.join(args.destinationDir, `${args.nameForModel(variantKey)}.fbx`);
      await fsp.writeFile(output, `new-cut-${entry.variantKey}`);
      added.push({
        suffix: args.meshSlotNameForOrder(nextOrder),
        path: output,
        variantKey,
        opaqueSourceSlot: entry.suffix
      });
      nextOrder += 1;
    }
    return { ok: added.length > 0, added, warnings: [], message: added.length > 0 ? "" : "没有生成任何裁切变体" };
  };
}

test("opaque cut detection accepts canonical and legacy names", () => {
  assert.equal(isOpaqueModelFile("SM_x_01_OPAQUE.fbx"), true);
  assert.equal(isOpaqueModelFile("SM_x_01OPAQUE.fbx"), true);
  assert.equal(isOpaqueModelFile("SM_x_01.fbx"), false);
  assert.equal(isOpaqueModelFile("T_x_01_OPAQUE.png"), false);
});

test("regenerate replaces previous cut variants and stays idempotent", async () => {
  const dir = await setupAssetDir();
  try {
    const meta = makeMeta(dir);
    const first = await regenerateFoliageOpaqueVariants({
      assetDir: dir,
      assetId: "ab12",
      assetName: "fern",
      meta,
      nameForModel,
      generateVariants: fakeGenerator()
    });
    assert.equal(first.ok, true);
    assert.equal(first.generated, 2);
    assert.equal(first.removedFiles, 3);
    assert.equal(await fsp.readFile(path.join(dir, "SM_fern_ab12_01_OPAQUE.fbx"), "utf8"), "new-cut-01");
    assert.equal(await fsp.readFile(path.join(dir, "SM_fern_ab12_02_OPAQUE.fbx"), "utf8"), "new-cut-02");
    assert.deepEqual(
      meta.modelVariants.filter((record) => /OPAQUE$/i.test(String(record.variantKey))).map((record) => record.variantKey).sort(),
      ["01OPAQUE", "02OPAQUE"]
    );
    assert.equal(meta.modelFiles.length, 4);
    assert.deepEqual(Object.keys(meta.modelSlots).sort(), ["Mesh", "Mesh02", "Mesh03", "Mesh04"]);
    assert.equal(meta.modelLods.length, 1);
    assert.equal(meta.modelLods.some((record) => /OPAQUE$/i.test(String(record.variantKey))), false);
    await assert.rejects(() => fsp.stat(path.join(dir, "SM_fern_ab12_01_LOD1_OPAQUE.fbx")));

    const second = await regenerateFoliageOpaqueVariants({
      assetDir: dir,
      assetId: "ab12",
      assetName: "fern",
      meta,
      nameForModel,
      generateVariants: fakeGenerator()
    });
    assert.equal(second.ok, true);
    assert.equal(second.generated, 2);
    assert.equal(second.removedFiles, 2);
    const fbxFiles = (await fsp.readdir(dir)).filter((name) => /\.fbx$/i.test(name)).sort();
    assert.deepEqual(fbxFiles, [
      "SM_fern_ab12_01.fbx",
      "SM_fern_ab12_01_LOD1.fbx",
      "SM_fern_ab12_01_OPAQUE.fbx",
      "SM_fern_ab12_02.fbx",
      "SM_fern_ab12_02_OPAQUE.fbx"
    ]);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("total failure restores previous cut files and leaves metadata untouched", async () => {
  const dir = await setupAssetDir();
  try {
    const meta = makeMeta(dir);
    const before = JSON.stringify(meta);
    const failed = await regenerateFoliageOpaqueVariants({
      assetDir: dir,
      assetId: "ab12",
      assetName: "fern",
      meta,
      nameForModel,
      generateVariants: async () => ({ ok: false, added: [], warnings: [], message: "处理器缺失" })
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.message, "处理器缺失");
    assert.equal(await fsp.readFile(path.join(dir, "SM_fern_ab12_01_OPAQUE.fbx"), "utf8"), "old-cut-01");
    assert.equal(await fsp.readFile(path.join(dir, "SM_fern_ab12_02_OPAQUE.fbx"), "utf8"), "old-cut-02");
    assert.equal(await fsp.readFile(path.join(dir, "SM_fern_ab12_01_LOD1_OPAQUE.fbx"), "utf8"), "lod-cut-01");
    assert.equal(JSON.stringify(meta), before);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("partial failure keeps regenerated variants and restores the missing ones", async () => {
  const dir = await setupAssetDir();
  try {
    const meta = makeMeta(dir);
    const partial = await regenerateFoliageOpaqueVariants({
      assetDir: dir,
      assetId: "ab12",
      assetName: "fern",
      meta,
      nameForModel,
      generateVariants: fakeGenerator({ only: ["01"] })
    });
    assert.equal(partial.ok, true);
    assert.equal(partial.generated, 1);
    assert.equal(partial.restoredVariants, 1);
    assert.equal(await fsp.readFile(path.join(dir, "SM_fern_ab12_01_OPAQUE.fbx"), "utf8"), "new-cut-01");
    assert.equal(await fsp.readFile(path.join(dir, "SM_fern_ab12_02_OPAQUE.fbx"), "utf8"), "old-cut-02");
    await assert.rejects(() => fsp.stat(path.join(dir, "SM_fern_ab12_01_LOD1_OPAQUE.fbx")));
    const opaqueVariants = meta.modelVariants.filter((record) => /OPAQUE$/i.test(String(record.variantKey)));
    assert.deepEqual(opaqueVariants.map((record) => record.variantKey).sort(), ["01OPAQUE", "02OPAQUE"]);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("custom cut options are forwarded to the cut pipeline", async () => {
  const dir = await setupAssetDir();
  try {
    const meta = makeMeta(dir);
    let received = null;
    const capture = async (args) => {
      received = args;
      return { ok: true, added: [], warnings: [], message: "stop-after-capture" };
    };
    const outcome = await regenerateFoliageOpaqueVariants({
      assetDir: dir,
      assetId: "ab12",
      assetName: "fern",
      meta,
      nameForModel,
      cutOptions: { contourPrecisionTexels: 0.5, maskErodeTexels: 2, fillHoles: false, holeMaxAreaTexels: 128, faceBudget: 123456, cleanupPercent: 3.5 },
      generateVariants: capture
    });
    assert.equal(outcome.ok, false);
    assert.equal(received.contourPrecisionTexels, 0.5);
    assert.equal(received.maskErodeTexels, 2);
    // 孔洞填充必须逐项透传：少下发不会报错，只会让重切悄悄退回处理器默认值。
    assert.equal(received.fillHoles, false);
    assert.equal(received.holeMaxAreaTexels, 128);
    assert.equal(received.faceBudget, 123456);
    assert.equal(received.cleanupPercent, 3.5);
    assert.equal(await fsp.readFile(path.join(dir, "SM_fern_ab12_01_OPAQUE.fbx"), "utf8"), "old-cut-01");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("library re-cut panel exposes adjustable parameters", async () => {
  const source = await fsp.readFile(path.join(__dirname, "..", "src", "ui", "App.tsx"), "utf8");
  assert.match(source, /foliage-opaque-cut-panel/);
  assert.match(source, /function buildFoliageOpaqueCutOptions/);
  assert.match(source, /toggleFoliageOpaqueCutPanel/);
  // 孔洞填充必须在导入面板与重切面板都有控件（默认开 + 面积上限）。
  assert.match(source, /foliageOpaqueFillHolesEnabled/);
  assert.match(source, /foliageOpaqueHoleMaxAreaTexels/);
  assert.match(source, /resolveFoliageOpaqueHoleMaxAreaTexels/);
  assert.match(source, /bridge\.regenerateFoliageOpaque\(\{[\s\S]{0,160}options: cutOptions/);
});

test("Zion plants reject geometry cuts while third-party FBX plants retain the controls", async () => {
  const source = await fsp.readFile(path.join(__dirname, "../src/ui/App.tsx"), "utf8");
  const parsed = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = ["collectAssetModelFilePaths", "collectQuickFilterTagKeys", "isZionPlantAsset", "supportsPlantExportMode", "canRegenerateFoliageOpaqueCut", "canSelectPlantExportMode"];
  const functions = parsed.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
  assert.equal(functions.length, names.length);
  const markerKeys = parsed.statements.find((node) => ts.isVariableStatement(node)
    && node.declarationList.declarations.some((item) => item.name.getText(parsed) === "QUICK_THIRD_PARTY_TAG_KEYS"));
  const compiled = ts.transpileModule([markerKeys, ...functions].map((node) => node.getText(parsed)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const rules = new Function(`${compiled}; return { canRegenerateFoliageOpaqueCut, canSelectPlantExportMode };`)();
  const asset = { source: "custom", assetType: "3dplant", modelFiles: ["D:/Grass_01.fbx"], zionTags: ["Zion"], standardAssetTags: ["Grass"] };
  assert.equal(rules.canRegenerateFoliageOpaqueCut(asset), false);
  assert.equal(rules.canSelectPlantExportMode(asset), false);
  assert.equal(rules.canSelectPlantExportMode({ ...asset, modelFiles: [...asset.modelFiles, "D:/Grass_01_OPAQUE.fbx"] }), false);
  const thirdParty = { ...asset, zionTags: [], standardAssetTags: ["ThirdParty", "Grass"] };
  assert.equal(rules.canRegenerateFoliageOpaqueCut(thirdParty), true);
  assert.equal(rules.canSelectPlantExportMode(thirdParty), true, "Opaque remains selectable before a cut exists; export falls back to Nanite Masked");
  assert.equal(rules.canSelectPlantExportMode({ ...thirdParty, modelFiles: [...asset.modelFiles, "D:/Grass_01_OPAQUE.fbx"] }), true);
  assert.equal(rules.canRegenerateFoliageOpaqueCut({ ...thirdParty, zionTags: ["Zion"] }), false);
  assert.equal(rules.canRegenerateFoliageOpaqueCut({ ...thirdParty, tags: ["Temp"] }), false);
  for (const invalid of [null, { ...asset, source: "megascans" }, { ...asset, assetType: "3d" }, { ...asset, modelFiles: [] },
    { ...asset, modelFiles: ["D:/Tree.st9"] }, { ...asset, modelFiles: [...asset.modelFiles, "D:/Tree.st9"] }]) {
    assert.equal(rules.canRegenerateFoliageOpaqueCut(invalid), false);
  }
  const main = await fsp.readFile(path.join(__dirname, "../electron/main.js"), "utf8");
  const mainParsed = ts.createSourceFile("main.js", main, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const handler = mainParsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "regenerateFoliageOpaqueCut");
  const regenerate = new Function("index", "loadJson", "foliageOpaqueRegenInFlight", "foliageOpaqueStatus", "isZionPlantAsset",
    `${handler.getText(mainParsed)}; return regenerateFoliageOpaqueCut;`)(
    [asset, thirdParty].map((item, i) => ({ ...item, id: String(i), path: "D:/Library/Grass", metaPath: "D:/Library/Grass/asset_info.json" })),
    async () => ({}), new Set(), () => ({ available: false, message: "runtime-check-reached" }),
    require("../electron/services/unrealExporter").isZionPlantAsset);
  assert.match((await regenerate({ assetId: "0" })).message, /Zion.*不支持 OPAQUE/);
  assert.equal((await regenerate({ assetId: "1" })).message, "runtime-check-reached");
});

test("re-cut rejects mixed FBX/ST9 source models before changing any existing files", async (t) => {
  const dir = await setupAssetDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const meta = makeMeta(dir);
  meta.identity = { sourceKind: "custom" };
  meta.standardAssetTags = ["Tree"];
  meta.components[0].uri = "Tree.st9";
  let invoked = false;
  const result = await regenerateFoliageOpaqueVariants({
    assetDir: dir, assetId: "ab12", meta, generateVariants: async () => { invoked = true; }
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /FBX/);
  assert.equal(invoked, false);
  assert.equal(await fsp.readFile(path.join(dir, "SM_fern_ab12_01_OPAQUE.fbx"), "utf8"), "old-cut-01");
});

test("missing mask aborts before touching existing cut files", async () => {
  const dir = await setupAssetDir();
  try {
    await fsp.rm(path.join(dir, "T_fern_ab12_Alpha.png"), { force: true });
    const meta = makeMeta(dir);
    const skipped = await regenerateFoliageOpaqueVariants({
      assetDir: dir,
      assetId: "ab12",
      assetName: "fern",
      meta,
      nameForModel,
      generateVariants: fakeGenerator()
    });
    assert.equal(skipped.ok, false);
    assert.match(skipped.message, /透贴/);
    assert.equal(await fsp.readFile(path.join(dir, "SM_fern_ab12_01_OPAQUE.fbx"), "utf8"), "old-cut-01");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
