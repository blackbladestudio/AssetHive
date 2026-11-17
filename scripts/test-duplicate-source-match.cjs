const assert = require("node:assert/strict");
const test = require("node:test");
const { deriveSourceIdentity } = require("../electron/services/assetIdentity");
const {
  evaluateSourceMatch,
  deriveStoredSourceIdentityFromMetadata
} = require("../electron/services/duplicateSourceMatch");

test("stored source identity is restored from disk metadata when the SQL snapshot omits it", () => {
  const diskMeta = {
    name: "Beech Fern",
    assetType: "3dplant",
    standardAssetTags: ["Megascans"],
    identity: {
      schemaVersion: 1,
      sourceKind: "megascans",
      sourceKey: "megascans:name:beech-fern",
      contentFingerprint: "sha256:abc"
    }
  };
  const restored = deriveStoredSourceIdentityFromMetadata(diskMeta);
  assert.equal(restored.sourceKind, "megascans");
  assert.equal(restored.sourceKey, "megascans:name:beech-fern");
});

test("stored source identity falls back to index fields when disk metadata is partial", () => {
  const restored = deriveStoredSourceIdentityFromMetadata({
    identity: { sourceKind: "megascans", sourceKey: "megascans:name:beech-fern" }
  }, {
    name: "Beech Fern",
    assetType: "3dplant",
    standardAssetTags: ["Megascans"]
  });
  assert.equal(restored.sourceKey, "megascans:name:beech-fern");
  assert.equal(restored.sourceKind, "megascans");
});

test("stored source identity requires a usable sourceKey", () => {
  assert.equal(deriveStoredSourceIdentityFromMetadata({ identity: { sourceKind: "megascans" } }), null);
  assert.equal(deriveStoredSourceIdentityFromMetadata({ name: "Beech Fern" }), null);
  assert.equal(deriveStoredSourceIdentityFromMetadata(null), null);
});

test("cached index without identity only matches by name and type until disk identity is restored", () => {
  const incomingSource = deriveSourceIdentity({
    assetName: "Beech Fern",
    assetType: "3dplant",
    standardAssetTags: ["Megascans"],
    sourceIdentity: { sourceAssetId: "vmkpdbeia" }
  });
  // SQL 快照缓存里的记录没有 identity：deriveSourceIdentity 只能回落到 zion:3dplant:...
  const cachedSource = deriveSourceIdentity({
    assetName: "Beech Fern",
    assetType: "3dplant",
    standardAssetTags: [],
    sourceIdentity: null
  });
  const cachedMatch = evaluateSourceMatch({
    incomingSource,
    incomingName: "beech-fern",
    incomingType: "3dplant",
    storedSource: cachedSource,
    targetName: "Beech Fern",
    targetType: "3dplant"
  });
  assert.equal(cachedMatch.nameMatches, true);
  assert.equal(cachedMatch.typeMatches, true);
  assert.equal(cachedMatch.isExactSource, false);

  // 回读磁盘 asset_info.json 之后应升级为同源匹配，而不是「仅同名」。
  const restoredSource = deriveStoredSourceIdentityFromMetadata({
    name: "Beech Fern",
    assetType: "3dplant",
    standardAssetTags: ["Megascans"],
    identity: { sourceKind: "megascans", sourceKey: "megascans:name:beech-fern" }
  });
  const restoredMatch = evaluateSourceMatch({
    incomingSource,
    incomingName: "beech-fern",
    incomingType: "3dplant",
    storedSource: restoredSource,
    targetName: "Beech Fern",
    targetType: "3dplant"
  });
  assert.equal(restoredMatch.isExactSource, true);
  assert.equal(restoredMatch.sameSourceFamilyAndName, true);
});

test("stable source keys match even when the display name changed", () => {
  const incomingSource = deriveSourceIdentity({
    assetName: "Beech Fern Renamed",
    assetType: "3dplant",
    standardAssetTags: ["Megascans"],
    sourceIdentity: { sourceKey: "megascans:vmkpdbeia", sourceKind: "megascans" }
  });
  const match = evaluateSourceMatch({
    incomingSource,
    incomingName: "beech-fern-renamed",
    incomingType: "3dplant",
    storedSource: { sourceKind: "megascans", sourceKey: "megascans:vmkpdbeia" },
    targetName: "Beech Fern",
    targetType: "3dplant"
  });
  assert.equal(match.sameSourceKey, true);
  assert.equal(match.isExactSource, true);
});

test("different source families with the same name are not treated as the same source", () => {
  const incomingSource = deriveSourceIdentity({
    assetName: "Beech Fern",
    assetType: "3dplant",
    standardAssetTags: ["Megascans"]
  });
  const match = evaluateSourceMatch({
    incomingSource,
    incomingName: "beech-fern",
    incomingType: "3dplant",
    storedSource: { sourceKind: "zion", sourceKey: "zion:3dplant:beech-fern" },
    targetName: "Beech Fern",
    targetType: "3dplant"
  });
  assert.equal(match.nameMatches, true);
  assert.equal(match.typeMatches, true);
  assert.equal(match.isExactSource, false);
});
