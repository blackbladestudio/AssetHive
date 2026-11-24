const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { parentPort, workerData } = require('node:worker_threads');
const { URL } = require('node:url');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const { parseFbxDocument, childNode } = require('./fbxCompactLayers');
const { inflateSync } = require('node:zlib');
function skinEvidence(bytes, selectedModels = null) {
  const doc = parseFbxDocument(bytes);
  const objects = doc.nodes.find(node => node.name === 'Objects')?.children || [];
  const id = prop => prop?.code === 'L' ? String(prop.bytes.readBigInt64LE(1)) : prop?.code === 'I' ? String(prop.bytes.readInt32LE(1)) : '';
  const text = prop => prop?.code === 'S' ? prop.bytes.toString('utf8', 5).split('\0')[0].replace(/^Model::/, '') : '';
  const nodes = new Map(objects.map(node => [id(node.props[0]), node]));
  const connections = (doc.nodes.find(node => node.name === 'Connections')?.children || []).map(node => [id(node.props[1]), id(node.props[2])]);
  const geometryDigests = new Map();
  const read = (node, name, Type) => {
    const property = childNode(node, name)?.props[0];
    if (!property) return [];
    const bytes = property.bytes;
    const payload = bytes.subarray(13, 13 + bytes.readUInt32LE(9));
    const raw = bytes.readUInt32LE(5) === 1 ? inflateSync(payload) : payload;
    // FBX array payloads are byte-aligned, not necessarily Float64-aligned.
    const values = new Type(Uint8Array.from(raw).buffer);
    if (values.length !== bytes.readUInt32LE(1)) throw Error('Invalid FBX skin array');
    return Array.from(values, value => Math.round(value * 100000));
  };
  // THREE only exposes four influences. Independently retain EVERY cluster
  // weight, control point index and bind matrix from the original FBX tree.
  return objects.filter(node => node.name === 'Deformer' && text(node.props[2]) === 'Cluster').map(node => {
    const nodeId = id(node.props[0]);
    const boneIds = connections.filter(([, target]) => target === nodeId).map(([source]) => source).filter(source => nodes.get(source)?.name === 'Model');
    const skinId = connections.find(([source]) => source === nodeId)?.[1];
    const geometryId = connections.find(([source]) => source === skinId)?.[1];
    const geometry = nodes.get(geometryId);
    if (selectedModels && !connections.some(([source, target]) => source === geometryId && selectedModels.has(target))) return null;
    if (boneIds.length !== 1 || !geometry) throw Error('Ambiguous skin graph');
    if (!geometryDigests.has(geometryId)) geometryDigests.set(geometryId, hash(read(geometry, 'Vertices', Float64Array)));
    return hash({ bone: text(nodes.get(boneIds[0]).props[1]), geometry: geometryDigests.get(geometryId),
      indices: read(node, 'Indexes', Int32Array), weights: read(node, 'Weights', Float64Array),
      transform: read(node, 'Transform', Float64Array), link: read(node, 'TransformLink', Float64Array) });
  }).filter(Boolean).sort();
}

function lodModels(bytes, index) {
  if (index === null || index === undefined) return null;
  const doc = parseFbxDocument(bytes);
  const objects = doc.nodes.find(node => node.name === 'Objects')?.children || [];
  const id = prop => prop?.code === 'L' ? String(prop.bytes.readBigInt64LE(1)) : prop?.code === 'I' ? String(prop.bytes.readInt32LE(1)) : '';
  const type = node => node.props[2]?.bytes.toString('utf8', 5).toLowerCase();
  const edges = (doc.nodes.find(node => node.name === 'Connections')?.children || []).map(node => [id(node.props[1]), id(node.props[2])]);
  const models = new Set(objects.filter(node => node.name === 'Model').map(node => id(node.props[0])));
  const attributes = new Set(objects.filter(node => node.name === 'NodeAttribute' && type(node) === 'lodgroup').map(node => id(node.props[0])));
  const groups = objects.filter(node => node.name === 'Model' && (type(node) === 'lodgroup' || edges.some(([source, target]) => target === id(node.props[0]) && attributes.has(source))));
  if (!groups.length) {
    if (index === 'count') return 1;
    if (index === 0) return null;
    throw Error('UE 导出中缺少 LOD 分组，无法核验 LOD' + index);
  }
  if (index === 'count') {
    const counts = new Set(groups.map(group => edges.filter(([child,parent]) => parent === id(group.props[0]) && models.has(child)).length));
    if (counts.size !== 1 || counts.has(0)) throw Error('FBX LOD 分组等级数量不一致，无法核验');
    return [...counts][0];
  }
  const selected = new Set();
  function descend(model) {
    selected.add(model);
    for (const [child, parent] of edges) if (parent === model && models.has(child)) descend(child);
  }
  for (const group of groups) {
    const levels = edges.filter(([child, parent]) => parent === id(group.props[0]) && models.has(child)).map(([child]) => child);
    if (!levels[index]) throw Error('UE 中缺少 LOD' + index);
    descend(levels[index]);
  }
  return selected;
}
// Conservative comparison: transforms, all vertex channels, triangle winding,
// material assignment, skin weights and bind poses. Names/timestamps are not geometry.
async function inspect(file) {
  const THREE = await import('three');
  const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
  const manager = new THREE.LoadingManager();
  manager.addHandler(/./, { setPath() { return this; }, load() { return new THREE.Texture(); } });
  globalThis.window = { URL };
  const bytes = await fs.readFile(file);
  if (workerData.lodIndex === 'count') return {count:lodModels(bytes,'count')};
  const selectedModels = lodModels(bytes, workerData.lodIndex);
  const scene = new FBXLoader(manager).parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  scene.updateMatrixWorld(true);
  const quantize = value => { if (!Number.isFinite(value)) throw Error('Invalid vertex value'); return Math.round(value * 100000); };
  const meshes = [];
  scene.traverse(mesh => {
    if (!mesh.isMesh || /^(UCX|UBX|USP|UCP)_/i.test(mesh.name)) return;
    if (selectedModels && !selectedModels.has(String(mesh.ID))) return;
    const geometry = mesh.geometry, attributes = geometry.attributes;
    const count = geometry.index?.count || attributes.position.count;
    const channels = Object.keys(attributes).filter(key => !['skinIndex', 'skinWeight'].includes(key)).sort();
    const triangles = [];
    const paths = new Map(Object.entries(workerData.materialPaths || {}).map(([name, value]) => [name.toLowerCase(), String(value).split('.')[0].toLowerCase()]));
    for (let face = 0; face < count; face += 3) {
      const vertices = [];
      for (let corner = 0; corner < 3; corner++) {
        const index = geometry.index ? geometry.index.getX(face + corner) : face + corner;
        const vertex = channels.map(key => Array.from({ length: attributes[key].itemSize }, (_, c) => quantize(attributes[key].array[index * attributes[key].itemSize + c])));
        if (attributes.skinIndex && attributes.skinWeight) vertex.push(Array.from({ length: attributes.skinIndex.itemSize }, (_, c) => {
          const bone = mesh.skeleton?.bones[attributes.skinIndex.array[index * attributes.skinIndex.itemSize + c]];
          return [String(bone?.userData.originalName || bone?.name || ''), quantize(attributes.skinWeight.array[index * attributes.skinWeight.itemSize + c])];
        }).filter(pair => pair[1]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
        vertices.push(JSON.stringify(vertex));
      }
      const winding = [vertices, [vertices[1], vertices[2], vertices[0]], [vertices[2], vertices[0], vertices[1]]].map(v => v.join('|')).sort()[0];
      const group = geometry.groups.find(g => face >= g.start && face < g.start + g.count)?.materialIndex || 0;
      const material = Array.isArray(mesh.material) ? mesh.material[group] : mesh.material;
      const mapped = paths.get(String(material?.name || '').toLowerCase());
      if (paths.size && !mapped) throw Error('Unresolved face material: ' + material?.name);
      triangles.push(hash([mapped || group, winding]));
    }
    const boneName = bone => bone.userData.originalName || bone.name;
    // UE's multi-LOD FBX repeats the same named bone under its counterpart.
    // UE reference skeletons require unique names; collapse only these exact
    // duplicate wrapper nodes, retaining every real parent relationship.
    const parentBoneName = bone => {
      let parent = bone.parent;
      while (parent?.isBone && boneName(parent) === boneName(bone)) parent = parent.parent;
      return parent?.isBone ? boneName(parent) : '';
    };
    const bones = (mesh.skeleton?.bones || []).map((bone, index) => [boneName(bone),
      parentBoneName(bone),
      mesh.skeleton.boneInverses[index].elements.map(quantize)]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    meshes.push(hash({ channels, transform: mesh.matrixWorld.elements.map(quantize), triangles: triangles.sort(), bones,
      morphs: Object.entries(geometry.morphAttributes).map(([key, attrs]) => [key, attrs.map(a => Array.from(a.array, quantize))]) }));
  });
  if (!meshes.length) throw Error('No mesh content');
  return { version: 4, kind: 'mesh', meshes: meshes.sort(), skin: skinEvidence(bytes, selectedModels) };
}
inspect(workerData.file).then(value => parentPort.postMessage(value)).catch(error => parentPort.postMessage({ error: String(error.message || error) }));
