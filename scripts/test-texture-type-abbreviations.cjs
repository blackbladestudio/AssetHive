const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  TEXTURE_TYPE_ABBREVIATIONS,
  TEXTURE_TYPES,
  detectTextureTypeFromFileName,
  normalizeTextureType,
  normalizePbrMaxDecalTextureType,
  normalizeOpacityTextureSlot
} = require("../electron/services/textureTypes");
const { normalizeMegascansTextureType } = require("../electron/services/megascansTextures");
const {
  detectTextureSlotByFileName,
  detectSurfaceTextureSlotByFileName,
  normalizeExportTextureSlot
} = require("../electron/services/unrealExporter");
const { buildScope } = require("./import-draft-harness.cjs");

test("material abbreviations resolve to their canonical texture types", () => {
  for (const [textureType, abbreviation] of Object.entries(TEXTURE_TYPE_ABBREVIATIONS)) {
    assert.equal(
      detectTextureTypeFromFileName(`T_Asset_${abbreviation}.png`),
      textureType,
      `${abbreviation} should resolve to ${textureType}`
    );
  }

  assert.equal(detectTextureTypeFromFileName("T_Asset_AL_4K_1001.png"), "Albedo");
  assert.equal(detectTextureTypeFromFileName("T_Asset_Dis_LOD0.tga"), "Displacement");
  assert.equal(detectTextureTypeFromFileName("T_Asset_ORT_8K.png"), "OpacityMaskRoughnessTranslucency");
  assert.equal(detectTextureTypeFromFileName("T_Asset_R_4K.png"), "Roughness");
});

test("compound texture names are resolved before short suffixes", () => {
  assert.equal(detectTextureTypeFromFileName("T_Asset_BaseColor_Roughness.png"), "BasecolorRoughness");
  assert.equal(detectTextureTypeFromFileName("T_Asset_Albedo_OpacityMasked.png"), "AlbedoOpacityMasked");
  assert.equal(detectTextureTypeFromFileName("T_Asset_Diffuse_OpacityMask.png"), "DiffuseOpacityMasked");
  assert.equal(detectTextureTypeFromFileName("T_Asset_OpacityMask_Roughness_Translucency.png"), "OpacityMaskRoughnessTranslucency");
  assert.equal(detectTextureTypeFromFileName("T_Asset_BaseColor.png"), "Basecolor");
  assert.equal(detectTextureTypeFromFileName("T_Asset_NormalMap.png"), "Normal");
  assert.equal(detectTextureTypeFromFileName("T_Asset_Normal_GL.png"), "Normal");
  assert.equal(detectTextureTypeFromFileName("T_Asset_N_DX.png"), "Normal");
});

test("short abbreviations only match the filename suffix, not asset-name words", () => {
  assert.equal(detectTextureTypeFromFileName("T_Asset_Tool.png"), "");
  assert.equal(detectTextureTypeFromFileName("T_Asset_Thumbnail.png"), "");
  assert.equal(detectTextureTypeFromFileName("T_Rusty_Metal_Pulley.png"), "");
  assert.equal(detectTextureTypeFromFileName("T_Asset_Alien.png"), "");
  assert.equal(normalizeTextureType("Rusty Metal Pulley"), "");
});

test("UI import detection and display labels use the same abbreviation table", () => {
  const scope = buildScope([]);
  assert.equal(scope.getTextureTypeDisplayLabel("Albedo"), "Albedo（AL）");
  assert.equal(scope.getTextureTypeDisplayLabel("Displacement"), "Displacement（Dis）");
  assert.equal(scope.getTextureTypeDisplayLabel("OpacityMaskRoughnessTranslucency"), "OpacityMask + Roughness + Translucency（ORT）");

  for (const [textureType, abbreviation] of Object.entries(TEXTURE_TYPE_ABBREVIATIONS)) {
    assert.equal(
      scope.detectTextureTypeFromFileName(`T_Asset_${abbreviation}.png`),
      textureType,
      `UI ${abbreviation} should resolve to ${textureType}`
    );
  }
});

test("SubsurfaceColor full suffix stays separate from the base color during drag import", async () => {
  const { buildDrafts } = require("./import-draft-harness.cjs");
  const scope = buildScope([]);
  for (const suffix of ["SubsurfaceColor", "SubSurfaceColor", "subsurfacecolor", "Subsurface_Color_4K", "SSC"]) {
    const file = `T_Grass_${suffix}.png`;
    assert.equal(detectTextureTypeFromFileName(file), "SubsurfaceColor", file);
    assert.equal(scope.detectTextureTypeFromFileName(file), "SubsurfaceColor", file);
    assert.equal(detectTextureSlotByFileName(file), "subsurfacecolor", file);
  }
  const files = ["Grass_GameWind.fbx", "T_Grass_Diffuse.png", "T_Grass_Normal.png", "T_Grass_ORM.png", "T_Grass_SubsurfaceColor.png"]
    .map((file) => `D:/Incoming/Grass_GameWind/${file}`);
  const { drafts } = await buildDrafts(files, { folderName: "Grass_GameWind" });
  assert.equal(drafts.length, 1);
  const textures = drafts[0].form.textureEntries.filter((entry) => entry.filePath);
  assert.equal(textures.find((entry) => /_Diffuse\.png$/i.test(entry.filePath))?.textureType, "Diffuse");
  assert.equal(textures.find((entry) => /_SubsurfaceColor\.png$/i.test(entry.filePath))?.textureType, "SubsurfaceColor");
});

test("export slot normalization accepts the same aliases", () => {
  assert.equal(detectTextureSlotByFileName("T_Asset_AL.png"), "albedo");
  assert.equal(detectTextureSlotByFileName("T_Asset_BC.png"), "albedo");
  assert.equal(detectTextureSlotByFileName("T_Asset_Dis.png"), "displacement");
  assert.equal(detectTextureSlotByFileName("T_Asset_H.png"), "displacement");
  assert.equal(detectTextureSlotByFileName("T_Asset_O.png"), "opacity");
  assert.equal(detectTextureSlotByFileName("T_Asset_T.png"), "subsurfacecolor");
  assert.equal(detectTextureSlotByFileName("T_Asset_ORM.png"), "orm");
  assert.equal(detectTextureSlotByFileName("T_Asset_ORMH.png"), "orm");
  assert.equal(detectSurfaceTextureSlotByFileName("T_Asset_ORM.png"), "orm");
  assert.equal(detectTextureSlotByFileName("T_Asset_R.png"), "roughness");
  assert.equal(normalizeExportTextureSlot("OpacityMaskRoughnessTranslucency"), "translucency");
  assert.equal(normalizeExportTextureSlot("Translucency"), "subsurfacecolor");
  assert.equal(normalizeExportTextureSlot("SubsurfaceColor"), "subsurfacecolor");
  assert.equal(normalizeExportTextureSlot("Subsurface"), "translucency");
  assert.equal(normalizeExportTextureSlot("AL"), "albedo");
  assert.equal(normalizeExportTextureSlot("Dis"), "displacement");
  assert.equal(normalizeExportTextureSlot("H"), "displacement");
  assert.equal(normalizeExportTextureSlot("R"), "roughness");
  assert.equal(normalizeExportTextureSlot("O"), "opacity");
  assert.equal(normalizeExportTextureSlot("ORM"), "orm");
  assert.equal(normalizeExportTextureSlot("ORMH"), "orm");
});

test("opacity aliases share one canonical type across import sources and export", () => {
  const pbrMaxDecal = { assetType: "decal", standardAssetTags: ["PBRMAX"] };
  const scope = buildScope([]);
  assert.equal(TEXTURE_TYPES.filter((type) => /^opacity(mask(ed)?)?$/i.test(type)).join(), "Opacity");
  assert.deepEqual(scope.textureTypeOptions, TEXTURE_TYPES);
  for (const value of ["Opacity", "Alpha", "Transparency", "OpacityMask", "OpacityMasked", "opacity_mask", "O"]) {
    assert.equal(normalizeTextureType(value), "Opacity");
    assert.equal(normalizePbrMaxDecalTextureType(value, pbrMaxDecal), "Opacity");
    assert.equal(normalizeMegascansTextureType(value, "3dplant", { opacityAsMasked: true }), "Opacity");
    assert.equal(detectTextureTypeFromFileName(`T_Asset_${value}_4K.png`), "Opacity");
    assert.equal(scope.detectTextureTypeFromFileName(`T_Asset_${value}_4K.png`), "Opacity");
    assert.equal(scope.getTextureTypeDisplayLabel(value), "Opacity（O）");
    assert.equal(normalizeExportTextureSlot(value), "opacity");
  }
  assert.equal(normalizeOpacityTextureSlot("002_OpacityMasked|billboard"), "002_Opacity|billboard");
  assert.equal(normalizeOpacityTextureSlot("AlbedoOpacityMasked"), "AlbedoOpacityMasked");
  assert.equal(normalizeOpacityTextureSlot("OpacityMaskRoughnessTranslucency"), "OpacityMaskRoughnessTranslucency");
  assert.equal(normalizePbrMaxDecalTextureType("Opacity", { assetType: "surface", standardAssetTags: ["PBRMAX"] }), "Opacity");
  assert.equal(normalizePbrMaxDecalTextureType("Opacity", { assetType: "decal", standardAssetTags: ["Megascans"] }), "Opacity");
});

test("legacy opacity rows keep their paths, UDIM areas and material roles when edited", () => {
  const scope = buildScope([]);
  assert.deepEqual(scope.parseTextureSlotToken("002_OpacityMask"), { areaId: 2, textureType: "Opacity" });
  const entries = [
    { id: "diffuse", textureType: "Diffuse", filePath: "D:/D.png", areaId: 2, materialRole: "billboard" },
    { id: "normal", textureType: "Normal", filePath: "D:/N.png", areaId: 2, materialRole: "billboard" },
    { id: "opacity", textureType: "OpacityMasked", filePath: "D:/O.png", areaId: 2, materialRole: "billboard" }
  ];
  const switched = scope.switchImportTextureEntriesForAssetType(entries, "decal");
  const opacity = switched.find((entry) => entry.textureType === "Opacity");
  assert.deepEqual(opacity, { ...entries[2], textureType: "Opacity" });
  assert.deepEqual(scope.normalizeTextureEntries(entries)[2], { textureType: "Opacity", filePath: "D:/O.png", areaId: 2, materialRole: "billboard" });
  assert.deepEqual(scope.getMissingRequiredTextureTypes("decal", entries), []);
  assert.equal(entries[2].textureType, "OpacityMasked");
});

test("Megascans aliases keep translucency (T) and opacity semantics", () => {
  assert.equal(normalizeMegascansTextureType("AL"), "Albedo");
  assert.equal(normalizeMegascansTextureType("Dis"), "Displacement");
  assert.equal(normalizeMegascansTextureType("O"), "Opacity");
  assert.equal(normalizeMegascansTextureType("T", "3dplant"), "Translucency");
  assert.equal(normalizeMegascansTextureType("T", "3d"), "Translucency");
  assert.equal(normalizeMegascansTextureType("opacity", "3d", { opacityAsMasked: true }), "Opacity");
});
