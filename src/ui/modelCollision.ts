import type { Mesh, Object3D } from "three";

export type CollisionAnalysis = {
  checked: true;
  hasCollision: boolean;
  nodeCount: number;
};

const COLLISION_NODE_PATTERN = /^(?:UCX|UBX|USP|UCP)(?:_|$)/i;

function getCollisionNodeName(object: Object3D): string {
  const geometryName = (object as Mesh).geometry?.name;
  const candidates = [
    object.name,
    object.userData?.originalName,
    object.userData?.name,
    geometryName
  ];

  for (const candidate of candidates) {
    const name = String(candidate || "").trim();
    if (name && COLLISION_NODE_PATTERN.test(name)) {
      return name;
    }
  }
  return "";
}

export function analyzeCollisionNodes(root: Object3D): CollisionAnalysis {
  let nodeCount = 0;
  root.traverse((child) => {
    if (getCollisionNodeName(child)) {
      nodeCount += 1;
    }
  });

  return {
    checked: true,
    hasCollision: nodeCount > 0,
    nodeCount
  };
}
