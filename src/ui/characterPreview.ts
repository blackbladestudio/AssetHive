import * as THREE from "three";
import { readCharacterFbxAxes } from "../../shared/characterFbxAxes.mjs";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { TGALoader } from "three/examples/jsm/loaders/TGALoader.js";
import { getPreviewUrl } from "./previewUrl";
import type { CharacterPreviewPaths } from "./hooks/types";

export const CHARACTER_PREVIEW_VIEWS = ["front", "left", "right", "back"] as const;
export type CharacterPreviewView = typeof CHARACTER_PREVIEW_VIEWS[number];
export type CharacterPreviewTextureInput = string | {
  sourcePath: string;
  previewPath?: string;
};

const VIEW_LABELS: Record<CharacterPreviewView, string> = {
  front: "正面",
  left: "左面",
  right: "右面",
  back: "背面"
};

const VIEW_DIRECTIONS: Record<CharacterPreviewView, THREE.Vector3> = {
  front: new THREE.Vector3(0, 0, 1),
  left: new THREE.Vector3(-1, 0, 0),
  right: new THREE.Vector3(1, 0, 0),
  back: new THREE.Vector3(0, 0, -1)
};

type ResolvedPreviewTexture = {
  sourcePath: string;
  previewPath: string;
};

function getFileStem(filePath: string) {
  const fileName = String(filePath || "").replace(/\\/g, "/").split("/").pop() || "";
  return fileName.replace(/\.[^.]+$/, "").toLowerCase();
}

function resolvePreviewTextures(inputs: CharacterPreviewTextureInput[]) {
  const byStem = new Map<string, ResolvedPreviewTexture>();
  for (const input of inputs) {
    const sourcePath = String(typeof input === "string" ? input : input?.sourcePath || "").trim();
    if (!sourcePath) continue;
    const previewPath = String(typeof input === "string" ? input : input?.previewPath || sourcePath).trim() || sourcePath;
    byStem.set(getFileStem(sourcePath), { sourcePath, previewPath });
  }
  return byStem;
}

function loadPreviewTexture(manager: THREE.LoadingManager, filePath: string) {
  return new Promise<THREE.Texture>((resolve, reject) => {
    const loader = /\.tga(?:$|[?#])/i.test(filePath) ? new TGALoader(manager) : new THREE.TextureLoader(manager);
    loader.load(getPreviewUrl(filePath), resolve, undefined, reject);
  });
}

async function applyStructuredMaterialTextures(
  root: THREE.Object3D,
  manager: THREE.LoadingManager,
  texturesByStem: Map<string, ResolvedPreviewTexture>
) {
  const textureCache = new Map<string, Promise<THREE.Texture>>();
  const getTexture = async (stem: string, suffix: "d" | "n" | "orm" | "a") => {
    const entry = texturesByStem.get(`t_${stem}_${suffix}`);
    if (!entry) return null;
    const key = entry.previewPath.toLowerCase();
    let pending = textureCache.get(key);
    if (!pending) {
      pending = loadPreviewTexture(manager, entry.previewPath);
      textureCache.set(key, pending);
    }
    return pending;
  };
  const jobs: Promise<void>[] = [];
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const sourceMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    jobs.push((async () => {
      const replacements = await Promise.all(sourceMaterials.map(async (sourceMaterial) => {
        if (!sourceMaterial) return sourceMaterial;
        let stem = String(sourceMaterial.name || "").replace(/^(?:mi|m)_/i, "").toLowerCase();
        if (!texturesByStem.has(`t_${stem}_d`)) {
          // Renaming the managed suit does not rewrite FBX's embedded material
          // names. Match an unambiguous suit material group (e.g. Upbody_01).
          const materialKey = stem.replace(/(?:sg|material)$/i, '').replace(/[^a-z0-9]/g, '');
          const candidates = [...texturesByStem.keys()].flatMap(key => {
            const match = /^t_[mf]\d+_(?:light|medium|heavy)\d+_[^_]+_(.+)_d$/.exec(key);
            const group = match?.[1].replace(/[^a-z0-9]/g, '');
            return group && materialKey.endsWith(group) ? [{ key, length: group.length }] : [];
          }).sort((a, b) => b.length - a.length);
          if (candidates.length && (!candidates[1] || candidates[0].length > candidates[1].length)) stem = candidates[0].key.slice(2, -2);
        }
        if (!texturesByStem.has(`t_${stem}_d`)) {
          // A single-material weapon may retain its original FBX material name
          // after the managed asset is renamed. Only use a unique weapon group.
          const weaponGroups = [...texturesByStem.keys()].filter(key => /^t_(?:bow|arrow|greataxe|jade|longsword|pairedswords|shieldaxe|spear|sword)\d+_.+_d$/.test(key));
          if (weaponGroups.length === 1 && sourceMaterials.length === 1) stem = weaponGroups[0].slice(2, -2);
        }
        const diffuse = await getTexture(stem, "d");
        if (!diffuse) return sourceMaterial;
        const [normal, orm, opacity] = await Promise.all([
          getTexture(stem, "n"),
          getTexture(stem, "orm"),
          getTexture(stem, "a")
        ]);
        diffuse.colorSpace = THREE.SRGBColorSpace;
        if (normal) normal.colorSpace = THREE.NoColorSpace;
        if (orm) {
          orm.colorSpace = THREE.NoColorSpace;
          orm.channel = 0;
        }
        if (opacity) opacity.colorSpace = THREE.NoColorSpace;
        const material = new THREE.MeshStandardMaterial({
          name: sourceMaterial.name,
          color: 0xffffff,
          map: diffuse,
          normalMap: normal,
          aoMap: orm,
          roughnessMap: orm,
          metalnessMap: orm,
          alphaMap: opacity,
          transparent: Boolean(opacity),
          alphaTest: opacity ? 0.08 : 0,
          roughness: 1,
          metalness: orm ? 1 : 0,
          side: THREE.DoubleSide,
          vertexColors: sourceMaterial.vertexColors
        });
        material.userData = { ...sourceMaterial.userData };
        sourceMaterial.dispose();
        return material;
      }));
      mesh.material = Array.isArray(mesh.material) ? replacements : replacements[0];
    })());
  });
  await Promise.all(jobs);
}

async function loadFbx(loader: FBXLoader, filePath: string, normalizeAxes = true) {
  if (normalizeAxes) {
    const url = getPreviewUrl(filePath);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`无法读取模型：${filePath}`);
    const bytes = await response.arrayBuffer();
    const model = loader.parse(bytes, url.slice(0, url.lastIndexOf('/') + 1));
    // FBXLoader leaves source axes unchanged. Rig exports from UE use Z-up,
    // while the existing art previews use Y-up. Rotate the whole hierarchy together.
    const wrapper = new THREE.Group();
    wrapper.add(model);
    const { upAxis, upSign } = readCharacterFbxAxes(bytes);
    if (upAxis !== null) {
      const up = new THREE.Vector3().setComponent(upAxis, upSign);
      wrapper.quaternion.setFromUnitVectors(up, new THREE.Vector3(0, 1, 0));
    }
    wrapper.userData.unitScaleFactor = model.userData.unitScaleFactor;
    return wrapper;
  }
  return new Promise<THREE.Group>((resolve, reject) => {
    loader.load(getPreviewUrl(filePath), resolve, undefined, reject);
  });
}

function applyFbxDisplayScale(object: THREE.Object3D) {
  const unitScaleFactor = Number(object.userData?.unitScaleFactor);
  const scale = (Number.isFinite(unitScaleFactor) && unitScaleFactor > 0 ? unitScaleFactor : 1) / 100;
  object.scale.multiplyScalar(scale);
  object.updateMatrixWorld(true);
}

function canvasToBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("角色预览图编码失败")), "image/png");
  });
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    materials.forEach((material) => {
      if (!material) return;
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) value.dispose();
      }
      material.dispose();
    });
  });
}

function createCamera(view: CharacterPreviewView, bounds: THREE.Box3, size: number) {
  const center = bounds.getCenter(new THREE.Vector3());
  const extents = bounds.getSize(new THREE.Vector3());
  const direction = VIEW_DIRECTIONS[view];
  const horizontal = Math.max(view === "front" || view === "back" ? extents.x : extents.z, 0.1);
  const vertical = Math.max(extents.y, 0.1);
  const halfHeight = Math.max(vertical * 0.57, horizontal * 0.57);
  const camera = new THREE.OrthographicCamera(-halfHeight, halfHeight, halfHeight, -halfHeight, 0.01, 1000);
  const distance = Math.max(extents.length() * 2.2, 2);
  camera.position.copy(center).addScaledVector(direction, distance);
  camera.up.set(0, 1, 0);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  camera.userData.previewSize = size;
  return camera;
}

function drawViewLabel(canvas: HTMLCanvasElement, view: CharacterPreviewView) {
  const context = canvas.getContext("2d");
  if (!context) return;
  const padding = Math.round(canvas.width * 0.035);
  const fontSize = Math.max(18, Math.round(canvas.width * 0.035));
  context.save();
  context.font = `600 ${fontSize}px "Microsoft YaHei", sans-serif`;
  context.textBaseline = "bottom";
  const label = VIEW_LABELS[view];
  const width = context.measureText(label).width;
  context.fillStyle = "rgba(0, 0, 0, 0.52)";
  context.fillRect(padding - 10, canvas.height - padding - fontSize - 12, width + 20, fontSize + 20);
  context.fillStyle = "rgba(255, 255, 255, 0.92)";
  context.fillText(label, padding, canvas.height - padding);
  context.restore();
}

function createSkeletonOverlay(root: THREE.Object3D) {
  root.updateMatrixWorld(true);
  const overlay = new THREE.Group();
  const links = new THREE.SkeletonHelper(root);
  [links.material].flat().forEach(material => { material.depthTest = false; material.depthWrite = false; });
  links.renderOrder = 10;
  overlay.add(links);
  // SkeletonHelper draws links only. A weapon with one root bone still needs
  // a visible joint; show real bone positions, never invent a bone chain.
  const positions: number[] = [];
  root.traverse(child => {
    if (!(child as THREE.Bone).isBone) return;
    const point = child.getWorldPosition(new THREE.Vector3());
    positions.push(point.x, point.y, point.z);
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const points = new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0x53e7c3, size: 5, sizeAttenuation: false, depthTest: false, depthWrite: false }));
  points.renderOrder = 11;
  overlay.add(points);
  return overlay;
}

function disposeSkeletonOverlay(overlay: THREE.Group | null) {
  overlay?.traverse(child => {
    const object = child as THREE.Mesh;
    object.geometry?.dispose();
    if (object.material) [object.material].flat().forEach(material => material.dispose());
  });
}

async function renderCharacterViews(modelPaths: string[], texturePaths: CharacterPreviewTextureInput[], size: number, views: readonly CharacterPreviewView[], labels: boolean, skeletonPreview = false,
  batch?: { owner: boolean; partPaths?: Set<string>; onPart: (path: string, images: Record<CharacterPreviewView, Blob>) => Promise<void>; onView: () => void }) {
  const models = [...new Set(modelPaths.map((value) => String(value || "").trim()).filter((value) => /\.fbx$/i.test(value)))];
  if (models.length === 0) throw new Error("没有可用于生成角色预览的 FBX 模型");
  const texturesByStem = resolvePreviewTextures(texturePaths);
  const manager = new THREE.LoadingManager();
  manager.addHandler(/\.tga(?:$|[?#])/i, new TGALoader(manager));
  const loader = new FBXLoader(manager);
  const root = new THREE.Group();
  const loaded = await Promise.all(models.map((filePath) => loadFbx(loader, filePath)));
  loaded.forEach((object) => {
    applyFbxDisplayScale(object);
    object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      materials.forEach((material) => {
        if (!material) return;
        material.side = THREE.DoubleSide;
        material.needsUpdate = true;
      });
    });
    root.add(object);
  });
  if (skeletonPreview) {
    root.traverse(child => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach(material => material.dispose());
      mesh.material = new THREE.MeshStandardMaterial({ color: 0xe3e3e3, roughness: 0.8, side: THREE.DoubleSide });
    });
  } else await applyStructuredMaterialTextures(root, manager, texturesByStem);
  root.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(root);
  if (bounds.isEmpty()) {
    disposeObject(root);
    throw new Error("套装模型没有可渲染的几何体");
  }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x24272c);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x30343b, 1.65));
  const key = new THREE.DirectionalLight(0xffffff, 2.1);
  key.position.set(3, 5, 4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xb9d5ff, 1.15);
  fill.position.set(-4, 2, 2);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffe0c2, 0.9);
  rim.position.set(1, 3, -4);
  scene.add(rim);
  scene.add(root);
  const skeletonHelper = skeletonPreview ? createSkeletonOverlay(root) : null;
  if (skeletonHelper) scene.add(skeletonHelper);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(size, size, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const renderViews = async (viewBounds: THREE.Box3, outputSize = size) => {
    renderer.setSize(outputSize, outputSize, false);
    const output = {} as Record<CharacterPreviewView, Blob>;
    for (const view of views) {
      const camera = createCamera(view, viewBounds, outputSize);
      renderer.render(scene, camera);
      const canvas = document.createElement("canvas");
      canvas.width = outputSize;
      canvas.height = outputSize;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("无法创建角色预览画布");
      context.drawImage(renderer.domElement, 0, 0, outputSize, outputSize);
      if (labels) drawViewLabel(canvas, view);
      output[view] = await canvasToBlob(canvas);
      batch?.onView();
    }
    return output;
  };
  try {
    // Load/parse each FBX and its textures once, then reuse the studio and GPU
    // for all individual parts and the assembled suit.
    if (batch) {
      for (let index = 0; index < loaded.length; index++) {
        if (batch.partPaths && !batch.partPaths.has(models[index])) continue;
        loaded.forEach((object, i) => { object.visible = i === index; });
        const partHelper = skeletonPreview ? createSkeletonOverlay(loaded[index]) : null;
        if (skeletonHelper) skeletonHelper.visible = false;
        if (partHelper) {
          scene.add(partHelper);
        }
        try { await batch.onPart(models[index], await renderViews(new THREE.Box3().setFromObject(loaded[index]))); }
        finally {
          if (partHelper) { scene.remove(partHelper); disposeSkeletonOverlay(partHelper); }
        }
      }
      loaded.forEach(object => { object.visible = true; });
      if (skeletonHelper) skeletonHelper.visible = true;
      if (!batch.owner) return {} as Record<CharacterPreviewView, Blob>;
    }
    return await renderViews(bounds, batch?.owner ? 1024 : size);
  } finally {
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
    disposeObject(root);
    disposeSkeletonOverlay(skeletonHelper);
  }
}

export async function generateCharacterImportPreviews(
  models: { sourcePath: string; meshKind: "staticMesh" | "skeletalMesh" }[], textures: CharacterPreviewTextureInput[],
  onPart: (sourcePath: string, meshKind: "staticMesh" | "skeletalMesh", images: Record<CharacterPreviewView, Blob>) => Promise<void>,
  onProgress: (done: number, total: number) => void,
  options: { partPaths?: Set<string>; texturedOwner?: boolean } = {}
) {
  const partPaths = options.partPaths || new Set(models.map(model => model.sourcePath));
  const total = (partPaths.size + 1) * 4;
  let done = 0;
  onProgress(done, total);
  let owner = {} as Record<CharacterPreviewView, Blob>;
  const ownerKind = models.some(model => model.meshKind === 'staticMesh') ? 'staticMesh' : 'skeletalMesh';
  for (const kind of ['staticMesh', 'skeletalMesh'] as const) {
    const paths = models.filter(model => model.meshKind === kind).map(model => model.sourcePath);
    if (!paths.length) continue;
    // Standalone characters keep a textured owner preview. Only skeletal part
    // inspection cards use white material and the skeleton overlay.
    if (kind === 'skeletalMesh' && kind === ownerKind && options.texturedOwner) {
      owner = await renderCharacterViews(paths, textures, 768, CHARACTER_PREVIEW_VIEWS, true, false, {
        owner: true, partPaths: new Set(), onPart: async () => {}, onView: () => onProgress(++done, total)
      });
    }
    const renderOwner = kind === ownerKind && !(kind === 'skeletalMesh' && options.texturedOwner);
    if (!renderOwner && !paths.some(path => partPaths.has(path))) continue;
    const result = await renderCharacterViews(paths, kind === 'staticMesh' ? textures : [], 768, CHARACTER_PREVIEW_VIEWS, true, kind === 'skeletalMesh', {
      owner: renderOwner, partPaths,
      onPart: (path, images) => onPart(path, kind, images),
      onView: () => onProgress(++done, total)
    });
    if (renderOwner) owner = result;
  }
  return owner;
}

export function generateCharacterFourViewBlobs(modelPaths: string[], texturePaths: CharacterPreviewTextureInput[], size = 1024, skeletonPreview = false) {
  return renderCharacterViews(modelPaths, texturePaths, size, CHARACTER_PREVIEW_VIEWS, true, skeletonPreview);
}

// Reuse one loaded scene for changed parts and the assembled suit; unchanged
// parts are loaded only when needed to compose the owner, never photographed.
export function generateCharacterUpdatePreviews(modelPaths: string[], textures: CharacterPreviewTextureInput[],
  partPaths: Set<string>, owner: boolean, skeletal: boolean,
  onPart: (path: string, images: Record<CharacterPreviewView, Blob>) => Promise<void>, onView: () => void) {
  return renderCharacterViews(modelPaths, textures, 768, CHARACTER_PREVIEW_VIEWS, true, skeletal, { owner, partPaths, onPart, onView });
}

// Same studio, framing and material pipeline; one part, one clean front cover.
export async function generateCharacterPartFrontBlob(modelPath: string, texturePaths: CharacterPreviewTextureInput[], size = 768) {
  return (await renderCharacterViews([modelPath], texturePaths, size, ["front"], false)).front;
}

export function hasCompleteCharacterPreview(paths: Partial<CharacterPreviewPaths> | null | undefined) {
  return CHARACTER_PREVIEW_VIEWS.every((view) => Boolean(String(paths?.[view] || "").trim()));
}
