"use strict";

// FBX 几何层压缩（fbxCompactLayers）的回归测试。
//
// 背景：导出器把法线/UV/顶点色全部写成"逐角展开 + 恒等索引"（100k 面实测
// 299,934 角的值数组 + 299,934 的恒等索引，合计 7.35MB）。压缩模块把它们改成
// Megascans 源 FBX 的形态（UE 已验证可导入）：
//   法线   ByVertice/Direct（逐顶点，无索引数组）
//   UV/颜色 ByPolygonVertex/IndexToDirect（真去重值 + 真索引）
//
// 三条契约：
//   1. 解析 → 重序列化必须逐字节复现原文件（序列化器正确性的唯一判据）。
//   2. 压缩后几何逐角等价：逐顶点一致的层改写后，角上的值一个都不变。
//   3. 逐顶点不一致的层必须原样保留（改写会把不同角的值偷偷平均掉）。

const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const { Buffer } = require("node:buffer");
const { test } = require("node:test");
const {
  arrayValues, childNode, compactFbxGeometryLayers, parseFbxDocument, scalarValue, serializeFbxDocument
} = require("../electron/services/fbxCompactLayers");

// ---------------------------------------------------------------------------
// 测试夹具：手工构造一个最小二进制 FBX（4 顶点 / 2 三角形 / 三个几何层）。
// ---------------------------------------------------------------------------

function fbxHeader(version) {
  const head = Buffer.alloc(27);
  Buffer.from("Kaydara FBX Binary  ", "latin1").copy(head, 0);
  head[20] = 0x00; head[21] = 0x1a; head[22] = 0x00;
  head.writeUInt32LE(version, 23);
  return head;
}

function makeNode(name, props = [], children = []) {
  return { name, props, children, nullTerminated: true };
}

function scalar(code, value) {
  const head = Buffer.alloc(1);
  head[0] = code.charCodeAt(0);
  let body;
  if (code === "S" || code === "R") {
    const len = Buffer.alloc(4);
    len.writeUInt32LE(value.length);
    body = Buffer.concat([len, value]);
  } else if (code === "I") { body = Buffer.alloc(4); body.writeInt32LE(value); }
  else if (code === "L") { body = Buffer.alloc(8); body.writeBigInt64LE(BigInt(value)); }
  else { throw new Error(`测试不支持构造标量 ${code}`); }
  return { code, bytes: Buffer.concat([head, body]) };
}

function array(code, typedArray) {
  const payload = Buffer.from(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
  const compressed = zlib.deflateSync(payload);
  const head = Buffer.alloc(13);
  head[0] = code.charCodeAt(0);
  head.writeUInt32LE(typedArray.length, 1);
  head.writeUInt32LE(1, 5);
  head.writeUInt32LE(compressed.length, 9);
  return { code, bytes: Buffer.concat([head, compressed]) };
}

// 逐角层：ByPolygonVertex / IndexToDirect，值按角展开、索引恒等 —— 导出器同款。
function perLoopLayer(name, valuesName, indexName, perLoopValues, itemSize) {
  const loops = perLoopValues.length / itemSize;
  const identity = new Int32Array(loops);
  for (let i = 0; i < loops; i += 1) identity[i] = i;
  return makeNode(name, [scalar("I", 0), scalar("S", Buffer.from("")), scalar("S", Buffer.from("Mesh"))], [
    makeNode("Version", [scalar("I", 101)]),
    makeNode("Name", [scalar("S", Buffer.from(""))]),
    makeNode("MappingInformationType", [scalar("S", Buffer.from("ByPolygonVertex"))]),
    makeNode("ReferenceInformationType", [scalar("S", Buffer.from("IndexToDirect"))]),
    makeNode(valuesName, [array("d", new Float64Array(perLoopValues))]),
    makeNode(indexName, [array("i", identity)])
  ]);
}

// 4 顶点 / 2 三角形。PolygonVertexIndex 每面最后一个角用按位取反编码。
const VERTICES = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0];
const PVI = [0, 1, ~2, 0, 2, ~3];
const NORMALS_PER_LOOP = [
  0, 0, 1, 0, 0, 1, 0, 0, 1,
  0, 0, 1, 0, 0, 1, 0, 0, 1
];
// 角 2 与角 5 共用同一份 UV，其余各不相同：12 个角值应去重为 5 份。
const UV_PER_LOOP = [0, 0, 0.5, 0, 0.5, 0.5, 1, 0, 0, 0.5, 0.5, 0.5];
const COLOR_PER_LOOP = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];

function buildDocument({ normalPerLoop = NORMALS_PER_LOOP, version = 7400 } = {}) {
  const geometry = makeNode("Geometry",
    [scalar("L", 123456), scalar("S", Buffer.from("Geometry::opaque\x00\x01")), scalar("S", Buffer.from("Mesh"))],
    [
      makeNode("Vertices", [array("d", new Float64Array(VERTICES))]),
      makeNode("PolygonVertexIndex", [array("i", new Int32Array(PVI))]),
      perLoopLayer("LayerElementNormal", "Normals", "NormalsIndex", normalPerLoop, 3),
      perLoopLayer("LayerElementColor", "Colors", "ColorIndex", COLOR_PER_LOOP, 4),
      perLoopLayer("LayerElementUV", "UV", "UVIndex", UV_PER_LOOP, 2)
    ]);
  const objects = makeNode("Objects", [scalar("L", 1)], [geometry]);
  return {
    version, wide: version >= 7500, HS: version >= 7500 ? 8 : 4,
    NULL_SIZE: version >= 7500 ? 25 : 13,
    header: fbxHeader(version), nodes: [objects], footer: Buffer.alloc(version >= 7500 ? 25 : 13)
  };
}

function layerOf(document, name) {
  const objects = document.nodes.find((node) => node.name === "Objects");
  const geometry = objects.children.find((node) => node.name === "Geometry");
  return childNode(geometry, name);
}

test("parse → serialize reproduces the input byte for byte", () => {
  for (const version of [7400, 7500]) {
    const doc = buildDocument({ version });
    const bytes = serializeFbxDocument(doc);
    const reparsed = parseFbxDocument(bytes);
    const again = serializeFbxDocument(reparsed);
    assert.ok(again.equals(bytes), `version ${version}: 重序列化必须逐字节一致`);
  }
});

test("compaction collapses per-loop layers without changing any loop value", () => {
  const bytes = serializeFbxDocument(buildDocument());
  const result = compactFbxGeometryLayers(bytes);
  assert.ok(result.buffer.length < bytes.length, "压缩后必须变小");

  const doc = parseFbxDocument(result.buffer);
  const geometry = doc.nodes.find((node) => node.name === "Objects")
    .children.find((node) => node.name === "Geometry");
  const pvi = arrayValues(childNode(geometry, "PolygonVertexIndex").props[0], Int32Array);
  const vertexOf = (value) => (value < 0 ? ~value : value);

  // 法线 → ByVertice/Direct：逐顶点值，无索引数组。
  const normalLayer = childNode(geometry, "LayerElementNormal");
  assert.equal(scalarValue(normalLayer, "MappingInformationType"), "ByVertice");
  assert.equal(scalarValue(normalLayer, "ReferenceInformationType"), "Direct");
  assert.equal(childNode(normalLayer, "NormalsIndex"), null, "法线索引数组应整体删除");
  const normals = arrayValues(childNode(normalLayer, "Normals").props[0], Float64Array);
  assert.equal(normals.length, (VERTICES.length / 3) * 3, "法线应收敛为逐顶点");

  // UV → 真去重 + 真索引：角上的值必须与改写前逐分量相等。
  const uvLayer = childNode(geometry, "LayerElementUV");
  assert.equal(scalarValue(uvLayer, "MappingInformationType"), "ByPolygonVertex");
  assert.equal(scalarValue(uvLayer, "ReferenceInformationType"), "IndexToDirect");
  const uv = arrayValues(childNode(uvLayer, "UV").props[0], Float64Array);
  const uvIndex = arrayValues(childNode(uvLayer, "UVIndex").props[0], Int32Array);
  assert.equal(uv.length, 10, "角2与角5共用UV：12 个角值应去重为 5 份（×2 分量）");
  for (let loop = 0; loop < uvIndex.length; loop += 1) {
    for (let c = 0; c < 2; c += 1) {
      assert.equal(uv[uvIndex[loop] * 2 + c], UV_PER_LOOP[loop * 2 + c],
        `UV 角 ${loop} 分量 ${c} 改写后取值必须不变`);
    }
  }

  // 颜色层同样去重；改写后角值不变。
  const colorLayer = childNode(geometry, "LayerElementColor");
  const colors = arrayValues(childNode(colorLayer, "Colors").props[0], Float64Array);
  const colorIndex = arrayValues(childNode(colorLayer, "ColorIndex").props[0], Int32Array);
  assert.equal(colors.length, 4, "全部同色的 6 个角值应去重为 1 份（×4 分量）");
  for (let loop = 0; loop < colorIndex.length; loop += 1) {
    assert.equal(colorIndex[loop], 0, `颜色角 ${loop} 应指向唯一值`);
  }

  // 法线的逐顶点改写必须与"按顶点号取值"的读法等价。
  for (let loop = 0; loop < pvi.length; loop += 1) {
    const v = vertexOf(pvi[loop]);
    for (let c = 0; c < 3; c += 1) {
      assert.equal(normals[v * 3 + c], NORMALS_PER_LOOP[loop * 3 + c],
        `法线角 ${loop} 分量 ${c} 改写后取值必须不变`);
    }
  }
});

test("a layer whose loops disagree per vertex is left untouched", () => {
  // 顶点 0 被角 0 与角 3 引用：让两个角持有不同法线，改写会静默丢掉其中一份，
  // 必须整体放弃。角 3 的分量 0 = 下标 9。
  const inconsistent = [...NORMALS_PER_LOOP];
  inconsistent[9] = 0.5;
  const bytes = serializeFbxDocument(buildDocument({ normalPerLoop: inconsistent }));
  const result = compactFbxGeometryLayers(bytes);
  const doc = parseFbxDocument(result.buffer);
  const normalLayer = layerOf(doc, "LayerElementNormal");
  assert.equal(scalarValue(normalLayer, "MappingInformationType"), "ByPolygonVertex",
    "逐顶点不一致的法线层必须保持原映射");
  const normals = arrayValues(childNode(normalLayer, "Normals").props[0], Float64Array);
  assert.equal(normals.length, 6 * 3, "值数组必须保持逐角展开");
  const normalStats = result.stats.layers.find((layer) => layer.kind === "normal");
  assert.equal(normalStats.rewritten, false);
  // 其余层不受牵连。
  assert.equal(result.stats.layers.find((layer) => layer.kind === "uv").rewritten, true);
});

test("non-fbx input is rejected instead of silently passing through", () => {
  assert.throws(() => parseFbxDocument(Buffer.from("not an fbx at all..........")), /不是二进制 FBX/);
});
