const fs = require("node:fs");
const path = require("node:path");
async function loadMesh(file) {
  const THREE = await import("three");
  const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
  const buffer = fs.readFileSync(file);
  const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const scene = new FBXLoader(new THREE.LoadingManager()).parse(ab, path.dirname(file));
  const meshes = [];
  scene.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const positions = [], tris = [], uv0 = [];
  for (const mesh of meshes) {
    const geo = mesh.geometry;
    const pos = geo.getAttribute("position");
    if (!pos) continue;
    const base = positions.length;
    for (let i = 0; i < pos.count; i++) positions.push([pos.array[i*3], -pos.array[i*3+2], pos.array[i*3+1]]);
    const index = geo.index ? geo.index.array : null;
    const triN = index ? index.length / 3 : pos.count / 3;
    for (let t = 0; t < triN; t++) tris.push([base + (index ? index[t*3] : t*3), base + (index ? index[t*3+1] : t*3+1), base + (index ? index[t*3+2] : t*3+2)]);
    const a = geo.getAttribute("uv");
    if (a) for (let i = 0; i < pos.count; i++) uv0.push([a.array[i*a.itemSize], a.array[i*a.itemSize+1]]);
    else for (let i = 0; i < pos.count; i++) uv0.push(null);
  }
  return { positions, tris, uv0 };
}
(async () => {
  const file = process.argv[2];
  const { positions, tris, uv0 } = await loadMesh(file);
  const key = (t) => {
    let umin=Infinity,umax=-Infinity,vmin=Infinity,vmax=-Infinity;
    for (const v of t) { const uv = uv0[v]; if (!uv) continue; umin=Math.min(umin,uv[0]);umax=Math.max(umax,uv[0]);vmin=Math.min(vmin,uv[1]);vmax=Math.max(vmax,uv[1]); }
    return [Math.round(umin*1000), Math.round(umax*1000), Math.round(vmin*1000), Math.round(vmax*1000)].join(",");
  };
  const groups = new Map();
  for (const t of tris) {
    const k = key(t);
    if (!groups.has(k)) groups.set(k, { tris: 0, verts: new Set(), min:[1e9,1e9,1e9], max:[-1e9,-1e9,-1e9] });
    const g = groups.get(k);
    g.tris++;
    for (const v of t) {
      g.verts.add(v);
      const p = positions[v];
      for (let i=0;i<3;i++){ g.min[i]=Math.min(g.min[i],p[i]); g.max[i]=Math.max(g.max[i],p[i]); }
    }
  }
  console.log("file:", path.basename(file), "verts", positions.length, "tris", tris.length, "uv0 rects", groups.size);
  let i = 0;
  for (const [k,g] of [...groups.entries()].sort((a,b)=>b[1].tris-a[1].tris)) {
    i++;
    const size = [g.max[0]-g.min[0], g.max[1]-g.min[1], g.max[2]-g.min[2]].map(x=>x.toFixed(1)).join(" x ");
    console.log(String(i).padStart(2), "tris", String(g.tris).padStart(6), "verts", String(g.verts.size).padStart(6),
      "bbox", size.padStart(22), "min", g.min.map(x=>x.toFixed(1)).join(","), "max", g.max.map(x=>x.toFixed(1)).join(","), "uvrect", k);
    if (i >= 30) { console.log("... more:", groups.size - 30); break; }
  }
})();