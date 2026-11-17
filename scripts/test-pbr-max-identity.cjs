const assert = require("node:assert/strict");
const test = require("node:test");
const { deriveSourceIdentity } = require("../electron/services/assetIdentity");
const { resolvePbrMaxSourceAssetId } = require("../electron/services/pbrMaxIdentity");

test("PBRMAX Decal resolves its native id from 8bit/T map names", () => {
  const sourceAssetId = resolvePbrMaxSourceAssetId({
    filePaths: [
      "D:/ZionFiles/Biaopai_3/8bit_T_05482_DC_Indicator_Albedo_8K.png",
      "D:/ZionFiles/Biaopai_3/8bit_T_05482_DC_Indicator_Opacity_8K.png",
      "D:/ZionFiles/Biaopai_3/T_05482_DC_Indicator_Displacement_8K.exr",
      "D:/ZionFiles/Biaopai_3/05482_DC_Indicator.jpg"
    ],
    folderNames: ["Biaopai_3"],
    standardAssetTags: ["PBRMAX"]
  });

  assert.equal(sourceAssetId, "05482");
});

test("PBRMAX resolves the id when the folder prefix is authoritative", () => {
  const sourceAssetId = resolvePbrMaxSourceAssetId({
    filePaths: ["D:/ZionFiles/PBRMAX_00369_DC_Moss/8bit_T_00369_DC_Moss_Normal_4K.png"],
    folderNames: ["PBRMAX_00369_DC_Moss"],
    standardAssetTags: ["PBRMAX"]
  });

  assert.equal(sourceAssetId, "00369");
});

test("PBRMAX model and LOD names resolve one stable id", () => {
  const sourceAssetId = resolvePbrMaxSourceAssetId({
    filePaths: [
      "D:/ZionFiles/Dimian_1/00369_MD_Stone.fbx",
      "D:/ZionFiles/Dimian_1/00369_MD_Stone_LOD0.fbx",
      "D:/ZionFiles/Dimian_1/00369_MD_Stone_LOD5.fbx",
      "D:/ZionFiles/Dimian_1/8bit_T_00369_MD_Stone_Albedo_8K.png"
    ],
    folderNames: ["Dimian_1"],
    standardAssetTags: ["PBRMAX"]
  });

  assert.equal(sourceAssetId, "00369");
});

test("PBRMAX without a source asset id does not fabricate one", () => {
  const sourceAssetId = resolvePbrMaxSourceAssetId({
    filePaths: [
      "D:/ZionFiles/Dimian_10/Ground.fbx",
      "D:/ZionFiles/Dimian_10/8bit_T_Ground_Albedo_8K.png"
    ],
    folderNames: ["Dimian_10"],
    standardAssetTags: ["PBRMAX"]
  });

  assert.equal(sourceAssetId, "");
});

test("non-PBRMAX sources do not use PBRMAX filename ids", () => {
  const sourceAssetId = resolvePbrMaxSourceAssetId({
    filePaths: ["D:/ZionFiles/Plants/8bit_T_6012_Plabts_Albedo_4K.png"],
    folderNames: ["Plants"],
    standardAssetTags: ["Megascans"]
  });

  assert.equal(sourceAssetId, "");
});

test("PBRMAX inferred id becomes the stable source key and display id", () => {
  const sourceAssetId = resolvePbrMaxSourceAssetId({
    filePaths: ["D:/ZionFiles/Biaopai_3/8bit_T_05482_DC_Indicator_Albedo_8K.png"],
    folderNames: ["Biaopai_3"],
    standardAssetTags: ["PBRMAX"]
  });
  const identity = deriveSourceIdentity({
    assetName: "Biaopai_3",
    assetType: "decal",
    standardAssetTags: ["PBRMAX"],
    sourceIdentity: { sourceAssetId }
  });

  assert.equal(identity.sourceKind, "pbrmax");
  assert.equal(identity.sourceAssetId, "05482");
  assert.equal(identity.sourceKey, "pbrmax:05482");
});
