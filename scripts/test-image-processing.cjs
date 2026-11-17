const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { Buffer } = require("node:buffer");
const { setInterval, clearInterval, setTimeout, clearTimeout } = require("node:timers");
const { performance } = require("node:perf_hooks");
const sharp = require("sharp");
const { runImageTask } = require("../electron/services/imageTasks");
const { imageDimensions } = require("../electron/services/imageDimensions");
const { getAssetDetails } = require("../electron/services/assetScanner");
const { decodeRadiancePreview } = require("../electron/services/hdrPreview");

async function loadApplicationServices(directory) {
  const vm = require("node:vm");
  const { createRequire } = require("node:module");
  const electronStub = {
    app: { setName() {}, setAppUserModelId() {}, getPath: () => directory, commandLine: { appendSwitch() {} },
      requestSingleInstanceLock: () => true, on() {}, whenReady: () => ({ then() {} }) },
    BrowserWindow: { getAllWindows: () => [] },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) }
  };
  const load = async (relativePath, append) => {
    const file = path.resolve(__dirname, "..", relativePath);
    const localRequire = createRequire(file);
    const context = vm.createContext({ process, console, __dirname: path.dirname(file), module: { exports: {} },
      setTimeout, clearTimeout, setInterval, clearInterval,
      require: (name) => name === "electron" ? electronStub
        : name === "./logManager" ? { writeLog() {}, setupLogger() {}, onLogLine() {} } : localRequire(name) });
    vm.runInContext(await fs.readFile(file, "utf8") + append, context, { filename: file });
    return context.module.exports;
  };
  // Skip app startup/watchers/UI. Exercise the real importer on a temporary
  // library, stubbing only unrelated indexing and color-tag services.
  const main = await load("electron/main.js", `
settings.customLibraryPath = ${JSON.stringify(path.join(directory, "Library"))};
markInternalLibraryMutation = () => {};
scheduleIndexSnapshotSave = () => {};
applyLibrarySqlCacheChanges = async () => {};
inferColorTagsSafely = async () => [];
module.exports = { importCustomAsset, updateCustomAsset, ensureCustomHdriPreview, resolvePreviewThumbnailPath, getIndex: () => index };
`);
  const exporter = await load("electron/services/unrealExporter.js", "\nmodule.exports = { buildExportAssets, exportToUnreal };\n");
  return { ...main, ...exporter };
}

function hdrFixture(width, height, pixel = [255, 0, 0, 128], orientation = "-Y") {
  const parts = [Buffer.from(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n${orientation} ${height} +X ${width}\n`)];
  for (let y = 0; y < height; y++) {
    const value = typeof pixel === "function" ? pixel(y) : pixel;
    if (width < 8) {
      for (let x = 0; x < width; x++) parts.push(Buffer.from(value));
      continue;
    }
    parts.push(Buffer.from([2, 2, width >> 8, width & 255]));
    for (let c = 0; c < 4; c++) {
      const runs = [];
      for (let x = 0; x < width;) {
        const count = Math.min(127, width - x);
        runs.push(128 + count, value[c]);
        x += count;
      }
      parts.push(Buffer.from(runs));
    }
  }
  return Buffer.concat(parts);
}

// Independently specified, uncompressed scanline EXR with top-down RGB floats.
function exrFixture(width, height, pixel, compression = 0) {
  const i32 = (value) => { const b = Buffer.alloc(4); b.writeInt32LE(value); return b; };
  const f32 = (value) => { const b = Buffer.alloc(4); b.writeFloatLE(value); return b; };
  const attr = (name, type, value) => Buffer.concat([Buffer.from(`${name}\0${type}\0`), i32(value.length), value]);
  const channels = Buffer.concat([...["B", "G", "R"].map((name) => Buffer.concat([
    Buffer.from(`${name}\0`), i32(2), Buffer.alloc(4), i32(1), i32(1)
  ])), Buffer.from([0])]);
  const box = Buffer.concat([i32(0), i32(0), i32(width - 1), i32(height - 1)]);
  const header = Buffer.concat([i32(20000630), i32(2), attr("channels", "chlist", channels),
    attr("compression", "compression", Buffer.from([compression])), attr("dataWindow", "box2i", box),
    attr("displayWindow", "box2i", box), attr("lineOrder", "lineOrder", Buffer.from([0])),
    attr("pixelAspectRatio", "float", f32(1)), attr("screenWindowCenter", "v2f", Buffer.alloc(8)),
    attr("screenWindowWidth", "float", f32(1)), Buffer.from([0])]);
  const blockLines = compression === 3 ? 16 : 1;
  const offsets = Buffer.alloc(Math.ceil(height / blockLines) * 8);
  const rows = [];
  let offset = header.length + offsets.length;
  for (let y = 0; y < height; y += blockLines) {
    const lines = Math.min(blockLines, height - y);
    let bytes = Buffer.alloc(lines * width * 12);
    for (let line = 0; line < lines; line++) for (let c = 0; c < 3; c++) for (let x = 0; x < width; x++) {
      bytes.writeFloatLE(pixel(x, y + line)[2 - c], (line * width * 3 + c * width + x) * 4);
    }
    if (compression) {
      const reordered = Buffer.alloc(bytes.length);
      let even = 0;
      let odd = Math.ceil(bytes.length / 2);
      for (let i = 0; i < bytes.length; i++) reordered[i % 2 ? odd++ : even++] = bytes[i];
      for (let i = reordered.length - 1; i > 0; i--) reordered[i] = (reordered[i] - reordered[i - 1] + 128) & 255;
      const compressed = require("node:zlib").deflateSync(reordered);
      if (compressed.length < bytes.length) bytes = compressed;
    }
    const row = Buffer.concat([i32(y), i32(bytes.length), bytes]);
    offsets.writeBigUInt64LE(BigInt(offset), (y / blockLines) * 8);
    rows.push(row);
    offset += row.length;
  }
  return Buffer.concat([header, offsets, ...rows]);
}

// Megascans 置换 EXR 的真实布局：单通道、通道名是 R 而不是 Y（three 只认 Y 或 RGB）。
function exrSingleChannelFixture(width, height, pixel) {
  const i32 = (value) => { const b = Buffer.alloc(4); b.writeInt32LE(value); return b; };
  const f32 = (value) => { const b = Buffer.alloc(4); b.writeFloatLE(value); return b; };
  const attr = (name, type, value) => Buffer.concat([Buffer.from(`${name}\0${type}\0`), i32(value.length), value]);
  const channels = Buffer.concat([Buffer.from("R\0"), i32(2), Buffer.alloc(4), i32(1), i32(1), Buffer.from([0])]);
  const box = Buffer.concat([i32(0), i32(0), i32(width - 1), i32(height - 1)]);
  const header = Buffer.concat([i32(20000630), i32(2), attr("channels", "chlist", channels),
    attr("compression", "compression", Buffer.from([0])), attr("dataWindow", "box2i", box),
    attr("displayWindow", "box2i", box), attr("lineOrder", "lineOrder", Buffer.from([0])),
    attr("pixelAspectRatio", "float", f32(1)), attr("screenWindowCenter", "v2f", Buffer.alloc(8)),
    attr("screenWindowWidth", "float", f32(1)), Buffer.from([0])]);
  const offsets = Buffer.alloc(height * 8);
  const rows = [];
  let offset = header.length + offsets.length;
  for (let y = 0; y < height; y++) {
    const bytes = Buffer.alloc(width * 4);
    for (let x = 0; x < width; x++) bytes.writeFloatLE(pixel(x, y), x * 4);
    const row = Buffer.concat([i32(y), i32(bytes.length), bytes]);
    offsets.writeBigUInt64LE(BigInt(offset), y * 8);
    rows.push(row);
    offset += row.length;
  }
  return Buffer.concat([header, offsets, ...rows]);
}

function readTga(buffer) {
  assert.equal(buffer[2], 2, "Surface textures must be uncompressed true-color TGA files");
  const width = buffer.readUInt16LE(12);
  const height = buffer.readUInt16LE(14);
  const bitsPerPixel = buffer[16];
  const channels = bitsPerPixel / 8;
  assert([3, 4].includes(channels));
  const offset = 18 + buffer[0];
  return { width, height, channels, data: buffer.subarray(offset) };
}

async function runChecks(directory) {
  const passed = [];
  const metadataPng = path.join(directory, "metadata-fast-path.png");
  await sharp({ create: { width: 32, height: 16, channels: 3, background: "#8899aa" } }).png().toFile(metadataPng);
  assert.deepEqual(await imageDimensions(metadataPng, {
    runImageTask: () => { throw new Error("PNG should not spawn an image worker"); }
  }), { width: 32, height: 16 });
  const hdr = path.join(directory, "天空 #1 100%.hdr");
  await fs.writeFile(hdr, hdrFixture(16, 8, (y) => y < 4 ? [255, 0, 0, 128] : [0, 0, 255, 128]));
  assert.deepEqual(await imageDimensions(hdr), { width: 16, height: 8 });
  passed.push("Common image dimensions read without a worker; HDR keeps its worker reader");
  const previewPath = path.join(directory, "Preview", "hdr.png");
  const first = runImageTask("hdrPreview", [hdr, previewPath]);
  assert.equal(first, runImageTask("hdrPreview", [hdr, previewPath]), "duplicate requests must share a job");
  await first;
  let result = await sharp(previewPath).raw().toBuffer({ resolveWithObject: true });
  assert.equal(result.info.width, 16);
  assert.deepEqual([...result.data.subarray(0, 3)], [186, 0, 0]);
  assert.deepEqual([...result.data.subarray(-3)], [0, 0, 186]);
  const flat = decodeRadiancePreview(hdrFixture(2, 2, [0, 255, 0, 128]));
  assert.deepEqual([...flat.data.subarray(0, 3)], [0, 186, 0]);
  const reversed = decodeRadiancePreview(hdrFixture(8, 2, (y) => y === 0 ? [255, 0, 0, 128] : [0, 0, 255, 128], "+Y"));
  assert.deepEqual([...reversed.data.subarray(0, 3)], [0, 0, 186]);
  passed.push("HDR RLE/flat/orientation, zero channels, Unicode paths and deduplication");

  const largeHdr = path.join(directory, "large-8K.hdr");
  const cappedHdr = path.join(directory, "large-4K.hdr");
  await fs.writeFile(largeHdr, hdrFixture(8192, 2, [255, 128, 0, 128]));
  await runImageTask("resizeHdr", [largeHdr, cappedHdr, 4096]);
  const cappedHdrSize = await runImageTask("imageSize", [cappedHdr]);
  assert.equal(cappedHdrSize.width, 4096);
  assert.equal(cappedHdrSize.height, 1);
  assert.equal((await runImageTask("imageSize", [largeHdr])).width, 8192);
  passed.push("8K HDR is detectable and downscales to 4K without losing the Radiance container");

  const exr = path.join(directory, "float.exr");
  await fs.writeFile(exr, exrFixture(4, 2, (_x, y) => y === 0 ? [1, 0, 0] : [0, 0, 1]));
  await runImageTask("hdrPreview", [exr, path.join(directory, "exr.png")]);
  result = await sharp(path.join(directory, "exr.png")).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([...result.data.subarray(0, 3)], [186, 0, 0]);
  assert.deepEqual([...result.data.subarray(-3)], [0, 0, 186]);
  passed.push("EXR float preview has correct colors and top-down orientation");
  for (const compression of [2, 3]) {
    const compressed = path.join(directory, `zip-${compression}.exr`);
    await fs.writeFile(compressed, exrFixture(8, 19, (_x, y) => y < 10 ? [1, 0, 0] : [0, 0, 1], compression));
    const output = await runImageTask("hdrPreview", [compressed, `${compressed}.png`]);
    const pixels = await sharp(output).raw().toBuffer();
    assert.deepEqual([...pixels.subarray(0, 3)], [186, 0, 0]);
    assert.deepEqual([...pixels.subarray(-3)], [0, 0, 186]);
  }
  passed.push("ZIP and ZIPS compressed EXR previews");

  const largeExr = path.join(directory, "large-8K.exr");
  const cappedExr = path.join(directory, "large-4K.exr");
  await fs.writeFile(largeExr, exrFixture(8192, 2, () => [0.25, 0.5, 1]));
  await runImageTask("resizeExr", [largeExr, cappedExr, 4096]);
  const cappedExrSize = await runImageTask("imageSize", [cappedExr]);
  assert.equal(cappedExrSize.width, 4096);
  assert.equal(cappedExrSize.height, 1);
  await runImageTask("hdrPreview", [cappedExr, path.join(directory, "large-exr-preview.png")]);
  passed.push("8K EXR downscales to a decodable 4K EXR");

  const corrupt = path.join(directory, "broken.hdr");
  await fs.writeFile(corrupt, (await fs.readFile(hdr)).subarray(0, 90));
  await assert.rejects(runImageTask("hdrPreview", [corrupt, path.join(directory, "broken.png")]));
  assert.equal(await fs.stat(path.join(directory, "broken.png")).catch(() => null), null);
  await runImageTask("hdrPreview", [hdr, previewPath]);
  passed.push("Truncated HDR rejects without publishing a partial file; queue recovers");

  const solid = async (name, value, width = 32, height = 16) => {
    const file = path.join(directory, `${name}.png`);
    await sharp({ create: { width, height, channels: 3, background: { r: value, g: value, b: value } } }).png().toFile(file);
    return file;
  };
  const ao = await solid("ao", 31);
  const rough = await solid("rough", 93);
  const disp = await solid("disp", 157, 128, 64);
  const opacity = await solid("opacity", 211);
  const entries = [["ao", ao], ["roughness", rough], ["displacement", disp], ["opacity", opacity]];
  const packed = await runImageTask("packTextures", [entries, "test", entries, 16]);
  result = await sharp(packed).raw().toBuffer({ resolveWithObject: true });
  assert.equal(result.info.width, 16);
  assert.equal(result.info.height, 8);
  assert.equal(result.info.channels, 4);
  assert.deepEqual([...result.data.subarray(0, 4)], [31, 93, 157, 211]);
  const partialOrm = await runImageTask("packOrmTexture", [ao, "", "", "partial-orm", 1, 32]);
  result = await sharp(partialOrm).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([...result.data.subarray(0, 3)], [31, 128, 0], "missing ORM channels must use O=1/R=0.5/M=0 defaults");
  assert.equal(await runImageTask("packTextures", [entries, "test", entries, 16]), packed, "unchanged sources should reuse the packed output");
  const changedTime = new Date(Date.now() + 2000);
  await fs.utimes(rough, changedTime, changedTime);
  assert.notEqual(await runImageTask("packTextures", [entries, "test", entries, 16]), packed, "changed sources must invalidate the packed output");
  const onlyDisp = [["displacement", disp]];
  const onlyPacked = await runImageTask("packTextures", [onlyDisp, "disp", onlyDisp, 32]);
  result = await sharp(onlyPacked).raw().toBuffer({ resolveWithObject: true });
  assert.equal(result.info.width, 32, "displacement-only export must obey resolution");
  assert.deepEqual([...result.data.subarray(0, 4)], [255, 128, 157, 255]);
  const missing = [["ao", ao], ["roughness", path.join(directory, "missing.png")]];
  await assert.rejects(runImageTask("packTextures", [missing, "missing", missing, 32]));
  passed.push("Packed RGBA bytes, defaults, output limit and unreadable source errors");

  const displacementExr = path.join(directory, "displacement.exr");
  await fs.writeFile(displacementExr, exrFixture(4, 2, (x) => [x - 1, x - 1, x - 1]));
  const exrEntries = [["displacement", displacementExr]];
  const exrPacked = await runImageTask("packTextures", [exrEntries, "exr", exrEntries, 4]);
  result = await sharp(exrPacked).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([result.data[2], result.data[6], result.data[10], result.data[14]], [0, 85, 170, 255]);
  const convertedDisplacement = path.join(directory, "displacement-converted.png");
  await runImageTask("exrToPng", [displacementExr, convertedDisplacement, { normalize: true }]);
  result = await sharp(convertedDisplacement).raw().toBuffer({ resolveWithObject: true });
  assert.equal(result.info.width, 4);
  assert.equal(result.info.height, 2);
  assert.deepEqual([result.data[0], result.data[3], result.data[6], result.data[9]], [0, 85, 170, 255]);
  passed.push("EXR-only displacement packs actual normalized values without sharp EXR support");

  const singleChannelExr = path.join(directory, "single-channel-R.exr");
  await fs.writeFile(singleChannelExr, exrSingleChannelFixture(4, 2, (x) => x / 3));
  const singleChannelPng = path.join(directory, "single-channel-R.png");
  await runImageTask("exrToPng", [singleChannelExr, singleChannelPng, { normalize: true }]);
  result = await sharp(singleChannelPng).raw().toBuffer({ resolveWithObject: true });
  const gray = (index) => result.data[index * result.info.channels];
  assert.equal(result.info.width, 4);
  assert.equal(result.info.height, 2);
  assert.deepEqual([gray(0), gray(1), gray(2), gray(3)], [0, 85, 170, 255]);
  passed.push("Single-channel R displacement EXR (Megascans layout) converts to PNG");

  const albedo = await solid("albedo", 70, 128, 64);
  const merged = await runImageTask("mergeAlbedo", [albedo, opacity, "plant", 1, 32]);
  result = await sharp(merged).raw().toBuffer({ resolveWithObject: true });
  assert.equal(result.info.width, 32);
  assert.deepEqual([...result.data.subarray(0, 4)], [70, 70, 70, 211]);
  passed.push("Plant opacity merge resizes before composition and preserves RGB/alpha");
  const bmp = Buffer.alloc(70);
  bmp.write("BM"); bmp.writeUInt32LE(70, 2); bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(2, 18); bmp.writeInt32LE(2, 22);
  bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28);
  bmp.fill(73, 54);
  const bmpPath = path.join(directory, "mask.bmp");
  await fs.writeFile(bmpPath, bmp);
  const bmpPacked = await runImageTask("packTextures", [[["ao", bmpPath]], "bmp", [], 16]);
  assert.deepEqual([...(await sharp(bmpPacked).raw().toBuffer()).subarray(0, 4)], [73, 128, 128, 255]);
  passed.push("Standard BMP masks and source-version cache invalidation");

  const services = await loadApplicationServices(directory);
  const imported = await services.importCustomAsset({ assetName: "Sky", assetType: "hdri", textureSlots: { HDR: hdr }, previewImagePath: hdr }, null);
  assert.equal(imported.ok, true);
  assert.equal(imported.previewWarning, false);
  let asset = services.getIndex().find((item) => item.id === imported.assetId);
  assert.equal((await sharp(asset.previewImage).metadata()).width, 16);
  assert.equal((await fs.readFile(asset.textureFiles[0])).equals(await fs.readFile(hdr)), true);
  const beforeBrowse = await fs.readFile(imported.metaPath);
  await fs.rm(asset.previewImage);
  asset = await services.ensureCustomHdriPreview(asset);
  assert.equal((await fs.stat(asset.previewImage)).isFile(), true);
  assert.ok(!asset.previewImage.startsWith(asset.path), "browsing generates only a derived cache file");
  assert.deepEqual(await fs.readFile(imported.metaPath), beforeBrowse, "HDRI browsing must leave metadata bytes unchanged");
  assert.equal(path.basename(imported.metaPath), "asset_info.json");
  const savedMetaText = await fs.readFile(imported.metaPath, "utf8");
  const savedMeta = JSON.parse(savedMetaText);
  assert.equal(savedMeta.schemaVersion, "1.0");
  assert.equal(savedMeta.id, savedMeta.assetID);
  assert.equal(savedMeta.json.uri, "asset_info.json");
  assert.equal(savedMeta.json.contentLength, Buffer.byteLength(savedMetaText, "utf8"));
  assert(savedMeta.previewImage.includes("Preview"));
  const thumbnail = await services.resolvePreviewThumbnailPath(exr);
  assert.equal((await fs.stat(thumbnail)).isFile(), true);
  const failedPreviewImport = await services.importCustomAsset({ assetName: "Unsupported Sky", assetType: "hdri", textureSlots: { HDR: corrupt }, previewImagePath: corrupt }, null);
  assert.equal(failedPreviewImport.ok, true, "preview failure must not discard the source asset");
  assert.equal(failedPreviewImport.previewWarning, true);
  const failedAsset = services.getIndex().find((item) => item.id === failedPreviewImport.assetId);
  assert.equal((await fs.readFile(failedAsset.textureFiles[0])).equals(await fs.readFile(corrupt)), true);

  // Saving must not remove the preview background on its own: cutout is opt-in
  // through the import form's background-removal buttons.
  const opaqueDiffuse = path.join(directory, "opaque-diffuse.png");
  await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toFile(opaqueDiffuse);
  const opaquePreview = path.join(directory, "opaque-preview.jpg");
  const subject = await sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 200, g: 0, b: 0 } } }).png().toBuffer();
  await sharp({ create: { width: 96, height: 64, channels: 3, background: { r: 0, g: 192, b: 0 } } })
    .composite([{ input: subject, left: 32, top: 20 }]).jpeg({ quality: 95 }).toFile(opaquePreview);
  const keptPreviewImport = await services.importCustomAsset({
    assetName: "Preview Keep",
    assetType: "surface",
    textureSlots: { Diffuse: opaqueDiffuse },
    previewImagePath: opaquePreview
  }, null);
  assert.equal(keptPreviewImport.ok, true, keptPreviewImport.message);
  const keptPreviewAsset = services.getIndex().find((item) => item.id === keptPreviewImport.assetId);
  assert.equal(path.extname(keptPreviewAsset.previewImage).toLowerCase(), ".jpg", "opaque preview must stay opaque");
  assert.equal((await sharp(keptPreviewAsset.previewImage).metadata()).hasAlpha, false);
  const keptCorner = await sharp(keptPreviewAsset.previewImage).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
  assert.ok(keptCorner[1] > keptCorner[0] && keptCorner[1] > keptCorner[2], "preview background must be preserved");
  passed.push("Import save keeps an opaque preview image untouched (no background removal)");

  // No chosen preview must stay empty: a texture slot is not a thumbnail.
  const noPreviewImport = await services.importCustomAsset({
    assetName: "No Preview",
    assetType: "surface",
    textureSlots: { Diffuse: opaqueDiffuse }
  }, null);
  assert.equal(noPreviewImport.ok, true, noPreviewImport.message);
  const noPreviewAsset = services.getIndex().find((item) => item.id === noPreviewImport.assetId);
  assert.equal(String(noPreviewAsset.previewImage || ""), "", "texture slots must not become the card preview");
  const noPreviewMeta = JSON.parse(await fs.readFile(noPreviewImport.metaPath, "utf8"));
  assert.equal(String(noPreviewMeta.previewImage || ""), "");
  const noPreviewDir = path.join(path.dirname(noPreviewImport.metaPath), "Preview");
  assert.deepEqual(await fs.readdir(noPreviewDir).catch(() => []), []);
  passed.push("Import without a chosen preview does not fall back to a texture slot");

  // Even an explicit preview path must be rejected when that file is already a
  // recognized texture slot.
  const textureAsPreviewImport = await services.importCustomAsset({
    assetName: "Texture As Preview",
    assetType: "surface",
    textureSlots: { Diffuse: opaqueDiffuse },
    previewImagePath: opaqueDiffuse
  }, null);
  assert.equal(textureAsPreviewImport.ok, true, textureAsPreviewImport.message);
  const textureAsPreviewAsset = services.getIndex().find((item) => item.id === textureAsPreviewImport.assetId);
  assert.equal(String(textureAsPreviewAsset.previewImage || ""), "", "a texture slot must never be accepted as a preview");
  const textureAsPreviewDir = path.join(path.dirname(textureAsPreviewImport.metaPath), "Preview");
  assert.deepEqual(await fs.readdir(textureAsPreviewDir).catch(() => []), []);
  passed.push("A texture slot path is rejected even when passed as an explicit preview");

  // The scanner must also ignore old metadata that points previewImage at a
  // texture slot (for example an absolute Diffuse path).
  const scannedMetaPath = noPreviewImport.metaPath;
  const scannedMeta = JSON.parse(await fs.readFile(scannedMetaPath, "utf8"));
  const scannedTextureUri = scannedMeta.textureEntries?.[0]?.uri;
  assert.ok(scannedTextureUri, "test asset has a Diffuse texture entry");
  const scannedTexturePath = path.join(path.dirname(scannedMetaPath), scannedTextureUri);
  scannedMeta.previewImage = scannedTexturePath;
  scannedMeta.detailImage = scannedTexturePath;
  await fs.writeFile(scannedMetaPath, JSON.stringify(scannedMeta, null, 2));
  const scannedAsset = await getAssetDetails(path.dirname(scannedMetaPath));
  assert.equal(String(scannedAsset?.previewImage || ""), "", "scanner must not surface a texture slot as preview");
  passed.push("Library scan ignores metadata preview paths that point at texture slots");

  const largeTexture = path.join(directory, "large-albedo_8K.png");
  await sharp({ create: { width: 8192, height: 2, channels: 3, background: { r: 64, g: 128, b: 192 } } }).png().toFile(largeTexture);
  const largeTextureImport = await services.importCustomAsset({ assetName: "Large Surface", assetType: "surface", textureSlots: { Diffuse: largeTexture } }, null);
  assert.equal(largeTextureImport.ok, true, largeTextureImport.message);
  const largeTextureAsset = services.getIndex().find((item) => item.id === largeTextureImport.assetId);
  const cappedTextureSize = await runImageTask("imageSize", [largeTextureAsset.textureFiles[0]]);
  assert.equal(cappedTextureSize.width, 4096, "8K textures must be stored at 4K");
  assert.equal(cappedTextureSize.height, 1);
  const largeTextureMeta = JSON.parse(await fs.readFile(largeTextureImport.metaPath, "utf8"));
  const largeTextureEntry = largeTextureMeta.textureEntries[0];
  assert.equal(largeTextureEntry.width, 4096);
  assert.equal(largeTextureEntry.height, 1);
  assert.equal(largeTextureEntry.resolution, "4K");
  assert.equal(largeTextureEntry.sourceWidth, 8192);
  assert.equal(largeTextureEntry.sourceHeight, 2);
  assert.equal(largeTextureEntry.sourceResolution, "8K");
  assert.equal(largeTextureEntry.compressed, true);
  const scannedLargeTextureAsset = await getAssetDetails(path.dirname(largeTextureImport.metaPath));
  const scannedLargeTextureEntry = scannedLargeTextureAsset?.meta?.textureEntries?.[0];
  assert.equal(scannedLargeTextureEntry?.resolution, "4K");
  assert.equal(scannedLargeTextureEntry?.sourceResolution, "8K");
  assert.equal(scannedLargeTextureEntry?.compressed, true);
  const tooLargeTexture = path.join(directory, "too-large_16K.png");
  await sharp({ create: { width: 16384, height: 1, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toFile(tooLargeTexture);
  const tooLargeImport = await services.importCustomAsset({ assetName: "Too Large", assetType: "surface", textureSlots: { Diffuse: tooLargeTexture } }, null);
  assert.equal(tooLargeImport.ok, false, "16K source textures must be rejected");
  assert.match(String(tooLargeImport.message || ""), /8K/);
  const largeDisplacementExr = path.join(directory, "large-displacement_8K.exr");
  await fs.writeFile(largeDisplacementExr, exrFixture(8192, 2, () => [0.25, 0.5, 0.75]));
  const largeDisplacementImport = await services.importCustomAsset({ assetName: "Large Displacement", assetType: "surface", textureSlots: { Displacement: largeDisplacementExr } }, null);
  assert.equal(largeDisplacementImport.ok, true, largeDisplacementImport.message);
  const largeDisplacementAsset = services.getIndex().find((item) => item.id === largeDisplacementImport.assetId);
  const cappedDisplacementSize = await sharp(largeDisplacementAsset.textureFiles[0]).metadata();
  assert.equal(cappedDisplacementSize.width, 4096, "8K displacement EXR must be converted at 4K");
  const largeDisplacementMeta = JSON.parse(await fs.readFile(largeDisplacementImport.metaPath, "utf8"));
  const largeDisplacementEntry = largeDisplacementMeta.textureEntries[0];
  assert.equal(largeDisplacementEntry.width, 4096);
  assert.equal(largeDisplacementEntry.height, 1);
  assert.equal(largeDisplacementEntry.resolution, "4K");
  assert.equal(largeDisplacementEntry.sourceResolution, "8K");
  assert.equal(largeDisplacementEntry.compressed, true);

  const largeHdrImport = await services.importCustomAsset({ assetName: "Large Sky", assetType: "hdri", textureSlots: { HDR: largeHdr } }, null);
  assert.equal(largeHdrImport.ok, true, largeHdrImport.message);
  const largeHdrAsset = services.getIndex().find((item) => item.id === largeHdrImport.assetId);
  const cappedHdrImportSize = await runImageTask("imageSize", [largeHdrAsset.textureFiles[0]]);
  assert.equal(cappedHdrImportSize.width, 4096, "8K HDRI must be stored at 4K");
  const largeHdrMeta = JSON.parse(await fs.readFile(largeHdrImport.metaPath, "utf8"));
  const largeHdrEntry = largeHdrMeta.textureEntries[0];
  assert.equal(largeHdrEntry.width, 4096);
  assert.equal(largeHdrEntry.height, 1);
  assert.equal(largeHdrEntry.resolution, "4K");
  assert.equal(largeHdrEntry.sourceResolution, "8K");
  assert.equal(largeHdrEntry.compressed, true);

  const displacementImport = await services.importCustomAsset({ assetName: "EXR Displacement", assetType: "surface", textureSlots: { Displacement: displacementExr } }, null);
  assert.equal(displacementImport.ok, true, displacementImport.message);
  const displacementAsset = services.getIndex().find((item) => item.id === displacementImport.assetId);
  assert.equal(displacementAsset.textureFiles.length, 1);
  assert.match(displacementAsset.textureFiles[0], /\.png$/i, "EXR-only displacement must be converted to PNG before import");
  const displacementMeta = JSON.parse(await fs.readFile(displacementImport.metaPath, "utf8"));
  assert.equal(displacementMeta.textureEntries[0].textureType, "Displacement");
  assert.match(displacementMeta.textureEntries[0].uri, /\.png$/i, "metadata must reference the generated PNG");
  result = await sharp(displacementAsset.textureFiles[0]).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([result.data[0], result.data[3], result.data[6], result.data[9]], [0, 85, 170, 255]);
  const singleChannelDisplacement = path.join(directory, "single-channel_4K_Displacement.exr");
  await fs.writeFile(singleChannelDisplacement, exrSingleChannelFixture(4, 2, (x) => x / 3));
  const singleChannelImport = await services.importCustomAsset({ assetName: "Single Channel EXR Displacement", assetType: "surface", textureSlots: { Displacement: singleChannelDisplacement } }, null);
  assert.equal(singleChannelImport.ok, true, singleChannelImport.message);
  const singleChannelAsset = services.getIndex().find((item) => item.id === singleChannelImport.assetId);
  assert.match(singleChannelAsset.textureFiles[0], /\.png$/i, "Megascans 单通道置换 EXR 必须能转换为 PNG 入库");
  const preferredPng = path.join(directory, "paired-displacement.png");
  const ignoredExr = path.join(directory, "paired-displacement.exr");
  await sharp({ create: { width: 4, height: 2, channels: 3, background: "#8899aa" } }).png().toFile(preferredPng);
  await fs.writeFile(ignoredExr, "invalid EXR that must never be converted");
  const pairedEntries = [ignoredExr, preferredPng].map((filePath) => ({ textureType: "Displacement", areaId: 1, filePath }));
  const preferredImport = await services.importCustomAsset({
    assetName: "Preferred PNG", assetType: "surface",
    textureSlots: { Displacement: ignoredExr }, textureEntries: pairedEntries
  }, null);
  assert.equal(preferredImport.ok, true, preferredImport.message);
  const preferredAsset = services.getIndex().find((item) => item.id === preferredImport.assetId);
  assert.equal(preferredAsset.textureFiles.length, 1);
  assert.deepEqual(await fs.readFile(preferredAsset.textureFiles[0]), await fs.readFile(preferredPng));
  const preferredUpdate = await services.updateCustomAsset({ assetId: preferredImport.assetId, textureEntries: pairedEntries }, null);
  assert.equal(preferredUpdate.ok, true, preferredUpdate.message);
  assert.equal(preferredUpdate.asset.textureFiles.length, 1);
  assert.match(preferredUpdate.asset.textureFiles[0], /\.png$/i);
  passed.push("PNG wins over a same-slot EXR during import and edit; the EXR is never converted");
  const metalness = await solid("metalness", 157);
  const emissive = await solid("emissive", 211);
  const normal = await solid("normal", 128);
  const surface = { id: "surface-test", name: "Moss_Rock", assetType: "surface", source: "custom", path: directory,
    textureFiles: [albedo, rough, normal, metalness, emissive, ao, disp],
    meta: { baseTiling: 2.5, textureSlots: { Diffuse: albedo, Roughness: rough, Normal: normal, Metallic: metalness, Emissive: emissive, AO: ao, Displacement: disp } } };
  const progress = [];
  const exportedSurface = await services.buildExportAssets([surface], (event) => progress.push(event), "2k");
  assert.equal(exportedSurface.length, 1);
  const surfaceJob = exportedSurface[0];
  assert.equal(surfaceJob.exportRootPath, "/Game/Environment/Asset");
  assert.equal(surfaceJob.categoryFolder, "TilableTex");
  assert.equal(surfaceJob.assetFolderName, "Moss_Rock");
  assert.equal(surfaceJob.modelFiles.length, 0);
  assert.equal(surfaceJob.materialParams.baseTiling, 2.5);
  assert.equal(surfaceJob.textureSlots.map((slot) => slot.slot).join(","), "BCR,N,AO,M,Displacement");
  assert(surfaceJob.textureSlots.every((slot) => slot.file.toLowerCase().endsWith(".tga")), "all Surface textures must be TGA");
  assert(surfaceJob.textureSlots.every((slot) => slot.resolution === "2K"));
  assert.equal(surfaceJob.textureSlots.find((slot) => slot.slot === "BCR").objectName, "T_Env_Tile_Moss_Rock_surface_test_BCR");
  assert.equal(surfaceJob.textureSlots.find((slot) => slot.slot === "N").objectName, "T_Env_Tile_Moss_Rock_surface_test_N");
  // Height / Displacement（2026-10-27）：Surface 高度贴图固定 _Dis 后缀，独立成纹理、不进材质实例。
  assert.equal(surfaceJob.textureSlots.find((slot) => slot.slot === "Displacement").objectName, "T_Env_Tile_Moss_Rock_surface_test_Dis");
  assert.equal(surfaceJob.textureSlots.find((slot) => slot.slot === "Displacement").resolution, "2K");
  assert.equal(surfaceJob.textureSlots.find((slot) => slot.slot === "AO").objectName, "T_Env_Tile_Moss_Rock_surface_test_AO");
  assert(!surfaceJob.textureSlots.some((slot) => ["Mask"].includes(slot.slot)));
  // 2026-10-29：AO 独立成 2K 纹理（T_Env_Tile_*_AO），不再塞进 Mask 的 R 通道。
  const aoTga = readTga(await fs.readFile(surfaceJob.textureSlots.find((slot) => slot.slot === "AO").file));
  assert.equal(aoTga.width, 32);
  assert.equal(aoTga.height, 16);
  assert.deepEqual([...aoTga.data.subarray(0, 3)], [31, 31, 31], "AO slot must carry the AO source texture");
  const bcrTga = readTga(await fs.readFile(surfaceJob.textureSlots.find((slot) => slot.slot === "BCR").file));
  assert.equal(bcrTga.width, 128);
  assert.equal(bcrTga.height, 64);
  assert.equal(bcrTga.channels, 4);
  assert.deepEqual([...bcrTga.data.subarray(0, 4)], [70, 70, 70, 93]);
  assert(progress.some((event) => event.message.includes("合成 BCR 贴图")));
  // AO 兜底（2026-10-30）：既无独立 AO、也无 ORM 时，Surface 仍导出 AO，内容为纯白（AO=1.0）。
  const surfaceNoAo = { id: "surface-no-ao-test", name: "PlainStone", assetType: "surface", source: "custom", path: directory,
    textureFiles: [albedo, normal],
    meta: { baseTiling: 1, textureSlots: { Diffuse: albedo, Normal: normal } } };
  const surfaceNoAoJob = (await services.buildExportAssets([surfaceNoAo], null, "2k"))[0];
  assert.equal(surfaceNoAoJob.textureSlots.map((slot) => slot.slot).join(","), "BCR,N,AO");
  const noAoTga = readTga(await fs.readFile(surfaceNoAoJob.textureSlots.find((slot) => slot.slot === "AO").file));
  assert.equal(noAoTga.width, 8);
  assert.deepEqual([...noAoTga.data.subarray(0, 3)], [255, 255, 255]);
  const surface4k = (await services.buildExportAssets([surface], null, "4k"))[0];
  assert.equal(surface4k.textureSlots.find((slot) => slot.slot === "BCR").resolution, "4K");
  assert.equal(surface4k.textureSlots.find((slot) => slot.slot === "BCR").objectName, "T_Env_Tile_Moss_Rock_surface_test_BCR");
  assert.equal(surface4k.textureSlots.find((slot) => slot.slot === "N").resolution, "4K");
  assert(!surface4k.textureSlots.some((slot) => slot.slot === "E"), "Surface 不再固定导出 Emissive");
  assert.equal(surface4k.textureSlots.find((slot) => slot.slot === "M").resolution, "2K");
  assert.equal(surface4k.textureSlots.find((slot) => slot.slot === "AO").resolution, "2K");
  assert.equal(surface4k.textureSlots.find((slot) => slot.slot === "Displacement").resolution, "4K");
  assert.equal(surface4k.textureSlots.find((slot) => slot.slot === "Displacement").objectName, "T_Env_Tile_Moss_Rock_surface_test_Dis");

  // 2026-10-29：没有第三方标记（ThirdParty / Megascans / PBRMAX）的资产默认按 Zion 导出，
  // Surface / Decal 因此分 MI / Tex；显式带第三方来源标记的仍平铺。
  assert.equal(surfaceJob.materialFolders, true);
  const zionSurface = { ...surface, id: "surface-zion-test", zionTags: ["Zion"] };
  const zionSurfaceJob = (await services.buildExportAssets([zionSurface], null, "2k"))[0];
  assert.equal(zionSurfaceJob.materialFolders, true);
  const thirdPartySurface = { ...surface, id: "surface-thirdparty-test", standardAssetTags: ["Megascans"] };
  const thirdPartySurfaceJob = (await services.buildExportAssets([thirdPartySurface], null, "2k"))[0];
  assert.equal(thirdPartySurfaceJob.materialFolders, undefined);

  const decalDiffuse = await solid("decal-diffuse", 41);
  const decalNormal = await solid("decal-normal", 128);
  const decalOpacity = await solid("decal-opacity", 203);
  const decalOrm = await solid("decal-orm", 77);
  const decalDisplacement = await solid("decal-displacement", 42);
  const decal = {
    id: "decal-test",
    name: "LeakingRust",
    assetType: "decal",
    source: "custom",
    path: directory,
    textureFiles: [decalDiffuse, decalNormal, decalOpacity, decalOrm, decalDisplacement],
    meta: { textureSlots: { Diffuse: decalDiffuse, Normal: decalNormal, Opacity: decalOpacity, ORM: decalOrm, Displacement: decalDisplacement } }
  };
  const decalJob = (await services.buildExportAssets([decal], null, "4k"))[0];
  assert(decalJob, "Decal export job must be generated");
  assert.equal(decalJob.exportRootPath, "/Game/Environment/Asset");
  assert.equal(decalJob.categoryFolder, "Decal");
  assert.equal(decalJob.assetFolderName, "LeakingRust");
  assert.equal(decalJob.modelFiles.length, 0);
  assert.equal(decalJob.materialParams.useOpacityTexture, true);
  assert.equal(decalJob.materialParams.decalParentType, "decal");
  assert.equal(decalJob.textureSlots.map((slot) => slot.slot).join(","), "D,N,O,ORM");
  assert(decalJob.textureSlots.every((slot) => slot.file.toLowerCase().endsWith(".tga")), "all Decal textures must be TGA");
  assert.equal(decalJob.textureSlots.find((slot) => slot.slot === "D").resolution, "4K");
  assert.equal(decalJob.textureSlots.find((slot) => slot.slot === "N").resolution, "4K");
  assert.equal(decalJob.textureSlots.find((slot) => slot.slot === "O").resolution, "2K");
  assert.equal(decalJob.textureSlots.find((slot) => slot.slot === "ORM").resolution, "2K");
  assert.equal(decalJob.textureSlots.find((slot) => slot.slot === "D").objectName, "T_Env_Decal_LeakingRust_decal_test_D");
  assert.equal(decalJob.textureSlots.find((slot) => slot.slot === "ORM").objectName, "T_Env_Decal_LeakingRust_decal_test_ORM");
  assert(!decalJob.textureSlots.some((slot) => ["Mask", "DRO", "Displacement"].includes(slot.slot)));
  assert.equal(decalJob.materialFolders, true);
  const thirdPartyDecal = { ...decal, id: "decal-thirdparty-test", standardAssetTags: ["Megascans"] };
  const thirdPartyDecalJob = (await services.buildExportAssets([thirdPartyDecal], null, "4k"))[0];
  assert.equal(thirdPartyDecalJob.materialFolders, undefined);
  const zionDecal = { ...decal, id: "decal-zion-test", zionTags: ["Zion"] };
  const zionDecalJob = (await services.buildExportAssets([zionDecal], null, "4k"))[0];
  assert.equal(zionDecalJob.materialFolders, true);
  const decal2kJob = (await services.buildExportAssets([decal], null, "2k"))[0];
  const incompleteDecal = { ...decal, id: "decal-missing-orm", textureFiles: [decalDiffuse, decalNormal, decalOpacity],
    meta: { textureSlots: { Diffuse: decalDiffuse, Normal: decalNormal, OpacityMasked: decalOpacity } } };
  const incompleteProgress = [];
  const incompleteDecalJob = (await services.buildExportAssets([incompleteDecal], (event) => incompleteProgress.push(event), "4k"))[0];
  assert(incompleteDecalJob, "Decal export must continue when advisory slots are missing");
  assert.equal(incompleteDecalJob.textureSlots.map((slot) => slot.slot).join(","), "D,N,O");
  assert.equal(incompleteDecalJob.materialParams.useOpacityTexture, true);
  assert(incompleteProgress.some((event) => event.message.includes("建议") && event.message.includes("ORM")));
  const partialOrmDecal = {
    ...decal,
    id: "decal-partial-orm",
    textureFiles: [decalDiffuse, decalNormal, decalOpacity, ao],
    meta: { textureSlots: { Diffuse: decalDiffuse, Normal: decalNormal, OpacityMasked: decalOpacity, AO: ao } }
  };
  const partialOrmDecalJob = (await services.buildExportAssets([partialOrmDecal], null, "4k"))[0];
  assert(partialOrmDecalJob, "Decal export must pack partial ORM channels");
  const partialOrmSlot = partialOrmDecalJob.textureSlots.find((slot) => slot.slot === "ORM");
  assert(partialOrmSlot, "partial ORM channels must produce an ORM texture");
  const partialOrmTga = readTga(await fs.readFile(partialOrmSlot.file));
  assert.deepEqual([partialOrmTga.data[2], partialOrmTga.data[1], partialOrmTga.data[0]], [31, 128, 0], "Decal ORM defaults must be O=1/R=0.5/M=0");
  const emptyDecalResult = await services.exportToUnreal([{ ...decal, id: "decal-no-textures", textureFiles: [], meta: { textureSlots: {} } }], {});
  assert.equal(emptyDecalResult.ok, false);
  assert.match(emptyDecalResult.message, /Decal资产缺少可用纹理/);
  assert(decal2kJob.textureSlots.every((slot) => slot.resolution === "2K"), "2K Decal export must keep every slot at 2K");
  const pomDecalJob = (await services.buildExportAssets([decal], null, "4k", "pomDecal"))[0];
  const pomDisplacementSlot = pomDecalJob.textureSlots.find((slot) => slot.slot === "Displacement");
  assert(pomDisplacementSlot, "POM Decal export must include a Displacement slot");
  assert.equal(pomDisplacementSlot.resolution, "1K");
  assert(pomDisplacementSlot.file.toLowerCase().endsWith(".tga"));
  // 2026-10-27：POM 贴花的位移贴图后缀与 Surface 统一为 _Dis。
  assert.equal(pomDisplacementSlot.objectName, "T_Env_Decal_LeakingRust_decal_test_Dis");
  const triplanarPomDecalJob = (await services.buildExportAssets([decal], null, "4k", "pomDecalTri"))[0];
  assert.equal(triplanarPomDecalJob.materialParams.decalParentType, "pomDecalTri");
  const triplanarPomDisplacementSlot = triplanarPomDecalJob.textureSlots.find((slot) => slot.slot === "Displacement");
  assert(triplanarPomDisplacementSlot, "Triplanar POM Decal export must include a Displacement slot");
  assert.equal(triplanarPomDisplacementSlot.resolution, "1K");
  assert(triplanarPomDisplacementSlot.file.toLowerCase().endsWith(".tga"));
  assert.equal(triplanarPomDisplacementSlot.objectName, "T_Env_Decal_LeakingRust_decal_test_Dis");

  const orm = path.join(directory, "Moss_Rock_ORM.png");
  await sharp(Buffer.from([19, 93, 157]), { raw: { width: 1, height: 1, channels: 3 } }).png().toFile(orm);
  const ormSurface = { ...surface, id: "surface-orm-test", textureFiles: [albedo, normal, emissive, orm],
    meta: { baseTiling: 1.5, textureSlots: { Diffuse: albedo, Normal: normal, ORM: orm, Emissive: emissive } } };
  const ormSurfaceJob = (await services.buildExportAssets([ormSurface], null, "2k"))[0];
  assert.equal(ormSurfaceJob.textureSlots.map((slot) => slot.slot).join(","), "BCR,N,AO,M");
  const ormBcrTga = readTga(await fs.readFile(ormSurfaceJob.textureSlots.find((slot) => slot.slot === "BCR").file));
  assert.deepEqual([...ormBcrTga.data.subarray(0, 4)], [70, 70, 70, 93], "ORM G channel must feed BCR roughness alpha");
  const ormMetalTga = readTga(await fs.readFile(ormSurfaceJob.textureSlots.find((slot) => slot.slot === "M").file));
  assert.deepEqual([...ormMetalTga.data.subarray(0, 3)], [157, 157, 157], "ORM B channel must feed Metallic");
  // 2026-10-29：Metallic 只在源贴图存在且不是全 0 时导出 —— 全黑等于没有金属度信息。
  const blackMetalness = await solid("metalness-black", 0);
  const blackMetalnessSurface = {
    ...surface,
    id: "surface-black-metalness",
    textureFiles: [albedo, rough, normal, blackMetalness, ao, disp],
    meta: { baseTiling: 1, textureSlots: { Diffuse: albedo, Roughness: rough, Normal: normal, Metallic: blackMetalness, AO: ao, Displacement: disp } }
  };
  const blackMetalnessJob = (await services.buildExportAssets([blackMetalnessSurface], null, "2k"))[0];
  assert.equal(blackMetalnessJob.textureSlots.map((slot) => slot.slot).join(","), "BCR,N,AO,Displacement");
  passed.push("Real importer/preview repair/thumbnail and export job preparation on a temporary library");

  // Regressions: source semantics, packed-channel preservation and resolution.
  const gloss = await solid("sample_Gloss", 64, 128, 64);
  const glossRoughness = await runImageTask("glossToRoughness", [gloss, "gloss-test", 2048]);
  const glossEntries = [["ao", ao], ["roughness", glossRoughness]];
  const glossPacked = await runImageTask("packTextures", [glossEntries, "gloss-test", glossEntries, 2048]);
  result = await sharp(glossPacked).raw().toBuffer({ resolveWithObject: true });
  assert.equal(result.info.width, 128, "small AO must not downsize the other channels");
  assert.deepEqual([...result.data.subarray(0, 4)], [31, 191, 128, 255]);
  const priorityEntries = [["ao", ao], ["roughness", rough]];
  const priorityPacked = await runImageTask("packTextures", [priorityEntries, "rough-priority", priorityEntries, 2048]);
  assert.equal((await sharp(priorityPacked).raw().toBuffer())[1], 93);
  const maskSource = path.join(directory, "sample_Mask.png");
  await sharp({ create: { width: 128, height: 64, channels: 4,
    background: { r: 31, g: 93, b: 157, alpha: 211 / 255 } } }).png().toFile(maskSource);
  for (const slotName of ["Mask", "ORDp"]) {
    const mixedEntries = [["ao", ao], ["roughness", glossRoughness], [slotName.toLowerCase(), maskSource]];
    const mixedPacked = await runImageTask("packTextures", [mixedEntries, "mixed-" + slotName, mixedEntries, 2048]);
    assert.deepEqual([...(await sharp(mixedPacked).raw().toBuffer()).subarray(0, 4)], [31, 191, 157, 211], "packed mask must preserve non-overridden channels");
  }
  const environmentModel = path.join(directory, "Props_ZG_WoodenBox.fbx");
  await fs.writeFile(environmentModel, Buffer.from("test-fbx"));
  const environment3D = {
    id: "env-3d-test",
    name: "WoodenBox",
    assetType: "3d",
    source: "custom",
    path: directory,
    modelFiles: [environmentModel],
    textureFiles: [albedo, normal, rough, metalness, ao, emissive],
    standardAssetTags: ["Props"],
    tags: [],
    meta: {
      materialNames: { 1: "WoodenBox" },
      textureSlots: {
        Diffuse: albedo,
        Normal: normal,
        Roughness: rough,
        Metallic: metalness,
        AO: ao,
        Emissive: emissive
      }
    }
  };
  // Fuzz 永不导出（2026-10-29）：即使库里识别到 fuzz 贴图，导出 job 也不得出现 Fuzz 槽位。
  const fuzzSolid = await solid("fuzz", 233);
  const environment3DFuzz = {
    ...environment3D,
    id: "env-3d-fuzz-test",
    textureFiles: [...environment3D.textureFiles, fuzzSolid],
    meta: {
      ...environment3D.meta,
      textureSlots: { ...environment3D.meta.textureSlots, Fuzz: fuzzSolid }
    }
  };
  const fuzzJob = (await services.buildExportAssets([environment3DFuzz], null, "4k"))[0];
  assert(!fuzzJob.textureSlots.some((slot) => /fuzz/i.test(String(slot.slot))), "导出绝不能包含 Fuzz 槽位");
  assert(!fuzzJob.textureSlots.some((slot) => /_Fuzz/i.test(String(slot.objectName || ""))), "导出对象名不得出现 _Fuzz");
  const environment3DJob = (await services.buildExportAssets([environment3D], null, "4k"))[0];
  assert(environment3DJob, "3D asset export job must be generated");
  assert.equal(environment3DJob.standardAssetTags.join(","), "Props");
  assert.equal(
    environment3DJob.textureSlots.map((slot) => slot.slot).join(","),
    "Albedo,Normal,Emissive,ORM"
  );
  assert(environment3DJob.textureFiles.every((file) => file.toLowerCase().endsWith(".tga")), "3D textures must be TGA");
  assert(!environment3DJob.textureSlots.some((slot) => ["AO", "Roughness", "Metalness", "Mask"].includes(slot.slot)));
  assert.equal(environment3DJob.textureSlots.find((slot) => slot.slot === "Albedo").resolution, "4K");
  assert.equal(environment3DJob.textureSlots.find((slot) => slot.slot === "Normal").resolution, "4K");
  assert.equal(environment3DJob.textureSlots.find((slot) => slot.slot === "ORM").resolution, "2K");
  const packedOrmTga = readTga(await fs.readFile(environment3DJob.textureSlots.find((slot) => slot.slot === "ORM").file));
  assert.deepEqual([...packedOrmTga.data.subarray(0, 3)], [157, 93, 31], "ORM TGA must store AO/Roughness/Metallic in RGB");

  const explicitOrm = path.join(directory, "WoodenBox_ORM.png");
  await sharp(Buffer.from([19, 93, 157]), { raw: { width: 1, height: 1, channels: 3 } }).png().toFile(explicitOrm);
  const explicitOrmJob = (await services.buildExportAssets([{
    ...environment3D,
    id: "env-3d-explicit-orm",
    textureFiles: [albedo, normal, explicitOrm],
    meta: { ...environment3D.meta, textureSlots: { Diffuse: albedo, Normal: normal, ORM: explicitOrm } }
  }], null, "2k"))[0];
  const explicitOrmTga = readTga(await fs.readFile(explicitOrmJob.textureSlots.find((slot) => slot.slot === "ORM").file));
  assert.deepEqual([...explicitOrmTga.data.subarray(0, 3)], [157, 93, 19], "Existing ORM textures must be preserved");

  const explicitMask = path.join(directory, "WoodenBox_Mask.png");
  await sharp({ create: { width: 4, height: 2, channels: 4, background: { r: 31, g: 93, b: 157, alpha: 0.5 } } }).png().toFile(explicitMask);
  const megaJob = (await services.buildExportAssets([{
    ...environment3D,
    id: "env-3d-mega-mask",
    tags: ["MEGA"],
    textureFiles: [albedo, normal, explicitMask, ao, rough, metalness],
    meta: { textureSlots: { Diffuse: albedo, Normal: normal, Mask: explicitMask, AO: ao, Roughness: rough, Metallic: metalness } }
  }], null, "2k"))[0];
  const megaMaskTga = readTga(await fs.readFile(megaJob.textureSlots.find((slot) => slot.slot === "Mask").file));
  assert.equal(megaMaskTga.channels, 4, "Explicit MEGA mask alpha must be preserved");
  assert.equal(megaMaskTga.data[3], 128, "MEGA mask alpha must survive TGA conversion");
  assert(megaJob.textureSlots.some((slot) => slot.slot === "ORM"));
  assert(!megaJob.textureSlots.some((slot) => ["AO", "Roughness", "Metalness"].includes(slot.slot)));
  passed.push("3D Assets export converts final maps to TGA and packs AO/Roughness/Metallic into ORM");
  const glossExr = path.join(directory, "gloss.exr");
  await fs.writeFile(glossExr, exrFixture(4, 2, x => [x / 4, x / 4, x / 4]));
  const convertedGloss = await runImageTask("glossToRoughness", [glossExr, "gloss-exr", 4]);
  result = await sharp(convertedGloss).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([0, 1, 2, 3].map(x => result.data[x * result.info.channels]), [255, 191, 127, 64]);
  passed.push("Gloss inversion and Roughness priority; Mask naming, legacy alias, channel preservation and largest input resolution");

  const large = path.join(directory, "16k.hdr");
  await fs.writeFile(large, hdrFixture(16384, 8192));
  const largeMask = await solid("4k", 73, 4096, 4096);
  let ticks = 0;
  let maxGapMs = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - last);
    last = now;
    ticks++;
  }, 10);
  try {
    await Promise.all([
      runImageTask("hdrPreview", [large, path.join(directory, "16k-preview.png")]),
      runImageTask("packTextures", [[["ao", largeMask]], "large", [], 4096])
    ]);
  } finally { clearInterval(timer); }
  assert(ticks >= 10, `event loop heartbeat did not run: ${ticks}`);
  assert(maxGapMs < 1000, `main thread stalled for ${maxGapMs}ms`);
  const metadata = await sharp(path.join(directory, "16k-preview.png")).metadata();
  assert.equal(metadata.width, 1024);
  assert.equal(metadata.height, 512);
  passed.push(`16K HDR + 4K packing: ${ticks} main-thread heartbeats, largest gap ${maxGapMs.toFixed(1)} ms`);
  return { ok: true, passed, directory };
}

async function main() {
  if (process.argv.includes("--electron") && !process.versions.electron) {
    const { spawn } = require("node:child_process");
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [path.join(__dirname, "test-image-processing.cjs")], { env, windowsHide: true, stdio: "inherit" });
    const timer = setTimeout(() => child.kill(), 120000);
    try {
      process.exitCode = await new Promise((resolve, reject) => { child.on("exit", (code) => resolve(code ?? 1)); child.on("error", reject); });
    } finally { clearTimeout(timer); }
    return;
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-image-tests-"));
  let app;
  if (process.versions.electron) {
    ({ app } = require("electron"));
    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch("disable-gpu");
    app.setPath("userData", path.join(directory, "profile"));
    await app.whenReady();
  }
  try {
    console.log(JSON.stringify(await runChecks(directory), null, 2));
    if (app) app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(`Artifacts: ${directory}`);
    if (app) app.exit(1);
    process.exitCode = 1;
  }
}

void main();
