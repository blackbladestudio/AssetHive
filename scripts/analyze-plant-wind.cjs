/*
 * analyze-plant-wind.cjs  (v2.1)
 * 离线「植被合成风规则」分析器 / 验证器。
 *
 * 1) 复刻插件 C++：
 *    - ComputePlantWindIslands  (位置焊接 + 连通片)
 *    - ComputePlantWindFronds   (FrondLike / ConnectedCluster 合并)
 *    - ApplySyntheticSpeedTreeWind 的逐顶点 UV 写入口径
 *      UV1 = (PackedPosition, PackedDirection)
 *      UV2 = (Weight, RippleWeight)
 * 2) 撕裂度量：
 *    把「空间近邻但不属于同一风单元」的顶点对视为接缝对(seam pair)，
 *    用相位方向差 / 锚点差 / ripple 差 / 权重差量化撕裂强度（流式统计，不落全量点对）。
 * 3) 基于模型特征的接缝连续性修正（--fix）：
 *    对接缝做风属性混合（方向、锚点、ripple、权重），再重算撕裂度量。
 *
 * 用法:
 *   node scripts/analyze-plant-wind.cjs <fbx> [--mode frondlike|connectedcluster|none]
 *        [--weld EPS] [--near CM] [--top N] [--fix] [--fix-radius CM] [--phase island|frond]
 *        [--axis yup|zup]   (默认 yup：Blender/Megascans FBX 为 Y-up，内部转换到 UE Z-up)
 */
const fs = require("node:fs");
const path = require("node:path");

function parseArgs(argv) {
  const args = {
    file: "", top: 8, mode: "frondlike", weld: 0, near: 2.0, fix: false,
    fixRadius: 0, phase: "island", axis: "yup",
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--top") { args.top = Number(argv[++i]) || 8; continue; }
    if (a === "--mode") { args.mode = String(argv[++i] || "frondlike").toLowerCase(); continue; }
    if (a === "--weld") { args.weld = Number(argv[++i]) || 0; continue; }
    if (a === "--near") { args.near = Number(argv[++i]) || 2.0; continue; }
    if (a === "--fix") { args.fix = true; continue; }
    if (a === "--fix-radius") { args.fixRadius = Number(argv[++i]) || 0; continue; }
    if (a === "--phase") { args.phase = String(argv[++i] || "island").toLowerCase(); continue; }
    if (a === "--axis") { args.axis = String(argv[++i] || "yup").toLowerCase(); continue; }
    rest.push(a);
  }
  args.file = rest[0] || "";
  return args;
}

function v3(x, y, z) { return { x, y, z }; }
function sub(a, b) { return v3(a.x - b.x, a.y - b.y, a.z - b.z); }
function add(a, b) { return v3(a.x + b.x, a.y + b.y, a.z + b.z); }
function mul(a, s) { return v3(a.x * s, a.y * s, a.z * s); }
function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
function len(a) { return Math.sqrt(dot(a, a)); }
function norm(a) { const l = len(a); return l > 1e-9 ? mul(a, 1 / l) : v3(0, 0, 1); }
function dist2(a, b) { const d = sub(a, b); return dot(d, d); }
function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }
function lerp(a, b, t) { return a + (b - a) * t; }
function angleDeg(a, b) { const d = clamp(dot(a, b), -1, 1); return Math.acos(d) * 180 / Math.PI; }

class DSU {
  constructor(n) { this.p = new Int32Array(n); for (let i = 0; i < n; i++) this.p[i] = i; }
  find(x) { let r = x; while (this.p[r] !== r) r = this.p[r]; let c = x; while (this.p[c] !== r) { const n = this.p[c]; this.p[c] = r; c = n; } return r; }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) { this.p[rb] = ra; return true; } return false; }
}

/* ---------------- 插件侧散列/编码口径复刻 ---------------- */
function hashAnchor(anchor) {
  const vals = [Math.round(anchor.x * 100), Math.round(anchor.y * 100), Math.round(anchor.z * 100)];
  let h = 2166136261 >>> 0;
  for (let v of vals) {
    v = v >>> 0;
    for (let s = 0; s < 32; s += 8) h = Math.imul((h ^ ((v >>> s) & 0xff)) >>> 0, 16777619) >>> 0;
  }
  return h >>> 0;
}
function hashToUnit(h) { return (h & 0x00ffffff) / 0x01000000; }
function packGrassRippleWeight(anchor) {
  return 0.60 + 0.30 * hashToUnit((hashAnchor(anchor) ^ 0x9E3779B9) >>> 0);
}
function bestAxisVectors(axis) {
  const ax = Math.abs(axis.x), ay = Math.abs(axis.y), az = Math.abs(axis.z);
  let side;
  if (ax <= ay && ax <= az) side = v3(1, 0, 0);
  else if (ay <= az) side = v3(0, 1, 0);
  else side = v3(0, 0, 1);
  const s = norm(sub(side, mul(axis, dot(side, axis))));
  const up = norm(v3(axis.y * s.z - axis.z * s.y, axis.z * s.x - axis.x * s.z, axis.x * s.y - axis.y * s.x));
  return { side: s, up };
}
function jitterGrassWindDirection(anchor, direction) {
  const axis = norm(direction);
  const { side, up } = bestAxisVectors(axis);
  const h = hashAnchor(anchor);
  const scale = 0.22;
  const ox = (hashToUnit(h) * 2 - 1) * scale;
  const oy = (hashToUnit(Math.imul(h, 2654435761) >>> 0) * 2 - 1) * scale;
  return norm(add(add(axis, mul(side, ox)), mul(up, oy)));
}

/* ---------------- FBX 载入 ---------------- */
async function loadMesh(file, axis) {
  const THREE = await import("three");
  const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
  const buffer = fs.readFileSync(file);
  const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const scene = new FBXLoader(new THREE.LoadingManager()).parse(ab, path.dirname(file));
  const meshes = [];
  scene.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const conv = axis === "zup"
    ? (x, y, z) => v3(x, y, z)
    : (x, y, z) => v3(x, -z, y); // Y-up -> UE Z-up
  const positions = [], tris = [], uv0 = [];
  for (const mesh of meshes) {
    const geo = mesh.geometry;
    const pos = geo.getAttribute("position");
    if (!pos) continue;
    const base = positions.length;
    for (let i = 0; i < pos.count; i++) positions.push(conv(pos.array[i * 3], pos.array[i * 3 + 1], pos.array[i * 3 + 2]));
    const index = geo.index ? geo.index.array : null;
    const triN = index ? index.length / 3 : pos.count / 3;
    for (let t = 0; t < triN; t++) {
      tris.push([base + (index ? index[t * 3] : t * 3), base + (index ? index[t * 3 + 1] : t * 3 + 1), base + (index ? index[t * 3 + 2] : t * 3 + 2)]);
    }
    const a = geo.getAttribute("uv");
    if (a) for (let i = 0; i < pos.count; i++) uv0.push([a.array[i * a.itemSize], a.array[i * a.itemSize + 1]]);
    else for (let i = 0; i < pos.count; i++) uv0.push(null);
  }
  return { positions, tris, uv0 };
}

/* ---------------- 连通片（位置焊接） ---------------- */
function computeIslands(positions, tris, uv0, weldOverride) {
  const n = positions.length;
  const dsu = new DSU(n);
  for (const [a, b, c] of tris) { dsu.union(a, b); dsu.union(b, c); }
  let mn = v3(Infinity, Infinity, Infinity), mx = v3(-Infinity, -Infinity, -Infinity);
  for (const p of positions) {
    mn = v3(Math.min(mn.x, p.x), Math.min(mn.y, p.y), Math.min(mn.z, p.z));
    mx = v3(Math.max(mx.x, p.x), Math.max(mx.y, p.y), Math.max(mx.z, p.z));
  }
  const diag = len(sub(mx, mn));
  const weldEpsilon = weldOverride > 0 ? weldOverride : Math.max(diag * 1e-5, 1e-3);
  let weldMerged = 0;
  {
    const cell = Math.max(weldEpsilon, 1e-6);
    const grid = new Map();
    for (let i = 0; i < n; i++) {
      const p = positions[i];
      const kx = Math.floor(p.x / cell), ky = Math.floor(p.y / cell), kz = Math.floor(p.z / cell);
      for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) for (let oz = -1; oz <= 1; oz++) {
        const arr = grid.get(`${kx + ox}|${ky + oy}|${kz + oz}`);
        if (!arr) continue;
        for (const j of arr) if (dist2(p, positions[j]) <= weldEpsilon * weldEpsilon) { if (dsu.find(i) !== dsu.find(j)) { dsu.union(i, j); weldMerged++; } }
      }
      const k = `${kx}|${ky}|${kz}`;
      let arr = grid.get(k); if (!arr) { arr = []; grid.set(k, arr); }
      arr.push(i);
    }
  }
  const rootToIdx = new Map();
  const islandOf = new Int32Array(n);
  const islands = [];
  for (let i = 0; i < n; i++) {
    const r = dsu.find(i);
    let idx = rootToIdx.get(r);
    if (idx === undefined) {
      idx = islands.length; rootToIdx.set(r, idx);
      islands.push({ verts: [], min: v3(Infinity, Infinity, Infinity), max: v3(-Infinity, -Infinity, -Infinity), minZ: Infinity, maxZ: -Infinity, sum: v3(0, 0, 0), lowSum: v3(0, 0, 0), lowCount: 0, highSum: v3(0, 0, 0), highCount: 0 });
    }
    islandOf[i] = idx;
    const A = islands[idx], p = positions[i];
    A.verts.push(i); A.sum = add(A.sum, p);
    A.min = v3(Math.min(A.min.x, p.x), Math.min(A.min.y, p.y), Math.min(A.min.z, p.z));
    A.max = v3(Math.max(A.max.x, p.x), Math.max(A.max.y, p.y), Math.max(A.max.z, p.z));
    A.minZ = Math.min(A.minZ, p.z); A.maxZ = Math.max(A.maxZ, p.z);
  }
  for (const A of islands) {
    const range = A.maxZ - A.minZ;
    for (const i of A.verts) {
      const p = positions[i];
      if (p.z <= A.minZ + range * 0.25) { A.lowSum = add(A.lowSum, p); A.lowCount++; }
      if (p.z >= A.maxZ - range * 0.25) { A.highSum = add(A.highSum, p); A.highCount++; }
    }
  }
  const count = islands.length;
  const base = new Array(count), tip = new Array(count), dir = new Array(count), maxProj = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const A = islands[i];
    const center = mul(A.sum, 1 / A.verts.length);
    let b = center, t = center;
    if (A.lowCount > 0) b = mul(A.lowSum, 1 / A.lowCount);
    if (A.highCount > 0) t = mul(A.highSum, 1 / A.highCount);
    const range = A.maxZ - A.minZ;
    const delta = sub(t, b);
    let d;
    if (dot(delta, delta) > Math.max(range * 0.05, 1e-6) ** 2) d = norm(delta);
    else {
      const ext = sub(A.max, A.min);
      let axisIdx = 0; if (ext.y > ext.x) axisIdx = 1; if (ext.z > (axisIdx === 0 ? ext.x : ext.y)) axisIdx = 2;
      d = v3(axisIdx === 0 ? 1 : 0, axisIdx === 1 ? 1 : 0, axisIdx === 2 ? 1 : 0);
    }
    base[i] = b; tip[i] = t; dir[i] = d;
  }
  for (let i = 0; i < n; i++) {
    const isl = islandOf[i];
    const proj = dot(sub(positions[i], base[isl]), dir[isl]);
    if (proj > maxProj[isl]) maxProj[isl] = proj;
  }
  return { islandOf, islands, count, base, tip, dir, maxProj, meshMin: mn, meshMax: mx, diag, weldEpsilon, weldMerged };
}

/* ---------------- 风单元合并（复刻插件） ---------------- */
function computeFronds(positions, islandInfo, mode) {
  const { islandOf, base, tip, dir, maxProj, count, diag } = islandInfo;
  const n = positions.length;
  const dsu = new DSU(count);
  const joinDistance = mode === "connectedcluster" ? clamp(diag * 0.014, 1.0, 2.0) : clamp(diag * 0.004, 0.1, 0.5);
  {
    const cell = Math.max(joinDistance, 1e-3);
    const grid = new Map();
    const jd2 = joinDistance * joinDistance;
    for (let i = 0; i < n; i++) {
      const p = positions[i], isl = islandOf[i];
      const kx = Math.floor(p.x / cell), ky = Math.floor(p.y / cell), kz = Math.floor(p.z / cell);
      for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) for (let oz = -1; oz <= 1; oz++) {
        const arr = grid.get(`${kx + ox}|${ky + oy}|${kz + oz}`);
        if (!arr) continue;
        for (const j of arr) {
          if (islandOf[j] === isl) continue;
          if (dist2(p, positions[j]) > jd2) continue;
          dsu.union(isl, islandOf[j]);
        }
      }
      const k = `${kx}|${ky}|${kz}`;
      let arr = grid.get(k); if (!arr) { arr = []; grid.set(k, arr); }
      arr.push(i);
    }
  }
  const rootToCluster = new Map();
  const clusters = [];
  const clusterOfIsland = new Int32Array(count).fill(-1);
  for (let i = 0; i < count; i++) {
    const r = dsu.find(i);
    let c = rootToCluster.get(r);
    if (c === undefined) { c = clusters.length; rootToCluster.set(r, c); clusters.push({ members: [], min: v3(Infinity, Infinity, Infinity), max: v3(-Infinity, -Infinity, -Infinity) }); }
    clusterOfIsland[i] = c;
    clusters[c].members.push(i);
  }
  for (const C of clusters) for (const m of C.members) {
    const A = islandInfo.islands[m];
    C.min = v3(Math.min(C.min.x, A.min.x), Math.min(C.min.y, A.min.y), Math.min(C.min.z, A.min.z));
    C.max = v3(Math.max(C.max.x, A.max.x), Math.max(C.max.y, A.max.y), Math.max(C.max.z, A.max.z));
  }
  const frondOfIsland = new Int32Array(count).fill(-1);
  const frBase = [], frTip = [], frDir = [], frIslands = [];
  let consolidated = 0;
  for (const C of clusters) {
    const members = C.members;
    let lead = members[0];
    for (const m of members) if (maxProj[m] > maxProj[lead]) lead = m;
    let isFrond = mode === "connectedcluster";
    if (mode === "frondlike" && members.length >= 2) {
      const lengths = members.map((m) => maxProj[m]).sort((a, b) => a - b);
      const maxLength = lengths[lengths.length - 1];
      const ref = members.length >= 3 ? lengths[Math.floor(lengths.length / 2)] : lengths[0];
      const span = len(sub(C.max, C.min));
      isFrond = maxLength >= 2 * Math.max(ref, 1e-6) && span <= maxLength * 1.8;
    }
    if (mode !== "none" && isFrond) {
      const fi = frBase.length;
      frBase.push(base[lead]); frTip.push(tip[lead]); frDir.push(dir[lead]);
      frIslands.push(members.slice());
      for (const m of members) frondOfIsland[m] = fi;
      if (members.length > 1) consolidated++;
    } else {
      for (const m of members) {
        frondOfIsland[m] = frBase.length;
        frBase.push(base[m]); frTip.push(tip[m]); frDir.push(dir[m]);
        frIslands.push([m]);
      }
    }
  }
  return { frondOfIsland, frBase, frTip, frDir, frIslands, consolidated, joinDistance };
}

/* ---------------- 逐顶点风属性（插件口径） ---------------- */
function buildVertexWind(positions, islands, fronds, options) {
  const n = positions.length;
  const { meshMin, meshMax } = islands;
  const height = Math.max(meshMax.z - meshMin.z, 1e-6);
  const frondCount = fronds.frBase.length;
  const rippleBase = new Float64Array(frondCount);
  const dirJitter = new Array(frondCount);
  const tipPacked = new Array(frondCount);
  const maxProjOfFrond = new Float64Array(frondCount);
  const size = sub(meshMax, meshMin);
  const safe = v3(Math.max(size.x, 1e-6), Math.max(size.y, 1e-6), Math.max(size.z, 1e-6));
  const phaseIsland = options.phase === "island";
  for (let f = 0; f < frondCount; f++) {
    const anchor = phaseIsland ? fronds.frBase[f] : fronds.frBase[f];
    dirJitter[f] = jitterGrassWindDirection(anchor, fronds.frDir[f]);
    rippleBase[f] = packGrassRippleWeight(anchor);
    const tp = fronds.frTip[f];
    tipPacked[f] = v3(clamp((tp.x - meshMin.x) / safe.x, 0, 1), clamp((tp.y - meshMin.y) / safe.y, 0, 1), clamp((tp.z - meshMin.z) / safe.z, 0, 1));
    let mp = 0;
    for (const m of fronds.frIslands[f]) mp = Math.max(mp, islands.maxProj[m]);
    maxProjOfFrond[f] = mp;
  }
  // 逐片相位锚点（Grass=FrondLike 时插件按「连通片」锚点抖动相位/ripple）
  const perIslandDir = new Array(islands.count), perIslandRipple = new Float64Array(islands.count);
  for (let isl = 0; isl < islands.count; isl++) {
    const f = fronds.frondOfIsland[isl];
    perIslandDir[isl] = phaseIsland ? jitterGrassWindDirection(islands.base[isl], fronds.frDir[f]) : dirJitter[f];
    perIslandRipple[isl] = phaseIsland ? packGrassRippleWeight(islands.base[isl]) : rippleBase[f];
  }
  const weight = new Float64Array(n), ripple = new Float64Array(n);
  const dirV = new Array(n), packPos = new Array(n);
  for (let v = 0; v < n; v++) {
    const isl = islands.islandOf[v];
    const f = fronds.frondOfIsland[isl];
    weight[v] = clamp((positions[v].z - meshMin.z) / height, 0, 1);
    const b = fronds.frBase[f], d = fronds.frDir[f];
    const proj = dot(sub(positions[v], b), d);
    const mp = maxProjOfFrond[f];
    const projW = mp > 1e-6 ? clamp(proj / mp, 0, 1) : 1;
    ripple[v] = clamp(perIslandRipple[isl] * projW, 0, 1);
    dirV[v] = perIslandDir[isl];
    packPos[v] = tipPacked[f];
  }
  return { weight, ripple, dirV, packPos, frondCount };
}

/* ---------------- 接缝扫描（流式） ---------------- */
function scanSeams(positions, islands, fronds, wind, nearCM, topN, label) {
  const n = positions.length;
  const cell = Math.max(nearCM, 1e-3);
  const grid = new Map();
  const near2 = nearCM * nearCM;
  const bands = { welded: 0, mm5: 0, cm1: 0, far: 0 };
  const mismatchBands = { welded: 0, mm5: 0, cm1: 0, far: 0 };
  let pairs = 0, mismatch = 0, sumDirMismatch = 0, maxDir = 0, sumWeightMismatch = 0, sumAnchorMismatch = 0;
  const dirHist = new Uint32Array(91);
  const top = [];
  const ccell = Math.max(islands.diag / 20, 0.05);
  const hotspot = new Map();
  const KEEP = Math.max(32, topN * 4);
  for (let i = 0; i < n; i++) {
    const p = positions[i];
    const wi = wind.weight[i];
    const kx = Math.floor(p.x / cell), ky = Math.floor(p.y / cell), kz = Math.floor(p.z / cell);
    for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) for (let oz = -1; oz <= 1; oz++) {
      const arr = grid.get(`${kx + ox}|${ky + oy}|${kz + oz}`);
      if (!arr) continue;
      for (const j of arr) {
        const d2 = dist2(p, positions[j]);
        if (d2 > near2) continue;
        const fa = fronds.frondOfIsland[islands.islandOf[i]];
        const fb = fronds.frondOfIsland[islands.islandOf[j]];
        if (fa === fb) continue;
        pairs++;
        const d = Math.sqrt(d2);
        const wMin = Math.min(wi, wind.weight[j]);
        const dDir = angleDeg(wind.dirV[i], wind.dirV[j]);
        const dRip = Math.abs(wind.ripple[i] - wind.ripple[j]);
        const dAnchor = len(sub(wind.packPos[i], wind.packPos[j])) * islands.diag;
        const dW = Math.abs(wi - wind.weight[j]);
        const score = wMin * (1 - Math.cos(dDir * Math.PI / 180)) + 0.5 * dRip * wMin + wMin * dAnchor / (0.05 * islands.diag) + dW;
        const bin = Math.min(90, Math.round(dDir));
        dirHist[bin]++;
        if (dDir > maxDir) maxDir = dDir;
        const bandName = d <= islands.weldEpsilon * 1.5 ? "welded" : (d <= 0.05 ? "mm5" : (d <= 0.5 ? "cm1" : "far"));
        bands[bandName]++;
        if (dDir >= 15 && wMin >= 0.25) {
          mismatchBands[bandName]++;
          mismatch++; sumDirMismatch += dDir; sumWeightMismatch += wMin; sumAnchorMismatch += dAnchor;
          const cx = Math.round(p.x / ccell), cy = Math.round(p.y / ccell), cz = Math.round(p.z / ccell);
          const key = `${cx}|${cy}|${cz}`;
          let h = hotspot.get(key);
          if (!h) { h = { count: 0, sumDir: 0, maxDir: 0, x: 0, y: 0, z: 0, fronds: new Set() }; hotspot.set(key, h); }
          h.count++; h.sumDir += dDir; h.maxDir = Math.max(h.maxDir, dDir);
          h.x += p.x; h.y += p.y; h.z += p.z; h.fronds.add(fa); h.fronds.add(fb);
        }
        if (top.length < KEEP || score > top[top.length - 1].score) {
          top.push({ score, d, dDir, dRip, dAnchor, wMin, pos: v3(p.x, p.y, p.z), fa, fb });
          top.sort((a, b) => b.score - a.score);
          if (top.length > KEEP) top.length = KEEP;
        }
      }
    }
    const k = `${kx}|${ky}|${kz}`;
    let arr = grid.get(k); if (!arr) { arr = []; grid.set(k, arr); }
    arr.push(i);
  }
  const quant = (q) => { let acc = 0; const target = pairs * q; for (let b = 0; b <= 90; b++) { acc += dirHist[b]; if (acc >= target) return b; } return 90; };
  const hot = [...hotspot.values()].sort((a, b) => b.count - a.count).slice(0, topN)
    .map((h) => ({ pos: v3(h.x / h.count, h.y / h.count, h.z / h.count), count: h.count, avgDir: h.sumDir / h.count, maxDir: h.maxDir, fronds: h.fronds.size }));
  return {
    stats: { label, pairs, mismatch, ratio: pairs ? mismatch / pairs : 0, dDirP50: quant(0.5), dDirP95: quant(0.95), dDirMax: maxDir, bands, mismatchBands, avgDirMismatch: mismatch ? sumDirMismatch / mismatch : 0, avgWeightMismatch: mismatch ? sumWeightMismatch / mismatch : 0, avgAnchorMismatch: mismatch ? sumAnchorMismatch / mismatch : 0 },
    top: top.slice(0, topN), hot,
  };
}

/* ---------------- 接缝混合（模型特征定位后的连续性修正） ---------------- */
function applySeamBlend(positions, islands, fronds, wind, radiusCM) {
  const n = positions.length;
  const ccell = Math.max(radiusCM * 0.5, 1e-3);
  const grid = new Map();
  const r2 = radiusCM * radiusCM;
  const newDir = wind.dirV.slice();
  const newPack = wind.packPos.slice();
  const newRip = Float64Array.from(wind.ripple);
  const newW = Float64Array.from(wind.weight);
  const clusterOf = new Int32Array(n).fill(-1);
  const clusters = [];
  for (let i = 0; i < n; i++) {
    const p = positions[i];
    const kx = Math.floor(p.x / ccell), ky = Math.floor(p.y / ccell), kz = Math.floor(p.z / ccell);
    let found = -1;
    for (let ox = -1; ox <= 1 && found < 0; ox++) for (let oy = -1; oy <= 1 && found < 0; oy++) for (let oz = -1; oz <= 1 && found < 0; oz++) {
      const arr = grid.get(`${kx + ox}|${ky + oy}|${kz + oz}`);
      if (!arr) continue;
      for (const c of arr) if (dist2(p, clusters[c].center) <= r2) { found = c; break; }
    }
    if (found < 0) {
      found = clusters.length;
      clusters.push({ center: p, members: [], sumP: v3(0, 0, 0) });
      const k = `${kx}|${ky}|${kz}`;
      let arr = grid.get(k); if (!arr) { arr = []; grid.set(k, arr); }
      arr.push(found);
    }
    const C = clusters[found];
    C.members.push(i);
    C.sumP = add(C.sumP, p);
    C.center = mul(C.sumP, 1 / C.members.length);
    clusterOf[i] = found;
  }
  const unitSet = new Set();
  let blendClusters = 0, touched = 0;
  for (const C of clusters) {
    unitSet.clear();
    for (const v of C.members) unitSet.add(fronds.frondOfIsland[islands.islandOf[v]]);
    if (unitSet.size < 2) continue;
    blendClusters++;
    let sumW = 0, sumRip = 0, sumWeights = 0;
    const dirAcc = v3(0, 0, 0), packAcc = v3(0, 0, 0);
    for (const v of C.members) {
      const wt = 1 / Math.max(0.2, wind.weight[v]);
      sumW += wt; sumRip += wind.ripple[v] * wt; sumWeights += wind.weight[v] * wt;
      dirAcc.x += wind.dirV[v].x * wt; dirAcc.y += wind.dirV[v].y * wt; dirAcc.z += wind.dirV[v].z * wt;
      packAcc.x += wind.packPos[v].x * wt; packAcc.y += wind.packPos[v].y * wt; packAcc.z += wind.packPos[v].z * wt;
    }
    const dAvg = norm(dirAcc), pAvg = mul(packAcc, 1 / sumW), rAvg = sumRip / sumW, wAvg = sumWeights / sumW;
    for (const v of C.members) { newDir[v] = dAvg; newPack[v] = pAvg; newRip[v] = rAvg; newW[v] = wAvg; touched++; }
  }
  return { wind: { ...wind, dirV: newDir, packPos: newPack, ripple: newRip, weight: newW }, blendClusters, touched, clusterCount: clusters.length };
}

function fmt(x, d = 2) { return Number(x).toFixed(d); }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) { console.error("usage: node scripts/analyze-plant-wind.cjs <fbx> [--mode ...] [--near CM] [--fix] [--top N] [--axis yup|zup]"); process.exit(2); }
  const file = path.resolve(args.file);
  if (!fs.existsSync(file)) { console.error("file not found:", file); process.exit(2); }
  const { positions, tris, uv0 } = await loadMesh(file, args.axis);
  console.log("=".repeat(92));
  console.log("FBX:", file);
  console.log(`verts=${positions.length} tris=${tris.length} mode=${args.mode} phase=${args.phase} axis=${args.axis}`);
  const islands = computeIslands(positions, tris, uv0, args.weld);
  console.log(`连通片: ${islands.count}（焊接合并顶点 ${islands.weldMerged}，weldEps=${fmt(islands.weldEpsilon, 4)}cm，对角线 ${fmt(islands.diag)}cm）`);
  console.log(`UE空间包围盒: (${fmt(islands.meshMin.x)}, ${fmt(islands.meshMin.y)}, ${fmt(islands.meshMin.z)}) ~ (${fmt(islands.meshMax.x)}, ${fmt(islands.meshMax.y)}, ${fmt(islands.meshMax.z)}) 尺寸=(${fmt(islands.meshMax.x - islands.meshMin.x)} x ${fmt(islands.meshMax.y - islands.meshMin.y)} x ${fmt(islands.meshMax.z - islands.meshMin.z)})`);
  const fronds = computeFronds(positions, islands, args.mode);
  const hist = new Map();
  for (let i = 0; i < islands.count; i++) { const f = fronds.frondOfIsland[i]; hist.set(f, (hist.get(f) || 0) + 1); }
  const sizes = [...hist.values()].sort((a, b) => b - a);
  console.log(`风单元: ${sizes.length} 个（合并事件 ${fronds.consolidated}；joinDistance=${fmt(fronds.joinDistance, 3)}cm；单片单元 ${sizes.filter((s) => s === 1).length}）`);
  console.log(`风单元含片数 top12: ${sizes.slice(0, 12).join(", ")}`);
  const wind = buildVertexWind(positions, islands, fronds, args);
  const base = scanSeams(positions, islands, fronds, wind, args.near, args.top, "baseline");
  const S = base.stats;
  console.log("-".repeat(92));
  console.log(`[baseline] 近邻(<${args.near}cm)跨风单元顶点对=${S.pairs}；相位不匹配对(Δdir>=15° 且 权重>=0.25)=${S.mismatch} (${(S.ratio * 100).toFixed(1)}%)`);
  console.log(`           Δdir p50=${S.dDirP50}° p95=${S.dDirP95}° max=${fmt(S.dDirMax, 1)}°；不匹配对均值: Δdir=${fmt(S.avgDirMismatch, 1)}° 权重=${fmt(S.avgWeightMismatch, 2)} 锚点差=${fmt(S.avgAnchorMismatch, 2)}cm`);
  console.log(`           距离带: <=焊接级=${S.bands.welded} <=0.5mm=${S.bands.mm5} <=5mm=${S.bands.cm1} 其余(<${args.near}cm)=${S.bands.far}`);
  console.log(`           不匹配对按距离带: <=焊接级=${S.mismatchBands.welded} <=0.5mm=${S.mismatchBands.mm5} <=5mm=${S.mismatchBands.cm1} 其余=${S.mismatchBands.far}`);
  console.log(`   撕裂热点 top${base.hot.length}:`);
  for (const h of base.hot) console.log(`     pos=(${fmt(h.pos.x)}, ${fmt(h.pos.y)}, ${fmt(h.pos.z)}) 对=${h.count} 平均Δdir=${fmt(h.avgDir, 1)}° 最大=${fmt(h.maxDir, 1)}° 风单元数=${h.fronds}`);
  console.log(`   最严重接缝 top${base.top.length}:`);
  for (const t of base.top) console.log(`     d=${fmt(t.d * 10, 2)}mm Δdir=${fmt(t.dDir, 1)}° Δripple=${fmt(t.dRip, 3)} Δ锚点=${fmt(t.dAnchor, 2)}cm w=${fmt(t.wMin, 2)} pos=(${fmt(t.pos.x)}, ${fmt(t.pos.y)}, ${fmt(t.pos.z)})`);

  if (args.fix) {
    const radius = args.fixRadius > 0 ? args.fixRadius : clamp(islands.diag * 0.01, 0.15, 1.0);
    const blended = applySeamBlend(positions, islands, fronds, wind, radius);
    const after = scanSeams(positions, islands, fronds, blended.wind, args.near, args.top, "blended");
    const A = after.stats;
    console.log("-".repeat(92));
    console.log(`[fix] 接缝混合半径=${fmt(radius, 3)}cm；位置簇=${blended.clusterCount} 跨单元簇=${blended.blendClusters} 受影响顶点=${blended.touched}`);
    console.log(`[blended] 不匹配对=${A.mismatch} (${(A.ratio * 100).toFixed(1)}%)；Δdir p95=${A.dDirP95}° max=${fmt(A.dDirMax, 1)}°；不匹配对均值 Δdir=${fmt(A.avgDirMismatch, 1)}° 锚点差=${fmt(A.avgAnchorMismatch, 2)}cm`);
    console.log(`          不匹配对下降: ${S.mismatch ? (100 * (1 - A.mismatch / S.mismatch)).toFixed(1) + "%" : "n/a"}`);
    console.log(`          最严重接缝: ${after.top.slice(0, 3).map((t) => `Δdir=${fmt(t.dDir, 1)}°@${fmt(t.d * 10, 1)}mm`).join("  ")}`);
  }
  console.log("=".repeat(92));
}

main().catch((e) => { console.error(e); process.exit(1); });
