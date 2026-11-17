const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { applyPreservedAnimationPreview, isFlatCustomAssetType, inferAnimationAffiliationFromPath, listAnimationArchiveExtras, pickPreservedAnimationPreview, resolveCustomAssetLayout } = require("../electron/services/customAssetLayout");

test("animation import stays flat in the archive folder", () => {
  const destinationRoot = "Z:\\Artist\\AssetLibrary\\Animation\\Hero\\Male_01\\WP00_Unarm\\Locomotion";
  const layout = resolveCustomAssetLayout({
    assetType: "animation",
    assetName: "AS_Unarm01_M01_RunB",
    destinationRoot,
    uniqueId: "iajv1jy"
  });
  assert.equal(isFlatCustomAssetType("animation"), true);
  assert.equal(layout.wrapFolder, false);
  assert.equal(layout.destinationDir, destinationRoot);
  assert.equal(layout.assetFolderName, "");
  assert.doesNotMatch(layout.destinationDir, /animation_as_unarm01_m01_runb_iajv1jy/i);
});

test("animation archive extras are sidecar json and Preview folders", () => {
  const destinationRoot = "Z:\\Artist\\AssetLibrary\\Animation\\Hero\\Male_01\\WP00_Unarm\\Locomotion";
  const extras = listAnimationArchiveExtras(destinationRoot, "AS_Unarm01_M01_WalkF");
  assert.ok(extras.some((item) => /Preview$/i.test(item)));
  assert.ok(extras.some((item) => item.endsWith("AS_Unarm01_M01_WalkF.asset_info.json")));
  assert.ok(extras.some((item) => item.endsWith("AS_Unarm01_M01_WalkF.asset_info")));
  assert.ok(!extras.some((item) => item.toLowerCase().endsWith(".fbx")));
});

test("animation affiliation is inferred from Hero/Monster/NPC folders", () => {
  assert.equal(
    inferAnimationAffiliationFromPath("Z:\\Artist\\AssetLibrary\\Animation\\Hero\\Male_01\\WP00_Unarm\\Locomotion\\AS_WalkF.fbx"),
    "主角"
  );
  assert.equal(
    inferAnimationAffiliationFromPath("Z:\\Artist\\AssetLibrary\\Animation\\Monster\\AS_Idle.fbx"),
    "怪物"
  );
  assert.equal(
    inferAnimationAffiliationFromPath("Z:\\Artist\\AssetLibrary\\Animation\\NPC\\AS_Talk.fbx"),
    "NPC"
  );
});

test("animation card previews stay local and are not share archive files", () => {
  const localPreview = "C:\\Users\\artist\\AppData\\Roaming\\AssetHive\\AnimationPreviews\\clip_preview.webm";
  const sharePreview = "Z:\\Artist\\AssetLibrary\\Animation\\Hero\\Male_01\\WP00_Unarm\\Locomotion\\Preview\\clip_preview.webm";
  const record = applyPreservedAnimationPreview(
    { preview: "", previewImage: "", detailImage: "", meta: {} },
    { previewImage: localPreview }
  );
  assert.equal(record.previewImage, localPreview);
  assert.equal(pickPreservedAnimationPreview({ previewImage: sharePreview }, {}), "");
  assert.equal(pickPreservedAnimationPreview({ previewImage: "Preview\\clip_preview.webm" }, {}), "");
});

test("environment assets still wrap in a unique folder", () => {
  const destinationRoot = "Z:\\Artist\\AssetLibrary\\Environment\\3D Assets";
  const layout = resolveCustomAssetLayout({
    assetType: "3d",
    assetName: "ZG_Ding",
    destinationRoot,
    uniqueId: "ab12cd3"
  });
  assert.equal(layout.wrapFolder, true);
  assert.equal(layout.assetFolderName, "3d_zg_ding_ab12cd3");
  assert.equal(layout.destinationDir, path.join(destinationRoot, "3d_zg_ding_ab12cd3"));
});
