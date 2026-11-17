const assert = require("node:assert/strict");
const { resolveMegascansName } = require("../electron/services/megascansName");
const test = require("node:test");
const { resolveMegascansSourceIdentity } = require("../electron/services/megascansIdentity");

test("Megascans Surface identity prefers the root native asset id", () => {
  const identity = resolveMegascansSourceIdentity({
    metadata: {
      pack: { _id: "city-street" },
      json: { uri: "sivodcfa.json" },
      version: 2,
      id: "sivodcfa",
      name: "Cracked Asphalt"
    },
    metadataFilePath: "D:/BridgeLibrary/Downloaded/surface/asphalt_cracked_sivodcfa/sivodcfa.json",
    assetName: "Cracked Asphalt",
    assetType: "surface",
    standardAssetTags: ["Megascans"],
    tags: ["megascans", "surface", "asphalt"]
  });

  assert.equal(identity.sourceKind, "megascans");
  assert.equal(identity.sourceAssetId, "sivodcfa");
  assert.equal(identity.sourceKey, "megascans:sivodcfa");
  assert.equal(identity.sourceVersion, "2");
});

test("Megascans Surface identity falls back to the Bridge metadata filename", () => {
  const identity = resolveMegascansSourceIdentity({
    metadata: {
      json: { uri: "ugjpajcew.json" },
      version: 2,
      name: "Birch Bark"
    },
    metadataFilePath: "D:/BridgeLibrary/Downloaded/surface/bark_birch_ugjpajcew/ugjpajcew.json",
    assetName: "Birch Bark",
    assetType: "surface",
    standardAssetTags: ["Megascans"]
  });

  assert.equal(identity.sourceKind, "megascans");
  assert.equal(identity.sourceAssetId, "ugjpajcew");
  assert.equal(identity.sourceKey, "megascans:ugjpajcew");
  assert.equal(identity.sourceVersion, "2");
});

test("Megascans identity does not treat generic library metadata as a source id", () => {
  const identity = resolveMegascansSourceIdentity({
    metadata: { json: { uri: "asset_info.json" }, name: "Cracked Asphalt" },
    metadataFilePath: "Z:/Artist/AssetLibrary/Environment/Surfaces/surface_cracked_asphalt_lu5amnk/asset_info.json",
    assetName: "Cracked Asphalt",
    assetType: "surface",
    standardAssetTags: ["Megascans"]
  });

  assert.equal(identity.sourceKind, "megascans");
  assert.equal(identity.sourceAssetId, undefined);
  assert.equal(identity.sourceKey, "megascans:name:cracked-asphalt");
});

test("Megascans structured names use the original title instead of object coercion", () => {
  assert.equal(resolveMegascansName({ name: { formats: { short: "Urb_Tra_Food", file: "Urban_Trash_Food", title: "Urban Trash Food IceCream Melted 02" } } }), "Urban Trash Food IceCream Melted 02");
  assert.equal(resolveMegascansName({ name: "Grey Sandstone", semanticTags: { name: "Another title" } }), "Grey Sandstone");
  assert.equal(resolveMegascansName({ name: "[object Object]", semanticTags: { name: "Urban Trash Styrofoam Dirty 02" } }), "Urban Trash Styrofoam Dirty 02");
  assert.equal(resolveMegascansName({ name: { formats: { file: "machine_name" } } }, "Fab Display Title"), "Fab Display Title");
  assert.equal(resolveMegascansName({ name: {}, title: {}, displayName: ["invalid"] }), "");
});
