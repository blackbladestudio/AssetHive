const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { Buffer } = require("node:buffer");
const sharp = require("sharp");
const { runImageTask } = require("../electron/services/imageTasks");
const { recoverModelCutout, refineModelCutout, opaqueBounds } = require("../electron/services/previewCutout");

const root = path.resolve(__dirname, "..");

function refinementFixture() {
  const width = 120, height = 120;
  const source = Buffer.alloc(width * height * 3, 16);
  const rgba = Buffer.alloc(width * height * 4);
  const mask = Buffer.alloc(width * height);
  const rect = (x, y, w, h, color, confidence, alpha) => {
    for (let py = y; py < y + h; py++) for (let px = x; px < x + w; px++) {
      const i = py * width + px;
      source.fill(color, i * 3, i * 3 + 3);
      rgba.fill(color, i * 4, i * 4 + 3);
      rgba[i * 4 + 3] = alpha;
      mask[i] = confidence;
    }
  };
  rect(25, 25, 70, 80, 170, 255, 255);
  return { width, height, source, rgba, mask, rect,
    alpha: (x, y) => rgba[(y * width + x) * 4 + 3],
    refine: () => refineModelCutout(rgba, source, mask, width, height) };
}

test("full-resolution refinement restores a thin contrasting detail without changing RGB", () => {
  const f = refinementFixture();
  f.rect(20, 45, 5, 1, 170, 48, 0);
  const original = Buffer.from(f.rgba);
  assert.equal(f.refine(), true);
  assert.equal(f.alpha(21, 45), 255);
  assert.equal(f.alpha(10, 10), 0);
  for (let i = 0; i < f.width * f.height; i++) {
    assert.deepEqual(f.rgba.subarray(i * 4, i * 4 + 3), original.subarray(i * 4, i * 4 + 3));
  }
});

test("opens a single enclosed background-colored gap with model background evidence", () => {
  const f = refinementFixture();
  f.rect(45, 45, 10, 10, 16, 200, 255);
  f.rect(45, 45, 5, 10, 16, 24, 0);
  assert.equal(f.refine(), true);
  assert.equal(f.alpha(52, 50), 0);
  assert.equal(f.alpha(44, 50), 255);
  assert.equal(f.alpha(55, 50), 255);
});

test("removes repeated flat-background openings even when the model marks them as solid", () => {
  const f = refinementFixture();
  for (const x of [35, 55, 75]) f.rect(x, 45, 8, 12, 16, 255, 255);
  // A compressed/antialiased fringe around one gap must not stay opaque.
  f.rect(34, 45, 1, 12, 20, 255, 255);
  const original = Buffer.from(f.rgba);
  assert.equal(f.refine(), true);
  for (const x of [38, 58, 78]) assert.equal(f.alpha(x, 50), 0);
  assert.ok(f.alpha(34, 50) > 0 && f.alpha(34, 50) < 255);
  assert.equal(f.alpha(33, 50), 255);
  for (let i = 0; i < f.width * f.height; i++) {
    assert.deepEqual(f.rgba.subarray(i * 4, i * 4 + 3), original.subarray(i * 4, i * 4 + 3));
  }
});

test("keeps textured dark panels while clearing repeated matching gaps", () => {
  const f = refinementFixture();
  for (const x of [35, 55, 75]) f.rect(x, 45, 8, 12, 16, 255, 255);
  f.rect(35, 70, 48, 20, 28, 255, 255);
  for (let x = 35; x < 83; x += 3) f.rect(x, 70, 1, 20, 24, 255, 255);
  assert.equal(f.refine(), true);
  assert.equal(f.alpha(38, 50), 0);
  assert.equal(f.alpha(50, 80), 255);
  assert.equal(f.alpha(51, 80), 255);
});

test("repairs tiny model-created pits in dark texture without filling real small openings", () => {
  const f = refinementFixture();
  f.rect(40, 45, 2, 3, 30, 0, 0);
  f.rect(60, 45, 2, 3, 16, 0, 0);
  assert.equal(f.refine(), true);
  assert.equal(f.alpha(40, 46), 255);
  assert.equal(f.alpha(60, 46), 0);
});

test("does not override confident interior masks on a nonuniform background", () => {
  const f = refinementFixture();
  for (const x of [35, 55, 75]) f.rect(x, 45, 8, 12, 16, 255, 255);
  for (let y = 0; y < f.height; y++) for (let x = 0; x < f.width; x++) {
    if (x > 0 && x < f.width - 1 && y > 0 && y < f.height - 1) continue;
    f.source.fill(16 + x % 8, (y * f.width + x) * 3, (y * f.width + x) * 3 + 3);
  }
  assert.equal(f.refine(), true);
  assert.equal(f.alpha(38, 50), 255);
  assert.equal(f.alpha(58, 50), 255);
});

test("preserves a background-colored backed panel and a shaded recess", () => {
  const f = refinementFixture();
  f.rect(40, 40, 15, 20, 16, 200, 255);
  f.rect(65, 40, 10, 20, 30, 90, 255);
  assert.equal(f.refine(), true);
  assert.equal(f.alpha(45, 50), 255);
  assert.equal(f.alpha(70, 50), 255);
});

test("preserves model-certain dark foreground beside an open gap", () => {
  const f = refinementFixture();
  f.rect(40, 40, 20, 20, 16, 24, 0);
  f.rect(50, 40, 10, 20, 16, 255, 255);
  assert.equal(f.refine(), true);
  assert.equal(f.alpha(45, 50), 0);
  assert.equal(f.alpha(55, 50), 255);
});

test("leaves the mask unchanged when the border cannot establish a plain background", () => {
  const f = refinementFixture();
  for (let y = 0; y < f.height; y++) for (let x = 0; x < f.width; x++) {
    if (x > 0 && x < f.width - 1 && y > 0 && y < f.height - 1) continue;
    f.source.fill(x % 2 ? 16 : 200, (y * f.width + x) * 3, (y * f.width + x) * 3 + 3);
  }
  const original = Buffer.from(f.rgba);
  assert.equal(f.refine(), false);
  assert.deepEqual(f.rgba, original);
});

async function automaticCutoutHandler(isPackaged, runTask = runImageTask, outputPath = "result.png") {
  const main = await fs.readFile(path.join(root, "electron/main.js"), "utf8");
  const modelPathStart = main.indexOf("function getCutoutModelPath(");
  const handlerStart = main.indexOf('  ipcMain.handle("assets:autoPreviewCutout",');
  assert.ok(modelPathStart >= 0 && handlerStart >= 0);
  let handler;
  const context = vm.createContext({
    path, app: { isPackaged, getAppPath: () => isPackaged ? path.join(root, "app.asar") : root },
    ipcMain: { handle: (_channel, fn) => { handler = fn; } },
    getPreviewEditTempPath: () => outputPath, runImageTask: runTask
  });
  vm.runInContext(main.slice(modelPathStart, main.indexOf("\n}", modelPathStart) + 2), context);
  vm.runInContext(main.slice(handlerStart, main.indexOf("\n  });", handlerStart) + 6), context);
  return handler;
}

test("restores a large lower section missed by the model on a plain background", () => {
  const width = 120, height = 120;
  const source = Buffer.alloc(width * height * 3, 16);
  const model = Buffer.alloc(width * height * 4);
  for (let y = 25; y < 105; y++) for (let x = 25; x < 95; x++) {
    const i = y * width + x;
    source.fill(170, i * 3, i * 3 + 3);
    if (y < 58) model[i * 4 + 3] = 255;
  }
  assert.equal(recoverModelCutout(model, source, width, height), true);
  assert.equal(model[(95 * width + 60) * 4 + 3], 255);
  assert.equal(model[(10 * width + 10) * 4 + 3], 0);
});

test("restores a smaller lost base while preserving an enclosed opening", () => {
  const f = refinementFixture();
  f.rect(25, 95, 70, 10, 170, 0, 0);
  f.rect(45, 45, 10, 10, 16, 0, 0);
  f.rect(70, 70, 8, 8, 170, 0, 0);
  assert.equal(recoverModelCutout(f.rgba, f.source, f.width, f.height), true);
  assert.equal(f.alpha(60, 100), 255);
  assert.equal(f.alpha(74, 74), 255);
  assert.equal(f.alpha(50, 50), 0);
  assert.equal(f.alpha(10, 10), 0);
});

test("keeps the model result when the color silhouette reaches the canvas edge", () => {
  const width = 120, height = 120;
  const source = Buffer.alloc(width * height * 3, 16);
  const model = Buffer.alloc(width * height * 4);
  for (let y = 25; y < 105; y++) for (let x = 0; x < 95; x++) {
    const i = y * width + x;
    source.fill(170, i * 3, i * 3 + 3);
    if (x >= 25 && y < 58) model[i * 4 + 3] = 255;
  }
  const original = Buffer.from(model);
  assert.equal(recoverModelCutout(model, source, width, height), false);
  assert.deepEqual(model, original);
});

test("automatic cutout rejects missing sources and resolves the unpacked native model", async () => {
  const calls = [];
  const handler = await automaticCutoutHandler(true, (...args) => { calls.push(args); return { ok: true }; });
  assert.equal((await handler(null, { sourcePath: "  " })).ok, false);
  assert.equal(calls.length, 0);
  await handler(null, { sourcePath: " source.png ", tolerance: 64, filterNoise: false });
  assert.equal(calls[0][0], "smartCutout");
  assert.equal(calls[0][1][0], "source.png");
  assert.equal(calls[0][1][2].modelPath, path.join(root, "app.asar.unpacked/electron/models/silueta.onnx"));
  const packaging = await fs.readFile(path.join(root, "package_assethive_exe.bat"), "utf8");
  const unpack = packaging.match(/--asar\.unpackDir="([^"]+)"/)[1];
  assert.ok(unpack.includes("electron/models"));
  assert.ok(unpack.includes("node_modules/onnxruntime-node/bin/napi-v6/win32/x64"));
});

test("public automatic cutout runs Silueta, writes a padded PNG and preserves its source", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-smart-cutout-"));
  try {
    const sourcePath = path.join(directory, "source.png");
    const outputPath = path.join(directory, "cutout.png");
    const rgb = Buffer.alloc(120 * 120 * 3, 16);
    for (let y = 25; y < 105; y++) for (let x = 25; x < 95; x++) {
      rgb.fill(170, (y * 120 + x) * 3, (y * 120 + x) * 3 + 3);
    }
    await sharp(rgb, { raw: { width: 120, height: 120, channels: 3 } }).png().toFile(sourcePath);
    const original = await fs.readFile(sourcePath);
    const handler = await automaticCutoutHandler(false, runImageTask, outputPath);
    const result = await handler(null, { sourcePath });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.path, outputPath);
    assert.deepEqual(await fs.readFile(sourcePath), original);
    const { data, info } = await sharp(outputPath).raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.channels, 4);
    assert.ok(info.width < 120 && info.height < 120);
    const bounds = opaqueBounds(data, info.width, info.height);
    assert.equal(bounds.minX, 10);
    assert.equal(bounds.minY, 10);
    assert.equal(bounds.maxX, info.width - 11);
    assert.equal(bounds.maxY, info.height - 11);
    assert.equal(data[3], 0);
    const edgeAlpha = data[(bounds.minY * info.width + Math.floor(info.width / 2)) * 4 + 3];
    assert.ok(edgeAlpha >= 90 && edgeAlpha < 191, `expected a cleaned and softened edge, received ${edgeAlpha}`);
    assert.equal(data[(Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * 4 + 3], 255);
    await assert.rejects(runImageTask("smartCutout", [sourcePath, path.join(directory, "failed.png"), {
      modelPath: path.join(directory, "missing.onnx")
    }]));
    assert.deepEqual(await fs.readFile(sourcePath), original);
    await assert.rejects(fs.access(path.join(directory, "failed.png")));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("automatic cutout never resurrects transparent pixels or increases source alpha", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-cutout-alpha-"));
  try {
    const width = 120, height = 120;
    const sourcePath = path.join(directory, "source.png"), outputPath = path.join(directory, "cutout.png");
    const rgba = Buffer.alloc(width * height * 4);
    for (let y = 25; y < 105; y++) for (let x = 25; x < 95; x++) {
      const i = y * width + x;
      rgba.fill(170, i * 4, i * 4 + 3); rgba[i * 4 + 3] = 255;
    }
    for (let y = 50; y < 60; y++) for (let x = 50; x < 60; x++) rgba[(y * width + x) * 4 + 3] = 0;
    for (let y = 70; y < 80; y++) for (let x = 50; x < 60; x++) rgba[(y * width + x) * 4 + 3] = 96;
    await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toFile(sourcePath);
    const original = await fs.readFile(sourcePath);
    const result = await runImageTask("smartCutout", [sourcePath, outputPath]);
    assert.equal(result.ok, true, result.message);
    const { data, info } = await sharp(outputPath).raw().toBuffer({ resolveWithObject: true });
    const bounds = opaqueBounds(data, info.width, info.height);
    const offsetX = 25 - bounds.minX, offsetY = 25 - bounds.minY;
    for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * 4;
      const j = ((y + offsetY) * width + x + offsetX) * 4;
      assert.ok(data[i + 3] <= rgba[j + 3], `source transparency lost at ${x},${y}`);
      assert.deepEqual(data.subarray(i, i + 3), rgba.subarray(j, j + 3));
    }
    assert.equal(data[((75 - offsetY) * info.width + 55 - offsetX) * 4 + 3], 96);
    assert.deepEqual(await fs.readFile(sourcePath), original);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
