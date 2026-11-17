const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const sharp = require("sharp");
const {
  analyzeAssetTextureUsage,
  FOUR_K_THRESHOLD_PIXELS,
  LARGE_OBJECT_LIMIT_METERS
} = require("../electron/services/textureAnalysis");
const { scanLibrary } = require("../electron/services/assetScanner");

// Windows 上扫描收尾会写入 <root>/.assethive/custom-index.json，紧接着删临时目录
// 偶尔会撞上删除挂起状态并抛 ENOTEMPTY，重试几次即可（不影响被测行为）。
function removeTempDir(root) {
  return fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }).catch(() => {});
}

async function makeTexture(filePath, width, height) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 92, g: 128, b: 230 }
    }
  }).png().toFile(filePath);
}

test("small assets using 4K textures are marked for review", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-texture-analysis-"));
  t.after(() => removeTempDir(root));
  const texture = path.join(root, "Diffuse_4K.png");
  const thumbnail = path.join(root, "Diffuse_4K_thumb.png");
  await makeTexture(texture, FOUR_K_THRESHOLD_PIXELS, 64);
  await makeTexture(thumbnail, 8192, 8192);

  const analysis = await analyzeAssetTextureUsage({
    dimensions: { x: 4.5, y: 3.2, z: 1.8 },
    dimensionsSource: "measured",
    textureFiles: [texture, thumbnail]
  });

  assert.equal(analysis.smallAsset, true);
  assert.equal(analysis.uses4KTexture, true);
  assert.equal(analysis.requiresReview, true);
  assert.equal(analysis.fourKTextureCount, 1);
  assert.equal(analysis.maxTextureDimension, FOUR_K_THRESHOLD_PIXELS);
  assert.equal(analysis.textureCount, 1, "preview thumbnails are not analysis textures");
  assert.equal(analysis.sizeThresholdMeters, LARGE_OBJECT_LIMIT_METERS);
});

test("assets at or above 5m are excluded before texture inspection", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-texture-analysis-"));
  t.after(() => removeTempDir(root));
  const texture = path.join(root, "Diffuse_4K.png");
  await makeTexture(texture, FOUR_K_THRESHOLD_PIXELS, 64);
  let inspected = 0;

  const analysis = await analyzeAssetTextureUsage({
    dimensions: { x: 5, y: 5, z: 5 },
    dimensionsSource: "measured",
    textureFiles: [texture]
  }, {
    inspectTexture: async () => {
      inspected += 1;
      return { width: FOUR_K_THRESHOLD_PIXELS, height: FOUR_K_THRESHOLD_PIXELS };
    }
  });

  assert.equal(analysis.smallAsset, false);
  assert.equal(analysis.requiresReview, false);
  assert.equal(inspected, 0);
});

test("legacy 1x1x1 placeholders stay unknown until dimensions are measured", async () => {
  const legacy = await analyzeAssetTextureUsage({
    dimensions: { x: 1, y: 1, z: 1 },
    textureFiles: ["D:/Library/Asset/Diffuse_4K.png"]
  });
  assert.equal(legacy.status, "unknown");
  assert.equal(legacy.requiresReview, false);

  const measured = await analyzeAssetTextureUsage({
    dimensions: { x: 1, y: 1, z: 1 },
    dimensionsSource: "measured",
    textureFiles: ["D:/Library/Asset/Diffuse_4K.png"]
  }, {
    inspectTexture: async () => ({ width: FOUR_K_THRESHOLD_PIXELS, height: 64 })
  });
  assert.equal(measured.smallAsset, true);
  assert.equal(measured.requiresReview, true);
});

test("unchanged texture fingerprints reuse the prior analysis", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-texture-analysis-"));
  t.after(() => removeTempDir(root));
  const texture = path.join(root, "Normal_4K.png");
  await makeTexture(texture, FOUR_K_THRESHOLD_PIXELS, 64);
  const input = {
    dimensions: { x: 2, y: 2, z: 2 },
    dimensionsSource: "measured",
    textureFiles: [texture]
  };
  const first = await analyzeAssetTextureUsage(input);
  const second = await analyzeAssetTextureUsage({ ...input, previousAnalysis: first }, {
    inspectTexture: async () => {
      throw new Error("cached analysis should not inspect images again");
    }
  });
  assert.deepEqual(second, first);
});

test("library scanning persists the 4K warning analysis into asset metadata", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-texture-scan-"));
  t.after(() => removeTempDir(root));
  const assetDir = path.join(root, "3d", "Small_4K_Asset");
  const texture = path.join(assetDir, "Diffuse_4K.png");
  await makeTexture(texture, FOUR_K_THRESHOLD_PIXELS, 64);
  const metaPath = path.join(assetDir, "asset_info.json");
  await fs.writeFile(metaPath, JSON.stringify({
    schemaVersion: "1.0",
    id: "small_4k_asset",
    assetID: "small_4k_asset",
    name: "Small 4K Asset",
    assetType: "3d",
    hasCollision: false,
    scanInformation: {
      dimensions: { x: 2, y: 2, z: 2 },
      dimensionsSource: "measured"
    },
    textureFiles: ["Diffuse_4K.png"]
  }, null, 2), "utf8");

  const records = await scanLibrary(root, { forceFullScan: true, maintenance: true });
  const record = records.find((item) => item.id === "small_4k_asset");
  assert.ok(record, "the asset should be scanned");
  assert.equal(record.hasCollision, false);
  assert.equal(record.meta.hasCollision, false);
  assert.equal(record.textureAnalysis?.requiresReview, true);
  assert.equal(record.textureAnalysis?.fourKTextureCount, 1);

  const savedMeta = JSON.parse(await fs.readFile(metaPath, "utf8"));
  assert.equal(savedMeta.textureAnalysis?.requiresReview, true);
});

test("3D Plants scanning participates in the 4K warning analysis", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-texture-plant-"));
  t.after(() => removeTempDir(root));
  const assetDir = path.join(root, "3dplant", "GrassPatch_4K");
  const texture = path.join(assetDir, "Grass_Diffuse_4K.png");
  await makeTexture(texture, FOUR_K_THRESHOLD_PIXELS, 64);
  const metaPath = path.join(assetDir, "asset_info.json");
  await fs.writeFile(metaPath, JSON.stringify({
    schemaVersion: "1.0",
    id: "grass_patch_4k",
    assetID: "grass_patch_4k",
    name: "Grass Patch 4K",
    assetType: "3dplant",
    scanInformation: {
      dimensions: { x: 0.6, y: 0.2, z: 0.6 },
      dimensionsSource: "measured"
    },
    textureFiles: ["Grass_Diffuse_4K.png"]
  }, null, 2), "utf8");

  const records = await scanLibrary(root, { forceFullScan: true, maintenance: true });
  const record = records.find((item) => item.id === "grass_patch_4k");
  assert.ok(record, "the 3D Plant asset should be scanned");
  assert.equal(record.textureAnalysis?.requiresReview, true);
  assert.equal(record.textureAnalysis?.fourKTextureCount, 1);
});
