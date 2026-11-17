"use strict";

// 不透明裁切 —— Trace 路线。按 Houdini HDA `sop_XJP.TA.GrassMaskedToOpaque` 的链路实现。
//
// 从 .hdalc 还原出的主链路（节点名与参数均为 HDA 原值）：
//
//   trace1  thresh=0.5  channel=red  overridesize=off  doresample=on  step=3
//           dosmooth=on  corner=1  convpoly=on  lod=1  hole=off  boundary=black
//     → group1 (grouptype=edge, unshared=on)           ← 描出遮罩前景的边界边
//     → edge_group_to_polylines1                        ← 边界边串成折线
//     → triangulate2d1 (useconstredges=on)              ← 用边界折线约束，把内部填成实心面片
//     → delete_small_parts1/2 (threshold 0.001/0.005)   ← 剔除碎块
//   boolean1 (subtract, aminusb, asurface=burface=solid, resolve=on, collapsetinyedges=on)
//     ← 源网格与实心面片求交：把源网格按遮罩轮廓裁开，边界由 boolean 精确求交得到
//   subdivide1 (algorithm=houdini, iterations=3)        ← 源网格细分，提高采样密度
//   ray1 (method=project, dirmethod=vector, dir=(0,-1,0), dotrans=on)
//     → attribtransfer1 / attribwrangle2                ← 把源网格 UV / 颜色 / 法线回填到新面
//   clean1 (fusepts=on, fusedist=0.001, deldegengeo=on, fixoverlap=on, delete_small=on, prim_count=3)
//     → normal1 → smooth1 → polyreduce1 (target=pt_percent)
//
// 本模块对应"遮罩 → 面片 → 投回源网格表面"，即 trace → group → triangulate2d → boolean → subdivide。
//
// 实现路线：逐源三角形在 UV 空间栅格化。
//
//   1) 先按采样密度自适应细分源三角形（对应 subdivide1）：只把 UV 边超过格距的三角形再分，
//      红绿细分保证相邻三角形公共边的切割点一致，因此不会出现裂缝。
//      源网格 UV 密度差异极大（UV 边长 p10=6、p50=124、max=271 纹素），
//      统一细分级别要么不够要么把面数放大几十倍，所以必须逐三角形按需细分。
//
//   2) 每个细分后的子三角形按"格心"判定：格心在遮罩前景内就输出这个子三角形。
//      顶点全部来自源三角形的重心插值 —— 必然落在源网格表面上，
//      对应 HDA 里 boolean1 精确求交 + ray1 投回表面两步的效果。
//
//   3) 相邻三角形共用同一个中点对象（按 UV 端点对缓存），
//      所以细分后的网格是连续的，不会出现 T 型接缝。
//
// 为什么不用"全局 UV 栅格 + 逐格点投影"（前一版的做法）：
//   遮罩是整张图集共用的，UV 岛在图上交错排布，相邻两个格点可能落在不同的 UV 岛上，
//   实测出现 37.3 单位的相邻格点间距（模型尺寸 50），引擎里就是一片横跨植株的破面。
//   逐三角形栅格化把"岛边界"变成三角形自身的边界，结构上不可能跨岛。
//   同时，前一版要求"四角与格心同三角形"，在粗网格下会把大量格子整格丢掉 ——
//   实测覆盖率只有 35~41%；逐三角形栅格化的覆盖率由细分精度决定，不受此限制。

const EPSILON = 1e-9;

function cornerUvKey(corner) {
  return `${corner.uv[0].toFixed(9)},${corner.uv[1].toFixed(9)}`;
}

// 中点缓存键 = UV + 位置。
//
// 为什么不能只用 UV：Megascans 植被网格是"同一个叶片实例复制多份"，
// 实测该资产 1,012 个唯一 UV 里 99.5% 对应多个 3D 位置（最多 30 份实例，散布可达 55 单位）。
// 只用 UV 做键时，A 实例的边会和 B 实例的同 UV 边共用中点，
// 生成的面片会跨越两个实例（实测出现 50.8 单位的边，模型尺寸才 50）。
// 位置取到 1e-3 精度：同一条边的两端点各算一次中点，结果一致；
// 不同实例的同 UV 边位置相差远大于 1e-3，不会碰撞。
function cornerKey(corner) {
  // 重合位置/UV0 仍可能属于不同风单元或法线接缝，中点只能在属性也一致时共用。
  const attributes = Object.keys(corner).filter((name) => name !== "position" && name !== "uv").sort()
    .map((name) => `${name}:${corner[name].map((value) => Math.round(value * (/^uv\d+$/.test(name) ? 1e5 : 1e3))).join(",")}`)
    .join(";");
  return `${cornerUvKey(corner)}@${corner.position.map((value) => Math.round(value * 1e3)).join(",")}|${attributes}`;
}

function edgeKey(a, b) {
  const ka = cornerKey(a), kb = cornerKey(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

// 边的最长 UV 分量（与遮罩纹素对齐，便于用"纹素/边"表达密度）。
function uvEdgeLength(a, b) {
  return Math.max(Math.abs(a.uv[0] - b.uv[0]), Math.abs(a.uv[1] - b.uv[1]));
}

// 角点线性插值。法线插值后归一化，避免出现零长度法线。
function midpointCorner(a, b, attributeNames) {
  const out = {};
  for (const name of attributeNames) {
    const left = a[name], right = b[name];
    if (!Array.isArray(left) || !Array.isArray(right)) continue;
    out[name] = left.map((value, index) => (value + (right[index] ?? value)) / 2);
  }
  if (Array.isArray(out.normal)) {
    const length = Math.hypot(out.normal[0], out.normal[1], out.normal[2]);
    if (length > 1e-9) out.normal = out.normal.map((value) => value / length);
  }
  return out;
}

// 按 UV 边长自适应细分：把超标边切成两半，直到所有边 ≤ maxUvEdge 或达到 maxLevels。
//
// 切分方式必须保证 UV 面积守恒 —— 这是本模块踩过的坑：
// 只有两条边超标时，若只切其中一条并丢掉"另一条也要切"的信息，下一轮会按错误的方式再分，
// 实测 UV 面积从 0.770 掉到 0.453（丢 41% 的几何）。所以每轮只按"最长边二分"处理：
//
//   最长边二分（长边切一刀，连到对角顶点）把三角形分成 2 个，面积严格守恒；
//   切完后最长边必然严格变短，因此一定收敛。
//   三条边都超标时改用四分（1→4，面积同样守恒），省轮次。
//
// minSplits：每个三角形至少切这么多刀。低模（如 LOD 简化后的 320 面网格）UV 边长本身
// 就不超标，只按 UV 边长判定会导致输出面数严重不足（实测 320 面源只出 2,571 面，
// 轮廓重合度掉到 85.2%）—— 因为轮廓精度需要的是"面片数量"，而不是"UV 边长够短"。
// 强制给每个源三角形至少 2 刀（4 个三角形）保证低模也有足够的轮廓分辨率。
//
// 收敛速度限制：面积守恒的约束是"每次二分都必须让最长边严格变短"，单靠它
// 只能把网格放大到约 500 倍就停了 —— 实测 step 从 4 一路降到 1，生成面数都卡在
// 300 万、3D 边中位数都停在 0.048~0.051，完全降不下去。
// 想要更细的密度必须补一层"不改形状的加密"（见 densify），对应 HDA 的 subdivide1。
//
// 相邻三角形共用中点缓存，因此同一段 UV 边无论被哪个三角形处理，
// 切出的中间点都是同一个角点对象，两侧网格在公共边上逐点对齐，不会出现 T 型接缝。
function subdivideForUv(triangles, attributeNames, options = {}) {
  const maxUvEdge = Number(options.maxUvEdge);
  if (!(maxUvEdge > 0) || !triangles.length) return triangles;
  const maxLevels = Math.max(1, Math.floor(Number(options.maxLevels) || 10));
  const minSplits = Math.max(0, Math.floor(Number(options.minSplits) || 0));
  const maxTriangles = Math.max(0, Math.floor(Number(options.maxTriangles) || 0));
  const midpointCache = new Map();

  const split = (a, b) => {
    const key = edgeKey(a, b);
    let value = midpointCache.get(key);
    if (value === undefined) {
      value = midpointCorner(a, b, attributeNames);
      midpointCache.set(key, value);
    }
    return value;
  };

  const accepted = [];
  let queue = [];
  for (const triangle of triangles) queue.push({ corners: triangle.corners, material: triangle.material, level: 0, splits: 0 });
  let total = queue.length;
  for (let pass = 0; pass < maxLevels; pass += 1) {
    // 每轮只处理"还没达标"的三角形，达标即出队进入 accepted；
    // 这里必须每轮清空，否则同一个三角形会在后续每轮被重复收进 accepted。
    const next = [];
    for (const triangle of queue) {
      const [a, b, c] = triangle.corners;
      const ab = uvEdgeLength(a, b);
      const bc = uvEdgeLength(b, c);
      const ca = uvEdgeLength(c, a);
      const oversized = ab > maxUvEdge || bc > maxUvEdge || ca > maxUvEdge;
      const tooFewSplits = triangle.splits < minSplits;
      if (!oversized && !tooFewSplits) { accepted.push(triangle); continue; }
      const level = triangle.level + 1;
      if (level >= maxLevels) { accepted.push(triangle); continue; }
      // 面数预算：低模的强制细分必须能在预算耗尽后停下来
      if (maxTriangles && total >= maxTriangles) { accepted.push(triangle); continue; }
      const material = triangle.material;
      const splits = triangle.splits + 1;

      // 四分：三条边都超标时最省轮次（面数 4x，面积守恒）
      if (ab > maxUvEdge && bc > maxUvEdge && ca > maxUvEdge) {
        const mab = split(a, b), mbc = split(b, c), mca = split(c, a);
        next.push({ corners: [a, mab, mca], material, level, splits });
        next.push({ corners: [mab, b, mbc], material, level, splits });
        next.push({ corners: [mca, mbc, c], material, level, splits });
        next.push({ corners: [mab, mbc, mca], material, level, splits });
        total += 3;
        continue;
      }

      // 最长边二分
      const longest = ab >= bc && ab >= ca ? 0 : (bc >= ca ? 1 : 2);
      if (longest === 0) {
        const m = split(a, b);
        next.push({ corners: [a, m, c], material, level, splits });
        next.push({ corners: [m, b, c], material, level, splits });
      } else if (longest === 1) {
        const m = split(b, c);
        next.push({ corners: [b, m, a], material, level, splits });
        next.push({ corners: [m, c, a], material, level, splits });
      } else {
        const m = split(c, a);
        next.push({ corners: [c, m, b], material, level, splits });
        next.push({ corners: [m, a, b], material, level, splits });
      }
      total += 1;
    }
    queue = next;
    if (!queue.length) break;
  }
  for (const triangle of queue) accepted.push(triangle);
  return accepted;
}

// 均匀四分加密：每个三角形按边中点拆成 4 个，面数精确 ×4，形状与 UV 面积严格不变。
//
// 这是 HDA `subdivide1 (iterations=3)` 的等价物，也是唯一能把采样密度继续推上去的手段：
// subdivideForUv 受"面积守恒 + 最长边必须变短"约束，最多放大到约 500 倍就收敛了
// （实测 step=1 时 3D 边中位仍是 0.049，与 step=4 相同）。
//
// 因为不改变表面形状，加密只会让遮罩采样更细、等值线裁剪的边界更准，
// 不会引入新的几何误差；多余的面数交给下游减面收敛。
//
// 提前停止：每级之后调 shouldStop(list)，返回 true 就不再加密。
// 用"UV 边是否已经小于一个格"作为判据，避免对已经够密的资产做无意义的 4× 膨胀。
// 中点同样按"UV+位置"缓存并两侧共用，所以加密后相邻三角形仍然严丝合缝。
function densify(triangles, attributeNames, options = {}) {
  const maxLevels = Math.max(0, Math.floor(Number(options.maxLevels) || 0));
  if (!maxLevels || !triangles.length) return { triangles, levels: 0 };
  const maxTriangles = Math.max(0, Math.floor(Number(options.maxTriangles) || 0));
  const shouldStop = typeof options.shouldStop === "function" ? options.shouldStop : null;
  const midpointCache = new Map();
  const split = (a, b) => {
    const key = edgeKey(a, b);
    let value = midpointCache.get(key);
    if (value === undefined) {
      value = midpointCorner(a, b, attributeNames);
      midpointCache.set(key, value);
    }
    return value;
  };
  let list = triangles;
  let levels = 0;
  for (let level = 0; level < maxLevels; level += 1) {
    if (shouldStop && shouldStop(list)) break;
    if (maxTriangles && list.length * 4 > maxTriangles) break;
    const next = [];
    for (const triangle of list) {
      const [a, b, c] = triangle.corners;
      const ab = split(a, b), bc = split(b, c), ca = split(c, a);
      const material = triangle.material;
      next.push({ corners: [a, ab, ca], material });
      next.push({ corners: [ab, b, bc], material });
      next.push({ corners: [ca, bc, c], material });
      next.push({ corners: [ab, bc, ca], material });
    }
    list = next;
    levels += 1;
  }
  return { triangles: list, levels };
}

// 抽样估计最长 UV 边（全量统计在千万面级别太慢，等距抽样足够判断"还要不要继续加密"）。
function sampleMaxUvEdge(triangles, maxSamples = 20000) {
  if (!triangles.length) return 0;
  const stride = Math.max(1, Math.floor(triangles.length / maxSamples));
  let worst = 0;
  for (let i = 0; i < triangles.length; i += stride) {
    const [a, b, c] = triangles[i].corners;
    const ab = uvEdgeLength(a, b), bc = uvEdgeLength(b, c), ca = uvEdgeLength(c, a);
    const m = ab > bc ? (ab > ca ? ab : ca) : (bc > ca ? bc : ca);
    if (m > worst) worst = m;
  }
  return worst;
}

// 按重心坐标插值三个角点的全部属性。法线插值后归一化，避免出现零长度法线。
// 重心坐标在 UV 上是仿射的，因此三角形顶点 → 等值线交点 → 3D 位置可以全程线性插值，
// 无需再按 UV 反查三角形（反查会在 UV 重叠的资产上查到另一个实例，直接导致跨岛破面）。
function interpolateCorner(corners, weights, attributeNames) {
  const result = {};
  for (const name of attributeNames) {
    const source = corners[0][name];
    const size = Array.isArray(source) ? source.length : 0;
    if (!size) continue;
    const values = new Array(size).fill(0);
    for (let i = 0; i < 3; i += 1) {
      const cornerValue = corners[i][name];
      if (!Array.isArray(cornerValue)) continue;
      for (let c = 0; c < size; c += 1) values[c] += (cornerValue[c] || 0) * weights[i];
    }
    result[name] = values;
  }
  if (Array.isArray(result.normal)) {
    const length = Math.hypot(result.normal[0], result.normal[1], result.normal[2]);
    if (length > 1e-9) result.normal = result.normal.map((value) => value / length);
  }
  return result;
}

// 输出一个多边形面片。环绕方向必须与父三角形一致：
// 方向反了在引擎里就是背面。
function pushPolygon(faces, polygon, parentSign, material) {
  let signed = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i].uv, b = polygon[(i + 1) % polygon.length].uv;
    signed += a[0] * b[1] - b[0] * a[1];
  }
  if (Math.sign(signed || 1) !== parentSign) polygon = polygon.slice().reverse();
  // 扇形三角化。格子内的多边形最多 5 个顶点，扇形足够且不会自交。
  for (let i = 1; i + 1 < polygon.length; i += 1) {
    faces.push({ corners: [polygon[0], polygon[i], polygon[i + 1]], material });
  }
}

// 遮罩采样（对应 attribfrommap1 的 dosmooth=on / filter=gauss）。
// values 的 [0] 是左下角（loadMask 已做过垂直翻转），v 向上。
function buildMaskSampler(mask) {
  const width = mask?.width | 0;
  const height = mask?.height | 0;
  const values = mask?.values;
  const texelSize = Number(mask?.texelSize) > 0 ? Number(mask.texelSize) : 1 / Math.max(width, height);
  if (!width || !height || !values) return null;
  return {
    width, height, texelSize,
    at(u, v) {
      if (!(u >= 0) || !(v >= 0) || u > 1 || v > 1) return 0;
      const x = u / texelSize - 0.5;
      const y = v / texelSize - 0.5;
      const x0 = Math.floor(x), y0 = Math.floor(y);
      const fx = x - x0, fy = y - y0;
      const at2 = (ix, iy) => values[Math.min(height - 1, Math.max(0, iy)) * width + Math.min(width - 1, Math.max(0, ix))];
      const bottom = at2(x0, y0) * (1 - fx) + at2(x0 + 1, y0) * fx;
      const top = at2(x0, y0 + 1) * (1 - fx) + at2(x0 + 1, y0 + 1) * fx;
      return bottom * (1 - fy) + top * fy;
    },
  };
}

// 两点之间二分求 threshold 等值线交点（对应 trace 的 doresample / dosmooth）。
function refineToIsoline(sample, a, b, threshold, iterations = 10) {
  const insideA = sample(a[0], a[1]) >= threshold;
  let low = 0, high = 1;
  for (let i = 0; i < iterations; i += 1) {
    const mid = (low + high) / 2;
    const u = a[0] + (b[0] - a[0]) * mid;
    const v = a[1] + (b[1] - a[1]) * mid;
    if ((sample(u, v) >= threshold) === insideA) low = mid; else high = mid;
  }
  const t = (low + high) / 2;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

// 按遮罩生成贴合源网格表面的面片。
//
//   stepTexels    采样密度（纹素/边），对应 trace 的 step。源遮罩 4096² 时：
//                 step=16 → 每条 UV 边最长 16 纹素，一个源三角形被分成约 60~70 份。
//   threshold     前景阈值（trace 的 thresh，HDA 为 0.5）
//   maxFaces      面片上限，超过后停止细分并保留当前结果（防止个别资产面数失控）
//
// 返回 faces 的角点带源网格的 position/normal/color/uv1 等属性，uv 用源网格自身的 UV
// （逐三角形栅格化时 UV 与位置同源，无需像全局栅格那样另写 UV）。
//
// maxFaces 是**生成上限**，直接决定内存峰值：实测每个面片约占 1.1KB
// （beech fern：207 万面片 → 堆 2.4GB，780 万面片 → 堆 9.2GB）。
// 调用方（worker）会给一个能兜住 worker 堆的值；撞上限时会返回告警，
// 表示采样密度没有完全展开，而不是静默降级。
function traceMeshFromMask(source, mask, options = {}) {
  const warnings = [];
  const sampler = buildMaskSampler(mask);
  if (!sampler) return { faces: [], warnings: ["遮罩无效"], stats: {} };
  const threshold = Number.isFinite(Number(options.threshold)) ? Number(options.threshold) : 0.5;
  const stepTexels = Math.max(1, Number(options.stepTexels) || 16);
  const attributeNames = Array.isArray(source?.attributeNames) ? source.attributeNames : [];
  const triangles = Array.isArray(source?.triangles) ? source.triangles : [];
  if (!attributeNames.length || !triangles.length) return { faces: [], warnings: ["源网格不可用"], stats: {} };

  const maxUvEdge = stepTexels * sampler.texelSize;
  const maxLevels = Math.max(1, Math.floor(Number(options.subdivideMaxLevels) || 10));
  const maxFaces = Math.max(0, Math.floor(Number(options.maxFaces) || 0));
  // 生成上限同时约束细分中间量：中间三角形数约为最终面片数的 1.2~1.3 倍。
  // 不设上限时用 1200 万（内存约 13GB，只有显式放开才会走到）。
  const triangleBudget = maxFaces > 0 ? Math.floor(maxFaces * 1.3) : 12000000;

  // 1) 自适应细分（对应 subdivide1）
  //
  // minSplits 默认 0：只按 UV 边长判定。实测给低模资产强制追加细分并不会提升轮廓精度
  // —— 面片顶点只能落在源三角形的边和顶点上，源网格本身没有的细节补不出来
  // （320 面的低模即使强行细分到 6,095 面，轮廓重合度仍停在 85%）。
  // 因此低模的轮廓上限由源网格决定，不在这里硬凑面数。
  // maxTriangles 必须给足：它同时是 subdivideForUv 和 densify 的停止条件，
  // 给太小会让 step 再小也提不上去（历史上默认 300 万，直接导致 step≤4 全部撞顶）；
  // 给太大则会 OOM（780 万面片时堆峰值 9.2GB）。所以由调用方的 maxFaces 决定。
  const denseBase = subdivideForUv(triangles, attributeNames, {
    maxUvEdge,
    maxLevels,
    minSplits: Number.isFinite(options.minSplits) ? Math.max(0, Math.floor(options.minSplits)) : 0,
    maxTriangles: triangleBudget,
  });
  // 1b) 均匀加密到 UV 边小于一个格（对应 subdivide1）：
  // subdivideForUv 收敛后三角形仍可能远大于一个格，这一步把采样密度补足，
  // 让遮罩采样真正达到 stepTexels 的精度。不改变形状，只增加采样点；
  // 多余面数由下游减面收回。已经够密的资产会在第一轮检查后直接跳过。
  const densifyResult = densify(denseBase, attributeNames, {
    maxLevels: Number.isFinite(options.densifyMaxLevels) ? Math.max(0, Math.floor(options.densifyMaxLevels)) : 8,
    maxTriangles: triangleBudget,
    shouldStop: (list) => sampleMaxUvEdge(list) <= maxUvEdge,
  });
  const dense = densifyResult.triangles;

  // 2) 逐三角形做等值线裁剪（对应 trace1 的描边 + triangulate2d1 的"轮廓内填实"）
  //
  // 为什么是"每个三角形内部"而不是"全图 UV 栅格 + marching squares"：
  // 该资产的 UV 布局重叠 12~30 倍，同一片 UV 区域对应植株上十几个不同部位。
  // 全图栅格会把相邻但属于**不同 3D 部位**的格子连成一个面片 —— 实测最大边长 29.6
  // （模型尺寸 50）、轮廓多出 3 万像素。放在源三角形内部就天然是子集，不可能跨岛。
  //
  // 为什么不用"格心在遮罩内就整格保留"（上一版）：那是二值判定，边界沿格子走台阶。
  // 这里改为在每个子三角形内求 0.5 等值线并裁剪：边界就是等值线本身，没有台阶。
  // 这也是 HDA 里 triangulate2d1「用边界折线约束、把内部填成实心」的等价做法。
  //
  // 细分（subdivide1）在这里的作用是保证三角形足够小，遮罩在三角形内部的变化
  // 能被线性插值抓住（否则三角形内部的孔洞/缺口会被整个漏掉）。
  const faces = [];
  const uvArea = maxUvEdge * maxUvEdge;
  // 遮罩采样（对应 attribfrommap1 的 dosmooth=on / filter=gauss 双线性采样）
  const near = (u, v) => sampler.at(u, v);
  let kept = 0, droppedNoMask = 0, droppedDegenerate = 0, crossingCount = 0, splitTriangles = 0;

  const corners3 = [null, null, null];
  // 按重心坐标取表面角点。重心坐标在 UV 上是仿射的，因此
  // 三角形顶点 → 等值线交点 → 3D 位置 全程线性插值，落点严格在源三角形平面上。
  const cornerAtWeights = (w) => {
    const result = interpolateCorner(corners3, w, attributeNames);
    result.uv = [
      w[0] * corners3[0].uv[0] + w[1] * corners3[1].uv[0] + w[2] * corners3[2].uv[0],
      w[0] * corners3[0].uv[1] + w[1] * corners3[1].uv[1] + w[2] * corners3[2].uv[1],
    ];
    return result;
  };
  // 三条边与 0.5 等值线的交点。w 是三点式重心坐标（可能带浮点负值，夹到非负后归一化）。
  const cutPoint = (w) => {
    crossingCount += 1;
    const clamped = [w[0] > 0 ? w[0] : 0, w[1] > 0 ? w[1] : 0, w[2] > 0 ? w[2] : 0];
    const sum = clamped[0] + clamped[1] + clamped[2];
    return cornerAtWeights(sum > EPSILON ? [clamped[0] / sum, clamped[1] / sum, clamped[2] / sum] : [1 / 3, 1 / 3, 1 / 3]);
  };

  for (const triangle of dense) {
    const [ca, cb, cc] = triangle.corners;
    const material = triangle.material || 0;
    corners3[0] = ca; corners3[1] = cb; corners3[2] = cc;
    // 父三角形在 UV 上的环绕方向：输出多边形必须与它一致，否则引擎里就是背面
    const parentSign = Math.sign((cb.uv[0] - ca.uv[0]) * (cc.uv[1] - ca.uv[1]) - (cc.uv[0] - ca.uv[0]) * (cb.uv[1] - ca.uv[1])) || 1;

    // 三个顶点的遮罩值（对应 attribfrommap1 按 UV 采样 + trace 的 thresh）
    const va = near(ca.uv[0], ca.uv[1]);
    const vb = near(cb.uv[0], cb.uv[1]);
    const vc = near(cc.uv[0], cc.uv[1]);
    const inA = va >= threshold, inB = vb >= threshold, inC = vc >= threshold;

    // 全在前景：整个子三角形保留（等价 triangulate2d1 填充的"内部"）
    if (inA && inB && inC) {
      pushPolygon(faces, [ca, cb, cc], parentSign, material);
      kept += 1;
      if (maxFaces && faces.length >= maxFaces) break;
      continue;
    }
    // 全在背景：丢弃
    if (!inA && !inB && !inC) { droppedNoMask += 1; continue; }

    // 混合：前景顶点 1 或 2 个，等值线恰好把三角形切成"三角形"或"四边形"。
    // 按 A→B→C 的环绕取出前景顶点，再依次插入 BC / CA / AB 边上的交点，
    // 得到的序列天然保持父三角形的环绕方向。
    splitTriangles += 1;
    const poly = [];
    const vertexOf = [ca, cb, cc];
    const inFlags = [inA, inB, inC];
    const valueOf = [va, vb, vc];
    const putCut = (i, j) => {
      const t = (threshold - valueOf[i]) / (valueOf[j] - valueOf[i]);
      const w = [0, 0, 0];
      w[i] = 1 - t; w[j] = t;
      poly.push(cutPoint(w));
    };
    for (let i = 0; i < 3; i += 1) {
      if (inFlags[i]) poly.push(vertexOf[i]);
      const j = (i + 1) % 3;
      if (inFlags[i] !== inFlags[j]) putCut(i, j);
    }
    if (poly.length < 3) { droppedDegenerate += 1; continue; }
    pushPolygon(faces, poly, parentSign, material);
    kept += 1;
    if (maxFaces && faces.length >= maxFaces) {
      warnings.push(`面片数达到上限 ${maxFaces}，采样密度未完全展开`);
      break;
    }
  }

  const stats = {
    stepTexels,
    maxUvEdgeTexels: maxUvEdge / sampler.texelSize,
    // 是否撞到生成上限（撞上说明采样密度没完全展开，边界会比 stepTexels 更粗）
    cappedByFaceLimit: maxFaces > 0 && faces.length >= maxFaces,
    faceLimit: maxFaces,
    sourceTriangles: triangles.length,
    // 细分（subdivideForUv）→ 加密（densify）→ 最终参与裁剪的三角形数
    subdivideTriangles: denseBase.length,
    densifyLevels: densifyResult.levels,
    denseTriangles: dense.length,
    subdivideRatio: triangles.length ? dense.length / triangles.length : 0,
    // 加密后仍超过一个格的最长 UV 边（纹素）：这个值才真正代表采样密度是否达标
    denseMaxUvEdgeTexels: sampleMaxUvEdge(dense) / sampler.texelSize,
    faces: faces.length,
    cellsKept: kept,
    droppedNoMask,
    droppedDegenerate,
    // 等值线交点数 / 被等值线切开的三角形数：用于判断细分密度是否够
    crossingCount,
    splitTriangles,
    // 面片数量 × 单格面积 ≈ 有效 UV 面积（含重叠 UV 的重复计入，仅作量级参考）
    coverageTexels: faces.length * uvArea / (sampler.texelSize * sampler.texelSize),
    triangles: triangles.length,
    maskSize: Math.max(sampler.width, sampler.height),
  };
  return { faces, warnings, stats };
}

// 保留旧接口名：外部（诊断脚本）曾用 buildUvIndex / projectUvToSurface 做 UV 覆盖统计，
// 现在主流程不再依赖它们，但保留一个最小实现供统计使用。
function buildUvIndex(source, options = {}) {
  const triangles = Array.isArray(source?.triangles) ? source.triangles : [];
  const maxCellsPerAxis = Math.max(16, Number(options.maxCellsPerAxis) || 512);
  const boxes = [];
  let gMinU = Infinity, gMaxU = -Infinity, gMinV = Infinity, gMaxV = -Infinity, spanSum = 0;
  for (let index = 0; index < triangles.length; index += 1) {
    const corners = triangles[index]?.corners;
    if (!corners || corners.length !== 3) continue;
    const uvs = corners.map((corner) => corner.uv);
    if (uvs.some((uv) => !uv || !Number.isFinite(uv[0]) || !Number.isFinite(uv[1]))) continue;
    let minU = uvs[0][0], maxU = uvs[0][0], minV = uvs[0][1], maxV = uvs[0][1];
    for (const uv of uvs) {
      if (uv[0] < minU) minU = uv[0]; if (uv[0] > maxU) maxU = uv[0];
      if (uv[1] < minV) minV = uv[1]; if (uv[1] > maxV) maxV = uv[1];
    }
    if (maxU - minU < EPSILON && maxV - minV < EPSILON) continue;
    boxes.push({ index, minU, maxU, minV, maxV });
    if (minU < gMinU) gMinU = minU; if (maxU > gMaxU) gMaxU = maxU;
    if (minV < gMinV) gMinV = minV; if (maxV > gMaxV) gMaxV = maxV;
    spanSum += Math.max(maxU - minU, maxV - minV);
  }
  if (!boxes.length) return null;
  const cellSize = Math.max(1 / maxCellsPerAxis, Math.min(spanSum / boxes.length, 1 / 16));
  const cellsU = Math.min(maxCellsPerAxis, Math.max(1, Math.ceil((gMaxU - gMinU) / cellSize) + 1));
  const cellsV = Math.min(maxCellsPerAxis, Math.max(1, Math.ceil((gMaxV - gMinV) / cellSize) + 1));
  const cellIndex = (cu, cv) => cv * cellsU + cu;
  const total = cellsU * cellsV;
  const rangeOf = (box) => ({
    cu0: Math.max(0, Math.min(cellsU - 1, Math.floor((box.minU - gMinU) / cellSize))),
    cu1: Math.max(0, Math.min(cellsU - 1, Math.floor((box.maxU - gMinU) / cellSize))),
    cv0: Math.max(0, Math.min(cellsV - 1, Math.floor((box.minV - gMinV) / cellSize))),
    cv1: Math.max(0, Math.min(cellsV - 1, Math.floor((box.maxV - gMinV) / cellSize))),
  });
  const counts = new Uint32Array(total);
  for (const box of boxes) {
    const r = rangeOf(box);
    for (let cv = r.cv0; cv <= r.cv1; cv += 1) for (let cu = r.cu0; cu <= r.cu1; cu += 1) counts[cellIndex(cu, cv)] += 1;
  }
  const starts = new Uint32Array(total + 1);
  for (let i = 0; i < total; i += 1) starts[i + 1] = starts[i] + counts[i];
  const cursor = starts.slice(0, total);
  const entries = new Uint32Array(starts[total]);
  for (const box of boxes) {
    const r = rangeOf(box);
    for (let cv = r.cv0; cv <= r.cv1; cv += 1) {
      for (let cu = r.cu0; cu <= r.cu1; cu += 1) {
        const cell = cellIndex(cu, cv);
        entries[cursor[cell]] = box.index;
        cursor[cell] += 1;
      }
    }
  }
  const weightsIn = (index, u, v) => {
    const corners = triangles[index]?.corners;
    if (!corners || corners.length !== 3) return null;
    const [a, b, c] = corners.map((corner) => corner.uv);
    const denominator = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(denominator) < EPSILON) return null;
    const wa = ((b[1] - c[1]) * (u - c[0]) + (c[0] - b[0]) * (v - c[1])) / denominator;
    const wb = ((c[1] - a[1]) * (u - c[0]) + (a[0] - c[0]) * (v - c[1])) / denominator;
    const w = [wa, wb, 1 - wa - wb];
    return w.every((value) => value >= -1e-9) ? w : null;
  };
  return {
    cellSize, cellsU, cellsV, originU: gMinU, originV: gMinV, cellCount: total, triangleCount: boxes.length,
    locate(u, v, radius = 1) {
      const cu = Math.max(0, Math.min(cellsU - 1, Math.floor((u - gMinU) / cellSize)));
      const cv = Math.max(0, Math.min(cellsV - 1, Math.floor((v - gMinV) / cellSize)));
      for (let dv = -radius; dv <= radius; dv += 1) {
        for (let du = -radius; du <= radius; du += 1) {
          const nx = cu + du, ny = cv + dv;
          if (nx < 0 || ny < 0 || nx >= cellsU || ny >= cellsV) continue;
          const cell = cellIndex(nx, ny);
          for (let i = starts[cell]; i < starts[cell + 1]; i += 1) {
            const w = weightsIn(entries[i], u, v);
            if (w) return { inside: true, triangleIndex: entries[i], weights: w, distance: 0 };
          }
        }
      }
      return null;
    },
  };
}

function projectUvToSurface(index, source, u, v, options = {}) {
  const located = index?.locate ? index.locate(u, v, Number.isFinite(options.radius) ? options.radius : 1) : null;
  if (!located) return null;
  const corners = source.triangles[located.triangleIndex]?.corners;
  if (!corners) return null;
  const result = {};
  for (const name of source.attributeNames || []) {
    const size = Array.isArray(corners[0][name]) ? corners[0][name].length : 0;
    if (!size) continue;
    const values = new Array(size).fill(0);
    for (let i = 0; i < 3; i += 1) for (let c = 0; c < size; c += 1) values[c] += (corners[i][name]?.[c] || 0) * located.weights[i];
    result[name] = values;
  }
  return { corner: result, inTriangle: located.inside, holeDistance: 0, triangleIndex: located.triangleIndex };
}

module.exports = { traceMeshFromMask, subdivideForUv, densify, sampleMaxUvEdge, buildMaskSampler, buildUvIndex, projectUvToSurface, refineToIsoline };
