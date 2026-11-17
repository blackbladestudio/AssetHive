const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Buffer } = require("node:buffer");
const { recoverModelCutout } = require("../electron/services/previewCutout");

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

test("keeps the model result when the color silhouette reaches the canvas edge", () => {
  const width = 120, height = 120;
  const source = Buffer.alloc(width * height * 3, 16);
  const model = Buffer.alloc(width * height * 4);
  for (let y = 25; y < 105; y++) for (let x = 0; x < 95; x++) {
    const i = y * width + x;
    source.fill(170, i * 3, i * 3 + 3);
    if (x >= 25 && y < 58) model[i * 4 + 3] = 255;
  }
  assert.equal(recoverModelCutout(model, source, width, height), false);
  assert.equal(model[(95 * width + 60) * 4 + 3], 0);
});

test("saving an imported asset never removes the preview background on its own", () => {
  const main = fs.readFileSync(path.join(__dirname, "../electron/main.js"), "utf8");
  const start = main.indexOf("async function importCustomAsset(");
  const end = main.indexOf("async function updateCustomAsset(", start);
  assert.ok(start >= 0 && end > start, "import asset save path exists");
  const body = main.slice(start, end);
  assert.doesNotMatch(body, /autoPreviewCutout|smartCutout/);
  assert.doesNotMatch(body, /compressImportedPreviewImage/);
  assert.match(body, /compressPreviewImage\(/);
});
