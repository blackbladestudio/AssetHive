"use strict";

// 不透明裁切的后处理：把"叶片壳体的上下两层"收敛成单层。
//
// 为什么需要：Megascans 植被是把同一片叶子做成有厚度的薄壳（正面 + 背面）。
// 不透明裁切按遮罩判定时，只要该处遮罩是实心，**上下两层都会被保留** ——
// 实测源网格 5,853 个三角形里就有 53.3% 的相邻面片对是"位置重合、法线相反"。
// 两层贴在一起渲染会互穿、闪烁，引擎里看就是叶片上一块块交错花斑（"碎"），
// 阴影也会因此变得斑驳。
//
// 判定规则（一条，与遍历顺序无关）：
//
//   1) 找出某面片在 layerDistance 邻域内所有"法线相反"（点积 < -0.5）的面片；
//   2) 若一个都没有 —— 这一小块只有一层，任何朝向都保留；
//   3) 若有 —— 在"该面片自身"和"这些反向面片"里，只有法线最朝上（+Y 最大）的胜出，
//      其余全部丢弃。
//
// 第 3 步是**全局比较**而不是"和第一个反向邻居比"：薄壳的正反两层常常正好是 ±Y，
// 谁更朝上取决于和谁比。早期版本在内层循环里用了 break，导致每格只检查到第一个
// 反向面，±Y 并列时判定结果取决于遍历顺序 —— 实测同一份合成数据在尺度 1 与
// 尺度 100 下结论相反。改成先收集全部候选、再统一取最朝上者，与顺序无关。
//
// 为什么用"朝上"当唯一决胜条件：植被资产的外表面朝上，这与引擎里看到的效果一致；
// 而且只有"确实存在反向邻居"时才比较，所以整片朝下的叶子不会被误删。
//
// layerDistance（认定"两层重合"的距离）按模型尺度取比例，不写死常数：
// 实测这类薄壳的层间距只占模型尺度的 0.003%~0.009%（beech fern：尺度 50.05 上
// p50=0.0015、max=0.0045），但它随资产而变。
//
// layerDistance（认定"两层重合"的距离）：固定取 span/2500。
//
// 为什么不按"正反面片对距离的高分位"标定：Trace 输出上正反面片对的绝大多数
// **不是**薄壳上下层，而是"面对面但相距很远的两片叶子"。实测该资产上的距离分布是
//   p1=0.003  p10=0.042  p50=0.183  p90=0.503  max=0.95
// 而真正的薄壳层间距只有 0.0015~0.0045（占 span 的 0.003%~0.009%），
// 即分布最左侧那一小撮（距离 ≤0.005 的仅占 1.6%）。
// 按高分位标定会把相距 0.5 的两片真实叶片当"上下两层"删掉 —— 那是在删几何，
// 比不修更糟（实测按 p95 标定会删掉 31% 的面片）。
//
// span/2500 在该资产上约 0.02：覆盖真实层间距的 4~13 倍，
// 又远小于"面对面叶片"的 0.04+，不会误伤。原则是宁可少删（只收拾真正的薄壳），
// 也不要多删（删掉真叶片）。

const EPSILON = 1e-12;

// 面法线（归一化）。
function faceNormal(p0, p1, p2) {
  const ab = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
  const ac = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
  const cr = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
  const length = Math.hypot(cr[0], cr[1], cr[2]);
  if (!(length > EPSILON)) return null;
  return [cr[0] / length, cr[1] / length, cr[2] / length];
}

function removeBackLayers(faces, options = {}) {
  if (!faces.length) {
    return { faces, stats: { facesIn: 0, facesOut: 0, removedBackLayers: 0, removedDegenerate: 0 } };
  }

  // 包围盒尺度（粗采样，千万面时也很快）
  const sampleStep = Math.max(1, Math.floor(faces.length / 20000));
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < faces.length; i += sampleStep) {
    for (const corner of faces[i].corners) {
      const p = corner.position;
      if (!p) continue;
      for (let k = 0; k < 3; k += 1) {
        if (p[k] < min[k]) min[k] = p[k];
        if (p[k] > max[k]) max[k] = p[k];
      }
    }
  }
  const span = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const safeSpan = Number.isFinite(span) && span > 0 ? span : 1;

  // 面法线与重心
  const normals = new Array(faces.length);
  const centroids = new Array(faces.length);
  for (let i = 0; i < faces.length; i += 1) {
    const corners = faces[i].corners;
    const n = faceNormal(corners[0].position, corners[1].position, corners[2].position);
    if (!n) continue;
    normals[i] = n;
    centroids[i] = [
      (corners[0].position[0] + corners[1].position[0] + corners[2].position[0]) / 3,
      (corners[0].position[1] + corners[1].position[1] + corners[2].position[1]) / 3,
      (corners[0].position[2] + corners[1].position[2] + corners[2].position[2]) / 3,
    ];
  }

  const cellIndex = (c, size) => [
    Math.floor(c[0] / size), Math.floor(c[1] / size), Math.floor(c[2] / size),
  ];
  const keyOf = (i, j, k) => `${i},${j},${k}`;
  const buildGrid = (size) => {
    const g = new Map();
    for (let i = 0; i < faces.length; i += 1) {
      if (!normals[i]) continue;
      const [ci, cj, ck] = cellIndex(centroids[i], size);
      const key = keyOf(ci, cj, ck);
      let list = g.get(key);
      if (!list) { list = []; g.set(key, list); }
      list.push(i);
    }
    return g;
  };

  // —— 阈值：只覆盖真正的薄壳层间距 ——
  const radius = Number(options.layerDistance) > 0 ? Number(options.layerDistance) : safeSpan / 2500;

  // 空间网格：格边长 = radius，取 ±1 格邻域（覆盖 3 倍半径的搜索范围）。
  // 邻域必须用 3x3x3 而不是只查本格：两层可能正好跨格边界。
  // 不用更大的邻域：邻居越多越容易把"面对面但相距远的两片叶子"卷进来，
  // 而且每多一环就多 26 个格子，千万面级别会拖慢到不可接受。
  const cell = radius;
  const grid = buildGrid(cell);

  const radiusSq = radius * radius;
  const kept = [];
  let removed = 0, degenerate = 0, layeredFaces = 0;
  for (let i = 0; i < faces.length; i += 1) {
    const n = normals[i];
    if (!n) { degenerate += 1; continue; }
    const c = centroids[i];
    const [ci, cj, ck] = cellIndex(c, cell);

    // 收集邻域内所有反向面片（不提前退出，保证判定与遍历顺序无关）
    let hasOpposite = false;
    let winnerY = n[1];
    for (let di = -1; di <= 1; di += 1) {
      for (let dj = -1; dj <= 1; dj += 1) {
        for (let dk = -1; dk <= 1; dk += 1) {
          const list = grid.get(keyOf(ci + di, cj + dj, ck + dk));
          if (!list) continue;
          for (const j of list) {
            if (j === i) continue;
            const m = normals[j];
            if (n[0] * m[0] + n[1] * m[1] + n[2] * m[2] > -0.5) continue;
            const o = centroids[j];
            const dx = c[0] - o[0], dy = c[1] - o[1], dz = c[2] - o[2];
            if (dx * dx + dy * dy + dz * dz > radiusSq) continue;
            hasOpposite = true;
            if (m[1] > winnerY) winnerY = m[1];
          }
        }
      }
    }

    // 没有反向邻居 = 这一小块只有一层，任何朝向都保留
    if (!hasOpposite) { kept.push(faces[i]); continue; }
    layeredFaces += 1;
    // 两层之间只有"最朝上"的那层胜出
    if (n[1] >= winnerY - 1e-9) { kept.push(faces[i]); continue; }
    removed += 1;
  }

  const stats = {
    facesIn: faces.length,
    facesOut: kept.length,
    removedBackLayers: removed,
    removedDegenerate: degenerate,
    layeredFaces,
    layerDistance: radius,
    span: safeSpan,
    removedRatio: faces.length ? removed / faces.length : 0,
  };
  return { faces: kept, stats };
}

module.exports = { removeBackLayers };
