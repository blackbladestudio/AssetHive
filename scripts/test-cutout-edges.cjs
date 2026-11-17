const test = require("node:test");
const assert = require("node:assert/strict");
const { Buffer } = require("node:buffer");
const { softenCutoutEdges } = require("../electron/services/previewCutout");

function fixture() {
  const width = 48, height = 48, rgba = Buffer.alloc(width * height * 4);
  const rect = (x, y, w, h, alpha = 255) => {
    for (let py = y; py < y + h; py++) for (let px = x; px < x + w; px++) {
      const i = (py * width + px) * 4;
      rgba[i] = 170; rgba[i + 1] = 95; rgba[i + 2] = 40; rgba[i + 3] = alpha;
    }
  };
  return { width, height, rgba, rect,
    alpha: (x, y) => rgba[(y * width + x) * 4 + 3],
    soften: () => softenCutoutEdges(rgba, width, height) };
}

test("cleans short edge spikes and detached specks while feathering the main silhouette", async () => {
  const f = fixture();
  f.rect(10, 10, 28, 28);
  f.rect(20, 8, 1, 2);
  f.rect(5, 5, 1, 1);
  const original = Buffer.from(f.rgba);
  await f.soften();
  assert.equal(f.alpha(20, 8), 0);
  assert.equal(f.alpha(5, 5), 0);
  assert.ok(f.alpha(24, 10) >= 90 && f.alpha(24, 10) < 191);
  assert.equal(f.alpha(24, 24), 255);
  for (let i = 0; i < f.width * f.height; i++) {
    assert.deepEqual(f.rgba.subarray(i * 4, i * 4 + 3), original.subarray(i * 4, i * 4 + 3));
    assert.ok(f.rgba[i * 4 + 3] <= original[i * 4 + 3]);
  }
});

test("preserves continuous one-pixel rods in horizontal, vertical and diagonal directions", async () => {
  for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
    const f = fixture();
    for (let t = -10; t <= 10; t++) f.rect(24 + dx * t, 24 + dy * t, 1, 1);
    await f.soften();
    assert.ok(f.alpha(24, 24) >= 216, `thin rod lost in direction ${dx},${dy}`);
    assert.equal(f.alpha(5, 5), 0);
  }
});

test("keeps internal openings empty and preserves uniform semitransparent interiors", async () => {
  const f = fixture();
  f.rect(6, 6, 36, 36, 128);
  f.rect(18, 18, 12, 12, 0);
  await f.soften();
  assert.equal(f.alpha(24, 24), 0);
  assert.equal(f.alpha(12, 24), 128);
  assert.equal(f.alpha(5, 24), 0);
});
