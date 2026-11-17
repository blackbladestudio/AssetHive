"use strict";

const fs = require("node:fs/promises");
const { Buffer } = require("node:buffer");
const path = require("node:path");
const { URL } = require("node:url");
const { parentPort, workerData } = require("node:worker_threads");

const COLLISION_NODE_PATTERN = /^(?:UCX|UBX|USP|UCP)(?:_|$)/i;

// THREE exposes UnitScaleFactor but leaves the model in its source axes.
// Read GlobalSettings.Properties70.P("UpAxis") for binary and ASCII FBX.
function plantUpAxis(bytes) {
  const globals = bytes.indexOf("GlobalSettings");
  if (globals < 0) return undefined;
  const settings = bytes.subarray(globals, globals + 65536);
  if (!bytes.subarray(0, 18).toString("ascii").startsWith("Kaydara FBX Binary")) {
    const axis = /P:\s*"UpAxis"\s*,[^\r\n]*?,\s*([012])\s*(?:\r?\n|$)/.exec(settings.toString("utf8"));
    return axis ? Number(axis[1]) : undefined;
  }
  const key = Buffer.from("S\x06\x00\x00\x00UpAxis", "binary");
  const start = settings.indexOf(key);
  if (start < 0) return undefined;
  let pos = start + key.length;
  for (let field = 0; field < 3; field++) {
    if (pos + 5 > settings.length || settings[pos] !== 83) return undefined; // S: type, type label, flags
    pos += 5 + settings.readUInt32LE(pos + 1);
  }
  if (pos + 5 > settings.length || settings[pos] !== 73) return undefined; // I: property value
  const axis = settings.readInt32LE(pos + 1);
  return axis >= 0 && axis <= 2 ? axis : undefined;
}

async function analyzeFbx(filePath) {
  const [THREE, { FBXLoader }] = await Promise.all([
    import("three"),
    import("three/examples/jsm/loaders/FBXLoader.js")
  ]);
  const bytes = await fs.readFile(filePath);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  // Bounds and collision names use geometry only. FBXLoader's default texture
  // loader needs a browser document, which a Node worker deliberately lacks.
  const manager = new THREE.LoadingManager();
  const emptyTextureLoader = {
    path: "",
    setPath(value) { this.path = value; return this; },
    load() { return new THREE.Texture(); }
  };
  manager.addHandler(workerData.geometryOnlyTextures ? /./ : /\.(?:bmp|jpe?g|png|tiff?|tga|webp)$/i, emptyTextureLoader);
  globalThis.window = { URL };
  const object = new FBXLoader(manager).parse(buffer, path.dirname(filePath));
  const box = new THREE.Box3().setFromObject(object);
  const size = new THREE.Vector3();
  box.getSize(size);
  const unitScaleFactor = Number(object.userData?.unitScaleFactor);
  const scale = (Number.isFinite(unitScaleFactor) && unitScaleFactor > 0 ? unitScaleFactor : 1) / 100;
  let plantSizeCm;
  if (workerData.measurePlant) {
    const up = plantUpAxis(bytes);
    if (up !== undefined) {
      const bounds = new THREE.Box3().setFromObject(object, true);
      const cm = bounds.getSize(new THREE.Vector3()).multiplyScalar(scale * 100).toArray();
      plantSizeCm = [...cm.filter((_, axis) => axis !== up), cm[up]];
    }
  }
  let nodeCount = 0;
  let triangleCount = 0;
  let skinnedMeshCount = 0;
  const boneNames = new Set();
  const materialNames = new Set();
  const bones = new Map();
  object.traverse((child) => {
    const geometry = child.geometry;
    if (geometry?.isBufferGeometry) {
      const used = Array.isArray(child.material)
        ? [...new Set(geometry.groups.filter(group => group.count > 0).map(group => group.materialIndex))].map(index => child.material[index])
        : [child.material];
      for (const material of used) {
        if (material?.name) materialNames.add(material.name);
      }
      const elementCount = geometry.index?.count ?? geometry.getAttribute("position")?.count ?? 0;
      triangleCount += Math.floor(elementCount / 3);
    }
    const candidates = [child.name, child.userData?.originalName, child.userData?.name, child.geometry?.name];
    if (candidates.some((candidate) => COLLISION_NODE_PATTERN.test(String(candidate || "").trim()))) {
      nodeCount += 1;
    }
    if (child.isBone || child.type === "Bone") {
      boneNames.add(String(child.name || `bone-${boneNames.size + 1}`));
      const originalName = child.userData?.originalName || child.name;
      // FBXLoader nests duplicates of a shared joint for different skinned meshes.
      // These are the same FBX node, not a bone parenting itself.
      let boneParent = child.parent;
      while (boneParent?.isBone && child.ID !== undefined && boneParent.ID === child.ID) boneParent = boneParent.parent;
      bones.set(originalName, { name: originalName, parent: boneParent?.isBone ? boneParent.userData?.originalName || boneParent.name : '' });
    }
    if (child.isSkinnedMesh) {
      skinnedMeshCount += 1;
      for (const bone of child.skeleton?.bones || []) boneNames.add(String(bone?.name || `bone-${boneNames.size + 1}`));
    }
  });
  return {
    ...(plantSizeCm ? { plantSizeCm } : {}),
    bounds: { x: size.x * scale, y: size.y * scale, z: size.z * scale },
    triangleCount,
    materialNames: [...materialNames],
    bones: [...bones.values()],
    meshKind: boneNames.size > 0 || skinnedMeshCount > 0 ? "skeletalMesh" : "staticMesh",
    hasSkeleton: boneNames.size > 0,
    hasSkin: skinnedMeshCount > 0,
    boneCount: boneNames.size,
    skinnedMeshCount,
    collision: { checked: true, hasCollision: nodeCount > 0, nodeCount }
  };
}

analyzeFbx(workerData.filePath)
  .then((result) => parentPort.postMessage({ ok: true, result }))
  .catch((error) => parentPort.postMessage({ ok: false, error: error?.message || String(error) }));
