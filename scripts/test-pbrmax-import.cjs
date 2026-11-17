const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const { buildDrafts, buildScope } = require("./import-draft-harness.cjs");
const { detectSourceStandardAssetTags } = require("../electron/services/sourceDetection");
const { collectMegascansTextureHints, normalizeMegascansTextureType } = require("../electron/services/megascansTextures");
const { resolveMegascansCategory } = require("../electron/services/megascansCategory");

test("source imports select ThirdParty and keep their source as a regular tag for every supported type", async () => {
  const scope = buildScope([]);
  for (const assetType of ["3d", "3dplant", "surface", "decal"]) {
    const options = scope.getStandardAssetTagOptions(assetType);
    assert.ok(options.includes("ThirdParty"));
    assert.ok(!options.includes("Megascans") && !options.includes("PBRMAX"));
    for (const sourceTag of ["Megascans", "PBRMAX"]) {
      const root = path.join("D:\\ZionFiles", `${sourceTag}_${assetType}_Sample`);
      const files = [path.join(root, "Sample_Albedo.png")];
      if (assetType === "3d" || assetType === "3dplant") files.push(path.join(root, "Sample.fbx"));
      const { drafts } = await buildDrafts(files, { metadata: {
        name: "Sample", assetType, standardAssetTags: [sourceTag], tags: [sourceTag]
      } });
      assert.equal(drafts.length, 1);
      const form = drafts[0].form;
      assert.equal(form.assetType, assetType);
      assert.deepEqual(scope.getSelectedStandardAssetTags(form.assetType, form.tagsText), ["ThirdParty"]);
      const tags = form.tagsText.split(", ");
      assert.ok(tags.includes("ThirdParty"));
      assert.equal(tags.filter((tag) => tag === sourceTag).length, 1);
      assert.ok(!tags.includes(sourceTag === "Megascans" ? "PBRMAX" : "Megascans"));
    }
  }
  assert.deepEqual(scope.getStandardAssetTagOptions("hdri"), []);
  assert.deepEqual(scope.getStandardAssetTagOptions("animation"), []);
});

test("legacy source tags select ThirdParty while an explicit standard selection takes precedence", () => {
  const scope = buildScope([]);
  for (const source of ["Megascans", "pbrmax"]) {
    assert.deepEqual(scope.getSelectedStandardAssetTags("3d", source), ["ThirdParty"]);
    assert.deepEqual(scope.getSelectedStandardAssetTags("3d", `Props, ${source}`), ["Props"]);
  }
});

test("ThirdParty folder prefixes keep third-party assets without inventing a source", async () => {
  const root = path.join("D:\\ZionFiles", "ThirdParty_Chair");
  const { drafts } = await buildDrafts([path.join(root, "Chair.fbx")]);
  assert.equal(drafts[0].form.tagsText, "ThirdParty");
  assert.equal(drafts[0].form.assetName, "Chair");
});

test("dropping while an import is saving queues drafts without replacing the active batch", async () => {
  const existing = [{ form: { assetName: "Already importing" }, tagInput: "" }];
  const scope = buildScope([path.join("D:\\New", "Next.fbx")], { existingDrafts: existing, importSaving: true });
  await scope.applyQuickDropImport(["D:\\New"]);
  // 后台导入进行中拖入资产：新草稿进入"预排队编辑"，由用户确认后再「加入排队」。
  // 关键不变量：此刻不得往待追加队列里塞入任何东西，正在导入的批次也不会被替换。
  assert.equal(scope.state.pendingImportAppendsRef.current.length, 0, "编辑确认前不得写入待追加队列");
  assert.equal(scope.state.open, true, "应打开导入弹窗以便编辑预排队草稿");
  assert.equal(scope.state.prequeueEditingRef.current, true, "应进入预排队编辑状态");
  assert.equal(scope.state.drafts.length, 1, "编辑区内只显示本次拖入的草稿");
  assert.equal(scope.state.drafts[0].form.assetName, "Next");
  assert.deepEqual(scope.state.dedupeChecks, []);
});

test("a drop resolved after the previous import appends to retained drafts", async () => {
  const existing = [{ form: { assetName: "Failed earlier" }, tagInput: "retry" }];
  const scope = buildScope([path.join("D:\\New", "Next.fbx")], { existingDrafts: existing, importSaving: true });
  const dropping = scope.applyQuickDropImport(["D:\\New"]);
  scope.state.importSavingRef.current = false;
  await dropping;
  assert.equal(scope.state.drafts.length, 2);
  assert.equal(scope.state.drafts[0], existing[0]);
  assert.deepEqual(scope.state.dedupeChecks, []);
  assert.equal(scope.state.open, true);
});

const PBRMAX_FOLDER = [
  "00369_MD_Stone_LOD0.fbx", "00369_MD_Stone_LOD5.fbx", "00369_MD_Stone.fbx",
  "00369_MD_Stone.ZTL", "00369_MD_Stone.jpg", "00369_MD_Stone_thumb.jpg",
  "8bit_T_00369_MD_Stone_Albedo_4K.png", "8bit_T_00369_MD_Stone_AO_4K.png",
  "8bit_T_00369_MD_Stone_Cavity_4K.png", "8bit_T_00369_MD_Stone_Displacement_4K.exr",
  "8bit_T_00369_MD_Stone_Displacement_4K.png", "8bit_T_00369_MD_Stone_Gloss_4K.png",
  "8bit_T_00369_MD_Stone_Metallic_4K.png", "8bit_T_00369_MD_Stone_Normal_4K.png",
  "8bit_T_00369_MD_Stone_Normal_4K_LOD0.png", "8bit_T_00369_MD_Stone_Roughness_4K.png",
  "8bit_T_00369_MD_Stone_Specular_4K.png"
].map(name => path.join("D:\\ZionFiles\\Dimian_1", name));

test("PBRMAX folder imports as one 3D asset with FBX-only model, Diffuse/Metalness slots and PBRMAX tag", async () => {
  const { drafts } = await buildDrafts(PBRMAX_FOLDER);
  assert.equal(drafts.length, 1);
  const { form } = drafts[0];
  assert.equal(form.assetType, "3d");
  assert.match(form.assetName, /00369.*Stone/i);

  const modelPaths = Object.values(form.modelSlots);
  assert.equal(modelPaths.length, 1);
  assert.match(modelPaths[0], /00369_MD_Stone\.fbx$/i);
  assert.ok(!modelPaths.some(filePath => /\.ztl$/i.test(filePath)), "ZBrush source must not fill a model slot");
  assert.ok(!modelPaths.some(filePath => /_lod\d/i.test(filePath)), "LOD meshes must not fill model slots");

  const byType = new Map(form.textureEntries.map(entry => [entry.textureType, entry.filePath]));
  assert.match(byType.get("Diffuse"), /_Albedo_4K\.png$/i);
  assert.match(byType.get("Metalness"), /_Metallic_4K\.png$/i);
  assert.match(byType.get("Normal"), /_Normal_4K\.png$/i);
  assert.ok(!form.textureEntries.some(entry => /_NORMAL_4K_LOD\d/i.test(entry.filePath)), "LOD maps must not be imported");
  const displacementEntries = form.textureEntries.filter(entry => entry.textureType === "Displacement");
  assert.equal(displacementEntries.length, 1, "the EXR/PNG displacement pair collapses to one row");
  assert.match(displacementEntries[0].filePath, /_Displacement_4K\.png$/i, "PNG wins over EXR displacement");
  assert.ok(!form.textureEntries.some(entry => /_Displacement_4K\.exr$/i.test(entry.filePath)), "the EXR twin is not imported");
  assert.ok(!form.textureEntries.some(entry => /_thumb\.jpg$/i.test(entry.filePath)), "the preview thumb is not a texture");

  assert.match(form.previewImagePath, /_thumb\.jpg$/i);
  assert.match(form.tagsText, /(?:^|,\s*)PBRMAX(?:,|$)/);
  assert.equal(form.normalMapFormat, "dx", "a name without a convention marker keeps DirectX");
});

test("Displacement prefers EXR over JPG when PNG is absent and falls back to JPG when both are absent", async () => {
  const root = "D:\\ZionFiles\\DisplacementPriority";
  const exrDraft = await buildDrafts([
    path.join(root, "Stone.fbx"),
    path.join(root, "Stone_Displacement_4K.exr"),
    path.join(root, "Stone_Displacement_4K.jpg")
  ]);
  const exrEntry = exrDraft.drafts[0].form.textureEntries.find((entry) => entry.textureType === "Displacement");
  assert.match(exrEntry?.filePath || "", /_Displacement_4K\.exr$/i, "EXR wins over JPG when PNG is absent");

  const jpgDraft = await buildDrafts([
    path.join(root, "Stone.fbx"),
    path.join(root, "Stone_Displacement_4K.jpg")
  ]);
  const jpgEntry = jpgDraft.drafts[0].form.textureEntries.find((entry) => entry.textureType === "Displacement");
  assert.match(jpgEntry?.filePath || "", /_Displacement_4K\.jpg$/i, "JPG is used only when PNG and EXR are absent");
});

test("PBRMAX Decal uses the unified Opacity slot and does not import its preview render as a texture", async () => {
  const root = "D:\\ZionFiles\\Biaopai_3";
  const files = [
    "8bit_T_05482_DC_Indicator_AO_8K.png",
    "8bit_T_05482_DC_Indicator_Albedo_8K.png",
    "8bit_T_05482_DC_Indicator_Cavity_8K.png",
    "8bit_T_05482_DC_Indicator_Displacement_8K.png",
    "8bit_T_05482_DC_Indicator_Gloss_8K.png",
    "8bit_T_05482_DC_Indicator_Metallic_8K.png",
    "8bit_T_05482_DC_Indicator_Normal_8K.png",
    "8bit_T_05482_DC_Indicator_Opacity_8K.png",
    "8bit_T_05482_DC_Indicator_Roughness_8K.png",
    "8bit_T_05482_DC_Indicator_Specular_8K.png",
    "05482_DC_Indicator.jpg",
    "T_05482_DC_Indicator_Displacement_8K.exr"
  ].map((name) => path.join(root, name));
  const { drafts } = await buildDrafts(files, { folderName: "Biaopai_3" });
  assert.equal(drafts.length, 1);
  const { form } = drafts[0];
  assert.equal(form.assetType, "decal");
  assert.match(form.tagsText, /(?:^|,\s*)PBRMAX(?:,|$)/);
  assert.ok(form.textureEntries.some((entry) => entry.textureType === "Opacity" && /_Opacity_8K\.png$/i.test(entry.filePath)), "PBRMAX Opacity must fill the Decal Opacity slot");
  assert.equal(form.textureEntries.some((entry) => entry.textureType === "OpacityMasked"), false);
  assert.equal(form.textureEntries.some((entry) => /05482_DC_Indicator\.jpg$/i.test(entry.filePath)), false, "the full-size preview render must not become a texture slot");
  assert.match(form.textureEntries.find((entry) => entry.textureType === "AO")?.filePath || "", /_AO_8K\.png$/i);
});

test("PBRMAX Decal fixes opacity-family map aliases into Opacity", async () => {
  const root = "D:\\ZionFiles\\PBRMAX_Decal_OpacityFamilies";
  for (const token of ["Opacity", "Alpha", "Transparency", "OpacityMask"]) {
    const files = [
      path.join(root, "8bit_T_05482_DC_Indicator_Albedo_8K.png"),
      path.join(root, "8bit_T_05482_DC_Indicator_Metallic_8K.png"),
      path.join(root, "8bit_T_05482_DC_Indicator_" + token + "_8K.png")
    ];
    const { drafts } = await buildDrafts(files, { folderName: "PBRMAX_Decal_OpacityFamilies" });
    assert.equal(drafts.length, 1, token + " should resolve to one draft");
    const { form } = drafts[0];
    assert.equal(form.assetType, "decal");
    const expectedSuffix = "_" + token.toLowerCase() + "_8k.png";
    const opacityEntry = form.textureEntries.find((entry) => entry.filePath.toLowerCase().endsWith(expectedSuffix));
    assert.ok(opacityEntry, token + " texture should be imported");
    assert.equal(opacityEntry.textureType, "Opacity", token + " must fill Opacity");
    assert.equal(form.textureEntries.some((entry) => entry.textureType === "OpacityMasked"), false, token + " must not leave a legacy OpacityMasked slot");
  }
});

test("plant archives keep the 8bit_T_ map naming without being tagged PBRMAX", async () => {
  const root = "D:\\ZionFiles\\Zhiwu_1";
  const files = [
    path.join(root, "6012_Plabts.fbx"), path.join(root, "6012_Plabts.jpg"),
    path.join(root, "8bit_T_6012_Plabts_Albedo_4K.png"),
    path.join(root, "8bit_T_6012_Plabts_Normal_4K.png"),
    path.join(root, "8bit_T_6012_Plabts_Roughness_4K.png"),
    path.join(root, "T_6012_Plabts_Displacement_4K.exr")
  ];
  const { drafts } = await buildDrafts(files);
  assert.equal(drafts.length, 1);
  const { form } = drafts[0];
  assert.ok(!/PBRMAX/i.test(form.tagsText), "plant archives must not inherit the PBRMAX tag");
  assert.equal(form.tagsText, "", "tags stay untouched when no tag is detected");
  assert.ok(form.textureEntries.length >= 3);
  const displacement = form.textureEntries.find(entry => entry.textureType === "Displacement");
  assert.match(displacement?.filePath || "", /\.exr$/i, "an EXR-only displacement remains available for conversion");
});

test("non-displacement EXR maps are excluded from import drafts", async () => {
  const root = "D:\\ZionFiles\\EXR_Filter";
  const files = [
    path.join(root, "Rock.fbx"),
    path.join(root, "Rock_Albedo.png"),
    path.join(root, "Rock_Normal.exr"),
    path.join(root, "Rock_Roughness.exr")
  ];
  const { drafts } = await buildDrafts(files);
  assert.equal(drafts.length, 1);
  const { form } = drafts[0];
  assert.equal(form.textureEntries.some(entry => /\.exr$/i.test(entry.filePath)), false);
  assert.equal(form.textureEntries.some(entry => entry.textureType === "Normal"), false);
  assert.equal(form.textureEntries.some(entry => entry.textureType === "Roughness"), false);
  assert.match(form.textureEntries.find(entry => entry.textureType === "Albedo")?.filePath || "", /_Albedo\.png$/i);
});

test("Surface scans all non-thumb textures and keeps the largest duplicate up to 8K", async () => {
  const root = path.join("D:\\ZionFiles", "Surface_LODStone");
  const files = [
    path.join(root, "Stone_Albedo_2K.png"),
    path.join(root, "Stone_Albedo_4K.png"),
    path.join(root, "Stone_Normal_4K_LOD0.png"),
    path.join(root, "Stone_Normal_8K_LOD1.png"),
    path.join(root, "Stone_Normal_16K_LOD2.png"),
    path.join(root, "Stone_Normal_thumb.png"),
    path.join(root, "Stone_Roughness_4K.png"),
    path.join(root, "Stone_Displacement_2K.png")
  ];
  const { drafts } = await buildDrafts(files);
  assert.equal(drafts.length, 1);
  const { form } = drafts[0];
  assert.equal(form.assetType, "surface");
  const entriesOfType = (type) => form.textureEntries.filter(entry => entry.textureType === type);
  const albedo = entriesOfType("Albedo");
  const normal = entriesOfType("Normal");
  assert.equal(albedo.length, 1, "duplicate Surface texture types collapse to one entry");
  assert.equal(normal.length, 1, "LOD normals collapse to one entry");
  assert.match(albedo[0].filePath, /_Albedo_4K\.png$/i);
  assert.match(normal[0].filePath, /_Normal_8K_LOD1\.png$/i);
  assert.equal(form.textureEntries.some(entry => /16K/i.test(entry.filePath)), false, "16K candidates must be excluded");
  assert.equal(form.textureEntries.some(entry => /8K/i.test(entry.filePath)), true, "8K candidates must remain for library downscaling");
  assert.equal(form.textureEntries.some(entry => /thumb/i.test(entry.filePath)), false, "thumb files must not become texture entries");
  assert.equal(entriesOfType("Roughness").length, 1);
  assert.equal(entriesOfType("Displacement").length, 1);
});

test("Surface keeps 8K candidates for library downscaling and excludes 16K", async () => {
  const root = path.join("D:\\ZionFiles", "Surface_Above4K");
  const files = [
    path.join(root, "Stone_Albedo_8K.png"),
    path.join(root, "Stone_Albedo_16K.png"),
    path.join(root, "Stone_Normal_8K.png"),
    path.join(root, "Stone_Normal_16K.png"),
    path.join(root, "Stone_Roughness_8K.png"),
    path.join(root, "Stone_Roughness_16K.png")
  ];
  const { drafts } = await buildDrafts(files);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].form.assetType, "surface");
  assert.equal(drafts[0].form.textureEntries.some((entry) => /_8K\./i.test(entry.filePath)), true, "8K candidates must remain in the import draft");
  assert.equal(drafts[0].form.textureEntries.some((entry) => /_16K\./i.test(entry.filePath)), false, "16K candidates must be excluded");
});

test("all import variants keep 8K and exclude 16K", async () => {
  const scenarios = [
    {
      name: "3D Assets",
      root: "Global4K_3D",
      folderName: "3D_Global4K",
      files: ["Stone.fbx", "Stone_Albedo_8K.png", "Stone_Albedo_4K.png", "Stone_Albedo_16K.png"],
      expectedTypes: ["Albedo"]
    },
    {
      name: "3D Plants",
      root: "Global4K_Plants",
      folderName: "Tree_Global4K",
      files: ["Conifer.st9", "Conifer_Albedo_8K.png", "Conifer_Albedo_4K.png", "Conifer_Albedo_16K.png"],
      expectedTypes: ["Albedo"]
    },
    {
      name: "Decal",
      root: "Global4K_Decal",
      folderName: "PBRMAX_Decal_Rust",
      files: ["Rust_Albedo_8K.png", "Rust_Albedo_4K.png", "Rust_Albedo_16K.png", "Rust_Normal_8K.png", "Rust_Normal_4K.png", "Rust_Normal_16K.png"],
      expectedTypes: ["Diffuse", "Normal"]
    },
    {
      name: "HDRI mixed",
      root: "Global4K_HDRI_Mixed",
      folderName: "Global4K_HDRI_Mixed",
      files: ["Sunset_8K.hdr", "Sunset_4K.hdr", "Sunset_16K.hdr"],
      expectedTypes: ["HDR"]
    },
    {
      name: "HDRI",
      root: "Global4K_HDRI",
      folderName: "Global4K_HDRI",
      files: ["Sunset_16K.hdr"],
      expectedTypes: [],
      expectEmpty: true
    }
  ];
  for (const scenario of scenarios) {
    const root = path.join("D:\\ZionFiles", scenario.root);
    const files = scenario.files.map((name) => path.join(root, name));
    const { drafts } = await buildDrafts(files, { folderName: scenario.folderName });
    assert.equal(drafts.length, 1, `${scenario.name} should produce one draft`);
    const form = drafts[0].form;
    const oversized = form.textureEntries.filter((entry) => /16K/i.test(entry.filePath));
    assert.equal(oversized.length, 0, `${scenario.name} must exclude 16K textures`);
    if (scenario.expectEmpty) {
      assert.equal(form.textureEntries.length, 0, `${scenario.name} must not keep a 16K-only texture`);
      continue;
    }
    for (const textureType of scenario.expectedTypes) {
      assert.ok(form.textureEntries.some((entry) => entry.textureType === textureType && /_8K\./i.test(entry.filePath)), `${scenario.name} should keep the 8K ${textureType} texture`);
    }
  }
});

test("PBRMAX packs without a _thumb fall back to the full-size render as preview", async () => {
  const root = "D:\\ZionFiles\\Dimian_10";
  const files = [
    "Ground_LOD0.fbx", "Ground.fbx", "Ground.ZTL", "Ground.jpg",
    "8bit_T_Ground_Albedo_4K.png", "8bit_T_Ground_AO_4K.png", "8bit_T_Ground_Cavity_4K.png",
    "8bit_T_Ground_Displacement_4K.exr", "8bit_T_Ground_Displacement_4K.png",
    "8bit_T_Ground_Fuzz_4K.png", "8bit_T_Ground_Gloss_4K.png", "8bit_T_Ground_Metallic_4K.png",
    "8bit_T_Ground_Normal_4K.png", "8bit_T_Ground_Normal_4K_LOD0.png",
    "8bit_T_Ground_Roughness_4K.png", "8bit_T_Ground_Specular_4K.png"
  ].map(name => path.join(root, name));
  const { drafts } = await buildDrafts(files);
  assert.equal(drafts.length, 1);
  const { form } = drafts[0];
  const modelPaths = Object.values(form.modelSlots);
  assert.equal(modelPaths.length, 1);
  assert.match(modelPaths[0], /Ground\.fbx$/i);
  assert.match(form.previewImagePath, /Ground\.jpg$/i);
  const byType = new Map(form.textureEntries.map(entry => [entry.textureType, entry.filePath]));
  assert.match(byType.get("Diffuse"), /_Albedo_4K\.png$/i);
  assert.match(byType.get("Fuzz"), /_Fuzz_4K\.png$/i);
  assert.match(form.tagsText, /PBRMAX/);
});

test("an explicit PBRMAX folder name still tags packs that lost their ZBrush source", async () => {
  const root = "D:\\ZionFiles\\PBRMAX_Surface\\Dimian_20";
  const files = [
    path.join(root, "Ground.fbx"),
    path.join(root, "8bit_T_Ground_Albedo_4K.png"),
    path.join(root, "8bit_T_Ground_Normal_4K.png")
  ];
  const { drafts } = await buildDrafts(files);
  assert.equal(drafts.length, 1);
  assert.match(drafts[0].form.tagsText, /PBRMAX/);
  assert.equal(drafts[0].form.textureEntries.find(entry => entry.textureType === "Diffuse")?.filePath.match(/_Albedo_4K\.png$/i)?.length, 1);
});

test("st9 foliage folder prefixes map to their standard asset tag (Tree_Conifer→Tree, Bush_CustomSpines→Bush)", async () => {
  const cases = [
    { folder: "Tree_Conifer", file: "Conifer.st9", tag: "Tree" },
    { folder: "Bush_CustomSpines", file: "Custom_Spines.st9", tag: "Bush" },
    { folder: "Grass_Patch", file: "Grass_Patch.st9", tag: "Grass" },
    { folder: "MicroFoliage_Moss", file: "Moss.st9", tag: "Micro" },
    { folder: "Micro_Lichen", file: "Lichen.st9", tag: "Micro" },
    { folder: "HeroFoliage_Oak", file: "Oak.st9", tag: "HeroFoliage" }
  ];
  for (const { folder, file, tag } of cases) {
    const root = path.join("D:\\ZionFiles\\Foliage\\Tree", folder);
    const files = [
      path.join(root, file),
      path.join(root, `${folder}_Albedo.png`),
      path.join(root, `${folder}_Normal.png`),
      path.join(root, `${folder}_thumb.jpg`)
    ];
    const { drafts } = await buildDrafts(files);
    assert.equal(drafts.length, 1, `${folder} should import as one asset`);
    assert.equal(drafts[0].form.assetType, "3dplant", `${folder} should be a 3D plant`);
    assert.match(drafts[0].form.tagsText, new RegExp(`(?:^|,\\s*)${tag}(?:,|$)`), `${folder} should be tagged ${tag}`);
    const expectedName = folder.slice(folder.indexOf("_") + 1);
    assert.equal(drafts[0].form.assetName, expectedName, `${folder} should remove its standard tag prefix from the asset name`);
  }
});

test("st9 foliage under a Tree/ parent folder is not tagged Tree when its own folder name has no tag prefix", async () => {
  const root = path.join("D:\\ZionFiles\\Foliage\\Tree", "OakHero_Field");
  const files = [
    path.join(root, "Oak_Hero_Field.st9"),
    path.join(root, "OakHero_Field_Albedo.png"),
    path.join(root, "OakHero_Field_Normal.png"),
    path.join(root, "OakHero_Field_thumb.jpg")
  ];
  const { drafts } = await buildDrafts(files);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].form.assetType, "3dplant");
  assert.equal(drafts[0].form.tagsText, "", "OakHero_Field must not inherit Tree from the parent /Tree/ path segment");
});

test("st9 BushSample without underscore is not auto-tagged", async () => {
  const root = path.join("D:\\ZionFiles\\Foliage\\Tree", "BushSample");
  const files = [
    path.join(root, "Bush_Hero.st9"),
    path.join(root, "BushSample_Albedo.png"),
    path.join(root, "BushSample_Normal.png"),
    path.join(root, "BushSample_thumb.jpg")
  ];
  const { drafts } = await buildDrafts(files);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].form.assetType, "3dplant");
  assert.equal(drafts[0].form.tagsText, "", "BushSample without an underscore must not be tagged Bush");
});

test("3D asset folder prefixes map to their standard asset tag (Props_ZG_Ding→Props)", async () => {
  const root = path.join("D:\\ZionFiles\\3DAssets", "Props_ZG_Ding");
  const files = [
    path.join(root, "ZG_Ding.fbx"),
    path.join(root, "ZG_Ding_Albedo.png"),
    path.join(root, "ZG_Ding_Normal.png"),
    path.join(root, "ZG_Ding_thumb.jpg")
  ];
  const { drafts } = await buildDrafts(files);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].form.assetType, "3d");
  assert.match(drafts[0].form.tagsText, /(?:^|,\s*)Props(?:,|$)/, "Props_ZG_Ding should be tagged Props");
  assert.equal(drafts[0].form.assetName, "ZG_Ding");
});
test("contained file names do not auto-fill non-source standard asset tags", async () => {
  const root = path.join("D:\\ZionFiles\\3DAssets", "ZG_Ding");
  const files = [
    path.join(root, "Dressing_Asset.fbx"),
    path.join(root, "Dressing_Asset_Albedo.png"),
    path.join(root, "Dressing_Asset_Normal.png"),
    path.join(root, "Dressing_Asset_ORM.png")
  ];
  const { drafts } = await buildDrafts(files);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].form.assetType, "3d");
  assert.equal(drafts[0].form.tagsText, "", "file names inside the folder must not auto-fill Dressing");
});

test("asset folder prefix stays authoritative over conflicting contained file names", async () => {
  const root = path.join("D:\\ZionFiles\\3DAssets", "Dressing_Sample");
  const files = [
    path.join(root, "Props_Asset.fbx"),
    path.join(root, "Props_Asset_Albedo.png"),
    path.join(root, "Props_Asset_Normal.png"),
    path.join(root, "Props_Asset_ORM.png")
  ];
  const { drafts } = await buildDrafts(files);
  assert.equal(drafts.length, 1);
  assert.match(drafts[0].form.tagsText, /(?:^|,\s*)Dressing(?:,|$)/, "Dressing_Sample should be tagged Dressing");
  assert.doesNotMatch(drafts[0].form.tagsText, /(?:^|,\s*)Props(?:,|$)/, "Props in a contained file name must not override the folder tag");
});
test("internal Props folder auto-fills 3D Assets, Props tag, FBX and D/N/ORM texture slots", async () => {
  const root = path.join("D:\\ZionFiles", "Props_ZG_Ding");
  const files = [
    path.join(root, "SM_Env_Props_Ding_01.fbx"),
    path.join(root, "T_Env_Props_Ding_01_4K_D.tga"),
    path.join(root, "T_Env_Props_Ding_01_4K_N.tga"),
    path.join(root, "T_Env_Props_Ding_01_4K_ORM.tga"),
    path.join(root, "Thumb_Env_Props_Ding_thumb.jpg"),
    path.join(root, "Thumb_Env_Props_Ding.png")
  ];
  const { drafts } = await buildDrafts(files);
  assert.equal(drafts.length, 1);
  const { form } = drafts[0];
  assert.equal(form.assetType, "3d");
  assert.match(form.tagsText, /(?:^|,\s*)Props(?:,|$)/);
  assert.equal(Object.values(form.modelSlots).length, 1);
  assert.match(Object.values(form.modelSlots)[0], /SM_Env_Props_Ding_01\.fbx$/i);

  const byType = new Map(form.textureEntries.map((entry) => [entry.textureType, entry.filePath]));
  assert.match(byType.get("Diffuse"), /_4K_D\.tga$/i);
  assert.match(byType.get("Normal"), /_4K_N\.tga$/i);
  assert.match(byType.get("ORM"), /_4K_ORM\.tga$/i);
  assert.equal(form.textureEntries.length, 3, "only D/N/ORM textures should be filled");
  assert.ok(form.textureEntries.every((entry) => !/_thumb|Thumb_/i.test(entry.filePath)), "thumbnail files must not become texture slots");
  assert.match(form.previewImagePath, /Thumb_Env_Props_Ding_thumb\.jpg$/i);
});

test("Megascans metadata keeps PBRMAX-like 8bit maps tagged Megascans", async () => {
  const root = path.join("D:\\ZionFiles", "RockPack_00369");
  const files = [
    path.join(root, "Rock.fbx"),
    path.join(root, "8bit_T_Rock_Albedo_4K.png"),
    path.join(root, "8bit_T_Rock_Metallic_4K.png"),
    path.join(root, "8bit_T_Rock_Normal_4K.png"),
    path.join(root, "Rock_thumb.jpg")
  ];
  const metadata = {
    name: "Rock",
    assetType: "3d",
    standardAssetTags: ["Megascans"],
    tags: []
  };
  const { drafts } = await buildDrafts(files, { metadata });
  assert.equal(drafts.length, 1);
  const { form } = drafts[0];
  assert.match(form.tagsText, /(?:^|,\s*)Megascans(?:,|$)/);
  assert.doesNotMatch(form.tagsText, /PBRMAX/i);
  const byType = new Map(form.textureEntries.map((entry) => [entry.textureType, entry.filePath]));
  assert.match(byType.get("Albedo"), /_Albedo_4K\.png$/i, "Megascans must not be normalized as a PBRMAX pack");
  assert.ok(!byType.has("Diffuse"), "the PBRMAX Albedo→Diffuse normalization must not leak into Megascans");
});

test("Megascans folder names do not identify the source without metadata", async () => {
  const root = path.join("D:\\ZionFiles", "Megascans_Rock");
  const files = [
    path.join(root, "Rock.fbx"),
    path.join(root, "Rock_Albedo.png"),
    path.join(root, "Rock_Normal.png"),
    path.join(root, "Rock_Roughness.png")
  ];
  const { drafts } = await buildDrafts(files);
  assert.equal(drafts.length, 1);
  assert.doesNotMatch(drafts[0].form.tagsText, /(?:^|,\s*)Megascans(?:,|$)/i);
});

test("Quixel Bridge metadata signature identifies Megascans without literal source text", () => {
  const metadata = {
    name: "Cracked Asphalt",
    categories: ["surface", "asphalt", "cracked"],
    semanticTags: { asset_type: "surface", subject_matter: "manmade" },
    assetCategories: { surface: { asphalt: { torn: {} } } },
    maps: [
      { mimeType: "image/jpeg", type: "albedo", resolution: "4096x4096", uri: "sivodcfa_4K_Albedo.jpg" }
    ],
    previews: { preview: { uri: "sivodcfa_Preview.png" } },
    uasset: []
  };
  assert.deepEqual(detectSourceStandardAssetTags(metadata), ["Megascans"]);
});

test("Megascans category resolver follows Bridge assetCategories and canonical UI categories", () => {
  assert.equal(resolveMegascansCategory({
    categories: ["3d", "props"],
    assetCategories: { "3D asset": { street: {}, industrial: {}, props: {} } }
  }, "3d"), "Props", "the categories hint must disambiguate multiple 3D branches");
  assert.equal(resolveMegascansCategory({
    categories: ["3d", "other"],
    assetCategories: { "3D asset": { historical: { medieval: {} }, props: { weaponry: {} } } }
  }, "3d"), "Historical", "assetCategories stays authoritative over a generic other category");
  assert.equal(resolveMegascansCategory({
    categories: ["surface", "imperfections", "grunge"],
    assetCategories: { imperfection: { grunge: {} } }
  }, "surface"), "Other", "imperfection assets map to the supported Surface Other category");
  assert.equal(resolveMegascansCategory({
    categories: ["surface", "asphalt", "cracked"]
  }, "surface"), "Asphalt", "categories remains a fallback when assetCategories is absent");
});

test("Quixel Bridge 3D metadata identifies Megascans and fills the 3D Assets tag", async () => {
  const root = path.join("D:\\BridgeLibrary\\Downloaded\\3d", "3d_concrete_ujikdbrva");
  const files = [
    path.join(root, "ujikdbrva_LOD0.fbx"),
    path.join(root, "ujikdbrva_4K_Albedo.jpg"),
    path.join(root, "ujikdbrva_4K_Normal_LOD0.jpg"),
    path.join(root, "ujikdbrva_4K_Roughness.jpg")
  ];
  const metadata = {
    name: "Concrete Pillar",
    assetType: "3d",
    json: { uri: "ujikdbrva.json" },
    categories: ["3d", "concrete"],
    semanticTags: { asset_type: "3D asset" },
    assetCategories: { "3D asset": { building: { pillar: {} } } },
    meshes: [{ type: "lod", uris: [{ mimeType: "application/x-fbx", uri: "ujikdbrva_LOD0.fbx" }] }],
    components: [{ type: "albedo", uris: [{ resolution: "4096x4096", formats: [{ mimeType: "image/jpeg", uri: "ujikdbrva_4K_Albedo.jpg" }] }] }],
    previews: { images: [{ uri: "ujikdbrva_Preview.png" }] },
    uasset: [{ type: "model", uri: "UAsset/Tier0/S_Concrete_Pillar_ujikdbrva_high_Var1.uasset" }]
  };
  assert.deepEqual(detectSourceStandardAssetTags(metadata), ["Megascans"]);
  metadata.standardAssetTags = detectSourceStandardAssetTags(metadata);
  metadata.category = resolveMegascansCategory(metadata, "3d");
  assert.equal(metadata.category, "Building");

  const { drafts } = await buildDrafts(files, { metadata });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].form.assetType, "3d");
  assert.equal(drafts[0].form.subCategory, "Building");
  assert.match(drafts[0].form.tagsText, /(?:^|,\s*)Megascans(?:,|$)/);
  assert.doesNotMatch(drafts[0].form.tagsText, /PBRMAX/i);
});

test("Bridge metadata category never becomes a 标签 tag", async () => {
  const root = path.join("D:\\BridgeLibrary\\Downloaded\\3d", "3d_concrete_ujikdbrva");
  const files = [
    path.join(root, "ujikdbrva_LOD0.fbx"),
    path.join(root, "ujikdbrva_4K_Albedo.jpg"),
    path.join(root, "ujikdbrva_4K_Normal.jpg")
  ];
  // readMegascansDropMetadata() 会把元数据的 category / categories 一起扫进 tags。
  // 「分类」与 Asset Type 是独立的分类维度，不能回灌成标签；真正的自定义标签要保留。
  const metadata = {
    name: "Concrete Pillar",
    assetType: "3d",
    standardAssetTags: ["Megascans"],
    category: "Building",
    tags: ["3d", "3dasset", "building", "weathered"]
  };
  const { drafts } = await buildDrafts(files, { metadata });
  assert.equal(drafts.length, 1);
  const { form } = drafts[0];
  assert.equal(form.subCategory, "Building");
  assert.match(form.tagsText, /(?:^|,\s*)Megascans(?:,|$)/, "标准 Asset Tag 仍然保留");
  assert.match(form.tagsText, /(?:^|,\s*)weathered(?:,|$)/, "自定义标签仍然保留");
  assert.doesNotMatch(form.tagsText, /building/i, "分类不得作为标签回灌");
  assert.doesNotMatch(form.tagsText, /(?:^|,\s*)(?:3d|3dasset)(?:,|$)/i, "Asset Type 不得作为标签回灌");
});

test("Surface imports do not regenerate the retired Tile standard tag from metadata", async () => {
  const root = path.join("D:\\BridgeLibrary\\Downloaded\\surface", "surface_tile_pack");
  const files = [
    path.join(root, "surface_tile_4K_Albedo.jpg"),
    path.join(root, "surface_tile_4K_Normal.jpg")
  ];
  const { drafts } = await buildDrafts(files, {
    folderName: "surface_tile_pack",
    metadata: { name: "Tile Pack", assetType: "surface", tags: ["tile", "surface"] }
  });
  assert.equal(drafts.length, 1);
  const { form } = drafts[0];
  assert.equal(form.assetType, "surface");
  assert.doesNotMatch(form.tagsText, /(?:^|,\s*)tile(?:,|$)/i);
  assert.deepEqual(buildScope([]).getStandardAssetTagOptions("surface"), ["ThirdParty"]);
  assert.doesNotMatch(form.tagsText, /(?:^|,\s*)surface(?:,|$)/i, "Asset Type 不得作为标签回灌");
});

// 编辑弹窗（openEditAsset）与导入草稿共用同一套分类维度判定：分类与 Asset Type 不进
// 「标签」槽，而与其同名的标准 Asset Tag 必须保留。openEditAsset 依赖 IPC 与大量界面
// 状态，这里锁定它复用的纯函数语义。
test("分类维度判定：分类 / Asset Type 不入标签槽，标准 Asset Tag 与自定义标签保留", () => {
  const scope = buildScope([]);
  const { buildTaxonomyTagKeys, isTaxonomyTag } = scope;

  const plantKeys = buildTaxonomyTagKeys({
    assetType: "3dplant",
    assetTypeLabel: "3D 植物",
    subCategory: "Flowering Plant",
    category: "Flowering Plant",
    folderAliases: ["3dplant", "3dplants", "plant3d", "foliage", "plants"],
    keepTags: ["Tree", "Bush", "Grass", "MicroFoliage", "HeroFoliage", "Megascans", "PBRMAX"]
  });
  for (const tag of ["Flowering Plant", "floweringplant", "flowering_plant", "3dplant", "3D 植物", "foliage"]) {
    assert.equal(isTaxonomyTag(tag, plantKeys), true, `${tag} 应视为分类维度`);
  }
  for (const tag of ["Megascans", "Tree", "weathered"]) {
    assert.equal(isTaxonomyTag(tag, plantKeys), false, `${tag} 必须保留为标签`);
  }

  const propsKeys = buildTaxonomyTagKeys({
    assetType: "3d",
    subCategory: "Props",
    category: "Props",
    keepTags: ["Props", "Destructible", "Dressing", "Megascans", "PBRMAX", "Kits", "MEGA"]
  });
  assert.equal(isTaxonomyTag("Props", propsKeys), false, "Props 同时是标准 Asset Tag，必须保留");
  assert.equal(isTaxonomyTag("props", propsKeys), false);

  const natureKeys = buildTaxonomyTagKeys({
    assetType: "3d",
    subCategory: "Nature",
    category: "Nature",
    keepTags: ["Props", "Megascans"]
  });
  assert.equal(isTaxonomyTag("Nature", natureKeys), true, "分类必须从标签槽剔除");
  assert.equal(isTaxonomyTag("nature", natureKeys), true);
  assert.equal(isTaxonomyTag("3d", natureKeys), true, "Asset Type 必须从标签槽剔除");
  assert.equal(isTaxonomyTag("Megascans", natureKeys), false);
});

test("Quixel Bridge 3D Plant metadata fills the Megascans standard tag", async () => {
  const root = path.join("D:\\BridgeLibrary\\Downloaded\\3dplant", "3dplant_fern_vmkpdbeia");
  const files = [
    path.join(root, "Fern.st9"),
    path.join(root, "vmkpdbeia_4K_Albedo.jpg"),
    path.join(root, "vmkpdbeia_4K_Normal.jpg")
  ];
  const metadata = {
    pack: { _id: "temperate-forest", name: "Temperate Forest" },
    name: "Beech Fern",
    json: { uri: "ab12cd34.json" },
    categories: ["3dplant", "fern"],
    semanticTags: { asset_type: "3D plant" },
    assetCategories: { "3D plant": { fern: {} } },
    meshes: [{ type: "original", uris: [{ mimeType: "application/x-st9", uri: "Fern.st9" }] }],
    previews: { images: [{ uri: "ab12cd34_Preview.png" }] }
  };
  metadata.standardAssetTags = detectSourceStandardAssetTags(metadata);
  metadata.category = resolveMegascansCategory(metadata, "3dplant");
  assert.equal(metadata.category, "Fern");

  const { drafts } = await buildDrafts(files, { metadata });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].form.assetType, "3dplant");
  assert.equal(drafts[0].form.subCategory, "Fern");
  assert.match(drafts[0].form.tagsText, /(?:^|,\s*)Megascans(?:,|$)/);
});

test("Bridge micro plants retain the Micro and ThirdParty standard tags on the import draft", async () => {
  const root = path.join("E:\\Downloads", "plants_3d_rbDjZ");
  const { drafts } = await buildDrafts([path.join(root, "Clovers.fbx"), path.join(root, "Clovers_Albedo.jpg")], {
    metadata: { name: "Clovers", assetType: "3dplant", standardAssetTags: ["Megascans", "Micro"], tags: ["clover"] }
  });
  const tags = drafts[0].form.tagsText.split(",").map(tag => tag.trim());
  assert.ok(tags.includes("Micro"));
  assert.ok(tags.includes("ThirdParty"));
});

test("Megascans st9 plant uses the preview referenced by its metadata", async () => {
  const root = path.join("E:\\Downloads", "3dplant_herb_umsfeaxja");
  const preview = path.join(root, "umsfeaxja_Preview.png");
  const thumb = path.join(root, "Herb_thumb.jpg");
  const { drafts } = await buildDrafts([
    path.join(root, "Herb.st9"), preview, thumb,
    path.join(root, "umsfeaxja_4K_Albedo.jpg")
  ], { metadata: {
    name: "Herb", assetType: "3dplant", standardAssetTags: ["Megascans"],
    previewImagePath: preview
  } });
  assert.equal(drafts[0].form.previewImagePath, preview);
});

test("Megascans st9 plant falls back to its root Preview image", async () => {
  const root = path.join("E:\\Downloads", "3dplant_herb_umsfeaxja");
  const preview = path.join(root, "umsfeaxja_Preview.png");
  const files = [path.join(root, "Herb.st9"), preview, path.join(root, "Herb_thumb.jpg"), path.join(root, "umsfeaxja_4K_Albedo.jpg")];
  const megascans = await buildDrafts(files, { metadata: {
    name: "Herb", assetType: "3dplant", standardAssetTags: ["Megascans"]
  } });
  assert.equal(megascans.drafts[0].form.previewImagePath, preview);
  const ordinary = await buildDrafts(files);
  assert.equal(ordinary.drafts[0].form.previewImagePath, path.join(root, "Herb_thumb.jpg"), "ordinary st9 preview rules stay strict");
});

test("Megascans FBX plant uses the root Preview when Bridge image URIs are missing", async () => {
  const root = path.join("E:\\Downloads", "3dplant_herb_umsfeaxja");
  const preview = path.join(root, "umsfeaxja_Preview.png");
  const { drafts } = await buildDrafts([
    path.join(root, "Var1", "Var1_LOD0.fbx"), preview,
    path.join(root, "umsfeaxja_4K_Albedo.jpg")
  ], { metadata: {
    name: "Peppermint", assetType: "3dplant", standardAssetTags: ["Megascans"]
  } });
  assert.equal(drafts[0].form.previewImagePath, preview);
});

test("Megascans 3D Plant metadata keeps every variant and attaches its LOD chain", async () => {
  const root = path.join("D:\\BridgeLibrary\\Downloaded\\3dplant", "3dplant_fern_vmkpdbeia");
  const files = [];
  for (const variation of Array.from({ length: 12 }, (_, index) => index + 1)) {
    for (const lod of [0, 1, 2, 3, 4]) {
      files.push(path.join(root, `Var${variation}`, `Var${variation}_LOD${lod}.fbx`));
    }
  }
  const modelFiles = Array.from({ length: 12 }, (_, index) => path.join(root, `Var${index + 1}`, `Var${index + 1}_LOD0.fbx`));
  const metadata = {
    name: "Beech Fern",
    assetType: "3dplant",
    standardAssetTags: ["Megascans"],
    tags: ["megascans"],
    modelFiles,
    modelVariants: modelFiles.map((file, index) => ({ file, variantKey: String(index + 1).padStart(2, "0"), variantNumber: index + 1 })),
    modelLods: files.map((file, index) => ({
      file,
      variantKey: String(Math.floor(index / 5) + 1).padStart(2, "0"),
      lod: index % 5
    })),
    textureSlots: []
  };

  const { drafts } = await buildDrafts(files, { metadata });
  assert.equal(drafts.length, 1);
  const { form } = drafts[0];
  assert.equal(form.assetType, "3dplant");
  assert.equal(Object.keys(form.modelSlots).length, 12);
  assert.deepEqual(Object.values(form.modelVariantKeys), Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, "0")));
  const slotKeys = Object.keys(form.modelSlots);
  assert.deepEqual(form.modelLodFiles[slotKeys[0]].map((entry) => entry.lod), [0, 1, 2, 3, 4]);
  assert.deepEqual(form.modelLodFiles[slotKeys[11]].map((entry) => entry.lod), [0, 1, 2, 3, 4]);
});

test("Quixel Bridge Atlas metadata maps to Decal and fills the Megascans standard tag", async () => {
  const root = path.join("D:\\BridgeLibrary\\Downloaded\\atlas", "atlas_moss_ab12cd34");
  const files = [
    path.join(root, "ab12cd34_4K_Albedo.jpg"),
    path.join(root, "ab12cd34_4K_Normal.jpg"),
    path.join(root, "ab12cd34_4K_Opacity.jpg")
  ];
  const metadata = {
    pack: { _id: "forest", name: "Forest" },
    name: "Moss Atlas",
    json: { uri: "ab12cd34.json" },
    categories: ["atlas", "moss"],
    semanticTags: { asset_type: "atlas" },
    assetCategories: { atlas: { moss: {} } },
    maps: [{ mimeType: "image/jpeg", type: "albedo", resolution: "4096x4096", uri: "ab12cd34_4K_Albedo.jpg" }],
    previews: { preview: { uri: "ab12cd34_Preview.png" } }
  };
  metadata.assetType = "decal";
  metadata.standardAssetTags = detectSourceStandardAssetTags(metadata);
  metadata.category = resolveMegascansCategory(metadata, "decal");
  assert.deepEqual(metadata.standardAssetTags, ["Megascans"]);
  assert.equal(metadata.category, "Moss");

  const { drafts } = await buildDrafts(files, { metadata });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].form.assetType, "decal");
  assert.equal(drafts[0].form.subCategory, "Moss");
  assert.match(drafts[0].form.tagsText, /(?:^|,\s*)Megascans(?:,|$)/);
});

test("Quixel Bridge Smart Material metadata identifies Megascans without semantic asset type", () => {
  const metadata = {
    name: "Aluminium - Anodized (Red)",
    categories: ["smartmaterial", "smartmaterials", "mixer"],
    maps: [{ name: "SmartMaterial", type: "smartmaterial", uri: "Aluminium - Anodized (Red).xml" }],
    previews: { images: [{ uri: "SmartMaterialPreview.png" }] }
  };
  assert.deepEqual(detectSourceStandardAssetTags(metadata), ["Megascans"]);
});

test("Megascans Bridge Surface metadata fills Megascans instead of Tile", async () => {
  const root = path.join("D:\\BridgeLibrary\\Downloaded\\surface", "asphalt_cracked_sivodcfa");
  const files = [
    path.join(root, "sivodcfa_4K_Albedo.jpg"),
    path.join(root, "sivodcfa_4K_AO.jpg"),
    path.join(root, "sivodcfa_4K_Displacement.jpg"),
    path.join(root, "sivodcfa_4K_Normal.jpg"),
    path.join(root, "sivodcfa_4K_Roughness.jpg")
  ];
  const metadata = {
    name: "Cracked Asphalt",
    assetType: "surface",
    categories: ["surface", "asphalt", "cracked"],
    semanticTags: { asset_type: "surface" },
    assetCategories: { surface: { asphalt: { torn: {} } } },
    maps: [
      { mimeType: "image/jpeg", type: "albedo", resolution: "4096x4096", uri: "sivodcfa_4K_Albedo.jpg" }
    ],
    previews: { preview: { uri: "sivodcfa_Preview.png" } }
  };
  metadata.standardAssetTags = detectSourceStandardAssetTags(metadata);
  metadata.category = resolveMegascansCategory(metadata, "surface");
  assert.equal(metadata.category, "Asphalt");
  const { drafts } = await buildDrafts(files, { metadata });
  assert.equal(drafts.length, 1);
  const { form } = drafts[0];
  assert.equal(form.assetType, "surface");
  assert.equal(form.subCategory, "Asphalt");
  assert.match(form.tagsText, /(?:^|,\s*)Megascans(?:,|$)/);
  assert.doesNotMatch(form.tagsText, /(?:^|,\s*)Tile(?:,|$)/);
});

test("Tile folder prefix is suppressed for Megascans and PBRMAX Surface sources", async () => {
  const megascansRoot = path.join("D:\\ZionFiles", "Tile_Megascans_Surface");
  const megascans = await buildDrafts([
    path.join(megascansRoot, "Stone_Albedo.png"),
    path.join(megascansRoot, "Stone_Normal.png"),
    path.join(megascansRoot, "Stone_Roughness.png")
  ], {
    metadata: { name: "Stone", assetType: "surface", standardAssetTags: ["Megascans"], tags: [] }
  });
  assert.equal(megascans.drafts[0].form.assetType, "surface");
  assert.match(megascans.drafts[0].form.tagsText, /(?:^|,\s*)Megascans(?:,|$)/);
  assert.doesNotMatch(megascans.drafts[0].form.tagsText, /(?:^|,\s*)Tile(?:,|$)/);

  const pbrMaxRoot = path.join("D:\\ZionFiles", "Tile_PBRMAX_Surface");
  const pbrMax = await buildDrafts([
    path.join(pbrMaxRoot, "8bit_T_Stone_Albedo_4K.png"),
    path.join(pbrMaxRoot, "8bit_T_Stone_Metallic_4K.png"),
    path.join(pbrMaxRoot, "8bit_T_Stone_Normal_4K.png")
  ]);
  assert.equal(pbrMax.drafts[0].form.assetType, "surface");
  assert.match(pbrMax.drafts[0].form.tagsText, /(?:^|,\s*)PBRMAX(?:,|$)/);
  assert.doesNotMatch(pbrMax.drafts[0].form.tagsText, /(?:^|,\s*)Tile(?:,|$)/);
});

test("Zion Tile folder prefix maps to Surface without a standard tag and detects compact texture names", async () => {
  const root = path.join("D:\\ZionFiles\\Landscape\\Zhaoge", "Tile_ZG_Scorched");
  const files = [
    path.join(root, "T_Env_Tile_Landscape_ZG_Scorched_BCR.tga"),
    path.join(root, "T_Env_Tile_Landscape_ZG_Scorched_Dis.png"),
    path.join(root, "T_Env_Tile_Landscape_ZG_Scorched_Metalness.png"),
    path.join(root, "T_Env_Tile_Landscape_ZG_Scorched_N.tga")
  ];
  const { drafts } = await buildDrafts(files);
  assert.equal(drafts.length, 1);
  const { form } = drafts[0];
  assert.equal(form.assetType, "surface");
  assert.equal(form.tagsText, "");
  assert.equal(form.assetName, "ZG_Scorched");
  const textureTypes = new Set(form.textureEntries.map((entry) => entry.textureType));
  for (const textureType of ["BasecolorRoughness", "Displacement", "Metalness", "Normal"]) {
    assert.ok(textureTypes.has(textureType), `${textureType} should be detected for the Zion Tile Surface asset`);
  }
});

test("Zion Surface folder prefix maps to Surface without a standard tag", async () => {
  const root = path.join("D:\\ZionFiles\\Landscape\\Zhaoge", "Surface_ZG_Scorched");
  const files = [
    path.join(root, "T_Env_Tile_Landscape_ZG_Scorched_BCR.tga"),
    path.join(root, "T_Env_Tile_Landscape_ZG_Scorched_Dis.png"),
    path.join(root, "T_Env_Tile_Landscape_ZG_Scorched_Metalness.png"),
    path.join(root, "T_Env_Tile_Landscape_ZG_Scorched_N.tga")
  ];
  const { drafts } = await buildDrafts(files);
  assert.equal(drafts.length, 1);
  const { form } = drafts[0];
  assert.equal(form.assetType, "surface");
  assert.equal(form.tagsText, "");
  assert.equal(form.assetName, "ZG_Scorched");
});

test("Asset Type switching preserves paths for matching texture types", () => {
  const { switchImportTextureEntriesForAssetType } = buildScope([], {});
  const sourceEntries = [
    { id: "diffuse", textureType: "Diffuse", filePath: "D:\\Textures\\Asset_D.png", areaId: 1 },
    { id: "normal", textureType: "Normal", filePath: "D:\\Textures\\Asset_N.png", areaId: 1 },
    { id: "orm", textureType: "ORM", filePath: "D:\\Textures\\Asset_ORM.png", areaId: 1 }
  ];
  const switched = switchImportTextureEntriesForAssetType(sourceEntries, "decal");
  const byType = new Map(switched.map(entry => [entry.textureType, entry]));
  assert.equal(byType.get("Diffuse")?.filePath, sourceEntries[0].filePath);
  assert.equal(byType.get("Normal")?.filePath, sourceEntries[1].filePath);
  assert.equal(byType.get("ORM")?.filePath, sourceEntries[2].filePath);
  assert.equal(byType.get("Opacity")?.filePath, "", "new target texture types start empty");
  assert.deepEqual(switched.map(entry => entry.textureType), ["Diffuse", "Normal", "Opacity", "ORM"]);
});

test("Asset Type switching does not recreate optional ORM slots", () => {
  const { switchImportTextureEntriesForAssetType } = buildScope([], {});
  const sourceEntries = [
    { id: "diffuse", textureType: "Diffuse", filePath: "D:\\Textures\\Asset_D.png", areaId: 1 },
    { id: "normal", textureType: "Normal", filePath: "D:\\Textures\\Asset_N.png", areaId: 1 }
  ];
  for (const assetType of ["3d", "3dplant", "decal"]) {
    const switched = switchImportTextureEntriesForAssetType(sourceEntries, assetType);
    assert.equal(switched.some(entry => entry.textureType === "ORM"), false, assetType);
    assert.equal(switched.find(entry => entry.textureType === "Diffuse")?.filePath, sourceEntries[0].filePath);
    assert.equal(switched.find(entry => entry.textureType === "Normal")?.filePath, sourceEntries[1].filePath);
  }
  const decal = switchImportTextureEntriesForAssetType(sourceEntries, "decal");
  assert.equal(decal.find(entry => entry.textureType === "Opacity")?.filePath, "");
  const roundTrip = switchImportTextureEntriesForAssetType(decal, "3d");
  assert.deepEqual(roundTrip.map(entry => entry.textureType), ["Diffuse", "Normal"]);
  assert.equal(switchImportTextureEntriesForAssetType([], "3d").some(entry => entry.textureType === "ORM"), false);
});

test("Asset Type switching keeps existing ORM only in its own area and material role", () => {
  const { switchImportTextureEntriesForAssetType } = buildScope([], {});
  const sourceEntries = [
    { id: "diffuse-1", textureType: "Diffuse", filePath: "D:\\Textures\\Atlas_D.png", areaId: 1, materialRole: "atlas" },
    { id: "orm-1", textureType: "ORM", filePath: "D:\\Textures\\Atlas_ORM.png", areaId: 1, materialRole: "atlas" },
    { id: "diffuse-billboard", textureType: "Diffuse", filePath: "D:\\Textures\\Billboard_D.png", areaId: 1, materialRole: "billboard" },
    { id: "diffuse-2", textureType: "Diffuse", filePath: "D:\\Textures\\Area2_D.png", areaId: 2 },
    { id: "orm-2", textureType: "ORM", filePath: "", areaId: 2 }
  ];
  const before = sourceEntries.map(entry => ({ ...entry }));
  const switched = switchImportTextureEntriesForAssetType(sourceEntries, "3dplant");
  assert.deepEqual(switched.filter(entry => entry.textureType === "ORM"), [sourceEntries[1], sourceEntries[4]]);
  assert.equal(switched.some(entry => entry.materialRole === "billboard" && entry.textureType === "ORM"), false);
  assert.deepEqual(sourceEntries, before);
});

test("Asset Type switching preserves matching texture paths per texture group", () => {
  const { switchImportTextureEntriesForAssetType } = buildScope([], {});
  const sourceEntries = [
    { id: "diffuse-1", textureType: "Diffuse", filePath: "D:\\Textures\\Area1_D.png", areaId: 1 },
    { id: "normal-1", textureType: "Normal", filePath: "D:\\Textures\\Area1_N.png", areaId: 1 },
    { id: "diffuse-2", textureType: "Diffuse", filePath: "D:\\Textures\\Area2_D.png", areaId: 2 },
    { id: "normal-2", textureType: "Normal", filePath: "D:\\Textures\\Area2_N.png", areaId: 2 }
  ];
  const switched = switchImportTextureEntriesForAssetType(sourceEntries, "surface");
  const findPath = (areaId, textureType) => switched.find(
    entry => entry.areaId === areaId && entry.textureType === textureType
  )?.filePath;
  assert.equal(findPath(1, "Diffuse"), "D:\\Textures\\Area1_D.png");
  assert.equal(findPath(1, "Normal"), "D:\\Textures\\Area1_N.png");
  assert.equal(findPath(2, "Diffuse"), "D:\\Textures\\Area2_D.png");
  assert.equal(findPath(2, "Normal"), "D:\\Textures\\Area2_N.png");
  assert.equal(findPath(1, "Roughness"), "");
  assert.equal(findPath(2, "Displacement"), "");
});
test("all 3D standard asset tag folder prefixes map to 3D Assets and their tag", async () => {
  for (const tag of ["Props", "Destructible", "Dressing", "PBRMAX", "Kits", "MEGA"]) {
    const root = path.join("D:\\ZionFiles\\3DAssets", `${tag}_Sample`);
    const files = [
      path.join(root, "Asset.fbx"),
      path.join(root, "T_Asset_01_4K_D.tga"),
      path.join(root, "T_Asset_01_4K_N.tga"),
      path.join(root, "T_Asset_01_4K_ORM.tga"),
      path.join(root, "Asset_thumb.jpg")
    ];
    const { drafts } = await buildDrafts(files);
    assert.equal(drafts.length, 1, `${tag} should produce one draft`);
    assert.equal(drafts[0].form.assetType, "3d", `${tag} should map to 3D Assets`);
    assert.match(drafts[0].form.tagsText, new RegExp(`(?:^|,\\s*)${tag}(?:,|$)`), `${tag} should be auto-filled`);
  }
});

test("Kit and Kits folder prefixes both map to Kits", async () => {
  for (const prefix of ["Kit", "Kits"]) {
    const root = path.join("D:\\ZionFiles\\3DAssets", `${prefix}_WallSet`);
    const files = [
      path.join(root, "Asset.fbx"),
      path.join(root, "T_Asset_01_4K_D.tga"),
      path.join(root, "T_Asset_01_4K_N.tga"),
      path.join(root, "T_Asset_01_4K_ORM.tga"),
      path.join(root, "Asset_thumb.jpg")
    ];
    const { drafts } = await buildDrafts(files);
    assert.equal(drafts.length, 1, `${prefix} should produce one draft`);
    assert.equal(drafts[0].form.assetType, "3d", `${prefix} should map to 3D Assets`);
    assert.match(drafts[0].form.tagsText, /(?:^|,\s*)Kits(?:,|$)/, `${prefix} should map to the Kits tag`);
    assert.equal(drafts[0].form.assetName, "WallSet", `${prefix} should be removed from the asset name`);
  }
});

test("PBRMAX pure texture packs fall back to Surface and keep the PBRMAX source tag", async () => {
  const root = path.join("D:\\ZionFiles", "PBRMAX_StoneWall");
  const files = [
    path.join(root, "8bit_T_StoneWall_Albedo_4K.png"),
    path.join(root, "8bit_T_StoneWall_Metallic_4K.png"),
    path.join(root, "8bit_T_StoneWall_Normal_4K.png"),
    path.join(root, "8bit_T_StoneWall_Roughness_4K.png")
  ];
  const { drafts } = await buildDrafts(files);
  assert.equal(drafts.length, 1);
  const { form } = drafts[0];
  assert.equal(form.assetType, "surface", "a PBRMAX pack without a model must not be forced to 3D Assets");
  assert.match(form.tagsText, /(?:^|,\s*)PBRMAX(?:,|$)/);
  assert.equal(Object.values(form.modelSlots).length, 0);
  const byType = new Map(form.textureEntries.map(entry => [entry.textureType, entry.filePath]));
  assert.match(byType.get("Diffuse"), /_Albedo_4K\.png$/i);
  assert.match(byType.get("Metalness"), /_Metallic_4K\.png$/i);
});

test("PBRMAX Surface folder hints resolve their Asset Type and PBRMAX tag", async () => {
  const root = path.join("D:\\ZionFiles", "PBRMAX_Surface_Stone");
  const files = [
    path.join(root, "8bit_T_Stone_Albedo_4K.png"),
    path.join(root, "8bit_T_Stone_Normal_4K.png"),
    path.join(root, "8bit_T_Stone_Roughness_4K.png"),
    path.join(root, "8bit_T_Stone_Displacement_4K.png")
  ];
  const { drafts } = await buildDrafts(files);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].form.assetType, "surface");
  assert.match(drafts[0].form.tagsText, /(?:^|,\s*)PBRMAX(?:,|$)/);
});

test("PBRMAX Decal folder hints resolve their Asset Type and PBRMAX tag", async () => {
  const root = path.join("D:\\ZionFiles", "PBRMAX_Decal_Rust");
  const files = [
    path.join(root, "8bit_T_Rust_Albedo_4K.png"),
    path.join(root, "8bit_T_Rust_Normal_4K.png"),
    path.join(root, "8bit_T_Rust_OpacityMasked_4K.png"),
    path.join(root, "8bit_T_Rust_ORM_4K.png")
  ];
  const { drafts } = await buildDrafts(files);
  assert.equal(drafts.length, 1);
  const { form } = drafts[0];
  assert.equal(form.assetType, "decal");
  assert.match(form.tagsText, /(?:^|,\s*)PBRMAX(?:,|$)/);
  const textureTypes = new Set(form.textureEntries.map(entry => entry.textureType));
  for (const textureType of ["Diffuse", "Normal", "Opacity", "ORM"]) {
    assert.ok(textureTypes.has(textureType), `${textureType} should be detected for a PBRMAX decal`);
  }
});

test("PBRMAX Decal prefix may appear after the type hint", async () => {
  const root = path.join("D:\\ZionFiles", "Decal_PBRMAX_Rust");
  const files = [
    path.join(root, "8bit_T_Rust_Albedo_4K.png"),
    path.join(root, "8bit_T_Rust_Normal_4K.png"),
    path.join(root, "8bit_T_Rust_OpacityMasked_4K.png"),
    path.join(root, "8bit_T_Rust_ORM_4K.png")
  ];
  const { drafts } = await buildDrafts(files);
  assert.equal(drafts.length, 1);
  const { form } = drafts[0];
  assert.equal(form.assetType, "decal");
  assert.match(form.tagsText, /(?:^|,\s*)PBRMAX(?:,|$)/);
  const textureTypes = new Set(form.textureEntries.map(entry => entry.textureType));
  for (const textureType of ["Diffuse", "Normal", "Opacity", "ORM"]) {
    assert.ok(textureTypes.has(textureType), `${textureType} should be detected for a PBRMAX decal`);
  }
});

test("PBRMAX _DC_ folder naming resolves the Decal Asset Type", async () => {
  const root = path.join("D:\\ZionFiles", "PBRMAX_00369_DC_Moss");
  const files = [
    path.join(root, "8bit_T_00369_DC_Moss_Albedo_4K.png"),
    path.join(root, "8bit_T_00369_DC_Moss_Normal_4K.png"),
    path.join(root, "8bit_T_00369_DC_Moss_OpacityMasked_4K.png"),
    path.join(root, "8bit_T_00369_DC_Moss_ORM_4K.png")
  ];
  const { drafts } = await buildDrafts(files);
  assert.equal(drafts.length, 1);
  const { form } = drafts[0];
  assert.equal(form.assetType, "decal");
  assert.match(form.tagsText, /(?:^|,\s*)PBRMAX(?:,|$)/);
  const textureTypes = new Set(form.textureEntries.map(entry => entry.textureType));
  for (const textureType of ["Diffuse", "Normal", "Opacity", "ORM"]) {
    assert.ok(textureTypes.has(textureType), `${textureType} should be detected for a PBRMAX _DC_ decal`);
  }
});

test("PBRMAX metadata plus _DC_ naming resolves the Decal Asset Type", async () => {
  const root = path.join("D:\\ZionFiles", "00369_DC_Moss");
  const files = [
    path.join(root, "8bit_T_00369_DC_Moss_Albedo_4K.png"),
    path.join(root, "8bit_T_00369_DC_Moss_Normal_4K.png"),
    path.join(root, "8bit_T_00369_DC_Moss_OpacityMasked_4K.png"),
    path.join(root, "8bit_T_00369_DC_Moss_ORM_4K.png")
  ];
  const metadata = {
    name: "00369_DC_Moss",
    assetType: "",
    standardAssetTags: ["PBRMAX"],
    tags: []
  };
  const { drafts } = await buildDrafts(files, { metadata });
  assert.equal(drafts.length, 1);
  const { form } = drafts[0];
  assert.equal(form.assetType, "decal");
  assert.match(form.tagsText, /(?:^|,\s*)PBRMAX(?:,|$)/);
});

test("PBRMAX 3D Plant folder hints resolve their Asset Type and PBRMAX tag", async () => {
  const root = path.join("D:\\ZionFiles", "PBRMAX_3DPlant_Conifer");
  const files = [
    path.join(root, "Conifer.fbx"),
    path.join(root, "8bit_T_Conifer_Albedo_4K.png"),
    path.join(root, "8bit_T_Conifer_Normal_4K.png")
  ];
  const { drafts } = await buildDrafts(files);
  assert.equal(drafts.length, 1);
  const { form } = drafts[0];
  assert.equal(form.assetType, "3dplant");
  assert.match(form.tagsText, /(?:^|,\s*)PBRMAX(?:,|$)/);
});

test("PBRMAX folder hints do not auto-tag HDRI assets", async () => {
  const root = path.join("D:\\ZionFiles", "PBRMAX_HDRI_Sunset");
  const { drafts } = await buildDrafts([path.join(root, "Sunset.hdr")]);
  assert.equal(drafts.length, 1);
  const { form } = drafts[0];
  assert.equal(form.assetType, "hdri");
  assert.doesNotMatch(form.tagsText, /(?:^|,\s*)PBRMAX(?:,|$)/i);
});

test("PBRMAX source names do not auto-tag HDRI when the type falls back from the file", async () => {
  const root = path.join("D:\\ZionFiles", "PBRMAX_Sunset");
  const { drafts } = await buildDrafts([path.join(root, "Sunset.hdr")]);
  assert.equal(drafts.length, 1);
  const { form } = drafts[0];
  assert.equal(form.assetType, "hdri");
  assert.doesNotMatch(form.tagsText, /(?:^|,\s*)PBRMAX(?:,|$)/i);
});


test("custom Dressing folder removes the first standard asset tag from its name", async () => {
  const root = path.join("D:\\ZionFiles\\3DAssets", "Dressing_ZG_Diaodeng");
  const files = [
    path.join(root, "SM_ZG_Diaodeng.fbx"),
    path.join(root, "T_ZG_Diaodeng_D.png"),
    path.join(root, "T_ZG_Diaodeng_N.png"),
    path.join(root, "T_ZG_Diaodeng_ORM.png")
  ];
  const { drafts } = await buildDrafts(files);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].form.assetName, "ZG_Diaodeng");
  assert.match(drafts[0].form.tagsText, /(?:^|,\s*)Dressing(?:,|$)/);
});

test("entering a single-asset import does not queue duplicate detection", async () => {
  const root = path.join("D:/ZionFiles/3DAssets", "Props_ZG_Box");
  const files = [
    path.join(root, "SM_ZG_Box.fbx"),
    path.join(root, "T_ZG_Box_D.png"),
    path.join(root, "T_ZG_Box_N.png")
  ];
  const { drafts, state } = await buildDrafts(files);
  assert.equal(drafts.length, 1);
  assert.deepEqual(state.dedupeChecks, []);
});

test("adding a draft to a batch does not queue duplicate detection", async () => {
  const root = path.join("D:/ZionFiles/3DAssets", "Props_ZG_Box");
  const { drafts, state } = await buildDrafts([path.join(root, "SM_ZG_Box.fbx")], {
    existingDrafts: [{ form: { assetName: "Earlier" }, tagInput: "" }]
  });
  assert.equal(drafts.length, 2);
  assert.deepEqual(state.dedupeChecks, []);
});

test("Megascans 3D Plant import keeps Atlas and Billboard textures separate and skips Thumbs", async () => {
  const root = path.join("D:\\BridgeLibrary\\Downloaded\\3dplant", "3dplant_fern_roles");
  const atlas = path.join(root, "Textures", "Atlas", "Fern_4K_Albedo.jpg");
  const billboard = path.join(root, "Textures", "Billboard", "Fern_4K_Albedo.jpg");
  const thumb = path.join(root, "Thumbs", "2k", "Fern_4K_Albedo.jpg");
  const files = [atlas, billboard, thumb];
  const metadata = {
    name: "Fern",
    assetType: "3dplant",
    standardAssetTags: ["Megascans"],
    tags: ["megascans"],
    textureSlots: [
      { filePath: atlas, textureType: "Albedo", areaId: 1, materialRole: "atlas" },
      { filePath: billboard, textureType: "Albedo", areaId: 1, materialRole: "billboard" },
      { filePath: thumb, textureType: "Albedo", areaId: 1, materialRole: "atlas" }
    ]
  };

  const { drafts } = await buildDrafts(files, { metadata });
  assert.equal(drafts.length, 1);
  const entries = drafts[0].form.textureEntries.filter((entry) => entry.textureType === "Albedo");
  assert.equal(entries.length, 2);
  assert.deepEqual(new Set(entries.map((entry) => entry.materialRole)), new Set(["atlas", "billboard"]));
  assert.ok(entries.every((entry) => !/[/\\]thumbs?[/\\]/i.test(entry.filePath)));
});

test("Megascans asset names do not contaminate texture type hints", () => {
  const asset = {
    name: "Rusty Metal Pulley",
    components: [
      { name: "Normal", type: "normal", uris: [] },
      { name: "Roughness", type: "roughness", uri: "vcejdht_4K_Roughness.jpg" }
    ]
  };
  assert.deepEqual(collectMegascansTextureHints(asset), [], "the asset root name is not a texture hint");

  const normalHints = collectMegascansTextureHints(asset.components[0]);
  assert.deepEqual(normalHints, ["normal", "Normal"]);
  assert.equal(normalHints.map((hint) => normalizeMegascansTextureType(hint, "3d", { opacityAsMasked: true })).find(Boolean), "Normal");
  const roughnessHints = collectMegascansTextureHints(asset.components[1]);
  assert.equal(roughnessHints.map((hint) => normalizeMegascansTextureType(hint, "3d", { opacityAsMasked: true })).find(Boolean), "Roughness");
});

test("Megascans texture aliases map to Translucency or the unified Opacity", () => {
  assert.equal(normalizeMegascansTextureType("translucency", "3dplant"), "Translucency");
  assert.equal(normalizeMegascansTextureType("Translucency", "3D plant"), "Translucency");
  assert.equal(normalizeMegascansTextureType("translucency", "3d"), "Translucency");
  assert.equal(normalizeMegascansTextureType("opacity", "3dplant"), "Opacity");
  assert.equal(normalizeMegascansTextureType("opacity", "3dplant", { opacityAsMasked: true }), "Opacity");
  assert.equal(normalizeMegascansTextureType("alpha", "surface", { opacityAsMasked: true }), "Opacity");
  assert.equal(normalizeMegascansTextureType("transparency", "3d", { opacityAsMasked: true }), "Opacity");
});
