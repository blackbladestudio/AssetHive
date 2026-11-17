// Generate disposable FBX + texture + normal export Job fixtures for the
// AssetHive.Import.Zion3DMaterialBatch UE automation test.
const fs = require("node:fs/promises");
const path = require("node:path");
const sharp = require("sharp");
const { buildExportAssets } = require("../electron/services/unrealExporter");
const { namedMaterialCatalog } = require("../electron/services/zion3dMaterials");

async function main() {
  const root = path.resolve(process.argv[2] || ".cache/zion-3d-validation/Fixtures");
  await fs.mkdir(root, { recursive: true });
  const THREE = await import("three");
  const { FBXExporter } = await import("@comfyorg/fbx-exporter-three");
  const names = ["Rope_01", "Rope_02", "Wood_01"];
  for (const [index, name] of names.entries()) {
    for (const suffix of ["D", "N", "ORM"]) {
      await sharp({ create: { width: 8, height: 8, channels: 3,
        background: { r: suffix === "N" ? 128 : 40 + 60 * index, g: 128, b: 255 } } }).png().toFile(path.join(root, `${name}_${suffix}.png`));
    }
  }
  const assets = [];
  for (const [label, used] of [["A", names], ["B", ["Wood_01", "Rope_01"]]]) {
    const geometry = new THREE.BufferGeometry();
    const positions = [], normals = [], uvs = [];
    for (const [index] of used.entries()) {
      const x = index * 200;
      positions.push(x, 0, 0, x + 100, 0, 0, x, 100, 0);
      normals.push(0, 0, 1, 0, 0, 1, 0, 0, 1);
      uvs.push(0, 0, 1, 0, 0, 1);
      geometry.addGroup(index * 3, 3, index);
    }
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    const materials = used.map((name) => {
      const material = new THREE.MeshStandardMaterial();
      material.name = `MI_${name}`;
      return material;
    });
    const mesh = new THREE.Mesh(geometry, materials);
    mesh.name = `Module${label}`;
    const scene = new THREE.Scene();
    scene.add(mesh);
    const model = path.join(root, `Module${label}.fbx`);
    await fs.writeFile(model, new FBXExporter().parseSync(scene, { preset: "unreal", embedTextures: false }));
    const entries = used.flatMap((name, index) => [
      ["Diffuse", "D"], ["Normal", "N"], ["ORM", "ORM"]
    ].map(([textureType, suffix]) => ({ areaIndex: index + 1, textureType, uri: `${name}_${suffix}.png` })));
    assets.push({ id: `fixture-${label}`, name: `Module${label}`, assetType: "3d", source: "custom", path: root,
      standardAssetTags: ["Kits"], modelFiles: [model], textureFiles: label === "A" ? entries.map((entry) => path.join(root, entry.uri)) : [],
      meta: label === "A" ? { textureEntries: entries, materialNames: Object.fromEntries(used.map((name, index) => [index + 1, name])) } : {} });
  }
  const jobs = await buildExportAssets(assets.reverse());
  const catalog = namedMaterialCatalog(jobs);
  const job = path.join(root, "named-material-job.json");
  await fs.writeFile(job, JSON.stringify({ assets: jobs, namedMaterialGroups: catalog.groups, resolution: "4k" }, null, 2));
  console.log(job);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
