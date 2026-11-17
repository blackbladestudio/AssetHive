import * as THREE from "three";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { analyzeCollisionNodes, type CollisionAnalysis } from "./modelCollision";

export type ModelBounds = { x: number; y: number; z: number };
export type ModelAnalysis = { bounds: ModelBounds | null; collision: CollisionAnalysis | null; triangleCount: number | null; meshKind?: "staticMesh" | "skeletalMesh"; hasSkeleton?: boolean; hasSkin?: boolean; boneCount?: number; skinnedMeshCount?: number };

export async function analyzeModel(filePath: string): Promise<ModelAnalysis> {
  const ext = filePath.split(".").pop()?.toLowerCase();
  const url = filePath.startsWith("file:") ? filePath : `file://${filePath.replace(/\\/g, "/")}`;
  return new Promise<ModelAnalysis>((resolve, reject) => {
    const onLoad = (object: THREE.Object3D) => {
      const box = new THREE.Box3().setFromObject(object);
      const size = new THREE.Vector3();
      box.getSize(size);
      // FBX metadata is in centimetres; three.js leaves the node coordinates unchanged.
      let scale = 1.0;
      if (ext === "fbx") {
        const unitScaleFactor = Number(object.userData?.unitScaleFactor);
        scale = (Number.isFinite(unitScaleFactor) && unitScaleFactor > 0 ? unitScaleFactor : 1) / 100;
      } else if (ext === "obj") {
        scale = Math.max(size.x, size.y, size.z) > 10 ? 0.01 : 1;
      }
      let triangleCount = 0;
      let boneCount = 0;
      let skinnedMeshCount = 0;
      object.traverse(child => {
        if ((child as THREE.Bone).isBone || child.type === "Bone") boneCount += 1;
        if ((child as THREE.SkinnedMesh).isSkinnedMesh) skinnedMeshCount += 1;
        const geometry = (child as THREE.Mesh).geometry;
        if (!geometry?.isBufferGeometry) return;
        triangleCount += Math.floor((geometry.index?.count ?? geometry.getAttribute("position")?.count ?? 0) / 3);
      });
      resolve({ bounds: { x: size.x * scale, y: size.y * scale, z: size.z * scale }, collision: analyzeCollisionNodes(object), triangleCount,
        meshKind: boneCount > 0 || skinnedMeshCount > 0 ? "skeletalMesh" : "staticMesh", hasSkeleton: boneCount > 0,
        hasSkin: skinnedMeshCount > 0, boneCount, skinnedMeshCount });
    };
    const onError = (error: unknown) => { console.error(error); reject(error); };
    try {
      if (ext === "obj") new OBJLoader().load(url, onLoad, undefined, onError);
      else if (ext === "fbx") new FBXLoader().load(url, onLoad, undefined, onError);
      else if (ext === "gltf" || ext === "glb") new GLTFLoader().load(url, gltf => onLoad(gltf.scene), undefined, onError);
      else reject(new Error("Unsupported format: " + ext));
    } catch (error) { reject(error); }
  });
}
