"use strict";

// 孔洞填充单测（2026-10-15）：透贴里「被白色完全包围」的黑色区域必须被填成白色，
// 与外部连通的黑色（叶尖之间的开口、背景）必须原样保留。
//
// 为什么值得单测：填充判据是拓扑（从图像四边泛洪），不是形态学闭运算 —— 所以
//   * 与边界连通的缺口一律不能填（填了会把叶尖糊成一整片）；
//   * 孔洞大小不设核尺寸，只由面积上限控制；
//   * 阈值语义必须与下游 traceContours 一致（>= threshold 视为白色）。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { fillMaskHoles } = require("../electron/services/foliageOpaqueWorker");

function blankMask(width, height) {
  return new Float32Array(width * height);
}

function fillRect(values, width, height, x0, y0, x1, y1, value) {
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) values[y * width + x] = value;
  }
}

function pixel(values, width, x, y) {
  return values[y * width + x];
}

test("fills black holes enclosed by white and keeps border-connected gaps", () => {
  const width = 24, height = 24;
  const values = blankMask(width, height);
  // 白色方块内部留一个 4x4 的黑色孔洞
  fillRect(values, width, height, 4, 4, 19, 19, 1);
  fillRect(values, width, height, 10, 10, 13, 13, 0);
  // 与图像边界连通的黑色缺口（叶尖之间的开口），绝不能被填
  fillRect(values, width, height, 2, 10, 8, 11, 0);
  const stats = fillMaskHoles(values, width, height, 0.5, 0);
  assert.equal(stats.holes, 1);
  assert.equal(stats.holesFilled, 1);
  assert.equal(stats.texelsFilled, 16);
  assert.equal(pixel(values, width, 10, 10), 1, "孔洞应被填成白色");
  assert.equal(pixel(values, width, 13, 13), 1, "孔洞右下角也应被填");
  assert.equal(pixel(values, width, 5, 10), 0, "与边界连通的缺口必须保留");
  assert.equal(pixel(values, width, 0, 0), 0, "背景必须保留");
  // 幂等：再跑一次不应再有孔洞
  const again = fillMaskHoles(values, width, height, 0.5, 0);
  assert.equal(again.holes, 0);
  assert.equal(again.texelsFilled, 0);
});

test("area limit keeps intentionally hollow interiors", () => {
  const width = 32, height = 32;
  const values = blankMask(width, height);
  fillRect(values, width, height, 2, 2, 29, 29, 1);
  fillRect(values, width, height, 6, 6, 10, 10, 0);   // 5x5 = 25 texels
  fillRect(values, width, height, 20, 20, 25, 25, 0); // 6x6 = 36 texels
  const capped = fillMaskHoles(values, width, height, 0.5, 30);
  assert.equal(capped.holes, 2);
  assert.equal(capped.holesFilled, 1, "只有 25 纹素的孔洞在 30 的上限内");
  assert.equal(capped.holesSkipped, 1);
  assert.equal(pixel(values, width, 8, 8), 1);
  assert.equal(pixel(values, width, 22, 22), 0, "超过上限的孔洞必须保留");
  const unlimited = fillMaskHoles(values, width, height, 0.5, 0);
  assert.equal(unlimited.holesFilled, 1);
  assert.equal(pixel(values, width, 22, 22), 1, "上限 0 = 全部填充");
});

test("threshold semantics match the contour tracer", () => {
  const width = 12, height = 12;
  const values = blankMask(width, height);
  fillRect(values, width, height, 0, 0, 11, 11, 1);
  // 半透明边缘（0.4 < 0.5）且被白色包围 -> 按阈值算孔洞
  fillRect(values, width, height, 5, 5, 6, 6, 0.4);
  const stats = fillMaskHoles(values, width, height, 0.5, 0);
  assert.equal(stats.holes, 1);
  assert.equal(pixel(values, width, 5, 5), 1);
  // 阈值降到 0.3 时 0.4 已属于白色，不再是孔洞
  const values2 = blankMask(width, height);
  fillRect(values2, width, height, 0, 0, 11, 11, 1);
  fillRect(values2, width, height, 5, 5, 6, 6, 0.4);
  const lowered = fillMaskHoles(values2, width, height, 0.3, 0);
  assert.equal(lowered.holes, 0);
});

test("diagonal-only contact does not leak (4-connectivity)", () => {
  const width = 8, height = 8;
  const values = blankMask(width, height);
  fillRect(values, width, height, 1, 1, 6, 6, 1);
  // 孔洞只通过一个对角点与外部相连：4 连通泛洪判定为独立孔洞，仍应被填
  fillRect(values, width, height, 3, 3, 4, 4, 0);
  values[1 * width + 1] = 0;
  values[3 * width + 3] = 0;
  const stats = fillMaskHoles(values, width, height, 0.5, 0);
  assert.equal(stats.holes, 1);
  assert.equal(pixel(values, width, 3, 3), 1);
});
