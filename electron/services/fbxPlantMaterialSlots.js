const fs = require("node:fs/promises");
const path = require("node:path");
const { parseFbxDocument, scalarValue } = require("./fbxCompactLayers");
const { detectTextureTypeFromFileName } = require("./textureTypes");

function stringValue(property) {
  return property?.code === "S" ? property.bytes.toString("utf8", 5) : "";
}

function objectId(property) {
  if (property?.code === "L") return property.bytes.readBigInt64LE(1);
  if (property?.code === "I") return BigInt(property.bytes.readInt32LE(1));
  return null;
}

function texturePath(directory, reference) {
  return path.resolve(directory, reference.replaceAll("\\", "/")).toLowerCase();
}

// Only materials assigned to a mesh and textures connected to its color input are evidence.
function meshMaterialSlots(document, directory) {
  const objects = document.nodes.find((node) => node.name === "Objects")?.children || [];
  const connections = document.nodes.find((node) => node.name === "Connections")?.children || [];
  const meshes = new Set();
  const materials = new Map();
  const textures = new Map();
  for (const node of objects) {
    const id = objectId(node.props[0]);
    if (id === null) continue;
    if (node.name === "Model" && stringValue(node.props[2]) === "Mesh") meshes.add(id);
    if (node.name === "Material") {
      const name = stringValue(node.props[1]).split("\0", 1)[0].replace(/^Material::/, "").trim();
      if (name) materials.set(id, { name, diffuse: new Set() });
    }
    if (node.name === "Texture") {
      const file = scalarValue(node, "RelativeFilename") || scalarValue(node, "FileName") || scalarValue(node, "Filename");
      if (file) textures.set(id, texturePath(directory, file));
    }
  }
  const assigned = new Set();
  for (const node of connections) {
    if (node.name !== "C") continue;
    const [kind, from, to, input] = node.props;
    const source = objectId(from);
    const target = objectId(to);
    if (stringValue(kind) === "OO" && meshes.has(target) && materials.has(source)) assigned.add(materials.get(source));
    if (stringValue(kind) === "OP" && materials.has(target) && /^(DiffuseColor|BaseColor)$/i.test(stringValue(input))) {
      materials.get(target).diffuse.add(textures.get(source) || "");
    }
  }
  return [...assigned];
}

async function resolveFbxWindMaterials(profile, models, sidecar) {
  const original = { profile, warnings: [] };
  if (!profile.materials?.some((row) => row.textureFiles?.length) || !models.every((file) => /\.fbx$/i.test(file))) return original;
  const byName = new Map();
  for (const model of models) {
    try {
      const bytes = await fs.readFile(model);
      // Other FBX formats retain the existing name-based import. Never infer a rename without the graph.
      if (bytes.toString("ascii", 0, 18) !== "Kaydara FBX Binary") return original;
      const slots = meshMaterialSlots(parseFbxDocument(bytes), path.dirname(model));
      if (!slots.length) throw new Error("未找到绑定到网格的材质槽");
      for (const slot of slots) {
        const key = slot.name.toLowerCase();
        if (!byName.has(key)) byName.set(key, { name: slot.name, diffuse: new Set() });
        // A different or missing connection in another mesh/LOD cannot prove the same alias.
        byName.get(key).diffuse.add(slot.diffuse.size === 1 ? [...slot.diffuse][0] : "");
      }
    } catch (error) {
      return { profile, warnings: [path.basename(model) + " 的 FBX 材质槽读取失败：" + error.message] };
    }
  }

  const slots = [...byName.values()];
  const used = new Set();
  const materials = [];
  for (const row of profile.materials) {
    let slot = byName.get(row.name.toLowerCase());
    if (!slot) {
      const diffuse = new Set((row.textureFiles || [])
        .filter((file) => /^(Diffuse|Basecolor|Albedo)/.test(detectTextureTypeFromFileName(file)))
        .map((file) => texturePath(path.dirname(sidecar), file)));
      const matches = slots.filter((candidate) => candidate.diffuse.size === 1 && diffuse.has([...candidate.diffuse][0]));
      if (matches.length === 1) slot = matches[0];
    }
    if (!slot || used.has(slot)) {
      return { profile, warnings: [path.basename(sidecar) + " 的材质 " + row.name
        + " 无法与 FBX 材质槽一一对应：" + slots.map((item) => item.name).join("、")] };
    }
    used.add(slot);
    materials.push(row.name === slot.name ? row : { ...row, name: slot.name });
  }
  if (used.size !== slots.length) {
    return { profile, warnings: [path.basename(sidecar) + " 缺少 FBX 材质槽：" + slots.filter((slot) => !used.has(slot)).map((slot) => slot.name).join("、")] };
  }
  return { profile: { ...profile, materials }, warnings: [] };
}

module.exports = { resolveFbxWindMaterials };
