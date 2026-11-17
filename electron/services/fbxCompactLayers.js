"use strict";

// 把不透明裁切导出的 FBX 几何层压成"源资产同款"形态。
//
// @comfyorg/fbx-exporter-three 对每个几何层（法线 / UV / 顶点色）都写：
//   Mapping=ByPolygonVertex  Reference=IndexToDirect
//   值数组 = 逐角展开（每角一份 Float64）    索引数组 = 恒等 [0..n-1]
// 实测 100k 面的产物每层都是 299,934 角的值数组 + 299,934 的恒等索引，
// 合计 7.35MB。Megascans 源 FBX（UE 侧验证可导入）的写法是：
//   法线    ByVertice/Direct（逐顶点值，无索引数组）
//   UV/颜色 ByPolygonVertex/IndexToDirect（真去重值 + 真索引）
// 本模块把导出产物改写为这两种形态。数值一个字节都不改（只去重 / 重排），
// 改写前先校验"逐顶点一致性"（同一顶点的所有角必须持有同一份值），
// 校验不过或形态不符的层原样保留 —— 压缩失败绝不让导出失败。
//
// 数组元素类型沿用 'd'（Float64）与 'i'（Int32）：与源资产、导出器完全一致，
// 不引入任何未经现有资产验证过的元素类型。

const zlib = require("node:zlib");
const { Buffer } = require("node:buffer");

const ARRAY_ITEM_WIDTH = { f: 4, i: 4, d: 8, l: 8, b: 1 };

// ---------------------------------------------------------------------------
// 二进制 FBX 解析。只解析到"节点树 + 属性"这一层；未改动的属性保留原始字节
// （压缩态照抄），重序列化时逐字节复现 —— 因此"解析再序列化"必须与原文件
// 逐字节一致（test-fbx-compact-layers.cjs 以此作为序列化器的正确性判据）。
// ---------------------------------------------------------------------------

// 导出器 parseSync 返回的是 Uint8Array（不是 Node Buffer，没有
// toString(encoding, start, end) / readUInt32LE 系列方法），直接喂进来会在
// 魔数校验处抛错。入口统一归一化，调用方传什么都行。
function toNodeBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  throw new Error("FBX 输入不是二进制数据");
}

function parseFbxDocument(input) {
  const buffer = toNodeBuffer(input);
  const magic = buffer.toString("ascii", 0, 21);
  if (!magic.startsWith("Kaydara")) {
    throw new Error("不是二进制 FBX 文件");
  }
  const version = buffer.readUInt32LE(23);
  const wide = version >= 7500;
  const HS = wide ? 8 : 4;
  const NULL_SIZE = wide ? 25 : 13;

  function readProperty(off) {
    const code = String.fromCharCode(buffer[off]);
    const start = off;
    off += 1;
    switch (code) {
      case "Y": off += 2; break;
      case "C": off += 1; break;
      case "I": case "F": off += 4; break;
      case "D": case "L": off += 8; break;
      case "S": case "R": {
        const len = buffer.readUInt32LE(off);
        off += 4 + len;
        break;
      }
      case "f": case "d": case "l": case "i": case "b": {
        off += 4; // arrayLength
        off += 4; // encoding
        const compLen = buffer.readUInt32LE(off);
        off += 4 + compLen;
        break;
      }
      default:
        throw new Error(`未知 FBX 属性类型 ${code} @${start}`);
    }
    return { code, bytes: buffer.subarray(start, off) };
  }

  function readNode(off) {
    const endOffset = wide ? Number(buffer.readBigUInt64LE(off)) : buffer.readUInt32LE(off);
    const numProps = wide ? Number(buffer.readBigUInt64LE(off + HS)) : buffer.readUInt32LE(off + HS);
    off += HS * 3;
    const nameLen = buffer[off];
    off += 1;
    if (endOffset === 0) {
      // 空记录（全零 NULL record）：父节点到此收尾。
      return { node: null, next: off };
    }
    const name = buffer.toString("utf8", off, off + nameLen);
    off += nameLen;
    const props = [];
    for (let i = 0; i < numProps; i += 1) {
      const prop = readProperty(off);
      off += prop.bytes.length;
      props.push(prop);
    }
    const children = [];
    while (off < endOffset - NULL_SIZE) {
      const result = readNode(off);
      if (!result.node) { off = result.next; continue; }
      children.push(result.node);
      off = result.next;
    }
    // 记录原始空记录的有无：重序列化必须逐节点复现，错一个字节整棵树错位。
    if (endOffset !== off && endOffset - off !== NULL_SIZE) {
      throw new Error(`FBX 节点 ${name} 尾部有 ${endOffset - off} 字节无法识别`);
    }
    const nullTerminated = endOffset - off === NULL_SIZE;
    return { node: { name, props, children, nullTerminated }, next: endOffset };
  }

  const nodes = [];
  let pos = 27;
  while (pos + NULL_SIZE <= buffer.length) {
    // 顶层以一个全零空记录收尾；空记录之后是 FBX footer（版本相关的魔数与补零），
    // 两者都不属于节点树 —— 整段作为不透明尾部照抄，不解释也不改写。
    if (isTopLevelNullRecord(buffer, pos, HS, NULL_SIZE)) break;
    const result = readNode(pos);
    if (!result.node) break;
    nodes.push(result.node);
    pos = result.next;
  }
  const footer = buffer.subarray(pos);
  if (footer.length && footer.length < NULL_SIZE) {
    throw new Error(`FBX 顶层尾部残留 ${footer.length} 字节`);
  }
  return { version, wide, HS, NULL_SIZE, header: buffer.subarray(0, 27), nodes, footer };
}

// ---------------------------------------------------------------------------
// 重序列化。EndOffset 是绝对偏移：先占位头部、递归排布子树，回填时才知道
// 本节点的结束位置。
// ---------------------------------------------------------------------------

function makeScalarProperty(code, value) {
  const head = Buffer.alloc(1);
  head[0] = code.charCodeAt(0);
  let body;
  if (code === "S" || code === "R") {
    const len = Buffer.alloc(4);
    len.writeUInt32LE(value.length);
    body = Buffer.concat([len, value]);
  } else if (code === "Y") { body = Buffer.alloc(2); body.writeInt16LE(value); }
  else if (code === "C") { body = Buffer.alloc(1); body.writeUInt8(value); }
  else if (code === "I") { body = Buffer.alloc(4); body.writeInt32LE(value); }
  else if (code === "F") { body = Buffer.alloc(4); body.writeFloatLE(value); }
  else if (code === "D") { body = Buffer.alloc(8); body.writeDoubleLE(value); }
  else if (code === "L") { body = Buffer.alloc(8); body.writeBigInt64LE(BigInt(value)); }
  else { throw new Error(`不支持构造标量属性 ${code}`); }
  return { code, bytes: Buffer.concat([head, body]) };
}

function makeArrayProperty(code, typedArray) {
  const payload = Buffer.from(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
  const compressed = zlib.deflateSync(payload, { level: 9 });
  const head = Buffer.alloc(13);
  head[0] = code.charCodeAt(0);
  head.writeUInt32LE(typedArray.length, 1);
  head.writeUInt32LE(1, 5); // encoding 1 = deflate
  head.writeUInt32LE(compressed.length, 9);
  return { code, bytes: Buffer.concat([head, compressed]) };
}

function serializeNode(doc, node, startOffset, chunks) {
  const nameBytes = Buffer.from(node.name, "utf8");
  const propBytes = node.props.map((prop) => prop.bytes);
  const propListLength = propBytes.reduce((total, part) => total + part.length, 0);
  const headerSize = doc.HS * 3 + 1 + nameBytes.length;
  let cursor = startOffset + headerSize + propListLength;
  const headerSlot = chunks.length;
  const propsSlot = headerSlot + 1;
  chunks.push(null, null); // 头部与属性占位，子树排完后回填
  for (const child of node.children) {
    cursor = serializeNode(doc, child, cursor, chunks);
  }
  if (node.nullTerminated) {
    chunks.push(Buffer.alloc(doc.NULL_SIZE));
    cursor += doc.NULL_SIZE;
  }
  const header = Buffer.alloc(headerSize);
  if (doc.wide) {
    header.writeBigUInt64LE(BigInt(cursor), 0);
    header.writeBigUInt64LE(BigInt(node.props.length), doc.HS);
    header.writeBigUInt64LE(BigInt(propListLength), doc.HS * 2);
  } else {
    header.writeUInt32LE(cursor, 0);
    header.writeUInt32LE(node.props.length, doc.HS);
    header.writeUInt32LE(propListLength, doc.HS * 2);
  }
  header[doc.HS * 3] = nameBytes.length;
  nameBytes.copy(header, doc.HS * 3 + 1);
  chunks[headerSlot] = header;
  chunks[propsSlot] = propBytes;
  return cursor;
}

function isTopLevelNullRecord(buffer, pos, HS) {
  // 空记录：EndOffset / NumProperties / PropertyListLen / NameLen 全为 0。
  for (let i = 0; i < HS * 3 + 1; i += 1) {
    if (buffer[pos + i] !== 0) return false;
  }
  return true;
}

function serializeFbxDocument(doc) {
  const chunks = [];
  let cursor = doc.header.length;
  for (const node of doc.nodes) {
    cursor = serializeNode(doc, node, cursor, chunks);
  }
  // footer 原样照抄（含顶层空记录之后的全部字节），游标只用于最后一个节点的
  // EndOffset —— footer 不参与偏移计算。
  return Buffer.concat([doc.header, ...chunks.flat(Infinity), doc.footer]);
}

// ---------------------------------------------------------------------------
// 几何层读取与改写
// ---------------------------------------------------------------------------

function arrayValues(prop, Type) {
  if (!prop || prop.code.length !== 1) return null;
  const bytes = prop.bytes;
  const count = bytes.readUInt32LE(1);
  const encoding = bytes.readUInt32LE(5);
  const compLen = bytes.readUInt32LE(9);
  const payload = encoding === 1
    ? zlib.inflateSync(bytes.subarray(13, 13 + compLen))
    : bytes.subarray(13, 13 + compLen);
  const width = ARRAY_ITEM_WIDTH[prop.code];
  if (payload.length !== count * width) return null;
  return new Type(payload.buffer, payload.byteOffset, count);
}

function childNode(node, name) {
  return node.children.find((candidate) => candidate.name === name) || null;
}

function scalarValue(node, name) {
  const child = childNode(node, name);
  if (!child || !child.props.length) return null;
  const prop = child.props[0];
  if (prop.code !== "S") return null;
  const bytes = prop.bytes;
  const len = bytes.readUInt32LE(1);
  return bytes.toString("utf8", 5, 5 + len);
}

// 解析一个几何层，还原"逐角值"（Direct 与 IndexToDirect 两种引用方式都支持）。
function resolveLayer(layerNode, valuesName, indexName, itemSize) {
  const mapping = scalarValue(layerNode, "MappingInformationType");
  const reference = scalarValue(layerNode, "ReferenceInformationType");
  if (mapping !== "ByPolygonVertex") return null;
  const valuesNode = childNode(layerNode, valuesName);
  const values = valuesNode ? arrayValues(valuesNode.props[0], Float64Array) : null;
  if (!values) return null;
  let index = null;
  if (reference === "IndexToDirect") {
    const indexNode = childNode(layerNode, indexName);
    index = indexNode ? arrayValues(indexNode.props[0], Int32Array) : null;
    if (!index) return null;
  } else if (reference !== "Direct") {
    return null;
  }
  return { mapping, reference, values, index, valuesNode, itemSize };
}

// PolygonVertexIndex 用按位取反编码每个面的最后一个角：负值 = ~真实顶点号。
function vertexOf(pviValue) {
  return pviValue < 0 ? ~pviValue : pviValue;
}

function replaceOrInsertChild(node, name, prop) {
  const existing = childNode(node, name);
  if (existing) {
    existing.props = [prop];
    return;
  }
  node.children.push({ name, props: [prop], children: [], nullTerminated: true });
}

// 法线层 → ByVertice/Direct：值数组从"每角一份"收敛为"每顶点一份"，并删掉
// 索引数组。前提：同一顶点的所有角持有完全相同的值（导出侧按顶点属性展开，
// 天然成立；校验不过就整体放弃，保留原样）。
function compactNormalLayer(layerNode, pvi, vertCount, loopCount) {
  const layer = resolveLayer(layerNode, "Normals", "NormalsIndex", 3);
  if (!layer || layer.values.length !== loopCount * 3) return false;
  const perVertex = new Float64Array(vertCount * 3);
  const seen = new Uint8Array(vertCount);
  for (let loop = 0; loop < loopCount; loop += 1) {
    const v = vertexOf(pvi[loop]);
    if (v < 0 || v >= vertCount) return false;
    const src = loop * 3;
    const dst = v * 3;
    if (!seen[v]) {
      perVertex[dst] = layer.values[src];
      perVertex[dst + 1] = layer.values[src + 1];
      perVertex[dst + 2] = layer.values[src + 2];
      seen[v] = 1;
    } else if (perVertex[dst] !== layer.values[src]
        || perVertex[dst + 1] !== layer.values[src + 1]
        || perVertex[dst + 2] !== layer.values[src + 2]) {
      return false;
    }
  }
  layerNode.children = layerNode.children.filter((child) => child.name !== "NormalsIndex");
  replaceOrInsertChild(layerNode, "MappingInformationType", makeScalarProperty("S", Buffer.from("ByVertice", "utf8")));
  replaceOrInsertChild(layerNode, "ReferenceInformationType", makeScalarProperty("S", Buffer.from("Direct", "utf8")));
  layer.valuesNode.props = [makeArrayProperty("d", perVertex)];
  return true;
}

// UV / 颜色层 → 真去重 + 真索引：值数组收敛为"每唯一值一份"，索引数组从
// 恒等改为"角 → 唯一值"。与导出侧的 ByPolygonVertex/IndexToDirect 形态一致，
// 只是数组内容从展开态换回去重态。
function compactIndexedLayer(layerNode, valuesName, indexName, itemSize, loopCount) {
  const layer = resolveLayer(layerNode, valuesName, indexName, itemSize);
  if (!layer || layer.values.length !== loopCount * itemSize) return false;
  // 去重键用数值的字符串形式：相同位型必然同串；-0 与 0 视为同一值（数值等价）。
  const uniqueRows = [];
  const rowIndexOf = new Map();
  const index = new Int32Array(loopCount);
  for (let loop = 0; loop < loopCount; loop += 1) {
    const src = loop * itemSize;
    const parts = new Array(itemSize);
    for (let c = 0; c < itemSize; c += 1) parts[c] = String(layer.values[src + c]);
    const key = parts.join("|");
    let row = rowIndexOf.get(key);
    if (row === undefined) {
      row = uniqueRows.length;
      rowIndexOf.set(key, row);
      uniqueRows.push(parts);
    }
    index[loop] = row;
  }
  const deduped = new Float64Array(uniqueRows.length * itemSize);
  uniqueRows.forEach((parts, row) => {
    for (let c = 0; c < itemSize; c += 1) deduped[row * itemSize + c] = Number(parts[c]);
  });
  layer.valuesNode.props = [makeArrayProperty("d", deduped)];
  const indexNode = childNode(layerNode, indexName);
  if (indexNode) {
    indexNode.props = [makeArrayProperty("i", index)];
  } else {
    const created = { name: indexName, props: [makeArrayProperty("i", index)], children: [], nullTerminated: true };
    const valuesPosition = layerNode.children.indexOf(layer.valuesNode);
    layerNode.children.splice(valuesPosition + 1, 0, created);
  }
  return true;
}

function layerCounts(layerNode, valuesName, indexName) {
  const valuesNode = childNode(layerNode, valuesName);
  const values = valuesNode ? arrayValues(valuesNode.props[0], Float64Array) : null;
  const indexNode = childNode(layerNode, indexName);
  const index = indexNode ? arrayValues(indexNode.props[0], Int32Array) : null;
  return { values: values ? values.length : 0, index: index ? index.length : 0 };
}

// 主入口：buffer in → { buffer, stats } out。任何层校验不过就原样保留该层；
// 整个过程抛错时由调用方回退到原始字节。
function compactFbxGeometryLayers(buffer) {
  const doc = parseFbxDocument(buffer);
  const stats = { sizeBefore: buffer.length, sizeAfter: 0, geometries: 0, layers: [] };
  const objects = doc.nodes.find((node) => node.name === "Objects");
  if (objects) {
    for (const geometry of objects.children) {
      if (geometry.name !== "Geometry") continue;
      const verticesNode = childNode(geometry, "Vertices");
      const pviNode = childNode(geometry, "PolygonVertexIndex");
      const vertices = verticesNode ? arrayValues(verticesNode.props[0], Float64Array) : null;
      const pvi = pviNode ? arrayValues(pviNode.props[0], Int32Array) : null;
      if (!vertices || !pvi) continue;
      const vertCount = vertices.length / 3;
      const loopCount = pvi.length;
      stats.geometries += 1;
      for (const layerNode of geometry.children) {
        const kind = layerNode.name === "LayerElementNormal" ? "normal"
          : layerNode.name === "LayerElementUV" ? "uv"
            : layerNode.name === "LayerElementColor" ? "color" : null;
        if (!kind) continue;
        const before = kind === "normal"
          ? layerCounts(layerNode, "Normals", "NormalsIndex")
          : layerCounts(layerNode, kind === "uv" ? "UV" : "Colors", kind === "uv" ? "UVIndex" : "ColorIndex");
        let rewritten = false;
        if (kind === "normal") {
          rewritten = compactNormalLayer(layerNode, pvi, vertCount, loopCount);
        } else if (kind === "uv") {
          rewritten = compactIndexedLayer(layerNode, "UV", "UVIndex", 2, loopCount);
        } else {
          rewritten = compactIndexedLayer(layerNode, "Colors", "ColorIndex", 4, loopCount);
        }
        const after = kind === "normal"
          ? layerCounts(layerNode, "Normals", "NormalsIndex")
          : layerCounts(layerNode, kind === "uv" ? "UV" : "Colors", kind === "uv" ? "UVIndex" : "ColorIndex");
        stats.layers.push({ kind, rewritten, valuesBefore: before.values, valuesAfter: after.values,
          indexBefore: before.index, indexAfter: after.index });
      }
    }
  }
  const out = serializeFbxDocument(doc);
  stats.sizeAfter = out.length;
  return { buffer: out, stats };
}

module.exports = {
  arrayValues, childNode, compactFbxGeometryLayers, parseFbxDocument,
  scalarValue, serializeFbxDocument
};
