const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildSyncedAssetMetadataFields,
  getSyncedTopCategory,
  isAnimationLibraryAsset,
  normalizeStandardAssetTagsForSync,
  hasCurrentMetadataUpdateMarker,
  buildMetadataUpdateMarker,
  METADATA_UPDATE_VERSION
} = require("../electron/services/libraryMetadataSync");

test("metadata update marker only accepts the current pipeline version", () => {
  assert.equal(hasCurrentMetadataUpdateMarker({}), false);
  assert.equal(hasCurrentMetadataUpdateMarker({ metadataUpdate: { version: METADATA_UPDATE_VERSION - 1 } }), false);
  const marker = buildMetadataUpdateMarker("2026-09-27T00:00:00.000Z");
  assert.equal(marker.version, METADATA_UPDATE_VERSION);
  assert.equal(marker.updatedAt, "2026-09-27T00:00:00.000Z");
  assert.equal(hasCurrentMetadataUpdateMarker({ metadataUpdate: marker }), true);
  const fallback = buildMetadataUpdateMarker("");
  assert.ok(Number.isFinite(Date.parse(fallback.updatedAt)));
});

test("metadata sync skips the animation top category and animation paths", () => {
  assert.equal(isAnimationLibraryAsset({ assetType: "animation", topCategory: "environment" }, {}), true);
  assert.equal(isAnimationLibraryAsset({ assetType: "3d", topCategory: "animation" }, {}), true);
  assert.equal(isAnimationLibraryAsset({ assetType: "3d", path: "Z:/Library/Animation/Hero/A.fbx" }, {}), true);
  assert.equal(isAnimationLibraryAsset({ assetType: "3d", topCategory: "environment", path: "Z:/Library/Environment/3D Assets/A" }, {}), false);
});

test("metadata sync maps environment asset types to the current top category", () => {
  assert.equal(getSyncedTopCategory("3d", "3D Assets"), "environment");
  assert.equal(getSyncedTopCategory("3dplant", ""), "environment");
  assert.equal(getSyncedTopCategory("surface", ""), "environment");
  assert.equal(getSyncedTopCategory("decal", ""), "environment");
  assert.equal(getSyncedTopCategory("hdri", ""), "environment");
});

test("metadata sync canonicalizes and filters standard asset tags by asset type", () => {
  assert.deepEqual(
    normalizeStandardAssetTagsForSync(["kit", "pbr max", "MEGA", "Tree"], "3d"),
    ["Kits", "ThirdParty"]
  );
  assert.deepEqual(
    normalizeStandardAssetTagsForSync(["Tree", "Hero_Foliage", "Dressing"], "3dplant"),
    ["Tree", "HeroFoliage"]
  );
  assert.deepEqual(normalizeStandardAssetTagsForSync(["PBRMAX", "Megascans"], "surface"), ["ThirdParty"]);
  assert.deepEqual(normalizeStandardAssetTagsForSync(["Tile", "Megascans"], "surface"), ["ThirdParty"]);
  assert.deepEqual(normalizeStandardAssetTagsForSync(["Tile"], "surface"), []);
  assert.deepEqual(normalizeStandardAssetTagsForSync(["PBRMAX"], "hdri"), []);
});

test("metadata sync rebuilds identity tags without retaining stale generated tags", () => {
  const fields = buildSyncedAssetMetadataFields({
    asset: {
      id: "props_zg_ding_abc1234",
      name: "ZG Ding",
      slug: "props_zg_ding_abc1234",
      path: "Z:/Library/Environment/3D Assets/props_zg_ding_abc1234",
      assetType: "3d",
      topCategory: "3D Assets",
      standardAssetTags: ["kit", "PBRMAX"]
    },
    meta: {
      assetID: "props_zg_ding_abc1234",
      name: "ZG Ding",
      assetType: "3d",
      topCategory: "3D Assets",
      category: "Props",
      standardAssetTags: ["kit", "PBRMAX"],
      zionTags: ["Zion"],
      tags: ["3d", "3D Assets", "props", "kit", "PBRMAX", "Zion", "custom"],
      semanticTags: { descriptive: ["metal"] }
    },
    assetType: "3d"
  });

  assert.equal(fields.topCategory, "environment");
  assert.deepEqual(fields.standardAssetTags, ["Kits", "ThirdParty"]);
  assert.ok(fields.tags.includes("PBRMAX"));
  assert.deepEqual(fields.zionTags, ["Zion"]);
  assert.deepEqual(fields.categories, ["environment", "3d", "props"]);
  assert.ok(fields.tags.includes("custom"));
  assert.ok(fields.tags.includes("Kits"));
  assert.ok(!fields.tags.includes("3D Assets"));
  assert.deepEqual(fields.semanticTags.contains, fields.tags);
  assert.deepEqual(fields.semanticTags.descriptive, ["metal"]);
});

test("metadata sync retains legacy sources that only exist in standardAssetTags", () => {
  for (const source of ["Megascans", "PBRMAX"]) {
    const fields = buildSyncedAssetMetadataFields({ meta: {
      id: "source-test", name: "Sample", assetType: "surface", standardAssetTags: [source], tags: []
    } });
    assert.deepEqual(fields.standardAssetTags, ["ThirdParty"]);
    assert.ok(fields.tags.includes(source));
  }
});
