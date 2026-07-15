import { useEffect } from "react";
import * as THREE from "three";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export function ModelProcessor() {
  useEffect(() => {
    if (!window.arkhive?.onCalculateBoundsRequest || !window.arkhive?.respondBounds) return;
    const respondBounds = window.arkhive.respondBounds;

    const cleanup = window.arkhive.onCalculateBoundsRequest(async (payload) => {
      const { requestId, filePath } = payload;
      console.log("[ModelProcessor] Calculating bounds for:", filePath);

      try {
        const bounds = await calculateBounds(filePath);
        console.log("[ModelProcessor] Bounds:", bounds);
        await respondBounds({ requestId, bounds });
      } catch (error) {
        console.error("[ModelProcessor] Failed:", error);
        await respondBounds({ requestId, bounds: null });
      }
    });

    return cleanup;
  }, []);

  return null;
}

async function calculateBounds(filePath: string) {
  const ext = filePath.split(".").pop()?.toLowerCase();
  const url = filePath.startsWith("file:") ? filePath : `file://${filePath.replace(/\\/g, "/")}`;

  return new Promise<{ x: number; y: number; z: number } | null>((resolve, reject) => {
    const onLoad = (object: THREE.Object3D) => {
      const box = new THREE.Box3().setFromObject(object);
      const size = new THREE.Vector3();
      box.getSize(size);
      let scale = 1.0;
      if (ext === "fbx" || ext === "obj") {
        if (Math.max(size.x, size.y, size.z) > 10) {
          scale = 0.01;
        }
      }
      
      resolve({ x: size.x * scale, y: size.y * scale, z: size.z * scale });
    };

    const onError = (err: unknown) => {
      console.error(err);
      reject(err);
    };

    try {
      if (ext === "obj") {
        const loader = new OBJLoader();
        loader.load(url, (obj) => onLoad(obj), undefined, onError);
      } else if (ext === "fbx") {
        const loader = new FBXLoader();
        loader.load(url, (obj) => onLoad(obj), undefined, onError);
      } else if (ext === "gltf" || ext === "glb") {
        const loader = new GLTFLoader();
        loader.load(url, (gltf) => onLoad(gltf.scene), undefined, onError);
      } else {
        reject(new Error("Unsupported format: " + ext));
      }
    } catch (e) {
      reject(e);
    }
  });
}
