const assert = require("node:assert/strict");
const { Buffer } = require("node:buffer");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { test } = require("node:test");
const {
  parseModelVariantKey,
  normalizeModelVariantKey,
  stripModelVariantKey,
  modelVariantNumberFromKey,
  buildModelVariantKeyMap,
  toOpaqueVariantFileStem
} = require("../electron/services/modelVariants");
const { buildModelLodPlan } = require("../electron/services/modelLods");
const { groupDroppedAssets } = require("../electron/services/dropAssetGroups");
const {
  collectCustomJsonModelVariants,
  buildExportModelPlan,
  buildExportAssets,
  normalizePlantExportMode,
  normalizePlantSyntheticWind,
  pickExportModelFiles,
  pickExportModelVariants,
  collectTextureGroupsForExport,
  filterPlantTextureGroupsForExport
} = require("../electron/services/unrealExporter");

test("model variant keys support numeric, alphabetic and mixed suffixes", () => {
  assert.equal(parseModelVariantKey("Var1_LOD0.fbx"), "01");
  assert.equal(parseModelVariantKey("Variation_12_LOD1.fbx"), "12");
  assert.equal(parseModelVariantKey("SM_Env_Props_WoodenBox_01.fbx"), "01");
  assert.equal(parseModelVariantKey("SM_Env_Props_WoodenBox-17.fbx"), "17");
  assert.equal(parseModelVariantKey("SM_Env_Props_WoodenBox_Var_03.fbx"), "03");
  assert.equal(parseModelVariantKey("SM_Env_Props_WoodenBox_Variant_B.fbx"), "B");
  assert.equal(parseModelVariantKey("SM_Env_Props_WoodenBox_A.fbx"), "A");
  assert.equal(parseModelVariantKey("SM_Env_Props_WoodenBox_b2.fbx"), "B2");
  assert.equal(parseModelVariantKey("SM_Env_Props_WoodenBox_04A.fbx"), "04A");
  assert.equal(parseModelVariantKey("SM_xeogciyqx_VarD.FBX"), "D");
  assert.equal(parseModelVariantKey("S_Dead_Shrubs_vdknafgha_Var11_lod1_Test.FBX"), "11");
  assert.equal(parseModelVariantKey("SM_Env_Props_WoodenBox_LOD0.fbx"), "");
  assert.equal(parseModelVariantKey("SM_Env_Props_WoodenBox_4K.fbx"), "");
  assert.equal(parseModelVariantKey("SM_Env_Props_Rock_Oak.fbx"), "");
  assert.equal(parseModelVariantKey("SM_Env_Props_Rock_Box.fbx"), "");

  assert.equal(normalizeModelVariantKey(2), "02");
  assert.equal(stripModelVariantKey("SM_xeogciyqx_VarD.FBX"), "SM_xeogciyqx");
  assert.equal(normalizeModelVariantKey("a"), "A");
  assert.equal(modelVariantNumberFromKey("A"), 0);
  assert.equal(modelVariantNumberFromKey("02"), 2);

  const variants = buildModelVariantKeyMap([
    ["Mesh", "D:\\incoming\\WoodenBox_03.fbx"],
    ["Mesh02", "D:\\incoming\\WoodenBox.fbx"],
    ["Mesh03", "D:\\incoming\\Rock_A.fbx"],
    ["Mesh04", "D:\\incoming\\Rock_B.fbx"]
  ]);
  assert.equal(variants.get("mesh"), "03");
  assert.equal(variants.get("mesh02"), "01");
  assert.equal(variants.get("mesh03"), "A");
  assert.equal(variants.get("mesh04"), "B");
});

test("model LOD plan keeps each variant with its own FBX LOD chain", () => {
  const root = path.resolve("D:\\BridgeLibrary\\Downloaded\\3dplant\\3dplant_fern_vmkpdbeia");
  const entries = [];
  for (const variation of [1, 2]) {
    for (const lod of [0, 1, 2, 3, 4]) {
      entries.push({ filePath: path.join(root, `Var${variation}`, `Var${variation}_LOD${lod}.abc`), variantKey: String(variation) });
      entries.push({ filePath: path.join(root, `Var${variation}`, `Var${variation}_LOD${lod}.fbx`), variantKey: String(variation) });
    }
  }
  const plan = buildModelLodPlan(entries);
  assert.deepEqual(plan.primaryFiles, [
    path.join(root, "Var1", "Var1_LOD0.fbx"),
    path.join(root, "Var2", "Var2_LOD0.fbx")
  ]);
  assert.deepEqual(plan.modelVariants, [
    { file: path.join(root, "Var1", "Var1_LOD0.fbx"), variantKey: "01", variantNumber: 1 },
    { file: path.join(root, "Var2", "Var2_LOD0.fbx"), variantKey: "02", variantNumber: 2 }
  ]);
  assert.equal(plan.modelLods.length, 10);
  assert.equal(plan.modelLods.filter((item) => item.variantKey === "01").map((item) => item.lod).join(","), "0,1,2,3,4");
  assert.equal(plan.modelLods.filter((item) => item.variantKey === "02").map((item) => item.lod).join(","), "0,1,2,3,4");
  assert.ok(plan.modelLods.every((item) => item.file.endsWith(".fbx")), "FBX wins over duplicate ABC LODs");
});

test("ordinary FBX LOD chains stay grouped with their variants", () => {
  const root = path.resolve("D:\\incoming\\PlantPack");
  const files = [
    path.join(root, "Plant_A.fbx"),
    path.join(root, "Plant_A_LOD1.fbx"),
    path.join(root, "Plant_B.fbx"),
    path.join(root, "Plant_B_LOD1.fbx")
  ];
  const assets = groupDroppedAssets(files);
  assert.equal(assets.length, 1);
  assert.deepEqual(assets[0].metadata.modelFiles, [
    path.join(root, "Plant_A.fbx"),
    path.join(root, "Plant_B.fbx")
  ]);
  assert.deepEqual(
    assets[0].metadata.modelVariants.map((item) => item.variantKey),
    ["A", "B"]
  );
  assert.deepEqual(
    assets[0].metadata.modelLods.map((item) => `${item.variantKey}:${item.lod}`),
    ["A:0", "A:1", "B:0", "B:1"]
  );
});

test("LOD-only FBX variants use their lowest LOD as the main model", () => {
  const root = path.resolve("D:\\incoming\\LodOnlyPlants");
  const files = [
    path.join(root, "Plant_A_LOD0.fbx"),
    path.join(root, "Plant_A_LOD1.fbx"),
    path.join(root, "Plant_B_LOD0.fbx"),
    path.join(root, "Plant_B_LOD1.fbx")
  ];
  const assets = groupDroppedAssets(files);
  assert.equal(assets.length, 1);
  assert.deepEqual(assets[0].metadata.modelFiles, [
    path.join(root, "Plant_A_LOD0.fbx"),
    path.join(root, "Plant_B_LOD0.fbx")
  ]);
  assert.deepEqual(
    assets[0].metadata.modelVariants.map((item) => item.variantKey),
    ["A", "B"]
  );
  assert.deepEqual(
    assets[0].metadata.modelLods.map((item) => `${item.variantKey}:${item.lod}`),
    ["A:0", "A:1", "B:0", "B:1"]
  );
});

test("export payload prefers imported metadata and preserves numeric keys", () => {
  const assetRoot = path.resolve("D:\\library\\Environment\\3d_wooden_box_ab12cd3");
  const first = path.join(assetRoot, "SM_WoodenBox_ab12cd3_02.fbx");
  const second = path.join(assetRoot, "SM_WoodenBox_ab12cd3_05.fbx");
  const plant = path.join(assetRoot, "SpeedTree_Tree.st9");
  const asset = {
    source: "custom",
    assetType: "3d",
    path: assetRoot,
    modelFiles: [second, first],
    meta: {
      modelVariants: [
        { file: first, variantNumber: 2 },
        { file: second, variantNumber: 5 }
      ]
    }
  };

  assert.deepEqual(collectCustomJsonModelVariants(asset), [
    { file: first, variantKey: "02", variantNumber: 2 },
    { file: second, variantKey: "05", variantNumber: 5 }
  ]);

  const plantAsset = {
    source: "custom",
    assetType: "3dplant",
    path: assetRoot,
    modelFiles: [plant],
    meta: { modelVariants: [{ file: plant, variantKey: "B" }] }
  };
  assert.deepEqual(pickExportModelFiles(plantAsset), [plant]);
  assert.deepEqual(collectCustomJsonModelVariants(plantAsset), [
    { file: plant, variantKey: "B" }
  ]);
  assert.deepEqual(pickExportModelVariants(plantAsset), [
    { file: plant, variantKey: "B" }
  ]);
});

test("export metadata variant wins over a conflicting filename variant", () => {
  const assetRoot = path.resolve("D:\\library\\Environment\\3d_megascans_rock");
  const file = path.join(assetRoot, "SM_Rock_ab12cd3_02.fbx");
  const asset = {
    source: "custom",
    assetType: "3d",
    path: assetRoot,
    modelFiles: [file],
    meta: {
      modelVariants: [{ file, variantKey: "A", variationId: "ignored" }],
      components: [
        { type: "model", slot: "Mesh", uri: path.basename(file), variantNumber: 2 }
      ]
    }
  };

  assert.deepEqual(pickExportModelVariants(asset), [
    { file, variantKey: "A" }
  ]);
});

test("export falls back to pbr filenames for alphabetic variants", () => {
  const assetRoot = path.resolve("D:\\library\\Environment\\3d_pbrmax_assets");
  const alpha = path.join(assetRoot, "00369_MD_Stone_A.fbx");
  const beta = path.join(assetRoot, "00369_MD_Stone_B.fbx");
  const asset = {
    source: "custom",
    assetType: "3d",
    path: assetRoot,
    modelFiles: [beta, alpha],
    meta: {}
  };

  assert.deepEqual(pickExportModelVariants(asset), [
    { file: alpha, variantKey: "A" },
    { file: beta, variantKey: "B" }
  ]);
});

test("export defaults to 01 when neither metadata nor filename has a variant", () => {
  const assetRoot = path.resolve("D:\\library\\Environment\\3d_pbrmax_assets");
  const file = path.join(assetRoot, "00370_MD_Wood.fbx");
  const asset = {
    source: "custom",
    assetType: "3d",
    path: assetRoot,
    modelFiles: [file],
    meta: {}
  };

  assert.deepEqual(pickExportModelVariants(asset), [
    { file, variantKey: "01", variantNumber: 1 }
  ]);
});

test("export falls back to component variant keys and old model lists", () => {
  const assetRoot = path.resolve("D:\\library\\Environment\\3d_old_asset");
  const oldModel = path.join(assetRoot, "SM_Old_asset_07.fbx");
  const asset = {
    source: "custom",
    assetType: "3d",
    path: assetRoot,
    meta: {
      components: [
        { type: "model", slot: "Mesh", uri: path.basename(oldModel), variantNumber: 7 }
      ]
    }
  };
  assert.deepEqual(pickExportModelVariants(asset), [
    { file: oldModel, variantKey: "07", variantNumber: 7 }
  ]);

  const legacyAsset = {
    source: "custom",
    assetType: "3d",
    path: assetRoot,
    modelFiles: [oldModel],
    meta: {}
  };
  assert.deepEqual(pickExportModelVariants(legacyAsset), [
    { file: oldModel, variantKey: "07", variantNumber: 7 }
  ]);
});

test("OPAQUE cut mesh file names keep the source variant key", () => {
  assert.equal(parseModelVariantKey("SM_wild_grass_oev2a42_01_OPAQUE.fbx"), "01OPAQUE");
  assert.equal(parseModelVariantKey("SM_Env_Grass_id_12_OPAQUE.FBX"), "12OPAQUE");
  assert.equal(parseModelVariantKey("SM_Env_Grass_id_VarB_OPAQUE.fbx"), "BOPAQUE");
  // Legacy compact suffix remains readable for older libraries.
  assert.equal(parseModelVariantKey("SM_wild_grass_oev2a42_01OPAQUE.fbx"), "01OPAQUE");
  assert.equal(parseModelVariantKey("SM_Env_Grass_id_VarBOPAQUE.fbx"), "BOPAQUE");
  assert.equal(parseModelVariantKey("SM_Env_Grass_OPAQUE.fbx"), "");
  assert.equal(parseModelVariantKey("SM_x_OPAQUE.fbx"), "");
  assert.equal(parseModelVariantKey("SM_Env_Grass_LOD0.fbx"), "");
  assert.equal(stripModelVariantKey("SM_wild_grass_oev2a42_01_OPAQUE.fbx"), "SM_wild_grass_oev2a42");
  assert.equal(stripModelVariantKey("SM_Env_Grass_id_VarB_OPAQUE.fbx"), "SM_Env_Grass_id");
  assert.equal(toOpaqueVariantFileStem("SM_wild_grass_oev2a42_01OPAQUE"), "SM_wild_grass_oev2a42_01_OPAQUE");
  assert.equal(toOpaqueVariantFileStem("SM_wild_grass_oev2a42_01_OPAQUE"), "SM_wild_grass_oev2a42_01_OPAQUE");
  assert.equal(toOpaqueVariantFileStem("SM_Env_Grass_id_VarBOPAQUE"), "SM_Env_Grass_id_B_OPAQUE");
  assert.equal(normalizeModelVariantKey("01OPAQUE"), "01OPAQUE");
  assert.equal(normalizeModelVariantKey("VAR1_OPAQUE"), "01OPAQUE");
  assert.equal(modelVariantNumberFromKey("01OPAQUE"), 0);
});

test("Megascans grass OPAQUE export resolves legacy metadata that renumbered the cut mesh", () => {
  const root = path.resolve("D:\\library\\Environment\\3dplant_grass_legacy");
  const normal0 = path.join(root, "SM_Grass_id_01.fbx");
  const normal1 = path.join(root, "SM_Grass_id_02.fbx");
  const normal0Lod1 = path.join(root, "SM_Grass_id_01_LOD1.fbx");
  const normal1Lod1 = path.join(root, "SM_Grass_id_02_LOD1.fbx");
  const opaque0 = path.join(root, "SM_Grass_id_01_OPAQUE.fbx");
  const opaque1 = path.join(root, "SM_Grass_id_02_OPAQUE.fbx");
  const asset = {
    source: "custom",
    assetType: "3dplant",
    path: root,
    standardAssetTags: ["Megascans", "Grass"],
    modelFiles: [normal0, normal1, normal0Lod1, normal1Lod1, opaque0, opaque1]
  };
  // Legacy metadata numbered the cut meshes as implicit variants 03 / 04.
  const meta = {
    identity: { sourceKind: "megascans" },
    modelVariants: [
      { file: normal0, variantKey: "01" },
      { file: normal1, variantKey: "02" },
      { file: opaque0, variantKey: "03" },
      { file: opaque1, variantKey: "04" }
    ],
    modelLods: [
      { file: normal0, variantKey: "01", lod: 0 },
      { file: normal0Lod1, variantKey: "01", lod: 1 },
      { file: normal1, variantKey: "02", lod: 0 },
      { file: normal1Lod1, variantKey: "02", lod: 1 }
    ]
  };

  const opaquePlan = buildExportModelPlan(asset, meta, "opaque");
  assert.deepEqual(opaquePlan.modelVariants, [
    { file: opaque0, variantKey: "01", variantNumber: 1, opaque: true },
    { file: opaque1, variantKey: "02", variantNumber: 2, opaque: true }
  ]);
  assert.deepEqual(opaquePlan.modelLods, []);

  const lodPlan = buildExportModelPlan(asset, meta, "lod");
  assert.deepEqual(lodPlan.modelVariants, [
    { file: normal0, variantKey: "01", variantNumber: 1 },
    { file: normal1, variantKey: "02", variantNumber: 2 }
  ]);
  // LOD0 is the base mesh itself, so only the derived LOD chain is listed.
  assert.deepEqual(lodPlan.modelLods.map((item) => path.basename(item.file)), [
    "SM_Grass_id_01_LOD1.fbx",
    "SM_Grass_id_02_LOD1.fbx"
  ]);
});

test("Megascans grass OPAQUE export mode uses the cut mesh and carries no LODs", () => {
  const root = path.resolve("D:\\library\\Environment\\3dplant_grass");
  const normal0 = path.join(root, "SM_Grass_id_01.fbx");
  const opaque0 = path.join(root, "SM_Grass_id_01_OPAQUE.fbx");
  const normal1 = path.join(root, "SM_Grass_id_01_LOD1.fbx");
  const normal2 = path.join(root, "SM_Grass_id_01_LOD2.fbx");
  const asset = {
    source: "custom",
    assetType: "3dplant",
    path: root,
    standardAssetTags: ["Megascans", "Grass"],
    modelFiles: [normal0, opaque0, normal1, normal2]
  };
  const meta = {
    identity: { sourceKind: "megascans" },
    modelVariants: [
      { file: normal0, variantKey: "01" },
      { file: opaque0, variantKey: "01OPAQUE" }
    ],
    modelLods: [
      { file: normal0, variantKey: "01", lod: 0 },
      { file: normal1, variantKey: "01", lod: 1 },
      { file: normal2, variantKey: "01", lod: 2 }
    ]
  };
  const plan = buildExportModelPlan(asset, meta, "opaque");
  assert.deepEqual(plan.modelVariants, [
    { file: opaque0, variantKey: "01", variantNumber: 1, opaque: true }
  ]);
  assert.deepEqual(plan.modelLods, []);
});

test("Megascans grass LOD export mode keeps the masked model with its own LOD chain", () => {
  const root = path.resolve("D:\\library\\Environment\\3dplant_grass");
  const normal0 = path.join(root, "SM_Grass_id_01.fbx");
  const opaque0 = path.join(root, "SM_Grass_id_01_OPAQUE.fbx");
  const normal1 = path.join(root, "SM_Grass_id_01_LOD1.fbx");
  const normal2 = path.join(root, "SM_Grass_id_01_LOD2.fbx");
  const asset = {
    source: "custom",
    assetType: "3dplant",
    path: root,
    standardAssetTags: ["Megascans", "Grass"],
    modelFiles: [normal0, opaque0, normal1, normal2]
  };
  const meta = {
    identity: { sourceKind: "megascans" },
    modelVariants: [
      { file: normal0, variantKey: "01" },
      { file: opaque0, variantKey: "01OPAQUE" }
    ],
    modelLods: [
      { file: normal0, variantKey: "01", lod: 0 },
      { file: normal1, variantKey: "01", lod: 1 },
      { file: normal2, variantKey: "01", lod: 2 }
    ]
  };
  const plan = buildExportModelPlan(asset, meta, "lod");
  assert.deepEqual(plan.modelVariants, [
    { file: normal0, variantKey: "01", variantNumber: 1 }
  ]);
  assert.deepEqual(plan.modelLods, [
    { file: normal1, variantKey: "01", variantNumber: 1, lod: 1 },
    { file: normal2, variantKey: "01", variantNumber: 1, lod: 2 }
  ]);
});

test("Nanite Masked exports only each original FBX LOD0, even with mixed legacy model lists", () => {
  const root = path.resolve("library", "cotton");
  const normal = path.join(root, "Var1.fbx"), base = path.join(root, "Var1_LOD0.fbx");
  const low = path.join(root, "Var1_LOD1.fbx"), cut = path.join(root, "Var1_LOD0_OPAQUE.fbx");
  const second = path.join(root, "Var2.fbx"), billboard = path.join(root, "Var3_Billboard.fbx");
  const asset = { path: root, assetType: "3dplant", standardAssetTags: ["ThirdParty"] };
  const meta = { modelFiles: [cut, low, normal, second, billboard],
    modelLods: [{ file: base, variantKey: "01", lod: 0 }, { file: low, variantKey: "01", lod: 1 }] };
  for (const input of [asset, { ...asset, zionTags: ["Zion"] }]) {
    const result = buildExportModelPlan(input, meta, "Nanite Masked");
    assert.equal(result.naniteMasked, true);
    assert.deepEqual(result.modelVariants.map(v => v.file), [base, second]);
    assert.deepEqual(result.modelLods, []);
  }
  assert.throws(() => buildExportModelPlan(asset, { modelFiles: [cut, low] }, "naniteMasked"), /LOD0/);
  const st9 = path.join(root, "Var1.st9");
  assert.deepEqual(buildExportModelPlan(asset, { modelFiles: [st9] }, "naniteMasked"),
    buildExportModelPlan(asset, { modelFiles: [st9] }));
  assert.equal(normalizePlantExportMode("masked"), "lod");
});

test("Megascans bush OPAQUE mode falls back to Nanite Masked LOD0 when no cut variant exists", () => {
  const root = path.resolve("D:\\library\\Environment\\3dplant_bush");
  const normal0 = path.join(root, "SM_Bush_id_02.fbx");
  const normal1 = path.join(root, "SM_Bush_id_02_LOD1.fbx");
  const asset = {
    source: "custom",
    assetType: "3dplant",
    path: root,
    standardAssetTags: ["Megascans", "Bush"]
  };
  const meta = {
    identity: { sourceKind: "megascans" },
    modelVariants: [{ file: normal0, variantKey: "02" }],
    modelLods: [
      { file: normal0, variantKey: "02", lod: 0 },
      { file: normal1, variantKey: "02", lod: 1 }
    ]
  };
  const plan = buildExportModelPlan(asset, meta, "opaque");
  assert.deepEqual(plan.modelVariants, [
    { file: normal0, variantKey: "02", variantNumber: 2, naniteMasked: true }
  ]);
  assert.deepEqual(plan.modelLods, []);
});

test("Megascans bush LOD export mode falls back to a single base model without LOD entries", () => {
  const root = path.resolve("D:\\library\\Environment\\3dplant_bush");
  const normal0 = path.join(root, "SM_Bush_id_02.fbx");
  const asset = {
    source: "custom",
    assetType: "3dplant",
    path: root,
    standardAssetTags: ["Megascans", "Bush"]
  };
  const meta = {
    identity: { sourceKind: "megascans" },
    modelVariants: [{ file: normal0, variantKey: "02" }]
  };
  const plan = buildExportModelPlan(asset, meta, "lod");
  assert.deepEqual(plan.modelVariants, [
    { file: normal0, variantKey: "02", variantNumber: 2 }
  ]);
  assert.deepEqual(plan.modelLods, []);
});

test("Plant export mode is ignored for non-FBX models (st9)", () => {
  const root = path.resolve("D:\\library\\Environment\\3dplant_grass_st9");
  const st9 = path.join(root, "Grass_Field.st9");
  const asset = {
    source: "custom",
    assetType: "3dplant",
    path: root,
    standardAssetTags: ["Megascans"],
    modelFiles: [st9]
  };
  const meta = {
    identity: { sourceKind: "megascans" },
    modelVariants: [{ file: st9, variantKey: "01" }],
    modelLods: [{ file: st9, variantKey: "01", lod: 0 }]
  };
  const opaquePlan = buildExportModelPlan(asset, meta, "opaque");
  assert.deepEqual(opaquePlan.modelVariants.map((item) => item.file), [st9]);
  assert.deepEqual(opaquePlan.modelLods, []);
  const lodPlan = buildExportModelPlan(asset, meta, "lod");
  assert.deepEqual(lodPlan.modelVariants.map((item) => item.file), [st9]);
  assert.deepEqual(lodPlan.modelLods, []);
});

test("plant export mode normalizes unknown values to OPAQUE", () => {
  assert.equal(normalizePlantExportMode(undefined), "opaque");
  assert.equal(normalizePlantExportMode(""), "opaque");
  assert.equal(normalizePlantExportMode("OPAQUE"), "opaque");
  assert.equal(normalizePlantExportMode("lod"), "lod");
  assert.equal(normalizePlantExportMode("Masked_LOD"), "lod");
  assert.equal(normalizePlantExportMode("masked"), "lod");
});

test("plant synthetic wind accepts the supported growth forms and legacy options", () => {
  assert.equal(normalizePlantSyntheticWind(undefined), "auto");
  assert.equal(normalizePlantSyntheticWind(""), "");
  assert.equal(normalizePlantSyntheticWind("none"), "");
  assert.equal(normalizePlantSyntheticWind("Grass"), "grass");
  assert.equal(normalizePlantSyntheticWind(" BUSH "), "bush");
  assert.equal(normalizePlantSyntheticWind("fern"), "fern");
  for (const profile of ["herb", "groundcover", "palm", "tree"]) {
    assert.equal(normalizePlantSyntheticWind(profile.toUpperCase()), profile);
  }
  assert.equal(normalizePlantSyntheticWind("unknown"), "");
  // 预设分类 v3：auto 交给插件按库类别决定（插件侧 _OPAQUE/masked 两条路径同一个 PlantProfile）
  assert.equal(normalizePlantSyntheticWind("auto"), "auto");
  assert.equal(normalizePlantSyntheticWind(" AUTO "), "auto");
});

test("plant synthetic wind comes from the export option, not library metadata", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "assethive-wind-"));
  try {
    const model = path.join(root, "SM_Env_Grass_id_01.fbx");
    fs.writeFileSync(model, "test-fbx");
    const asset = {
      id: "wind-test",
      name: "Grass",
      assetType: "3dplant",
      source: "custom",
      path: root,
      modelFiles: [model],
      standardAssetTags: ["Megascans", "Grass"]
    };
    const withWind = (await buildExportAssets([asset], null, "4k", "decal", "lod", "grass"))[0];
    assert.equal(withWind.plantSyntheticWind, "grass");
    const noOption = (await buildExportAssets([asset], null, "4k", "decal", "lod"))[0];
    assert.equal(noOption.plantSyntheticWind, "grass");
    const [disabled] = await buildExportAssets([asset], null, "4k", "decal", "lod", "none");
    assert.equal(disabled.plantSyntheticWind, undefined);
    const legacyMeta = (await buildExportAssets(
      [{ ...asset, meta: { ...(asset.meta || {}), plantSyntheticWind: "bush" } }],
      null, "4k", "decal", "lod", ""
    ))[0];
    assert.equal(legacyMeta.plantSyntheticWind, undefined, "library metadata no longer drives synthetic wind");
    const nonPlant = (await buildExportAssets([{ ...asset, assetType: "3d" }], null, "4k", "decal", "lod", "grass"))[0];
    assert.equal(nonPlant.plantSyntheticWind, undefined, "synthetic wind must only apply to 3dplant assets");
    const st9Model = path.join(root, "SM_Env_Grass_id_01.st9");
    fs.writeFileSync(st9Model, "test-st9");
    const st9Plant = (await buildExportAssets(
      [{ ...asset, id: "wind-st9", modelFiles: [st9Model] }],
      null, "4k", "decal", "lod", "grass"
    ))[0];
    assert.equal(st9Plant.plantSyntheticWind, undefined, "synthetic wind must skip non-FBX plants (st9)");
    const mixed = (await buildExportAssets([{ ...asset, modelFiles: [model, st9Model] }],
      null, "4k", "decal", "lod", "auto"))[0];
    assert.equal(mixed.plantSyntheticWind, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("batch Auto assigns Bridge forms per asset and manual choices override them", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "assethive-bridge-wind-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const model = path.join(root, "Var1_LOD0.fbx");
  fs.writeFileSync(model, "export routing fixture");
  const forms = [
    ["Grass Clumps", "Grass", "grass"], ["Desert Cotton", "Grass", "herb"],
    ["Beech Fern", "Fern", "fern"], ["Chinese Fan Palm", "Garden Plant", "palm"],
    ["Boxwood", "Garden Plant", "bush"], ["English Ivy", "Ground Cover", "groundcover"],
    ["Dwarf Willow", "Ground Cover", "groundcover"], ["Dragon Tree", "Houseplant", "tree"],
    ["Dead Leaves", "Garden Plant", "groundcover"], ["Carolana Water Lily", "Aquatic", "herb"],
    ["Common Eelgrass", "Aquatic", "grass"], ["Softstem Bulrush", "Aquatic", "grass"],
    ["Clover Varieties", "Grass", "groundcover"], ["Reindeer Lichen", "Ground Cover", "groundcover"],
    ["Ocean Seaweed", "Ocean", "herb"], ["Bermuda Buttercup", "Flowering Plant", "herb"],
    ["Wood Sorrel", "Ground Cover", "groundcover"]
  ];
  const assets = forms.map(([name, category], index) => ({
    id: String(index + 1), name, assetType: "3dplant", source: "custom", path: root,
    modelFiles: [model], meta: { category, identity: { sourceKind: "megascans" } }
  }));
  const jobs = await buildExportAssets(assets, null, "4k", "decal", "lod");
  assert.deepEqual(jobs.map(job => job.plantSyntheticWind), forms.map(form => form[2]));
  assert.equal(jobs[4].assetFolderName, "Boxwood_5");
  for (const asset of [{ ...assets[1], standardAssetTags: ["MicroFoliage"] }, { ...assets.at(-1), standardAssetTags: ["Micro"] }]) {
    const [micro] = await buildExportAssets([asset], null, "4k", "decal", "lod", "palm");
    assert.ok(micro.standardAssetTags.includes("Micro"));
    assert.equal(micro.plantSyntheticWind, undefined);
    assert.equal(micro.nativePlantWind, undefined);
  }
  assert.deepEqual(jobs[4].zionTags, []);
  const thirdParty = { ...assets[4], id: "library42", name: "Boxwood", standardAssetTags: ["ThirdParty"],
    meta: { category: "Garden Plant", identity: { sourceKind: "custom", sourceKey: "supplier99" } } };
  const [libraryJob] = await buildExportAssets([thirdParty], null, "4k", "decal", "lod", "auto");
  assert.equal(libraryJob.id, "library42");
  assert.equal(libraryJob.assetFolderName, "Boxwood_library42");
  assert.equal(libraryJob.modelVariants[0].variantKey, "01");
  assert.equal(libraryJob.plantSyntheticWind, "bush");
  const secondModel = path.join(root, "Variation2_LOD0.fbx");
  fs.writeFileSync(secondModel, "second export variant");
  const [multiVariant] = await buildExportAssets([{ ...thirdParty, modelFiles: [model, secondModel] }],
    null, "4k", "decal", "lod", "auto");
  assert.deepEqual(multiVariant.modelVariants.map(variant => variant.variantKey), ["01", "02"]);
  const manual = await buildExportAssets([assets[6]], null, "4k", "decal", "lod", "palm");
  assert.equal(manual[0].plantSyntheticWind, "palm");
});

test("managed Auto wind preserves the verified growth form when library tags change", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "assethive-reviewed-wind-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const model = path.join(root, "Var1_LOD0.fbx");
  fs.writeFileSync(model, "yucca fixture");
  const asset = {
    id: "yucca-test", name: "Spineless Yucca", assetType: "3dplant", source: "custom",
    standardAssetTags: ["ThirdParty"], tags: ["shrub"], path: root, modelFiles: [model]
  };
  const manifest = {
    schemaVersion: 1, assetId: asset.id, variants: { Var1: {
      source: path.basename(model), sha256: require("node:crypto").createHash("sha256").update(fs.readFileSync(model)).digest("hex"),
      bindings: [{ secondary: 0, terminal: true }]
    } }
  };
  const exportWith = async (form, option = "auto") => {
    fs.writeFileSync(path.join(root, "_layer.json"), JSON.stringify({ ...manifest, form }));
    return (await buildExportAssets([asset], null, "2k", "decal", "naniteMasked", option))[0];
  };
  for (const legacyForm of [undefined, "unsupported"]) {
    assert.equal((await exportWith(legacyForm)).plantSyntheticWind, "bush");
  }
  const reviewed = await exportWith("herb");
  assert.equal(reviewed.plantSyntheticWind, "herb");
  assert.ok(reviewed.standardAssetTags.includes("Grass"));
  assert.equal(reviewed.plantWindLayers.hasTerminal, true);
  for (const [preset, subtype] of [["bush", "Bush"], ["tree", "Tree"], ["palm", "Grass"], ["fern", "Grass"]]) {
    const job = await exportWith("herb", preset);
    assert.equal(job.plantSyntheticWind, preset);
    assert.deepEqual(job.standardAssetTags.filter(tag => ["Grass", "Tree", "Bush"].includes(tag)), [subtype]);
    assert.deepEqual(job.plantNamingTags, ["Foliage"]);
  }
  for (const off of [await exportWith(""), await exportWith("herb", "none")]) {
    assert.equal(off.plantSyntheticWind, undefined);
    assert.equal(off.plantWindLayers, undefined);
  }
});
test("Micro uses original dimensions from every variant and exports a static Micro job", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "assethive-micro-size-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const name = "Var1_LOD0.fbx";
  const file = path.join(root, name);
  fs.writeFileSync(file, "size fixture");
  const asset = { id: "mat", name: "Ground plant", assetType: "3dplant", path: root,
    standardAssetTags: ["ThirdParty", "Grass"], modelFiles: [file] };
  const entry = { source: name, sha256: require("node:crypto").createHash("sha256").update("size fixture").digest("hex"),
    frame: { up: "Z", units: "cm", sizeCm: [60, 38, 10] }, bindings: [{ secondary: 0, terminal: true }] };
  const run = async (size, mode, form = "herb") => {
    const other = { ...entry, frame: { ...entry.frame, sizeCm: size } };
    fs.writeFileSync(path.join(root, "_layer.json"), JSON.stringify({
      assetId: asset.id, schemaVersion: 1, form, variants: { Var1: entry, Var2: other }
    }));
    return (await buildExportAssets([asset], null, "2k", "decal", "naniteMasked", mode))[0];
  };
  for (const job of [await run([20, 60, 10], "auto"), await run([70, 30, 50], "micro")]) {
    assert.deepEqual(job.standardAssetTags, ["ThirdParty", "Micro"]);
    assert.equal(job.plantCategory, "Micro");
    assert.equal(job.plantWindLayers, undefined);
    assert.equal(job.plantSyntheticWind, undefined);
    assert.equal(job.nativePlantWind, undefined);
  }
  assert.equal((await run([10, 12, 10.1], "auto")).plantSyntheticWind, "herb");
  assert.equal((await run([60.1, 12, 7], "auto")).plantSyntheticWind, "herb");
  assert.equal((await run([10, 12, 7], "bush")).plantSyntheticWind, "bush");
  assert.equal((await run([10, 12, 7], "auto", "")).plantCategory, "Micro");
  asset.name = "Dead Leaves";
  assert.equal((await run([10, 12, 7], "auto", "")).standardAssetTags.includes("Micro"), true);
});

test("plant jobs distinguish explicit Zion tags from the naming placeholder", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "assethive-zion-grass-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const model = path.join(root, "Grass_GameWind.fbx");
  fs.writeFileSync(model, "test-fbx");
  const base = {
    id: "zion-grass", name: "Grass_GameWind", assetType: "3dplant",
    source: "custom", path: root, modelFiles: [model], standardAssetTags: ["Grass"]
  };
  const exportJob = async (asset) => (await buildExportAssets([asset], null, "4k", "decal", "lod", ""))[0];
  const tagged = await exportJob({ ...base, zionTags: ["Zion", " ", null, 42] });
  assert.equal(tagged.hasExplicitZionTags, true);
  assert.deepEqual(tagged.zionTags, ["Zion"]);
  assert.deepEqual(tagged.standardAssetTags, ["Grass"]);
  assert.equal(tagged.plantSyntheticWind, undefined, "a material tag does not request UV wind synthesis");

  for (const zionTags of [undefined, [], [" ", null, 42]]) {
    const job = await exportJob({ ...base, zionTags });
    assert.equal(job.hasExplicitZionTags, false);
    assert.deepEqual(job.zionTags, ["zion"], "keep the existing naming placeholder");
    assert.equal(job.assetFolderName, tagged.assetFolderName);
  }
  const fromMeta = await exportJob({
    ...base, standardAssetTags: undefined, meta: { standardAssetTags: ["Grass"], zionTags: ["Zion"] }
  });
  assert.equal(fromMeta.hasExplicitZionTags, true);
  assert.deepEqual(fromMeta.standardAssetTags, ["Grass"]);
  const cleared = await exportJob({ ...base, zionTags: [], meta: { zionTags: ["Zion"] } });
  assert.equal(cleared.hasExplicitZionTags, false, "an explicit empty asset field wins over stale metadata");

  const conifer = await exportJob({ ...base, standardAssetTags: ["Tree"], zionTags: ["Zion"] });
  assert.deepEqual(conifer.standardAssetTags, ["Tree"], "a native plant must keep its own type");
  const nonPlant = await exportJob({ ...base, assetType: "3d", zionTags: ["Zion"] });
  assert.equal(nonPlant.hasExplicitZionTags, undefined);
});

test("Zion foliage ignores legacy cuts and carries the original LOD chain only in LOD mode", () => {
  const root = path.resolve("D:\\library\\Environment\\3dplant_tree");
  const normal0 = path.join(root, "SM_Tree_id_01.fbx");
  const normal1 = path.join(root, "SM_Tree_id_01_LOD1.fbx");
  const opaque0 = path.join(root, "SM_Tree_id_01_OPAQUE.fbx");
  const asset = {
    source: "custom",
    assetType: "3dplant",
    path: root,
    standardAssetTags: ["Grass"]
  };
  const meta = {
    modelVariants: [
      { file: normal0, variantKey: "01" },
      { file: opaque0, variantKey: "01OPAQUE" }
    ],
    modelLods: [
      { file: normal0, variantKey: "01", lod: 0 },
      { file: normal1, variantKey: "01", lod: 1 },
      { file: path.join(root, "SM_Tree_id_01_LOD2_OPAQUE.fbx"), variantKey: "01", lod: 2 }
    ]
  };
  const plan = buildExportModelPlan(asset, meta);
  assert.deepEqual(plan.modelVariants, [{ file: normal0, variantKey: "01", variantNumber: 1, naniteMasked: true }]);
  assert.deepEqual(plan.modelLods, []);
  const maskedPlan = buildExportModelPlan(asset, meta, "lod");
  assert.deepEqual(maskedPlan.modelVariants, [{ file: normal0, variantKey: "01", variantNumber: 1 }]);
  assert.deepEqual(maskedPlan.modelLods, [{ file: normal1, variantKey: "01", variantNumber: 1, lod: 1 }]);
  const groups = [{ groupId: 1, materialRole: "atlas" }, { groupId: 2, materialRole: "billboard" }];
  assert.deepEqual(filterPlantTextureGroupsForExport(asset, "3dplant", meta, groups, "opaque").map((item) => item.groupId), [1]);
  assert.equal(filterPlantTextureGroupsForExport(asset, "3dplant", meta, groups, "lod").length, 2);
  const thirdParty = { ...asset, standardAssetTags: ["ThirdParty", "Tree"] };
  assert.equal(buildExportModelPlan(thirdParty, meta).modelVariants[0].file, opaque0);
  assert.equal(buildExportModelPlan({ ...thirdParty, zionTags: ["Zion"] }, meta).modelVariants[0].file, normal0);
  assert.deepEqual(buildExportModelPlan(asset, { modelVariants: [{ file: opaque0, variantKey: "01OPAQUE" }] }), { modelVariants: [], modelLods: [] });
});

test("Zion plant export keeps meaningful color alpha per group and packs authored opacity into Diffuse", async (t) => {
  const sharp = require("sharp");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "assethive-zion-alpha-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const model = path.join(root, "Tree_01.fbx");
  fs.writeFileSync(model, "test-fbx");
  const textureEntries = [];
  const makeTexture = async (areaIndex, textureType, alpha = null) => {
    const file = path.join(root, `Tree_${areaIndex}_${textureType}.png`);
    const channels = alpha ? 4 : 3;
    const pixels = Buffer.from([0, 1, 2, 3].flatMap((i) => {
      const maskValue = [255, 96, 48, 0][i];
      return /opacity/i.test(textureType) ? [maskValue, maskValue, maskValue] : [20, 40, 60, ...(alpha ? [alpha[i]] : [])];
    }));
    await sharp(pixels, { raw: { width: 2, height: 2, channels } }).png().toFile(file);
    textureEntries.push({ textureType, file, areaIndex });
    return file;
  };
  const leaf = await makeTexture(1, "Diffuse", [0, 64, 128, 255]);
  const originalLeaf = fs.readFileSync(leaf);
  await makeTexture(2, "Diffuse");
  await makeTexture(3, "Diffuse", [255, 255, 255, 255]);
  await makeTexture(4, "Diffuse", [0, 0, 0, 0]);
  await makeTexture(5, "Diffuse", [0, 64, 128, 255]);
  await makeTexture(5, "OpacityMasked");
  await makeTexture(6, "Diffuse");
  await makeTexture(6, "Normal", [0, 64, 128, 255]);
  await makeTexture(6, "ORM", [0, 64, 128, 255]);
  const tga = path.join(root, "Tree_7_Diffuse.tga");
  const header = Buffer.alloc(18);
  header[2] = 2;
  header.writeUInt16LE(2, 12);
  header.writeUInt16LE(2, 14);
  header[16] = 32;
  header[17] = 0x28;
  fs.writeFileSync(tga, Buffer.concat([header, Buffer.from([0, 64, 128, 255].flatMap((alpha) => [60, 40, 20, alpha]))]));
  textureEntries.push({ textureType: "Diffuse", file: tga, areaIndex: 7 });
  const maskOnly = await makeTexture(8, "Opacity");
  const asset = {
    id: path.basename(root), name: "Tree", source: "custom", assetType: "3dplant", path: root,
    modelFiles: [model], zionTags: ["Zion"], standardAssetTags: ["Tree"], meta: { textureEntries }
  };
  const [job] = await buildExportAssets([asset], null, "4k");
  const group = (id) => job.materialGroups.find((entry) => entry.groupId === id);
  const color = (id) => group(id).textureSlots.find((entry) => ["D", "AL"].includes(entry.slot)).file;
  const alpha = async (file) => [...await sharp(file).extractChannel("alpha").raw().toBuffer()];
  assert.deepEqual(job.materialGroups.filter((g) => g.opacityInDiffuseAlpha).map((g) => g.groupId), [1, 4, 5, 7]);
  assert.deepEqual(job.textureSlots.filter((s) => s.slot === "Opacity").map((s) => s.file.toLowerCase()), [maskOnly.toLowerCase()]);
  assert.deepEqual(await alpha(color(1)), [0, 64, 128, 255]);
  assert.deepEqual(await alpha(color(4)), [0, 0, 0, 0]);
  assert.deepEqual(await alpha(color(5)), [255, 96, 48, 0]);
  assert.equal(color(7).toLowerCase(), tga.toLowerCase(), "native RGBA TGA passes through with its original alpha");
  assert.deepEqual(fs.readFileSync(leaf), originalLeaf, "source color texture remains unchanged");
});

test("all plant sources export Billboard textures only in LOD mode", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "assethive-plant-non-mega-opaque-"));
  try {
    const atlasDir = path.join(root, "Textures", "Atlas");
    const billboardDir = path.join(root, "Textures", "Billboard");
    fs.mkdirSync(atlasDir, { recursive: true });
    fs.mkdirSync(billboardDir, { recursive: true });
    const atlas = path.join(atlasDir, "Grass_4K_Albedo.png");
    const billboard = path.join(billboardDir, "Grass_4K_Billboard_Albedo.png");
    fs.writeFileSync(atlas, "atlas");
    fs.writeFileSync(billboard, "billboard");
    const asset = {
      source: "custom",
      assetType: "3dplant",
      path: root,
      standardAssetTags: ["Grass"],
      textureFiles: [billboard, atlas]
    };
    const meta = {
      standardAssetTags: ["Grass"],
      textureEntries: [
        { textureType: "albedo", areaIndex: 1, uri: path.basename(billboard), materialRole: "billboard" },
        { textureType: "albedo", areaIndex: 1, uri: path.basename(atlas), materialRole: "atlas" }
      ]
    };
    const groups = collectTextureGroupsForExport(asset, "3dplant", meta, 4096);
    for (const mode of ["opaque", "naniteMasked", "lod"]) {
      const filtered = filterPlantTextureGroupsForExport(asset, "3dplant", meta, groups, mode);
      assert.deepEqual(new Set(filtered.map((group) => group.materialRole)), new Set(mode === "lod" ? ["atlas", "billboard"] : ["atlas"]));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("plant export sends packed ORM and separate ORM inputs to the UE material groups", async (t) => {
  const sharp = require("sharp");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "assethive-plant-orm-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const model = path.join(root, "Grass_GameWind.fbx");
  fs.writeFileSync(model, "test-fbx");
  const textureEntries = [];
  for (const type of ["Diffuse", "Normal", "ORM", "SubsurfaceColor", "AO", "Roughness", "Metalness", "Fuzz"]) {
    const file = path.join(root, `Grass_${type}.png`);
    await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 128, g: 128, b: 255 } } }).png().toFile(file);
    textureEntries.push({ textureType: type, file, areaIndex: 1 });
  }
  const asset = {
    id: "grass-orm", name: "Grass", assetType: "3dplant", source: "custom", path: root,
    modelFiles: [model], standardAssetTags: ["Grass"], zionTags: ["Zion"]
  };
  const slotsOf = async (entries) => (await buildExportAssets([{ ...asset, meta: { textureEntries: entries } }], null, "4k"))[0];
  const packed = await slotsOf(textureEntries);
  const slots = packed.textureSlots.map((entry) => entry.slot.toLowerCase());
  for (const slot of ["orm", "subsurfacecolor", "ao", "roughness", "metalness"]) assert.ok(slots.includes(slot), slot);
  assert.ok(!slots.includes("fuzz"));
  assert.equal(packed.materialGroups[0].textureSlots.find((entry) => entry.slot === "ORM")?.file,
    packed.textureSlots.find((entry) => entry.slot === "ORM")?.file);
  const separate = await slotsOf(textureEntries.filter((entry) => entry.textureType !== "ORM"));
  assert.ok(!separate.textureSlots.some((entry) => entry.slot === "ORM"));
  for (const slot of ["ao", "roughness", "metalness"]) {
    assert.ok(separate.textureSlots.some((entry) => entry.slot.toLowerCase() === slot), slot);
  }
});

test("3D Plant export keeps Atlas and Billboard textures in separate material groups", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "assethive-plant-roles-"));
  try {
    const atlasDir = path.join(root, "Textures", "Atlas");
    const billboardDir = path.join(root, "Textures", "Billboard");
    fs.mkdirSync(atlasDir, { recursive: true });
    fs.mkdirSync(billboardDir, { recursive: true });
    const atlas = path.join(atlasDir, "Fern_4K_Albedo.png");
    const billboard = path.join(billboardDir, "Fern_4K_Albedo.png");
    fs.writeFileSync(atlas, "atlas");
    fs.writeFileSync(billboard, "billboard");
    const asset = {
      source: "custom",
      assetType: "3dplant",
      path: root,
      textureFiles: [billboard, atlas]
    };
    const meta = {
      textureEntries: [
        { textureType: "albedo", areaIndex: 1, uri: path.basename(billboard), materialRole: "billboard" },
        { textureType: "albedo", areaIndex: 1, uri: path.basename(atlas), materialRole: "atlas" }
      ]
    };
    const groups = collectTextureGroupsForExport(asset, "3dplant", meta, 4096);
    assert.equal(groups.length, 2);
    const atlasGroup = groups.find((group) => group.materialRole === "atlas");
    const billboardGroup = groups.find((group) => group.materialRole === "billboard");
    assert.ok(atlasGroup);
    assert.ok(billboardGroup);
    assert.notEqual(atlasGroup.groupId, billboardGroup.groupId);
    assert.equal(atlasGroup.bySlot.get("albedo"), atlas);
    assert.equal(billboardGroup.bySlot.get("albedo"), billboard);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("3D Plant Subsurface texture exports into the NRS translucency slot", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "assethive-plant-subsurface-"));
  try {
    const translucency = path.join(root, "Fern_4K_Translucency.png");
    fs.writeFileSync(translucency, "translucency");
    const asset = {
      source: "custom",
      assetType: "3dplant",
      path: root,
      textureFiles: [translucency]
    };
    const meta = {
      textureEntries: [
        { textureType: "Subsurface", areaIndex: 1, uri: path.basename(translucency), materialRole: "atlas" }
      ]
    };
    const groups = collectTextureGroupsForExport(asset, "3dplant", meta, 4096);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].bySlot.get("translucency"), translucency);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("3D Plant Translucency (T) texture exports into the SSC slot", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "assethive-plant-translucency-"));
  try {
    const translucency = path.join(root, "Fern_4K_Translucency.png");
    fs.writeFileSync(translucency, "translucency");
    const asset = {
      source: "custom",
      assetType: "3dplant",
      path: root,
      textureFiles: [translucency]
    };
    const meta = {
      textureEntries: [
        { textureType: "Translucency", areaIndex: 1, uri: path.basename(translucency), materialRole: "atlas" }
      ]
    };
    const groups = collectTextureGroupsForExport(asset, "3dplant", meta, 4096);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].bySlot.get("subsurfacecolor"), translucency);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("unified Opacity and legacy mask aliases export into the same plugin opacity slot", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "assethive-opacity-masked-"));
  try {
    const opacity = path.join(root, "Fern_4K_OpacityMasked.png");
    fs.writeFileSync(opacity, "opacity");
    const asset = {
      source: "custom",
      assetType: "3dplant",
      path: root,
      textureFiles: [opacity]
    };
    for (const textureType of ["Opacity", "OpacityMask", "OpacityMasked"]) {
      const meta = { textureEntries: [{ textureType, areaIndex: 1, uri: path.basename(opacity), materialRole: "atlas" }] };
      const groups = collectTextureGroupsForExport(asset, "3dplant", meta, 4096);
      assert.equal(groups.length, 1);
      assert.equal(groups[0].bySlot.get("opacity"), opacity);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Megascans OPAQUE export drops Billboard when a variant falls back to masked", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "assethive-plant-opaque-mixed-billboard-"));
  try {
    const atlasDir = path.join(root, "Textures", "Atlas");
    const billboardDir = path.join(root, "Textures", "Billboard");
    fs.mkdirSync(atlasDir, { recursive: true });
    fs.mkdirSync(billboardDir, { recursive: true });
    const normal0 = path.join(root, "SM_Grass_id_01.fbx");
    const opaque0 = path.join(root, "SM_Grass_id_01_OPAQUE.fbx");
    const normal1 = path.join(root, "SM_Grass_id_02.fbx");
    const atlas = path.join(atlasDir, "Grass_4K_Albedo.png");
    const billboard = path.join(billboardDir, "Billboard_4K_Albedo.png");
    for (const filePath of [normal0, opaque0, normal1, atlas, billboard]) {
      fs.writeFileSync(filePath, "x");
    }
    const asset = {
      source: "custom",
      assetType: "3dplant",
      path: root,
      standardAssetTags: ["Megascans", "Grass"],
      textureFiles: [billboard, atlas],
      modelFiles: [normal0, opaque0, normal1]
    };
    const meta = {
      identity: { sourceKind: "megascans" },
      standardAssetTags: ["Megascans", "Grass"],
      modelVariants: [
        { file: normal0, variantKey: "01" },
        { file: opaque0, variantKey: "01OPAQUE" },
        { file: normal1, variantKey: "02" }
      ],
      textureEntries: [
        { textureType: "albedo", areaIndex: 1, uri: path.basename(billboard), materialRole: "billboard" },
        { textureType: "albedo", areaIndex: 1, uri: path.basename(atlas), materialRole: "atlas" }
      ]
    };
    const plan = buildExportModelPlan(asset, meta, "opaque");
    assert.equal(plan.modelVariants.length, 2);
    assert.ok(plan.modelVariants.some((item) => item.opaque !== true), "variant 02 keeps the masked fallback");
    const [job] = await buildExportAssets([{ ...asset, id: "wind-cut-fixture", name: "Grass", meta }], null, "4k", "decal", "opaque", "grass");
    assert.deepEqual(job.plantWindOriginals, { "01": normal0 }, "a cut without a verified manifest supplies only its original LOD0");
    const [masked] = await buildExportAssets([{ ...asset, id: "wind-cut-fixture", name: "Grass", meta }], null, "4k", "decal", "lod", "grass");
    assert.equal(masked.plantWindOriginals, undefined);
    const groups = collectTextureGroupsForExport(asset, "3dplant", meta, 4096);
    const filtered = filterPlantTextureGroupsForExport(asset, "3dplant", meta, groups, "opaque", plan);
    assert.deepEqual(filtered.map((group) => group.materialRole), ["atlas"]);
    assert.ok(!filtered.some((group) => [...group.bySlot.values()].some((value) => path.basename(String(value)).toLowerCase().includes("billboard"))));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Megascans OPAQUE fallback grouping keeps Atlas and drops Billboard", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "assethive-plant-opaque-fallback-"));
  try {
    const atlasDir = path.join(root, "Textures", "Atlas");
    const billboardDir = path.join(root, "Textures", "Billboard");
    fs.mkdirSync(atlasDir, { recursive: true });
    fs.mkdirSync(billboardDir, { recursive: true });
    const normal0 = path.join(root, "SM_Grass_id_01.fbx");
    const opaque0 = path.join(root, "SM_Grass_id_01_OPAQUE.fbx");
    const atlas = path.join(atlasDir, "Grass_4K_Albedo.png");
    const billboard = path.join(billboardDir, "Billboard_4K_Albedo.png");
    for (const filePath of [normal0, opaque0, atlas, billboard]) {
      fs.writeFileSync(filePath, "x");
    }
    const asset = {
      source: "custom",
      assetType: "3dplant",
      path: root,
      standardAssetTags: ["Megascans", "Grass"],
      textureFiles: [billboard, atlas],
      modelFiles: [normal0, opaque0]
    };
    const meta = {
      identity: { sourceKind: "megascans" },
      standardAssetTags: ["Megascans", "Grass"],
      modelVariants: [
        { file: normal0, variantKey: "01" },
        { file: opaque0, variantKey: "01OPAQUE" }
      ]
    };
    const groups = collectTextureGroupsForExport(asset, "3dplant", meta, 4096);
    assert.deepEqual(new Set(groups.map((group) => group.materialRole)), new Set(["atlas", "billboard"]));
    const filtered = filterPlantTextureGroupsForExport(asset, "3dplant", meta, groups, "opaque");
    assert.deepEqual(filtered.map((group) => group.materialRole), ["atlas"]);
    assert.equal(filtered[0].bySlot.get("albedo"), atlas);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Megascans OPAQUE export drops Billboard texture groups", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "assethive-plant-opaque-billboard-"));
  try {
    const atlasDir = path.join(root, "Textures", "Atlas");
    const billboardDir = path.join(root, "Textures", "Billboard");
    fs.mkdirSync(atlasDir, { recursive: true });
    fs.mkdirSync(billboardDir, { recursive: true });
    const normal0 = path.join(root, "SM_Grass_id_01.fbx");
    const opaque0 = path.join(root, "SM_Grass_id_01_OPAQUE.fbx");
    const normal1 = path.join(root, "SM_Grass_id_01_LOD1.fbx");
    const atlas = path.join(atlasDir, "Grass_4K_Albedo.png");
    const billboard = path.join(billboardDir, "Billboard_4K_Albedo.png");
    for (const filePath of [normal0, opaque0, normal1, atlas, billboard]) {
      fs.writeFileSync(filePath, "x");
    }
    const asset = {
      source: "custom",
      assetType: "3dplant",
      path: root,
      standardAssetTags: ["Megascans"],
      tags: ["megascans"],
      textureFiles: [billboard, atlas],
      modelFiles: [normal0, opaque0, normal1]
    };
    const meta = {
      identity: { sourceKind: "megascans" },
      category: "Grass",
      tags: ["megascans"],
      modelVariants: [
        { file: normal0, variantKey: "01" },
        { file: opaque0, variantKey: "01OPAQUE" }
      ],
      modelLods: [
        { file: normal0, variantKey: "01", lod: 0 },
        { file: normal1, variantKey: "01", lod: 1 }
      ],
      textureEntries: [
        { textureType: "albedo", areaIndex: 1, uri: path.basename(billboard), materialRole: "billboard" },
        { textureType: "albedo", areaIndex: 1, uri: path.basename(atlas), materialRole: "atlas" }
      ]
    };
    const groups = collectTextureGroupsForExport(asset, "3dplant", meta, 4096);
    assert.equal(groups.length, 2);
    const opaquePlan = buildExportModelPlan(asset, meta, "opaque");
    assert.equal(opaquePlan.modelVariants[0].file, opaque0);
    assert.equal(opaquePlan.modelVariants[0].opaque, true);
    const opaqueGroups = filterPlantTextureGroupsForExport(asset, "3dplant", meta, groups, "opaque", opaquePlan);
    assert.deepEqual(opaqueGroups.map((group) => group.materialRole), ["atlas"]);
    const lodPlan = buildExportModelPlan(asset, meta, "lod");
    const lodGroups = filterPlantTextureGroupsForExport(asset, "3dplant", meta, groups, "lod", lodPlan);
    assert.deepEqual(new Set(lodGroups.map((group) => group.materialRole)), new Set(["atlas", "billboard"]));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
