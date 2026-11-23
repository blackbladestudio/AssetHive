import * as THREE from "three";
import { readCharacterFbxAxes } from "../../shared/characterFbxAxes.mjs";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { TGALoader } from "three/examples/jsm/loaders/TGALoader.js";
import { getPreviewUrl } from "./previewUrl";
import type { CharacterPreviewPaths } from "./hooks/types";
import { characterPreviewMaterialPlan, characterPreviewTextureKey } from "../../shared/characterPreviewMaterials.mjs";

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
  texturesByStem: Map<string, ResolvedPreviewTexture>,
  heroPart = ""
) {
  const textureCache = new Map<string, Promise<THREE.Texture>>();
  const getTexture = async (stem: string, suffix: "d" | "n" | "orm" | "a") => {
    const textureKey = characterPreviewTextureKey(stem, suffix, texturesByStem.keys());
    const entry = textureKey ? texturesByStem.get(textureKey) : undefined;
    if (!entry) return null;
    const cacheKey = entry.previewPath.toLowerCase();
    let pending = textureCache.get(cacheKey);
    if (!pending) {
      pending = loadPreviewTexture(manager, entry.previewPath);
      textureCache.set(cacheKey, pending);
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
        const plan = characterPreviewMaterialPlan(sourceMaterial.name, texturesByStem.keys(), heroPart, sourceMaterials.length === 1);
        const stem = plan.stem;
        const [normal, orm, opacity] = await Promise.all([
          getTexture(stem, "n"),
          getTexture(stem, "orm"),
          getTexture(stem, "a")
        ]);
        const diffuse = await getTexture(stem, "d");
        if (!diffuse && !normal && !orm && !opacity) {
          // UE material graphs do not survive FBX export. Their black placeholder
          // colors/maps are not a usable preview; missing textures use a clean clay material.
          const neutral = new THREE.MeshStandardMaterial({
            name: sourceMaterial.name,
            color: 0xffffff,
            roughness: 0.8,
            metalness: 0,
            side: THREE.DoubleSide,
            vertexColors: false
          });
          neutral.userData = { ...sourceMaterial.userData };
          sourceMaterial.dispose();
          return neutral;
        }
        if (diffuse) diffuse.colorSpace = THREE.SRGBColorSpace;
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
  batch?: { owner: boolean; partPaths?: Set<string>; onPart: (path: string, images: Record<CharacterPreviewView, Blob>) => Promise<void>; onView: () => void }, heroPart = "", separateModels = false) {
  const models = [...new Set(modelPaths.map((value) => String(value || "").trim()).filter((value) => /\.fbx$/i.test(value)))];
  if (models.length === 0) throw new Error("没有可用于生成角色预览的 FBX 模型");
  const reportStage = (stage: "load" | "render" | "webgl-context-lost" | "render-ended") => {
    window.arkhive?.reportCharacterPreviewDiagnostic?.({
      stage, modelCount: models.length, textureCount: texturePaths.length,
      viewCount: views.length, imageSize: batch?.owner ? Math.max(1024, size) : size, skeletonPreview
    });
  };
  reportStage("load");
  const texturesByStem = resolvePreviewTextures(texturePaths);
  const manager = new THREE.LoadingManager();
  manager.addHandler(/\.tga(?:$|[?#])/i, new TGALoader(manager));
  const loader = new FBXLoader(manager);
  const root = new THREE.Group();
  const loaded = await Promise.all(models.map((filePath) => loadFbx(loader, filePath)));
  loaded.forEach((object) => {
    // FBX collision hulls remain in the source file, but are not render meshes.
    const collisionNodes: THREE.Object3D[] = [];
    object.traverse(child => {
      if ([child.name, child.userData?.originalName, (child as THREE.Mesh).geometry?.name]
        .some(name => /^(?:UCX|UBX|USP|UCP)(?:_|$)/i.test(String(name || '')))) collisionNodes.push(child);
    });
    collisionNodes.forEach(child => { child.removeFromParent(); disposeObject(child); });
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
  } else await applyStructuredMaterialTextures(root, manager, texturesByStem, heroPart);
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

  reportStage("render");
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
  const onContextLost = () => reportStage("webgl-context-lost");
  renderer.domElement.addEventListener("webglcontextlost", onContextLost);
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
      const visibleModels = loaded.filter(object => object.visible);
      if (separateModels && visibleModels.length > 1) {
        // Each component gets its own camera and cell in every view. Merely
        // moving them along X would overlap again in the side views.
        context.fillStyle = '#24272c';
        context.fillRect(0, 0, outputSize, outputSize);
        const columns = Math.ceil(Math.sqrt(visibleModels.length));
        const rows = Math.ceil(visibleModels.length / columns);
        const cell = Math.floor(outputSize / Math.max(columns, rows));
        const overlayVisible = skeletonHelper?.visible;
        if (skeletonHelper) skeletonHelper.visible = false;
        visibleModels.forEach((object, index) => {
          loaded.forEach(model => { model.visible = model === object; });
          const cellOverlay = skeletonPreview ? createSkeletonOverlay(object) : null;
          if (cellOverlay) scene.add(cellOverlay);
          renderer.render(scene, createCamera(view, new THREE.Box3().setFromObject(object), outputSize));
          context.drawImage(renderer.domElement, index % columns * cell, Math.floor(index / columns) * cell, cell, cell);
          if (cellOverlay) { scene.remove(cellOverlay); disposeSkeletonOverlay(cellOverlay); }
        });
        if (skeletonHelper) skeletonHelper.visible = Boolean(overlayVisible);
        loaded.forEach(object => { object.visible = visibleModels.includes(object); });
      }
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
    renderer.domElement.removeEventListener("webglcontextlost", onContextLost);
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
    disposeObject(root);
    disposeSkeletonOverlay(skeletonHelper);
    reportStage("render-ended");
  }
}

export async function generateCharacterImportPreviews(
  models: { sourcePath: string; meshKind: "staticMesh" | "skeletalMesh" }[], textures: CharacterPreviewTextureInput[],
  onPart: (sourcePath: string, meshKind: "staticMesh" | "skeletalMesh", images: Record<CharacterPreviewView, Blob>) => Promise<void>,
  onProgress: (done: number, total: number) => void,
  options: { partPaths?: Set<string>; texturedOwner?: boolean; heroPart?: string; separateModels?: boolean } = {}
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
      }, options.heroPart, options.separateModels);
    }
    const renderOwner = kind === ownerKind && !(kind === 'skeletalMesh' && options.texturedOwner);
    if (!renderOwner && !paths.some(path => partPaths.has(path))) continue;
    const result = await renderCharacterViews(paths, kind === 'staticMesh' ? textures : [], 768, CHARACTER_PREVIEW_VIEWS, true, kind === 'skeletalMesh', {
      owner: renderOwner, partPaths,
      onPart: (path, images) => onPart(path, kind, images),
      onView: () => onProgress(++done, total)
    }, options.heroPart, options.separateModels);
    if (renderOwner) owner = result;
  }
  return owner;
}

export function generateCharacterFourViewBlobs(modelPaths: string[], texturePaths: CharacterPreviewTextureInput[], size = 1024, skeletonPreview = false, heroPart = "", separateModels = false) {
  return renderCharacterViews(modelPaths, texturePaths, size, CHARACTER_PREVIEW_VIEWS, true, skeletonPreview, undefined, heroPart, separateModels);
}

// Reuse one loaded scene for changed parts and the assembled suit; unchanged
// parts are loaded only when needed to compose the owner, never photographed.
export function generateCharacterUpdatePreviews(modelPaths: string[], textures: CharacterPreviewTextureInput[],
  partPaths: Set<string>, owner: boolean, skeletal: boolean,
  onPart: (path: string, images: Record<CharacterPreviewView, Blob>) => Promise<void>, onView: () => void, heroPart = "", separateModels = false) {
  return renderCharacterViews(modelPaths, textures, 768, CHARACTER_PREVIEW_VIEWS, true, skeletal, { owner, partPaths, onPart, onView }, heroPart, separateModels);
}

// Same studio, framing and material pipeline; one part, one clean front cover.
export async function generateCharacterPartFrontBlob(modelPath: string, texturePaths: CharacterPreviewTextureInput[], size = 768, heroPart = "") {
  return (await renderCharacterViews([modelPath], texturePaths, size, ["front"], false, false, undefined, heroPart)).front;
}

export function hasCompleteCharacterPreview(paths: Partial<CharacterPreviewPaths> | null | undefined) {
  return CHARACTER_PREVIEW_VIEWS.every((view) => Boolean(String(paths?.[view] || "").trim()));
}
