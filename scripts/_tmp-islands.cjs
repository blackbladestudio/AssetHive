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
async function main() {
  for (const file of process.argv.slice(2)) {
    const { positions, tris, uv0 } = await loadMesh(file);
    const n = positions.length;
    const p = new Int32Array(n);
    for (let i = 0; i < n; i++) p[i] = i;
    const find = (x) => { while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; } return x; };
    for (const [a, b, c] of tris) { const ra = find(a), rb = find(b), rc = find(c); if (rb !== ra) p[rb] = ra; if (rc !== ra) p[rc] = ra; }
    const groups = new Map();
    for (let i = 0; i < n; i++) { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); }
    const rectOf = (i) => { const uv = uv0[i]; return uv ? uv.map(x => x.toFixed(2)).join(",") : "-"; };
    console.log("=====", path.basename(file), "verts", n, "tris", tris.length, "islands", groups.size);
    const list = [...groups.values()].map((vs) => {
      const rects = new Set(vs.map(rectOf));
      let mn = [1e9,1e9,1e9], mx = [-1e9,-1e9,-1e9];
      for (const v of vs) { const q = positions[v]; for (let k=0;k<3;k++){ if(q[k]<mn[k])mn[k]=q[k]; if(q[k]>mx[k])mx[k]=q[k]; } }
      return { count: vs.length, rects: rects.size, size: [mx[0]-mn[0],mx[1]-mn[1],mx[2]-mn[2]], mn, mx };
    }).sort((a,b)=>b.count-a.count);
    for (const it of list.slice(0, 10)) {
      console.log("  verts", String(it.count).padStart(6), "uvrects", String(it.rects).padStart(4),
        "size", it.size.map(x=>x.toFixed(1)).join(" x "), "min", it.mn.map(x=>x.toFixed(1)).join(","), "max", it.mx.map(x=>x.toFixed(1)).join(","));
    }
    if (list.length > 10) console.log("  ... more islands:", list.length - 10);
  }
}
main();