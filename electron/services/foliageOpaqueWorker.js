"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { Buffer } = require("node:buffer");
const { randomUUID } = require("node:crypto");
const { isMainThread, parentPort, workerData } = require("node:worker_threads");
const sharp = require("sharp");
const { area, traceContours, simplifyLoops, ContourIndex, cutTriangle, barycentric } = require("./foliageOpaqueGeometry");
const { traceMeshFromMask } = require("./foliageOpaqueTrace");
const { removeBackLayers } = require("./foliageOpaqueLayers");
const { compactFbxGeometryLayers } = require("./fbxCompactLayers");
const { resolveFloatedOpaqueBudget } = require("./plantOpaqueBudget");

// 网格简化器（QEM，支持 UV 属性加权）。按需加载：未开启减面时不引入依赖开销。
let simplifierPromise = null;
function loadSimplifier() {
  if (!simplifierPromise) {
    simplifierPromise = import("meshoptimizer")
      .then(async (mod) => {
        await mod.MeshoptSimplifier.ready;
        return mod.MeshoptSimplifier;
      })
      .catch(() => null);
  }
  return simplifierPromise;
}

// 三角形四分细分：对每条边取中点，一个三角形拆成 4 个。
//
// 用途：源网格的三角形在 UV 上可能跨越几十个纹素，而遮罩边界是 1 纹素级细节，
// 直接裁切时一个源三角形内要同时容纳过多边界信息，切出来的边界带会粗糙。
// 先细分让每个三角形覆盖更小的 UV 区域，边界就能切得更贴合；
// 由此产生的面数膨胀再由 simplifyFaces 收回到面数阈值之内。
// 顶点属性按线性插值（位置 / 法线 / UV / 顶点色），与原始四边形细分一致。
function subdivideTriangles(triangles, attributeNames, levels) {
  const count = Math.max(0, Math.floor(Number(levels) || 0));
  if (!count) return triangles;
  const midpoint = (a, b) => {
    const out = {};
    for (const name of attributeNames) {
      out[name] = a[name].map((value, index) => (value + b[name][index]) / 2);
    }
    return out;
  };
  let list = triangles;
  for (let level = 0; level < count; level += 1) {
    const next = [];
    for (const triangle of list) {
      const [a, b, c] = triangle.corners;
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      next.push({ corners: [a, ab, ca], material: triangle.material });
      next.push({ corners: [ab, b, bc], material: triangle.material });
      next.push({ corners: [ca, bc, c], material: triangle.material });
      next.push({ corners: [ab, bc, ca], material: triangle.material });
    }
    list = next;
  }
  return list;
}

// 将三角形汤焊接为索引网格：属性完全一致的角点才合并，
// 因此 UV 缝隙两侧不会被焊在一起（缝隙处的顶点法线 / UV 不同）。
function weldFaces(faces) {
  const lookup = new Map();
  const positions = [];
  const uvs = [];
  const indices = [];
  for (const face of faces) {
    for (const corner of face.corners) {
      const position = corner.position || [0, 0, 0];
      const uv = corner.uv || [0, 0];
      const key = `${position.map((v) => Math.round(v * 1e5)).join(",")}|${uv.map((v) => Math.round(v * 1e5)).join(",")}`;
      let index = lookup.get(key);
      if (index === undefined) {
        index = positions.length / 3;
        positions.push(position[0], position[1], position[2]);
        uvs.push(uv[0], uv[1]);
        lookup.set(key, index);
      }
      indices.push(index);
    }
  }
  return { positions: new Float32Array(positions), uvs: new Float32Array(uvs), indices: new Uint32Array(indices) };
}

// 按位置把原始面片上的角点属性（法线 / 顶点色 / 第二套 UV）转移到简化后的顶点上。
//
// 关键：donors 必须是"简化前"的面片。QEM 简化只输出位置与 UV，
// 早期版本误把"待填充的简化面片"本身当作 donors —— 那时角点上还没有 color/normal/uv1，
// donor 就是角点自己，于是永远转移不到任何东西，最后统一写 0。
// 表现为产物顶点法线与顶点色全零：几何没错，但 UE 里着色完全变样（实测顶点法线
// 与面法线平均偏差 90°，即法线退化），而且不会报任何错。
function transferCornerAttributes(faces, transferredNames, donors = faces) {
  if (!transferredNames.length) return;
  const grid = new Map();
  const cell = (v) => Math.round(v * 1e3);
  const keyOf = (p) => `${cell(p[0])},${cell(p[1])},${cell(p[2])}`;
  for (const face of donors) {
    for (const corner of face.corners) {
      if (!corner.position) continue;
      const key = keyOf(corner.position);
      if (!grid.has(key)) grid.set(key, corner);
    }
  }
  let hit = 0, miss = 0;
  for (const face of faces) {
    for (const corner of face.corners) {
      if (!corner.position) continue;
      const donor = grid.get(keyOf(corner.position));
      if (!donor) { miss += 1; continue; }
      hit += 1;
      for (const name of transferredNames) {
        if (corner[name] === undefined && Array.isArray(donor[name])) {
          corner[name] = donor[name].slice();
        }
      }
    }
  }
  // hit/miss 只用于诊断（历史上这里曾因为 donors 传错而静默全零）；
  // 保留计数避免下游误以为是未使用变量。
  void hit; void miss;
}

// 减面迭代参数：单次 meshoptimizer 调用会提前停手，且放宽 target_error 无效
// （实测 1e-2 与 1.6e-1 得到的面数只差 0.03%），因此改为把上一轮的结果当输入继续减。
// 上限 8 轮：每轮至少收敛一个量级就足够覆盖当前所有档位，再多只是白烧 CPU。
const SIMPLIFY_MAX_PASSES = 8;
// 允许的超出比例：meshoptimizer 的收敛是离散的，卡在目标附近即可，不必强求精确相等。
const SIMPLIFY_TARGET_SLACK = 1.02;
// 单个连通片至少保留的面数：低于此值的片在全局减面下会被整片塌没，
// 表现为成品上凭空少一片叶（见 simplifyFaces 的按片分配预算说明）。
const MIN_COMPONENT_FACES = 8;

// 减面到目标面数：按位置 + UV 加权做二次误差简化（QEM）。
// UV 权重高于位置，避免简化把边界拽离遮罩轮廓（实测 UV 权重过低会让贴合度变差）。
//
// donors 是简化前的面片：QEM 只保留位置与 UV，normal / color / uv1 必须从 donors 回填。
// 连通片切分（按位置键做并查集）。裁切产物由大量互不相连的窄叶片组成，
// 全局减面会让小的整片消失（见 simplifyFaces 的说明）。
function splitFaceComponents(faces) {
  const parent = new Int32Array(faces.length);
  for (let i = 0; i < faces.length; i += 1) parent[i] = i;
  const find = (index) => {
    let i = index;
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const owner = new Map();
  for (let i = 0; i < faces.length; i += 1) {
    for (const corner of faces[i].corners) {
      const key = vertexKey(corner.position);
      const first = owner.get(key);
      if (first === undefined) owner.set(key, i);
      else {
        const a = find(first), b = find(i);
        if (a !== b) parent[b] = a;
      }
    }
  }
  const groups = new Map();
  for (let i = 0; i < faces.length; i += 1) {
    const root = find(i);
    const list = groups.get(root);
    if (list) list.push(faces[i]);
    else groups.set(root, [faces[i]]);
  }
  return [...groups.values()];
}

// 单连通片减面：逐轮把结果继续减，命中该片目标即停；没有进展就退出。
async function simplifyComponent(Simplifier, faces, target) {
  if (!target || faces.length <= target) return faces;
  const welded = weldFaces(faces);
  if (welded.indices.length < 3) return [];
  let indices = welded.indices;
  for (let pass = 0; pass < SIMPLIFY_MAX_PASSES; pass += 1) {
    const [next] = Simplifier.simplifyWithAttributes(
      indices,
      welded.positions,
      3,
      welded.uvs,
      2,
      [1.0],
      null,
      target * 3,
      1e-2,
      ["Permissive"]
    );
    if (!next || next.length < 3) break;
    const reduced = next.length < indices.length;
    indices = next;
    if (indices.length / 3 <= target * SIMPLIFY_TARGET_SLACK) break;
    if (!reduced) break;
  }
  const simplified = [];
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const corners = [];
    for (let k = 0; k < 3; k += 1) {
      const v = indices[i + k];
      corners.push({
        position: [welded.positions[v * 3], welded.positions[v * 3 + 1], welded.positions[v * 3 + 2]],
        uv: [welded.uvs[v * 2], welded.uvs[v * 2 + 1]],
      });
    }
    simplified.push({ corners });
  }
  return simplified;
}

async function simplifyFaces(faces, targetFaceCount, transferredNames = [], donors = faces) {
  const target = Math.max(0, Math.floor(Number(targetFaceCount) || 0));
  if (!target || faces.length <= target) return faces;
  const Simplifier = await loadSimplifier();
  if (!Simplifier) return faces;
  // 目标面数是契约，不是建议：插件按面数上限设 Nanite 保留百分比，没减到目标就等于
  // 把差额整段存进资产却不参与渲染（实测 4.73M 面按目标 100k 只收到 306k，保留百分比
  // 因此停在 32%，文件仍是 20 MB）。
  //
  // 但**不能对整块网格一次性减**：裁切产物是许多互不相连的窄叶片，全局误差排序下
  // 小叶片会被整片塌没 —— 实测 ddr6qld_01 按 15 万面减完，一片羽叶完全消失
  // （遮罩不透明区丢掉 6.01%，而不减面时只有 2.01%）。所以按连通片分预算：
  //   每片分到 target × (该片面数 / 总面数)，并至少保留 MIN_COMPONENT_FACES 个面。
  // 这样小叶片不会被大叶片吃掉，总面数仍在目标附近（各片取整误差为片数量级）。
  const components = splitFaceComponents(faces);
  const simplified = [];
  if (components.length <= 1) {
    simplified.push(...await simplifyComponent(Simplifier, faces, target));
  } else {
    for (const component of components) {
      const share = Math.max(MIN_COMPONENT_FACES,
        Math.round(target * (component.length / faces.length)));
      simplified.push(...await simplifyComponent(Simplifier, component,
        Math.min(component.length, share)));
    }
  }
  if (!simplified.length) return faces;
  transferCornerAttributes(simplified, transferredNames, donors);
  // 转移不到的角点必须重算，绝不能填 0。
  //
  // 历史问题：这里原来填 [0,0,0]，导出的 FBX 顶点法线全是零向量 ——
  // 实测某个产物 599,925 个顶点的 |N| 全部为 0，UE 里光照表现完全不像源植物，
  // 而几何本身其实没问题（面法线分布与源网格一致）。零法线不报错，只会静默变样。
  // 因此按位置匹配失败时退回"由面法线重建"：累加每个顶点相邻面的面法线再归一化。
  const missing = new Set();
  for (const face of simplified) {
    for (const corner of face.corners) {
      for (const name of transferredNames) {
        if (!Array.isArray(corner[name])) missing.add(name);
      }
    }
  }
  if (missing.size) {
    const rebuilt = rebuildCornerAttributes(simplified, missing);
    for (const face of simplified) {
      for (const corner of face.corners) {
        for (const name of missing) {
          if (Array.isArray(corner[name])) continue;
          const table = rebuilt.get(name);
          const value = table ? table.get(vertexKey(corner.position)) : null;
          corner[name] = value ? value.slice() : fallbackAttribute(name);
        }
      }
    }
  }
  return simplified;
}

// 位置键：与 transferCornerAttributes 保持同一量化精度，保证两侧能互相命中。
function vertexKey(position) {
  return `${Math.round((position?.[0] || 0) * 1e3)},${Math.round((position?.[1] || 0) * 1e3)},${Math.round((position?.[2] || 0) * 1e3)}`;
}

// 兜底值：法线给 (0,1,0)（向上）而不是零向量 —— 零向量会让 UE 的法线计算退化，
// 表现为整株植物光照异常；其余属性（顶点色等）保持 0 即可。
function fallbackAttribute(name) {
  if (name === "normal") return [0, 1, 0];
  return [0, 0, 0];
}

// 由简化后的面片自身重建顶点属性（目前只用于法线）：
// 累加每个顶点相邻面的叉积（长度 = 两倍面积，天然按面积加权）再归一化。
function rebuildCornerAttributes(faces, names) {
  const out = new Map();
  if (!names.has("normal")) return out;
  const accum = new Map();
  for (const face of faces) {
    const [a, b, c] = face.corners.map((corner) => corner.position);
    if (!a || !b || !c) continue;
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    if (!Number.isFinite(cross[0]) || !Number.isFinite(cross[1]) || !Number.isFinite(cross[2])) continue;
    for (const position of [a, b, c]) {
      const key = vertexKey(position);
      const current = accum.get(key) || [0, 0, 0];
      current[0] += cross[0]; current[1] += cross[1]; current[2] += cross[2];
      accum.set(key, current);
    }
  }
  const normals = new Map();
  for (const [key, value] of accum) {
    const length = Math.hypot(value[0], value[1], value[2]);
    normals.set(key, length > 1e-12 ? [value[0] / length, value[1] / length, value[2] / length] : [0, 1, 0]);
  }
  out.set("normal", normals);
  return out;
}

const log = (message) => parentPort?.postMessage({ type: "log", message: String(message) });

// 按 UV 边长尺度细分源网格：目标是让细分后的三角形 UV 边长不大于 targetTexels（纹素）。
// targetTexels 为空 / 0 时不做细分。逐级四分，最多 3 级（面数最多 ×64），
// 避免对超密网格产生无意义的中间几何。
// texelSize 为遮罩的纹素尺寸（1 / 遮罩边长）：UV 是 0-1 归一化坐标，
// 必须换算成纹素才能与 targetTexels 比较，否则数值尺度差 3 个数量级导致永不细分。
function subdivideSourceToScale(source, targetTexels, texelSize, item, warnings) {
  const target = Number(targetTexels);
  if (!Number.isFinite(target) || target <= 0) return source;
  const perTexel = Number(texelSize) > 0 ? 1 / Number(texelSize) : 0;
  if (!perTexel) return source;
  const triangles = source?.triangles || [];
  if (!triangles.length) return source;

  // 取三角形最长 UV 边的中位数（换算为纹素），避免少量超大三角形把整体判断拉偏。
  const edgeLengths = [];
  for (const triangle of triangles) {
    const [a, b, c] = triangle.corners;
    const ab = Math.hypot(b.uv[0] - a.uv[0], b.uv[1] - a.uv[1]);
    const bc = Math.hypot(c.uv[0] - b.uv[0], c.uv[1] - b.uv[1]);
    const ca = Math.hypot(a.uv[0] - c.uv[0], a.uv[1] - c.uv[1]);
    edgeLengths.push(Math.max(ab, bc, ca) * perTexel);
  }
  edgeLengths.sort((x, y) => x - y);
  const median = edgeLengths[Math.floor(edgeLengths.length / 2)] || 0;
  if (!median) return source;

  let level = 0;
  let current = median;
  while (current > target && level < 3) {
    current /= 2;
    level += 1;
  }
  item.subdivideMedianTexelsBefore = Number(median.toFixed(1));
  if (!level) {
    item.subdivideLevel = 0;
    return source;
  }
  const subdivided = subdivideTriangles(triangles, source.attributeNames, level);
  item.subdivideLevel = level;
  item.subdivideMedianTexelsAfter = Number(current.toFixed(1));
  warnings.push(
    `${item.object}：源网格 UV 边长中位 ${median.toFixed(1)} 纹素，细分 ${level} 级（1/${4 ** level}）到 ${current.toFixed(1)} 纹素，` +
    `面数 ${triangles.length} → ${subdivided.length}`
  );
  // 必须带上 attributes：下游 geometryFromFaces 要用 source.attributes[name].itemSize
  // 决定每个属性的分量数，缺了会在回填几何体时报错。
  return { triangles: subdivided, attributeNames: source.attributeNames, attributes: source.attributes };
}

function sample(values, width, height, x, y) {
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return 0;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  return (values[y0 * width + x0] * (1 - fx) + values[y0 * width + x1] * fx) * (1 - fy) +
    (values[y1 * width + x0] * (1 - fx) + values[y1 * width + x1] * fx) * fy;
}

function bmpPixels(buffer) {
  if (buffer.length < 54 || buffer.toString("ascii", 0, 2) !== "BM") throw new Error("无效的 BMP 文件");
  const width = buffer.readInt32LE(18), signedHeight = buffer.readInt32LE(22);
  const height = Math.abs(signedHeight), bits = buffer.readUInt16LE(28);
  const offset = buffer.readUInt32LE(10), stride = Math.ceil(width * bits / 32) * 4;
  if (width <= 0 || height <= 0 || ![24, 32].includes(bits) || buffer.readUInt32LE(30) !== 0 ||
      offset + stride * height > buffer.length) throw new Error("不支持或损坏的 BMP 像素格式");
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const row = offset + (signedHeight > 0 ? height - y - 1 : y) * stride;
    for (let x = 0; x < width; x += 1) {
      const source = row + x * bits / 8, target = (y * width + x) * 4;
      pixels[target] = buffer[source + 2];
      pixels[target + 1] = buffer[source + 1];
      pixels[target + 2] = buffer[source];
      pixels[target + 3] = bits === 32 ? buffer[source + 3] : 255;
    }
  }
  return { pixels, width, height };
}

function normalizeExrChannelNames(buffer) {
  if (buffer.length < 16 || buffer.readUInt32LE(0) !== 0x01312f76) return;
  let offset = 8;
  while (offset < buffer.length) {
    const nameEnd = buffer.indexOf(0, offset);
    if (nameEnd < 0) return;
    const name = buffer.toString("ascii", offset, nameEnd);
    offset = nameEnd + 1;
    if (!name) return;
    const typeEnd = buffer.indexOf(0, offset);
    if (typeEnd < 0 || typeEnd + 5 > buffer.length) return;
    const size = buffer.readInt32LE(typeEnd + 1);
    offset = typeEnd + 5;
    if (size < 0 || offset + size > buffer.length) return;
    if (name === "channels") {
      const entries = [];
      for (let cursor = offset; cursor < offset + size;) {
        const end = buffer.indexOf(0, cursor);
        if (end < 0 || end >= offset + size || end === cursor) break;
        entries.push({ name: buffer.toString("ascii", cursor, end), start: cursor });
        cursor = end + 17;
      }
      if (entries.length && !entries.some((entry) => entry.name === "Y") &&
          !["R", "G", "B"].every((channel) => entries.some((entry) => entry.name === channel)) &&
          entries[0].name.length === 1) buffer[entries[0].start] = "Y".charCodeAt(0);
      return;
    }
    offset += size;
  }
}

async function openMaskImage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".bmp") {
    const image = bmpPixels(await fs.readFile(filePath));
    return sharp(image.pixels, { raw: { width: image.width, height: image.height, channels: 4 } });
  }
  if (ext === ".tga") {
    const { TGALoader } = await import("three/examples/jsm/loaders/TGALoader.js");
    const buffer = await fs.readFile(filePath);
    const image = new TGALoader().parse(buffer);
    return sharp(image.data, { raw: { width: image.width, height: image.height, channels: 4 } });
  }
  if (ext === ".exr") {
    const { HalfFloatType, DataUtils } = await import("three");
    const { EXRLoader } = await import("three/examples/jsm/loaders/EXRLoader.js");
    const buffer = await fs.readFile(filePath);
    normalizeExrChannelNames(buffer);
    const array = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    const image = new EXRLoader().setDataType(HalfFloatType).parse(array);
    const { width, height, data } = image;
    const channels = data.length / (width * height);
    if (![1, 2, 3, 4].includes(channels)) throw new Error("无效的 EXR 通道数据");
    const pixels = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const source = ((height - 1 - y) * width + x) * channels, target = (y * width + x) * 4;
      for (let c = 0; c < 4; c += 1) {
        const channel = c === 3 ? (channels === 4 ? 3 : channels === 2 ? 1 : -1)
          : channels < 3 ? 0 : c;
        const value = channel < 0 ? 1 : DataUtils.fromHalfFloat(data[source + channel]);
        pixels[target + c] = Math.max(0, Math.min(255, Math.round(value * 255)));
      }
    }
    return sharp(pixels, { raw: { width, height, channels: 4 } });
  }
  return sharp(filePath, { failOn: "error" });
}

async function loadMask(filePath, channel, maxSize, warnings) {
  const image = await openMaskImage(filePath);
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) throw new Error(`遮罩图片无法读取：${filePath}`);
  let pipeline = image;
  if (maxSize > 0 && Math.max(metadata.width, metadata.height) > maxSize) {
    pipeline = pipeline.resize({ width: maxSize, height: maxSize, fit: "inside", withoutEnlargement: true });
  }
  // sharp rows start at the image top; FBX UV V=0 and Blender's image.pixels
  // start at the bottom. Flip here so the contour coordinates stay compatible.
  const { data, info } = await pipeline.flip().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const width = info.width, height = info.height;
  const values = new Float32Array(width * height);
  let minAlpha = 255;
  for (let i = 0; i < values.length; i += 1) {
    const alpha = data[i * 4 + 3];
    minAlpha = Math.min(minAlpha, alpha);
  }
  // 常量 alpha 也有透明度语义，显式 alpha 遮罩不能因没有变化而退回 RGB。
  const hasAlpha = metadata.hasAlpha === true;
  let resolvedChannel = channel || "auto";
  if (resolvedChannel === "auto") resolvedChannel = hasAlpha && minAlpha < 255 ? "alpha" : "luminance";
  if (resolvedChannel === "alpha" && !hasAlpha) {
    warnings.push(`遮罩不含有效 alpha 通道，改用亮度采样：${path.basename(filePath)}`);
    resolvedChannel = "luminance";
  }
  for (let i = 0; i < values.length; i += 1) {
    const offset = i * 4;
    values[i] = resolvedChannel === "alpha" ? data[offset + 3] / 255
      : resolvedChannel === "red" ? data[offset] / 255
        : (data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722) / 255;
  }
  return { values, width, height, resolvedChannel, texelSize: 1 / Math.max(width, height) };
}

function erodeMask(values, width, height, amount) {
  if (!(amount > 0)) return values;
  const diagonal = amount / Math.SQRT2;
  const offsets = [[amount, 0], [-amount, 0], [0, amount], [0, -amount],
    [diagonal, diagonal], [diagonal, -diagonal], [-diagonal, diagonal], [-diagonal, -diagonal]];
  const result = new Float32Array(values.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let value = values[y * width + x];
      for (const [dx, dy] of offsets) value = Math.min(value, sample(values, width, height, x + dx, y + dy));
      result[y * width + x] = value;
    }
  }
  return result;
}

// 填充孔洞：把「被白色完全包围」的黑色区域填成白色，让追踪出的边界只剩外轮廓。
//
// 为什么需要：透贴里叶片内部常带针孔与缝隙（实测 Megascans 草丛遮罩 4096² 下有 443 个
// 内含孔洞、共 2.9 万纹素，轮廓环因此多出 434 个 = 44%）。这些孔洞会被轮廓追踪当成额外的
// 内环，裁切/生成阶段沿内环再走一圈 —— 边界因此出现毛刺与碎面，观感就是"切出来的边缘不干净"。
//
// 判据用泛洪而不是形态学闭运算：从图像四边泛洪黑色像素，能到达的属于「外部背景」，
// 到达不了的黑色像素必然被白色包围，才是真正的孔洞。闭运算要选核大小 —— 小核填不掉
// 大孔、大核会把叶尖之间的开口也糊上；泛洪只按拓扑判定，与孔洞大小无关。
//
// maxAreaTexels > 0 时只填面积不超过该值（平方纹素）的孔洞，用来避开"白环内部本来就
// 该镂空"的大面积区域；0 = 不限，全部填充。就地改写 values（不额外复制整张遮罩），
// 返回统计供报告使用。
function fillMaskHoles(values, width, height, threshold, maxAreaTexels) {
  const stats = { holes: 0, holesFilled: 0, holesSkipped: 0, texelsFilled: 0, maxAreaTexels: Math.max(0, Number(maxAreaTexels) || 0) };
  if (!(width > 0) || !(height > 0) || values.length < width * height) return stats;
  const outside = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  const limit = threshold > 0 ? threshold : 0.5;
  let top = 0;
  const pushOutside = (index) => {
    if (outside[index] || values[index] >= limit) return;
    outside[index] = 1;
    stack[top++] = index;
  };
  for (let x = 0; x < width; x += 1) {
    pushOutside(x);
    pushOutside((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    pushOutside(y * width);
    pushOutside(y * width + width - 1);
  }
  while (top > 0) {
    const index = stack[--top];
    const x = index % width;
    const y = (index - x) / width;
    if (x > 0) pushOutside(index - 1);
    if (x + 1 < width) pushOutside(index + 1);
    if (y > 0) pushOutside(index - width);
    if (y + 1 < height) pushOutside(index + width);
  }
  // 未被外部泛洪访问到的黑色像素 = 被白色包围的孔洞，逐连通片统计后再决定填不填。
  for (let start = 0; start < outside.length; start += 1) {
    if (outside[start] || values[start] >= limit) continue;
    top = 0;
    outside[start] = 1;
    stack[top++] = start;
    const members = [];
    while (top > 0) {
      const index = stack[--top];
      members.push(index);
      const x = index % width;
      const y = (index - x) / width;
      const visit = (neighbor) => {
        if (outside[neighbor] || values[neighbor] >= limit) return;
        outside[neighbor] = 1;
        stack[top++] = neighbor;
      };
      if (x > 0) visit(index - 1);
      if (x + 1 < width) visit(index + 1);
      if (y > 0) visit(index - width);
      if (y + 1 < height) visit(index + width);
    }
    stats.holes += 1;
    if (stats.maxAreaTexels > 0 && members.length > stats.maxAreaTexels) {
      stats.holesSkipped += 1;
      continue;
    }
    for (const index of members) values[index] = 1;
    stats.holesFilled += 1;
    stats.texelsFilled += members.length;
  }
  return stats;
}

function sourceTriangles(mesh) {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute("position");
  const uv = geometry.getAttribute("uv");
  if (!position || !uv) return null;
  const index = geometry.getIndex();
  const count = index ? index.count : position.count;
  const attributeNames = Object.keys(geometry.attributes).filter((name) =>
    name === "position" || name === "normal" || name === "color" || /^uv\d*$/.test(name));
  const groups = geometry.groups.length ? geometry.groups : [{ start: 0, count, materialIndex: 0 }];
  const materialFor = (offset) => groups.find((group) => offset >= group.start && offset < group.start + group.count)?.materialIndex || 0;
  const triangles = [];
  for (let offset = 0; offset + 2 < count; offset += 3) {
    const corners = [];
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = index ? index.getX(offset + corner) : offset + corner;
      const data = {};
      for (const name of attributeNames) {
        const attribute = geometry.getAttribute(name);
        data[name] = Array.from({ length: attribute.itemSize }, (_, component) => attribute.array[vertex * attribute.itemSize + component]);
      }
      corners.push(data);
    }
    triangles.push({ corners, material: materialFor(offset) });
  }
  return { triangles, attributeNames, attributes: geometry.attributes };
}

// 估算某个采样步长下 trace 会生成多少面片。
//
// 不能用"UV 面积 ÷ 每格面积"：trace 的实际生成量由**源三角形细分**决定 —— 每个源三角形
// 按最长 UV 边细分到不超过 stepTexels（每级 ×4），之后遮罩再保留约 0.87~0.92。
// 实测 axz0tqu_01：5,853 个源三角形 → 5,611,690 个密集三角形（比值 958）→ 4,891,108 面。
// 按面积估算会给出约 5.7 万面（差 85 倍），因此必须按逐三角形的细分级数累加。
function estimateTraceFaces(source, mask, stepTexels) {
  const size = Math.max(1, mask?.width || 1, mask?.height || 1);
  const step = Math.max(Number(stepTexels) || 0, 1e-6);
  let dense = 0;
  for (const triangle of source.triangles || []) {
    const uv = triangle.corners.map((corner) => corner.uv || [0, 0]);
    let maxEdge = 0;
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
      const dx = (uv[a][0] - uv[b][0]) * size;
      const dy = (uv[a][1] - uv[b][1]) * size;
      const edge = Math.hypot(dx, dy);
      if (edge > maxEdge) maxEdge = edge;
    }
    const level = maxEdge > step ? Math.ceil(Math.log2(maxEdge / step)) : 0;
    dense += 4 ** Math.max(0, level);
  }
  return Math.round(dense * 0.9);
}

function interpolateCorner(corners, weights, attributeNames) {
  const result = {};
  for (const name of attributeNames) {
    const size = corners[0][name].length;
    result[name] = Array.from({ length: size }, (_, i) =>
      corners[0][name][i] * weights[0] + corners[1][name][i] * weights[1] + corners[2][name][i] * weights[2]);
    if (name === "normal") {
      const length = Math.hypot(...result[name]);
      if (length > 1e-9) result[name] = result[name].map((value) => value / length);
    }
  }
  return result;
}

function cutMeshTriangles(source, contours, minArea, mask, threshold, warnings) {
  const faces = [];
  let cutTriangles = 0, degenerateUvTriangles = 0;
  for (const item of source.triangles) {
    const triangle = item.corners.map((corner) => corner.uv);
    let pieces, cut;
    if (Math.abs(area(triangle)) <= 1e-14) {
      degenerateUvTriangles += 1;
      const [u, v] = triangle[0];
      const alpha = sample(mask.values, mask.width, mask.height,
        Math.max(0, Math.min(1, u)) * (mask.width - 1), Math.max(0, Math.min(1, v)) * (mask.height - 1));
      pieces = alpha >= threshold ? [triangle] : [];
      cut = false;
    } else {
      ({ pieces, cut } = cutTriangle(triangle, contours, minArea, (warning) => warnings.push(warning)));
    }
    if (cut) cutTriangles += 1;
    for (const piece of pieces) {
      for (let i = 1; i + 1 < piece.length; i += 1) {
        const points = [piece[0], piece[i], piece[i + 1]];
        const corners = cut ? points.map((point) => interpolateCorner(item.corners, barycentric(point, triangle), source.attributeNames))
          : item.corners.map((corner) => Object.fromEntries(Object.entries(corner).map(([name, values]) => [name, values.slice()])));
        faces.push({ corners, material: item.material });
      }
    }
  }
  return { faces, cutTriangles, degenerateUvTriangles };
}

// 细碎面片清理：单一「区域大小比率阈值」判据——连通片包围盒对角线占整体模型包围盒
// 对角线的比率低于阈值即删除。0 = 关闭清理（默认）。
function cleanupFaces(faces, minSizeRatio) {
  const stats = { islandsBefore: 0, islandsRemoved: 0, facesRemoved: 0, vertsRemoved: 0, minSizeRatio };
  if (!minSizeRatio || !faces.length) return { faces, stats };
  const vertexIds = new Map();
  const vertices = [];
  const parent = [];
  const find = (value) => { while (parent[value] !== value) { parent[value] = parent[parent[value]]; value = parent[value]; } return value; };
  const faceIds = faces.map((face) => face.corners.map((corner) => {
    const pos = corner.position;
    const key = pos.map((value) => Math.round(value * 1e6)).join(":");
    if (!vertexIds.has(key)) {
      const id = vertices.length;
      vertexIds.set(key, id);
      vertices.push(pos);
      parent.push(id);
    }
    return vertexIds.get(key);
  }));
  for (const ids of faceIds) {
    const a = find(ids[0]);
    for (let i = 1; i < 3; i += 1) {
      const b = find(ids[i]);
      if (a !== b) parent[b] = a;
    }
  }
  const parts = new Map();
  const modelMin = [Infinity, Infinity, Infinity], modelMax = [-Infinity, -Infinity, -Infinity];
  faces.forEach((face, index) => {
    const root = find(faceIds[index][0]);
    if (!parts.has(root)) parts.set(root, { indices: [], vertices: new Set(), area: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
    const part = parts.get(root);
    part.indices.push(index);
    faceIds[index].forEach((id) => part.vertices.add(id));
    const [a, b, c] = face.corners.map((corner) => corner.position);
    const ab = b.map((value, axis) => value - a[axis]);
    const ac = c.map((value, axis) => value - a[axis]);
    const cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    const faceArea = Math.hypot(...cross) * 0.5;
    part.area += faceArea;
    for (const point of [a, b, c]) {
      for (let axis = 0; axis < 3; axis += 1) {
        part.min[axis] = Math.min(part.min[axis], point[axis]);
        part.max[axis] = Math.max(part.max[axis], point[axis]);
        modelMin[axis] = Math.min(modelMin[axis], point[axis]);
        modelMax[axis] = Math.max(modelMax[axis], point[axis]);
      }
    }
  });
  stats.islandsBefore = parts.size;
  const modelSpan = Math.hypot(...modelMin.map((value, axis) => modelMax[axis] - value));
  const doomed = new Set();
  for (const [root, part] of parts) {
    const span = Math.hypot(...part.min.map((value, axis) => part.max[axis] - value));
    if (span / Math.max(modelSpan, 1e-12) < minSizeRatio) doomed.add(root);
  }
  if (doomed.size === parts.size) {
    const largest = [...parts].sort((a, b) => b[1].area - a[1].area)[0];
    if (largest) doomed.delete(largest[0]);
  }
  if (!doomed.size) return { faces, stats };
  const keep = [];
  faces.forEach((face, index) => {
    if (doomed.has(find(faceIds[index][0]))) stats.facesRemoved += 1;
    else keep.push(face);
  });
  stats.islandsRemoved = doomed.size;
  for (const root of doomed) stats.vertsRemoved += parts.get(root).vertices.size;
  return { faces: keep, stats };
}

// 由角点数组构造 BufferGeometry。
//
// 角点按「完整属性元组」焊接成索引网格：属性完全一致的角点才合并，因此 UV 缝隙、
// 朝向相反的前后面都保持分离，接缝不会破。不焊接时顶点数 = 角数
// （每面各持 3 个独立顶点），FBX 的 Vertices 数组因此是 3×面数 ——
// 实测某个 20 万面产物的 FBX 写出 599,985 个顶点（唯一位置只有 98,953 个）。
// 顶点零共享还会让任何"按顶点平均"的法线下游退化成逐面硬边，因此这里必须焊接。
//
// 导出属性表不含顶点色：不透明裁切材质不消费顶点色，而颜色层占产物约两成体积
// （实测 100k 面：颜色层 1.56MB / 7.35MB，且其值全部继承自源网格、不含裁切信息）。
// masked 变体不受影响（源 FBX 原样导入，顶点色保留）。焊接键同步排除顶点色，
// 否则顶点数仍按"颜色不同即不同顶点"膨胀，白占 Vertices 数组。
const EXPORT_EXCLUDED_ATTRIBUTES = new Set(["color"]);

function geometryFromFaces(THREE, source, faces) {
  const geometry = new THREE.BufferGeometry();
  const names = (source.attributeNames || []).filter((name) => !EXPORT_EXCLUDED_ATTRIBUTES.has(name));
  const itemSizeOf = (name) => {
    const declared = Number(source.attributes?.[name]?.itemSize);
    if (declared > 0) return declared;
    return /^uv\d*$/.test(name) ? 2 : name === "color" ? 4 : 3;
  };
  const itemSizes = {};
  const components = {};
  for (const name of names) {
    itemSizes[name] = itemSizeOf(name);
    components[name] = [];
  }
  // 量化容差：位置与 UV 用 1e-5（模型尺度 50 时约 5e-4 单位，远小于最短边 0.03，
  // 不会把相邻顶点并成一个）；法线 / 顶点色用 1e-3（约 0.06°），让相邻三角形在
  // 共享角点上可靠命中同一个键 —— 容差太紧会让焊接失效，退回顶点零共享。
  // UV2/UV3 也可能承载原生 ST 风动编码，必须与 UV0/UV1 使用同样的焊接精度。
  const quantScale = (name) => (name === "position" || /^uv\d*$/.test(name) ? 1e5 : 1e3);
  const lookup = new Map();
  const indices = [];
  const keyParts = [];
  let vertexCount = 0;
  let lastMaterial = null, groupStart = 0;
  faces.forEach((face, index) => {
    if (face.material !== lastMaterial) {
      if (lastMaterial !== null) geometry.addGroup(groupStart, index * 3 - groupStart, lastMaterial);
      groupStart = index * 3;
      lastMaterial = face.material;
    }
    for (const corner of face.corners) {
      keyParts.length = 0;
      for (const name of names) {
        const values = corner[name];
        const scale = quantScale(name);
        for (let c = 0; c < itemSizes[name]; c += 1) {
          keyParts.push(Math.round((Number(values?.[c]) || 0) * scale));
        }
      }
      const key = keyParts.join("|");
      let vertexIndex = lookup.get(key);
      if (vertexIndex === undefined) {
        vertexIndex = vertexCount;
        vertexCount += 1;
        for (const name of names) {
          const values = corner[name];
          // 按 itemSize 补齐：角点缺分量时补 0，避免把不足 itemSize 的数组塞进
          // Float32BufferAttribute 而错位（此前会把后续顶点整体读歪）。
          for (let c = 0; c < itemSizes[name]; c += 1) {
            components[name].push(Number(values?.[c]) || 0);
          }
        }
        lookup.set(key, vertexIndex);
      }
      indices.push(vertexIndex);
    }
  });
  if (lastMaterial !== null) geometry.addGroup(groupStart, faces.length * 3 - groupStart, lastMaterial);
  for (const name of names) {
    geometry.setAttribute(name, new THREE.Float32BufferAttribute(components[name], itemSizes[name]));
  }
  geometry.setIndex(indices);
  if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
  return geometry;
}

function boundsOf(scene, THREE) {
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3();
  scene.traverse((object) => { if (object.isMesh) box.expandByObject(object); });
  if (box.isEmpty()) return null;
  return { yMin: box.min.y, yMax: box.max.y, zMin: box.min.z, zMax: box.max.z,
    sizeY: Math.max(box.max.y - box.min.y, 1e-6), sizeZ: Math.max(box.max.z - box.min.z, 1e-6) };
}

function placeholderMaterials(scene, THREE) {
  scene.traverse((object) => {
    if (!object.isMesh) return;
    const make = (material) => new THREE.MeshStandardMaterial({ name: material?.name || "Material" });
    object.material = Array.isArray(object.material) ? object.material.map(make) : make(object.material);
  });
}

function makeCutMaskContext(mask, denseLoops, settings) {
  return { mask, denseLoops, contours: new ContourIndex(denseLoops),
    hasCutouts: mask.values.some((value) => value < settings.threshold) };
}

// 包围盒里没有任何透明边界，且三角形内部在白区时，整面可原样保留；孔洞边界也会阻止跳过。
function isFullyOpaqueTriangle(triangle, context) {
  const uvs = triangle.corners.map((corner) => corner.uv);
  const us = uvs.map((uv) => uv[0]), vs = uvs.map((uv) => uv[1]);
  const minU = Math.min(...us), maxU = Math.max(...us), minV = Math.min(...vs), maxV = Math.max(...vs);
  if (!context.contours.pointInside((us[0] + us[1] + us[2]) / 3, (vs[0] + vs[1] + vs[2]) / 3)) return false;
  for (const index of context.contours.segmentsInBox(minU, minV, maxU, maxV)) {
    const [ax, ay, bx, by] = context.contours.segments[index];
    if (Math.max(ax, bx) >= minU && Math.min(ax, bx) <= maxU &&
        Math.max(ay, by) >= minV && Math.min(ay, by) <= maxV) return false;
  }
  return true;
}

// 只有材质自身的透明度证据才允许套用遮罩。多材质中无从确定的实体部分保留，避免叶片透贴误切树干。
async function partitionMeshForCut(mesh, source, fallbackContext, settings, materialCount, hasDeclaredOpacity, maskCache, warnings) {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const groups = new Map();
  for (const triangle of source.triangles) {
    if (!groups.has(triangle.material)) groups.set(triangle.material, []);
    groups.get(triangle.material).push(triangle);
  }
  const textureContext = async (texture, channel) => {
    const file = texture?.userData?.assethiveSourcePath;
    if (!file) return null;
    const key = `${file}|${channel}`;
    if (!maskCache.has(key)) {
      maskCache.set(key, (async () => {
        try {
          const mask = await loadMask(file, channel, settings.maskMaxSize, []);
          if (channel === "alpha" && mask.resolvedChannel !== "alpha") return { opaque: true };
          if (settings.fillHoles) fillMaskHoles(mask.values, mask.width, mask.height, settings.threshold, settings.holeMaxAreaTexels);
          mask.values = erodeMask(mask.values, mask.width, mask.height, settings.maskErodeTexels);
          return makeCutMaskContext(mask, traceContours(mask.values, mask.width, mask.height, settings.threshold), settings);
        } catch { return null; }
      })());
    }
    return maskCache.get(key);
  };
  const preserved = [], parts = [], report = [];
  for (const [index, triangles] of groups) {
    const material = materials[index];
    const name = material?.name || `Material${index}`;
    const alphaMap = await textureContext(material?.alphaMap, "auto");
    const diffuseAlpha = material?.map ? await textureContext(material.map, "alpha") : null;
    const declaresOpacity = material?.alphaMap || material?.alphaTest > 0 || material?.transparent === true || material?.opacity < 1;
    let context = null, reason;
    if (alphaMap && !alphaMap.opaque) {
      context = alphaMap;
      reason = "material-opacity-map";
    } else if (declaresOpacity) {
      context = diffuseAlpha?.hasCutouts ? diffuseAlpha : fallbackContext;
      reason = "material-opacity";
    } else if (diffuseAlpha) {
      context = diffuseAlpha.hasCutouts ? diffuseAlpha : null;
      reason = context ? "material-basecolor-alpha" : "opaque-material";
    } else if (materialCount === 1) {
      context = fallbackContext;
      reason = "single-material-mask";
    } else if (hasDeclaredOpacity) {
      reason = "opaque-material";
    } else {
      reason = "unresolved-material-preserved";
      warnings.push(`${mesh.name}/${name}：没有该材质的透明度依据，保留原始几何体`);
    }
    const cut = [];
    let kept = 0;
    for (const triangle of triangles) {
      if (!context || !context.hasCutouts || isFullyOpaqueTriangle(triangle, context)) {
        preserved.push(triangle);
        kept += 1;
      } else cut.push(triangle);
    }
    const detail = { material: index, name, reason, facesIn: triangles.length, preservedFaces: kept, cutFacesIn: cut.length };
    report.push(detail);
    if (cut.length) parts.push({ triangles: cut, context, detail });
  }
  return { preserved, parts, report };
}

async function cutSourceFaces(source, settings, mask, denseLoops, item, warnings, label) {
  let phaseMark = Date.now();
  // 两条生成路线，目标相同（按遮罩得到裁切面片），取面片的方式不同：
  //   cut（默认）：在源网格上沿轮廓剪开。边界精度受源三角形尺寸限制。
  //   trace：按遮罩在 UV 空间直接生成均匀面片，再投影回源网格表面。
  //          边界精度只由 traceStepTexels 决定，与源网格密度无关。
  let sourceForCut = source;
  let baseFaces = null;
  if (settings.traceStepTexels > 0) {
    // stepTexels 就是成品的采样密度：值越小边界越贴合，面片数按平方增长。
    // maxFaces 只作为失控保护 —— 正常情况下面片数由 stepTexels 决定，
    // 之后再由 simplifyTarget 收到面数阈值内。
    //
    // 但"撞上限截断"和"主动调粗"是两件事：截断会让遮罩有一块没被覆盖（成品上凭空
    // 缺一片叶/缺一块），而调粗只是边界更粗、覆盖完整。因此这里先按源网格的 UV 面积
    // 估算该步长需要多少面片，超上限就把步长抬到刚好装得下（步长↔面数按 1/步长²）。
    // 实测 axz0tqu 在 6 纹素下需 489 万面，而 Electron 的 JS 堆天花板（约 3.78GB）
    // 只允许约 100 万面，于是被截断 —— 用户看到的就是"模型上有空洞"。
    const faceCap = settings.traceMaxFaces > 0
      ? settings.traceMaxFaces
      : (settings.denseFaceLimit > 0 ? settings.denseFaceLimit : 0);
    let stepTexels = settings.traceStepTexels;
    if (faceCap > 0) {
      const estimated = estimateTraceFaces(source, mask, stepTexels);
      const safe = faceCap * 0.9;
      if (estimated > safe) {
        const raised = Math.ceil(stepTexels * Math.sqrt(estimated / safe));
        warnings.push(`${label}：按 ${stepTexels} 纹素采样约需 ${estimated.toLocaleString()} 面，`
          + `超过生成上限 ${faceCap.toLocaleString()}（内存约束）；已自动调粗到 ${raised} 纹素 —— `
          + `覆盖完整、不会缺面，代价是边界比 ${stepTexels} 纹素更粗`);
        stepTexels = raised;
      }
    }
    const traced = traceMeshFromMask(source, mask, {
      threshold: settings.threshold,
      stepTexels,
      // trace 路线的面数闸门：这一步的面片数直接决定内存峰值（约 1.1KB/面片，
      // 100 万面 ≈ 1.1GB 堆），所以由 traceMaxFaces 单独控制，外部可调。
      // 不能拿 faceBudget 顶替：那是"最终输出面数阈值"，比生成量小一个量级，
      // 用它当生成上限会把采样密度死死压住（边界明显变粗）。
      // 不用 denseFaceLimit：那个是这一项的历史名字（按 6GB 堆设计），
      // 仅作为旧 plan 的兼容回退保留在下一位。
      maxFaces: faceCap,
    });
    if (!traced.faces.length) {
      warnings.push(`${label}：Trace 未生成任何面片，回退为裁切`);
    } else {
      baseFaces = traced.faces;
      item.trace = { ...traced.stats };
      for (const warning of traced.warnings) warnings.push(`${label}：${warning}`);
      // 撞到生成上限时明确告知：此时边界精度由上限决定而不是 stepTexels，
      // 用户要么调大上限（占更多内存），要么接受更粗的边界。
      if (traced.stats.cappedByFaceLimit) {
        warnings.push(`${label}：生成面片数达到上限 ${traced.stats.faceLimit}，采样密度未完全展开（边界会比 ${settings.traceStepTexels} 纹素更粗）`);
      }
      // 叶片是薄壳：遮罩是实心的地方，壳体上下两层都会被保留（实测源网格里
      // 53% 的相邻面片对就是"位置重合、法线相反"）。两层叠在一起渲染会互穿闪烁，
      // 引擎里表现为叶片上一块块交错花斑。这里按空间桶的主方向收敛成单层。
      const layered = removeBackLayers(baseFaces, { bucketSize: settings.layerBucketSize });
      if (layered.stats.removedBackLayers > 0) {
        baseFaces = layered.faces;
        item.layers = layered.stats;
      }
    }
  }
  let outcome = null, cleanup = null;
  if (baseFaces) {
    // Trace 路线的面片已经是"裁切结果"，无需再按轮廓裁剪；
    // 仍走一次细碎面片清理，保持与裁切路线一致的语义。
    cleanup = cleanupFaces(baseFaces, settings.cleanupPercent > 0 ? settings.cleanupPercent / 100 : 0);
    outcome = { faces: baseFaces, cutTriangles: 0, degenerateUvTriangles: 0 };
  } else {
    // 细分：源三角形在 UV 上跨越的纹素越多，边界带越粗糙。按 UV 边长（以纹素计）
    // 逐级细分到目标尺度，让裁切边界有足够密度贴合遮罩轮廓。
    // 明细度对边界的影响是平方级的：边长减半 = 面积降到 1/4。
    sourceForCut = subdivideSourceToScale(source, settings.subdivideTexels, mask.texelSize, item, warnings);
    let precision = settings.contourPrecisionTexels;
    for (let attempt = 0; attempt <= 5; attempt += 1) {
      const contours = new ContourIndex(simplifyLoops(denseLoops,
        precision * mask.texelSize, settings.contourMinAreaTexels * mask.texelSize ** 2));
      outcome = cutMeshTriangles(sourceForCut, contours, settings.contourMinAreaTexels * mask.texelSize ** 2,
        mask, settings.threshold, warnings);
      cleanup = cleanupFaces(outcome.faces, settings.cleanupPercent > 0 ? settings.cleanupPercent / 100 : 0);
      // 两条控制面数的手段必须互斥，否则质量损失会叠加：
      //   - 减面模式：由 QEM 收敛到目标面数，这里直接跳出，不再放宽精度
      //     （放宽精度会让边界变粗，实测会把减面换来的质量改善全部吃掉）；
      //   - 非减面模式：维持原行为，超出上限时逐级放宽轮廓精度。
      if (settings.simplifyTarget || !settings.faceBudget ||
          cleanup.faces.length <= settings.faceBudget || attempt === 5) break;
      precision *= 1.6;
      warnings.push(`面数达到上限：${label} 输出 ${cleanup.faces.length} 面，轮廓精度放宽到 ${precision.toFixed(3)} 纹素后重试`);
    }
  }
  // 面数档随结构复杂度浮动（自动档，见 plantOpaqueBudget 的档位表）：
  // 生成的候选面数就是复杂度的直接度量 —— 同一条轮廓精度基准下，复杂资产
  // （itx1dbp_01，4.73M 候选）的候选远多于简单资产（_08，1.09M）。
  // 这个浮动值现在只用于**上报与超限告警**（见下方 faceBudget 的用法），
  // 不再当作 QEM 目标（2026-10-15 起导出不减面）。
  let faceBudget = settings.faceBudget;
  // 导出不再自动减面（产品口径）：生成多少面就导出多少面，交给 UE 侧 Nanite 收敛。
  // 面数设置在这里只作为"面数预设"（自动档位或操作者覆盖值）用于上报与超限告警，
  // **不再**用它当 QEM 目标。只有调用方显式下发 simplifyTarget > 0 时才减面。
  const simplifyTarget = settings.simplifyTarget;
  const floatedBudget = resolveFloatedOpaqueBudget(
    { floor: settings.faceBudgetFloor, ceiling: settings.faceBudgetCeiling },
    outcome.faces.length);
  if (floatedBudget > 0) {
    faceBudget = floatedBudget;
    item.faceBudgetFloated = { generated: outcome.faces.length, budget: floatedBudget };
  }
  // 减面：把细分 / Trace 带来的面数膨胀收回到目标面数（阈值），同时顺带改善三角形质量
  // （实测 sliver 占比与薄度都下降）。关闭时保留原样。
  // 第 4 个参数把"简化前的面片"作为属性来源：QEM 只输出位置与 UV，
  // normal / 顶点色 / uv1 都要从简化前的角点按位置回填。
  const generateMs = Date.now() - phaseMark;    // 源网格建岛 + trace/裁切 + 清理
  phaseMark = Date.now();
  const finalFaces = simplifyTarget
    ? await simplifyFaces(cleanup.faces, simplifyTarget,
        // 减面后的属性回填不含顶点色：导出侧已整体剔除（见 geometryFromFaces），
        // 回填它是纯浪费。位置与 UV 本来就由 QEM 自己携带。
        (sourceForCut.attributeNames || []).filter((name) =>
          name !== "position" && name !== "uv" && !EXPORT_EXCLUDED_ATTRIBUTES.has(name)),
        cleanup.faces)
    : cleanup.faces;
  const simplifyMs = Date.now() - phaseMark;
  if (simplifyTarget && finalFaces !== cleanup.faces) {
    item.simplifiedFrom = cleanup.faces.length;
  }
  // 只在"要求减面却仍超预设"时告警：不减面导出是当前产品口径，自然面数高于面数预设
  // 属正常（UE 侧 Nanite 按预设收敛），这里刷告警只会误导。
  if (simplifyTarget && faceBudget && finalFaces.length > faceBudget) {
    warnings.push(`面数达到上限：${label} 输出 ${finalFaces.length} 面，仍高于上限 ${faceBudget} 面`);
  }
  item.cutTriangles = outcome.cutTriangles;
  item.degenerateUvTriangles = outcome.degenerateUvTriangles;
  item.facesBuilt = outcome.faces.length;
  item.cleanup = cleanup.stats;
  item.islandsOut = cleanup.stats.islandsBefore - cleanup.stats.islandsRemoved;
  item.facesOut = finalFaces.length;
  return { faces: finalFaces, generateMs, simplifyMs };
}

async function runJob(job, settings, mask, denseLoops, THREE, FBXLoader, FBXExporter, warnings) {
  const started = Date.now();
  // 分段计时：任务总时长（durationMs）已进报告，但"慢在哪一段"没法从总时长看出来。
  // 生成（trace/裁切 + 清理）、减面、导出三段分别计时，写进日志行与报告，
  // 下次出现"重新裁切很慢"时可以直接读日志定位，不必再复现。
  const timings = { readMs: 0, generateMs: 0, simplifyMs: 0, exportMs: 0 };
  let phaseMark = started;
  const entry = { input: job.input, output: job.output, ok: false, objects: [] };
  const warningStart = warnings.length;
  try {
    const buffer = await fs.readFile(job.input);
    const manager = new THREE.LoadingManager();
    const stub = { path: "", setPath(value) { this.path = value; return this; }, load(file) {
      const texture = new THREE.Texture();
      if (file && !/^(?:blob:|data:|https?:)/i.test(file)) {
        texture.userData.assethiveSourcePath = path.resolve(this.path || path.dirname(job.input), file);
      }
      return texture;
    } };
    manager.addHandler(/\.[a-z0-9]+(?:$|\?)/i, stub);
    globalThis.window = { URL: { createObjectURL: () => "blob:assethive-placeholder" } };
    const scene = new FBXLoader(manager).parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), path.dirname(job.input));
    const meshes = [];
    scene.traverse((object) => { if (object.isMesh) meshes.push(object); });
    if (!meshes.length) throw new Error(`FBX 中未找到网格：${job.input}`);
    // 读盘 + FBX 解析到此结束；后面的源网格建岛/trace/裁切/清理归入"生成"段。
    timings.readMs = Date.now() - started;
    phaseMark = Date.now();
    entry.bounds = boundsOf(scene, THREE);
    entry.faceBudget = settings.faceBudget;
    entry.contourPrecisionTexels = settings.contourPrecisionTexels;
    let remaining = 0;
    const materials = [...new Set(meshes.flatMap((mesh) => {
      const slots = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      return mesh.geometry.groups.length
        ? mesh.geometry.groups.filter((group) => group.count > 0).map((group) => slots[group.materialIndex]).filter(Boolean)
        : [slots[0]];
    }))];
    const materialCount = materials.length;
    const hasDeclaredOpacity = materials.some((material) => material?.alphaMap || material?.alphaTest > 0 || material?.transparent === true || material?.opacity < 1);
    const fallbackContext = makeCutMaskContext(mask, denseLoops, settings);
    const maskCache = new Map();
    for (const mesh of meshes) {
      const source = sourceTriangles(mesh);
      const item = { object: mesh.name, facesIn: source?.triangles.length || 0,
        vertsIn: mesh.geometry.getAttribute("position")?.count || 0, skipped: "" };
      if (mesh.isSkinnedMesh || !source) {
        item.skipped = mesh.isSkinnedMesh ? "skinned" : "no-uv";
        warnings.push(mesh.name + "：" + (mesh.isSkinnedMesh ? "检测到骨骼绑定" : "缺少 UV0") + "，跳过不透明裁切");
        item.facesOut = item.facesIn;
        item.vertsOut = item.vertsIn;
        entry.objects.push(item);
        remaining += item.facesOut;
        continue;
      }
      const partition = await partitionMeshForCut(mesh, source, fallbackContext, settings, materialCount, hasDeclaredOpacity, maskCache, warnings);
      item.materialParts = partition.report;
      item.preservedFaces = partition.preserved.length;
      const finalFaces = partition.preserved;
      const inputCutFaces = partition.parts.reduce((sum, part) => sum + part.triangles.length, 0);
      const traceCap = settings.traceMaxFaces > 0 ? settings.traceMaxFaces : settings.denseFaceLimit;
      for (const part of partition.parts) {
        const detail = part.detail;
        // 分区共享生成上限，不能每个材质都领取整份预算而把同一网格的内存峰值成倍放大。
        const partSettings = traceCap > 0
          ? { ...settings, traceMaxFaces: Math.max(part.triangles.length, Math.floor(traceCap * part.triangles.length / inputCutFaces)) }
          : settings;
        const result = await cutSourceFaces({ ...source, triangles: part.triangles }, partSettings,
          part.context.mask, part.context.denseLoops, detail, warnings, mesh.name + "/" + detail.name);
        for (const face of result.faces) finalFaces.push(face);
        timings.generateMs += result.generateMs;
        timings.simplifyMs += result.simplifyMs;
      }
      item.cutTriangles = partition.report.reduce((sum, part) => sum + (part.cutTriangles || 0), 0);
      item.degenerateUvTriangles = partition.report.reduce((sum, part) => sum + (part.degenerateUvTriangles || 0), 0);
      item.facesBuilt = item.preservedFaces + partition.report.reduce((sum, part) => sum + (part.facesBuilt || 0), 0);
      if (partition.parts.length === 1) {
        for (const name of ["trace", "layers", "cleanup", "islandsOut", "faceBudgetFloated", "simplifiedFrom"]) {
          if (partition.parts[0].detail[name] !== undefined) item[name] = partition.parts[0].detail[name];
        }
      }
      if (partition.parts.length) {
        mesh.geometry.dispose();
        // 实体部分绕过细分、删层、碎面清理与减面，只与裁切结果合并回原材质槽。
        mesh.geometry = geometryFromFaces(THREE, source, finalFaces);
      }
      item.facesOut = finalFaces.length;
      item.vertsOut = mesh.geometry.getAttribute("position")?.count || 0;
      entry.objects.push(item);
      remaining += item.facesOut;
    }
    if (!remaining) throw new Error("裁切后没有剩余几何体，已取消生成");
    scene.traverse((object) => {
      if (object.isMesh && object.geometry.getAttribute("position")?.count === 0) object.visible = false;
    });
    placeholderMaterials(scene, THREE);
    // Megascans/Zion source FBX uses Up=+Y / Front=+Z / Coord=+X.
    // The three.js default preset writes the opposite axis signs, so UE rotates
    // the cut mesh 180 degrees on import, which makes UV0 hit the far-side wind
    // cards and separates fronds from stems. Keep the axis declaration aligned.
    const bytes = new FBXExporter().parseSync(scene, { preset: "threejs",
      axisUp: "Y", axisForward: "-Z", embedTextures: false,
      includeAnimations: false, onlyVisible: true });
    // 几何层压缩：把导出器逐角展开的法线/UV 压回源资产同款形态
    // （法线 ByVertice/Direct、UV 去重+真索引，见 fbxCompactLayers）。
    // 压缩失败绝不让导出失败：任何异常都回退未压缩字节并记一条警告。
    let finalBytes = bytes;
    let compactStats = null;
    try {
      const compacted = compactFbxGeometryLayers(bytes);
      if (compacted.buffer.length < bytes.length) {
        finalBytes = compacted.buffer;
        compactStats = compacted.stats;
      }
    } catch (error) {
      warnings.push(`FBX 几何层压缩失败，已回退未压缩形式：${error?.message || error}`);
    }
    await fs.mkdir(path.dirname(job.output), { recursive: true });
    const stagedOutput = `${job.output}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(stagedOutput, finalBytes);
      await fs.rename(stagedOutput, job.output);
    } finally {
      await fs.rm(stagedOutput, { force: true }).catch(() => {});
    }
    entry.ok = true;
    entry.outputSize = finalBytes.byteLength;
    if (compactStats) {
      entry.fbxCompact = { sizeBefore: compactStats.sizeBefore, sizeAfter: compactStats.sizeAfter };
    }
    // 导出段 = 重建几何 + FBX 序列化 + 几何层压缩 + 落盘
    timings.exportMs = Date.now() - phaseMark;
    timings.totalMs = Date.now() - started;
    entry.timings = timings;
    log(`job ok ${path.basename(job.output)} faces=${remaining}${compactStats ? ` fbx=${(compactStats.sizeAfter / 1048576).toFixed(2)}MB` : ""}`
      + ` 耗时 读${timings.readMs}ms 生成${timings.generateMs}ms 减面${timings.simplifyMs}ms 导出${timings.exportMs}ms 合计${timings.totalMs}ms`);
  } catch (error) {
    entry.error = error?.message || String(error);
    log(`job failed ${path.basename(job.input)}: ${entry.error}`);
  }
  entry.warnings = warnings.slice(warningStart);
  entry.durationMs = Date.now() - started;
  return entry;
}

async function runPlan(plan) {
  const started = Date.now();
  const warnings = [];
  const settings = {
    threshold: Number(plan.threshold) || 0.5,
    // 遮罩尺寸上限：默认按 4K 原图解析，不主动降采样。
    //
    // 这里曾是 2048，会把 4K 遮罩缩小一半再二值化。蕨类等细碎叶缘在缩放后的
    // 抗锯齿灰阶上重新取阈值，会在原图没有边界的地方产生新的锯齿（实测 4K 下
    // 0.5 等值线约 62 万像素，缩到 2K 后等值线像素数比面积折算值多出 80%），
    // 裁切沿这些"假边缘"走，就会出现破面与不贴合的叶缘。
    // 按原图解析后同一变体的输出面数接近翻倍（仍在面数上限内），叶缘才贴合遮罩。
    // 该值仅作为内存保护上限：更大的遮罩（8K）仍会被限制到 4096。
    maskMaxSize: Number(plan.maskMaxSize) || 4096,
    contourPrecisionTexels: Number(plan.contourPrecisionTexels) > 0 ? Number(plan.contourPrecisionTexels) : 1,
    // 轮廓环最小面积（平方纹素）：低于该面积的轮廓环视为遮罩噪点，不参与裁切。
    //
    // 实测依据（Beech Fern 4096² 遮罩）：原图 5185 个轮廓环里有 3446 个点数 ≤16，
    // 都是叶缘抗锯齿/JPEG 噪点在阈值处形成的针孔。这些针孔若逐个切出来，叶面会被
    // 打成一堆小片 —— 这正是"破碎感"的主因，且网格越细（细分后）越明显。
    // 阈值 8 时连通片 854 个、≤8 面的碎块 684 个；提到 64 后降到 179 / 49，
    // 而丢弃面积仅占叶片本体 0.76%；再提到 256 收益有限（175 / 45）代价翻倍（1.50%）。
    // 因此 64 是"消噪点"与"保小特征"的平衡点。
    contourMinAreaTexels: Number(plan.contourMinAreaTexels) >= 0 ? Number(plan.contourMinAreaTexels) : 64,
    maskErodeTexels: Math.max(0, Number(plan.maskErodeTexels) || 0),
    // 孔洞填充（缺省关）：把白色区域内含的黑色孔洞填成白色，追踪出的边界只剩外轮廓
    // （见 fillMaskHoles）。默认关闭：填孔会改变遮罩轮廓，是否该填取决于资产 ——
    // 有些白区内部本来就该镂空，因此改为显式开启，未下发时按关闭处理。
    fillHoles: plan.fillHoles === true,
    // 只填面积不超过该值（平方纹素）的孔洞；0 = 不限（全部填充）。
    holeMaxAreaTexels: Math.max(0, Number(plan.holeMaxAreaTexels) || 0),
    faceBudget: Math.max(0, Number(plan.faceBudget) || 0),
    // 自动档的浮动区间（plantOpaqueBudget 的档位表）：上限 > 0 时开启
    // "生成后按复杂度浮动"（见 runJob 内的实现与 OPAQUE_REDUCTION_RATIO）。
    faceBudgetFloor: Math.max(0, Number(plan.faceBudgetFloor) || 0),
    faceBudgetCeiling: Math.max(0, Number(plan.faceBudgetCeiling) || 0),
    cleanupPercent: Number(plan.cleanupPercent) > 0 ? Number(plan.cleanupPercent) : 0,
    // 细分目标：源三角形 UV 边长细到多少纹素以内（0 = 不细分）。
    // 细分的目的只是让边界切得准，多出来的面数交给下面的减面收回。
    subdivideTexels: Number(plan.subdivideTexels) > 0 ? Number(plan.subdivideTexels) : 0,
    // 减面目标面数：裁切后把面数收敛到该值（0 = 不减面）。
    // 与 faceBudget 的区别：faceBudget 是"不得超过"的上限，只在超出时才放宽精度；
    // simplifyTarget 是"做到这么多面"的目标，用来把细分带来的膨胀收回去。
    simplifyTarget: Number(plan.simplifyTarget) > 0 ? Number(plan.simplifyTarget) : 0,
    // Trace 路线：面片间距（纹素）。> 0 时改用"按遮罩直接生成面片"，
    // 边界精度由此值决定，与源网格密度无关（裁切路线的精度受源三角形尺寸限制）。
    // 0 = 关闭，走原来的裁切路线。
    traceStepTexels: Number(plan.traceStepTexels) > 0 ? Number(plan.traceStepTexels) : 0,
    // Trace 面片数保护上限（0 = 不限制）。正常由 traceStepTexels 决定面片数，
    // 这一项只防止个别资产因 UV 畸变导致面片数失控。
    traceMaxFaces: Number(plan.traceMaxFaces) > 0 ? Number(plan.traceMaxFaces) : 0,
    // 单层化空间桶边长（0 = 按模型尺度自动取 span/2500）。见 foliageOpaqueLayers。
    layerBucketSize: Number(plan.layerBucketSize) > 0 ? Number(plan.layerBucketSize) : 0,
    // 生成阶段面片数上限（0 = 不限制）。内存峰值与生成面片数近似线性
    // （实测约 1.1KB/面片：207 万面片 2.4GB 堆、780 万面片 9.2GB 堆），
    // 超过这个上限就没有必要再往下细分了。
    denseFaceLimit: Number(plan.denseFaceLimit) > 0 ? Number(plan.denseFaceLimit) : 0
  };
  const report = { ok: false, mask: plan.mask, maskChannel: plan.maskChannel || "auto", threshold: settings.threshold,
    contourPrecisionTexels: settings.contourPrecisionTexels, maskErodeTexels: settings.maskErodeTexels,
    fillHoles: settings.fillHoles, holeMaxAreaTexels: settings.holeMaxAreaTexels,
    cleanupPercent: settings.cleanupPercent,
    jobs: [], warnings };
  const mask = await loadMask(plan.mask, report.maskChannel, settings.maskMaxSize, warnings);
  report.resolvedMaskChannel = mask.resolvedChannel;
  const maskLoadedAt = Date.now();
  // 先填孔洞、后内缩：内缩作用在已经干净的外轮廓上，两者互不干扰。
  if (settings.fillHoles) {
    const holes = fillMaskHoles(mask.values, mask.width, mask.height, settings.threshold, settings.holeMaxAreaTexels);
    report.holes = holes.holes;
    report.holesFilled = holes.holesFilled;
    report.holesSkipped = holes.holesSkipped;
    report.holeTexelsFilled = holes.texelsFilled;
    if (holes.holes > 0) {
      log(`mask holes=${holes.holes} filled=${holes.holesFilled} skipped=${holes.holesSkipped} texels=${holes.texelsFilled}`);
    }
  }
  const holesFilledAt = Date.now();
  mask.values = erodeMask(mask.values, mask.width, mask.height, settings.maskErodeTexels);
  const denseLoops = traceContours(mask.values, mask.width, mask.height, settings.threshold);
  report.contourLoops = denseLoops.length;
  report.contourPoints = denseLoops.reduce((total, loop) => total + loop.length, 0);
  log(`contours=${report.contourLoops} points=${report.contourPoints}`);
  const [THREE, { FBXLoader }, { FBXExporter }] = await Promise.all([
    import("three"), import("three/examples/jsm/loaders/FBXLoader.js"), import("@comfyorg/fbx-exporter-three")
  ]);
  // 准备阶段计时：这一段是"重新裁切"点下去之后到第一个任务开始之间的静默期，
  // 遮罩解码/填孔/轮廓追踪/模块加载都可能在这里吃掉几十秒（大遮罩或首次冷加载）。
  report.timings = {
    maskMs: maskLoadedAt - started,
    holesMs: holesFilledAt - maskLoadedAt,
    contoursMs: Date.now() - holesFilledAt,
    prepareMs: Date.now() - started
  };
  log(`准备完成 mask=${report.timings.maskMs}ms 孔洞=${report.timings.holesMs}ms 轮廓/模块=${report.timings.contoursMs}ms 合计=${report.timings.prepareMs}ms`);
  for (const job of plan.jobs || []) {
    const entry = await runJob(job, settings, mask, denseLoops, THREE, FBXLoader, FBXExporter, warnings);
    report.jobs.push(entry);
    // 逐任务上报进度：主进程把它映射成入库进度环与任务栏进度。
    // 裁切是入库里最长的阶段（实测 12 变体约 6 分钟），期间完全静默会让界面
    // 看起来"已经处理完"，关闭应用时却提示"还有资产在导入"。
    parentPort?.postMessage({
      type: "progress",
      done: report.jobs.length,
      total: (plan.jobs || []).length,
      output: String(job.output || ""),
      ok: entry.ok === true
    });
  }
  report.ok = report.jobs.some((job) => job.ok);
  report.jobCount = report.jobs.length;
  report.succeededCount = report.jobs.filter((job) => job.ok).length;
  report.durationMs = Date.now() - started;
  return report;
}

if (!isMainThread) {
  fs.readFile(workerData.planPath, "utf8").then(JSON.parse).then(runPlan)
    .then((report) => fs.writeFile(workerData.reportPath, JSON.stringify(report), "utf8"))
    .then(() => parentPort.postMessage({ type: "done" }))
    .catch(async (error) => {
      const message = error?.message || String(error);
      await fs.writeFile(workerData.reportPath, JSON.stringify({ ok: false, error: message, jobs: [], warnings: [] }), "utf8").catch(() => {});
      parentPort.postMessage({ type: "error", message });
    });
}

module.exports = { loadMask, erodeMask, fillMaskHoles, sourceTriangles, cutMeshTriangles, cleanupFaces, runPlan,
  subdivideTriangles, subdivideSourceToScale, weldFaces, simplifyFaces, transferCornerAttributes };
