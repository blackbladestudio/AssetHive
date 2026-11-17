"use strict";

// 单层化（removeBackLayers）的回归测试。
//
// 背景：Megascans 植被是"有厚度的薄壳"，遮罩为实心处上下两层都会被保留。
// 实测某个真实资产（模型尺度 50.05）源网格里，正反重合面片对的重心距离
// p50 = 0.0015、max = 0.0045，即只占模型尺度的 0.003%~0.009%。
// 两层叠着渲染会互穿闪烁，引擎里表现为叶片上一块块交错花斑。

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { removeBackLayers } = require("../electron/services/foliageOpaqueLayers");

const face = (a, b, c) => ({ material: 0, corners: [a, b, c].map((position) => ({ position })) });

// 一片朝上的水平叶子 + 其下方紧邻的背面层（法线朝下）。XZ 平面铺开，与植被资产一致。
// 尺度 10，层间距 0.004（占尺度 0.04%，与实测资产同比例）。
function shell(zTop = 0, zBottom = -0.004) {
  return [
    face([0, zTop, 0], [10, zTop, 0], [10, zTop, 10]),   // 上表面，法线 +Y
    face([0, zTop, 0], [10, zTop, 10], [0, zTop, 10]),
    face([0, zBottom, 0], [10, zBottom, 10], [10, zBottom, 0]), // 下表面，法线 -Y
    face([0, zBottom, 0], [0, zBottom, 10], [10, zBottom, 10]),
  ];
}

test("opposite-facing shell layers collapse to a single layer", () => {
  const result = removeBackLayers(shell());
  assert.equal(result.stats.facesIn, 4);
  assert.equal(result.stats.facesOut, 2, "上下两层应只剩朝上的一层");
  assert.equal(result.stats.removedBackLayers, 2);
  for (const f of result.faces) {
    const [a, b, c] = f.corners.map((corner) => corner.position);
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const ny = ab[2] * ac[0] - ab[0] * ac[2];
    assert.ok(ny > 0, "保留面片的法线必须朝上");
  }
});

test("a single-layer surface is not modified", () => {
  const result = removeBackLayers(shell().slice(0, 2));
  assert.equal(result.stats.facesOut, 2);
  assert.equal(result.stats.removedBackLayers, 0);
});

test("a lone downward-facing leaf is kept", () => {
  // 只有朝下的一层：没有反向邻居，不该被当成背面层删掉
  const result = removeBackLayers(shell().slice(2));
  assert.equal(result.stats.removedBackLayers, 0, "整片朝下的叶子必须保留");
  assert.equal(result.stats.facesOut, 2);
});

test("an explicit threshold overrides the size-derived default", () => {
  // 阈值默认取 span/2500。这里显式传一个更大的阈值，验证参数确实生效：
  // 两层间距 0.5 在默认阈值下够不到，放大阈值后应能被识别。
  const faces = shell(0, -0.5);
  const byDefault = removeBackLayers(faces);
  assert.equal(byDefault.stats.removedBackLayers, 0, "默认阈值只覆盖真正的薄壳，够不到 0.5 的间距");

  const widened = removeBackLayers(faces, { layerDistance: 1 });
  assert.equal(widened.stats.layerDistance, 1);
  assert.equal(widened.stats.removedBackLayers, 2, "放大阈值后应识别出两层");
  assert.equal(widened.stats.facesOut, 2);
});

test("identical coincident faces with the same orientation are all kept", () => {
  // 同向重合面（不是薄壳上下两层）不该被删
  const faces = [
    face([0, 0, 0], [10, 0, 0], [10, 0, 10]),
    face([0, 0, 0], [10, 0, 0], [10, 0, 10]),
  ];
  const result = removeBackLayers(faces);
  assert.equal(result.stats.removedBackLayers, 0);
  assert.equal(result.stats.facesOut, 2);
});

test("degenerate faces are dropped instead of crashing", () => {
  const faces = [
    face([0, 0, 0], [10, 0, 0], [10, 0, 10]),
    face([1, 1, 1], [1, 1, 1], [2, 2, 2]), // 零面积
  ];
  const result = removeBackLayers(faces);
  assert.equal(result.stats.removedDegenerate, 1);
  assert.equal(result.stats.facesOut, 1);
});

test("empty input is handled", () => {
  const result = removeBackLayers([]);
  assert.equal(result.faces.length, 0);
  assert.equal(result.stats.facesOut, 0);
});
