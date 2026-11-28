import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { getPreviewUrl } from "./previewUrl";
import { AnimationMotionPanel } from "./AnimationMotionPanel";
import { isWindowForeground, subscribeToWindowForeground } from "./windowForeground";
import { analyzeRootMotion, findRootMotionBone, rootMotionAt, type RootMotionAnalysis } from "./animationRootMotion";

type AnimationPreviewProps = {
  filePath: string;
  skeletonPath?: string;
  skeletalMeshPath?: string;
  className?: string;
  emptyLabel: string;
  playLabel: string;
  pauseLabel: string;
  failedLabel: string;
  missingMeshLabel: string;
  onMotionCapture?: (capture: () => Promise<Blob | null>) => Promise<void>;
  captureOnly?: boolean;
  onCaptureFinished?: () => void;
  motionDetailsHost?: HTMLElement | null;
  language?: "zh" | "en";
};

const DETAIL_BACKGROUND = 0xffffff;
const CARD_BACKGROUND = 0xd9d9d9;
const MANNEQUIN_COLOR = 0x8fb0bc;
const CAPTURE_WIDTH = 384;
const CAPTURE_HEIGHT = 384;
const VIEW_DIRECTION = new THREE.Vector3(0.55, 0.28, 0.9).normalize();

function recordCanvasToWebm(canvas: HTMLCanvasElement, durationMs: number, signal: AbortSignal) {
  return new Promise<Blob>((resolve, reject) => {
    signal.throwIfAborted();
    if (typeof canvas.captureStream !== "function" || typeof MediaRecorder === "undefined") {
      reject(new Error("motion preview capture is not supported"));
      return;
    }
    const stream = canvas.captureStream(16);
    const mimeType = ["video/webm;codecs=vp8", "video/webm;codecs=vp9", "video/webm"]
      .find((type) => MediaRecorder.isTypeSupported(type));
    if (!mimeType) {
      stream.getTracks().forEach((track) => track.stop());
      reject(new Error("webm recording is not supported"));
      return;
    }
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1200000 });
    const chunks: BlobPart[] = [];
    const stop = () => { if (recorder.state !== "inactive") recorder.stop(); };
    const timer = window.setTimeout(stop, Math.max(700, durationMs));
    const cleanup = () => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", abortRecording);
      stream.getTracks().forEach(track => track.stop());
    };
    const abortRecording = () => {
      stop();
      cleanup();
      reject(signal.reason);
    };
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onerror = () => {
      cleanup();
      reject(new Error("motion preview record failed"));
    };
    recorder.onstop = () => {
      cleanup();
      resolve(new Blob(chunks, { type: "video/webm" }));
    };
    try {
      recorder.start(120);
      signal.addEventListener("abort", abortRecording, { once: true });
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

function loadFbx(filePath: string, signal?: AbortSignal) {
  const url = getPreviewUrl(filePath);
  if (signal) {
    return fetch(url, { signal }).then(async response => {
      if (!response.ok && response.status !== 0) throw new Error(`FBX load failed: ${response.status}`);
      const bytes = await response.arrayBuffer();
      signal.throwIfAborted();
      return new FBXLoader().parse(bytes, THREE.LoaderUtils.extractUrlBase(url));
    });
  }
  return new Promise<THREE.Group>((resolve, reject) => {
    new FBXLoader().load(url, resolve, undefined, reject);
  });
}

function applyFbxDisplayScale(object: THREE.Object3D) {
  // FBX 的 UnitScaleFactor 以厘米计，three.js 只写进 userData，预览时再换成米。
  const unitScaleFactor = Number(object.userData?.unitScaleFactor);
  const scale = (Number.isFinite(unitScaleFactor) && unitScaleFactor > 0 ? unitScaleFactor : 1) / 100;
  object.scale.multiplyScalar(scale);
  object.updateMatrixWorld(true);
}

function countRenderableMeshes(object: THREE.Object3D) {
  let count = 0;
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry) {
      count += 1;
    }
  });
  return count;
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    materials.forEach((material) => material?.dispose?.());
  });
}

// Rig textures are rarely reachable from the library, so every mesh shares
// one lit mannequin material like the Mixamo previews.
function applyMannequinMaterial(object: THREE.Object3D) {
  const material = new THREE.MeshStandardMaterial({ color: MANNEQUIN_COLOR, roughness: 0.62, metalness: 0.05 });
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const previous = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    previous.forEach((item) => item?.dispose?.());
    mesh.material = material;
    // Cached skinned bounds do not follow root motion.
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = false;
  });
  return material;
}

function boneDepth(bone: THREE.Object3D) {
  let depth = 0;
  for (let parent = bone.parent; parent; parent = parent.parent) depth += 1;
  return depth;
}

function topBone(object: THREE.Object3D) {
  let best: THREE.Object3D | null = null;
  let bestDepth = Infinity;
  object.traverse((child) => {
    if (!(child as THREE.Bone).isBone) return;
    const depth = boneDepth(child);
    if (depth < bestDepth) {
      best = child;
      bestDepth = depth;
    }
  });
  return best as THREE.Object3D | null;
}

// Rig and animation FBX files may use different up axes (UE rigs often bake
// the Z-up conversion into the root bone). When the clip drives the top bone's
// rotation, rotate the rig so the clip plays in the rig's rest orientation.
function alignClipSpace(visual: THREE.Object3D, animationObject: THREE.Object3D, clip: THREE.AnimationClip | undefined) {
  if (!clip || visual === animationObject) return;
  const rigRoot = topBone(visual);
  if (!rigRoot || !clip.tracks.some((track) => track.name === `${rigRoot.name}.quaternion`)) return;
  let clipRoot: THREE.Object3D | null = null;
  animationObject.traverse((child) => {
    if (!clipRoot && (child as THREE.Bone).isBone && child.name === rigRoot.name) clipRoot = child;
  });
  if (!clipRoot) return;
  visual.updateMatrixWorld(true);
  animationObject.updateMatrixWorld(true);
  const rigRotation = rigRoot.getWorldQuaternion(new THREE.Quaternion());
  const clipRotation = (clipRoot as THREE.Object3D).getWorldQuaternion(new THREE.Quaternion());
  const correction = rigRotation.multiply(clipRotation.invert());
  visual.quaternion.copy(correction.multiply(animationObject.quaternion));
  visual.updateMatrixWorld(true);
}

// The body is followed through its hips: the shallowest position-tracked bone
// below the root motion bone (UE root -> pelvis), or the root itself for
// Mixamo-style clips that move the hips directly.
function findBodyBone(object: THREE.Object3D, clip: THREE.AnimationClip | undefined) {
  const tracked = new Set((clip?.tracks || [])
    .filter((track) => track.name.endsWith(".position"))
    .map((track) => track.name.slice(0, -".position".length)));
  const bones: THREE.Object3D[] = [];
  object.traverse((child) => {
    if ((child as THREE.Bone).isBone && tracked.has(child.name)) bones.push(child);
  });
  bones.sort((a, b) => boneDepth(a) - boneDepth(b));
  const root = bones[0] || null;
  if (!root) return null;
  const hips = bones.find((bone) => bone !== root && bone.parent === root);
  return hips || root;
}

function horizontal(object: THREE.Object3D | null, origin: THREE.Vector3) {
  const point = object ? object.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3();
  return point.set(point.x - origin.x, 0, point.z - origin.z);
}

// Collects a thinned set of posed vertex positions (skinning applied),
// shifted by `offset`; falls back to bone positions without meshes.
function collectPosedPoints(object: THREE.Object3D, offset: THREE.Vector3, stride: number, points: THREE.Vector3[]) {
  const before = points.length;
  object.updateMatrixWorld(true);
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    const position = mesh.isMesh ? mesh.geometry?.getAttribute("position") : undefined;
    if (!position) return;
    for (let index = 0; index < position.count; index += stride) {
      points.push(mesh.getVertexPosition(index, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld).sub(offset));
    }
  });
  if (points.length === before) {
    object.traverse((child) => {
      if ((child as THREE.Bone).isBone) points.push(child.getWorldPosition(new THREE.Vector3()).sub(offset));
    });
  }
}

type ClipBounds = {
  start: THREE.Vector3;
  inPlace: THREE.Box3;
  points: THREE.Vector3[];
};

// Samples the clip with the body held at the origin, so the bounds cover
// every pose regardless of how far the root travels.
function sampleClipBounds(mixer: THREE.AnimationMixer | null, visual: THREE.Object3D, stage: THREE.Object3D, bodyBone: THREE.Object3D | null, duration: number): ClipBounds {
  const points: THREE.Vector3[] = [];
  const origin = stage.getWorldPosition(new THREE.Vector3());
  const samples = mixer && duration > 0 ? 16 : 1;
  let vertexCount = 0;
  visual.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) vertexCount += mesh.geometry?.getAttribute("position")?.count || 0;
  });
  const stride = Math.max(1, Math.floor(vertexCount / 1500));
  let start = new THREE.Vector3();
  for (let index = 0; index < samples; index += 1) {
    if (mixer) mixer.setTime((duration * index) / samples);
    visual.updateMatrixWorld(true);
    const offset = horizontal(bodyBone, origin);
    if (index === 0) start = offset.clone();
    collectPosedPoints(visual, offset, stride, points);
  }
  if (mixer) mixer.setTime(0);
  const inPlace = new THREE.Box3().setFromPoints(points);
  if (inPlace.isEmpty()) inPlace.setFromCenterAndSize(new THREE.Vector3(0, 0.9, 0), new THREE.Vector3(0.6, 1.8, 0.6));
  return { start, inPlace, points };
}

// Places the camera along VIEW_DIRECTION at the closest distance where every
// sampled point fits inside `fill` of the frame, centred on their projection.
function fitCamera(camera: THREE.PerspectiveCamera, bounds: ClipBounds, fill: number) {
  const center = bounds.inPlace.getCenter(new THREE.Vector3());
  const points = bounds.points.length ? bounds.points : [bounds.inPlace.min, bounds.inPlace.max];
  const forward = VIEW_DIRECTION.clone().negate();
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();
  const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * fill;
  const tanH = tanV * camera.aspect;
  const relative = new THREE.Vector3();
  const fitDistance = () => {
    let distance = 0.1;
    for (const point of points) {
      relative.subVectors(point, center);
      const depth = relative.dot(forward);
      distance = Math.max(distance, Math.abs(relative.dot(up)) / tanV - depth, Math.abs(relative.dot(right)) / tanH - depth);
    }
    return distance;
  };
  let distance = fitDistance();
  for (let pass = 0; pass < 3; pass += 1) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const point of points) {
      relative.subVectors(point, center);
      const depth = Math.max(1e-3, distance + relative.dot(forward));
      const x = relative.dot(right) / depth;
      const y = relative.dot(up) / depth;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    center.addScaledVector(right, ((minX + maxX) / 2) * distance).addScaledVector(up, ((minY + maxY) / 2) * distance);
    distance = fitDistance();
  }
  const size = bounds.inPlace.getSize(new THREE.Vector3()).length();
  camera.position.copy(center).addScaledVector(VIEW_DIRECTION, distance);
  camera.near = Math.max(0.01, size / 200);
  camera.far = Math.max(50, distance + size * 20);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  return center;
}

function createShadowLight(size: number) {
  const light = new THREE.DirectionalLight(0xffffff, 1.6);
  light.castShadow = true;
  light.shadow.mapSize.set(1024, 1024);
  light.shadow.bias = -0.0005;
  light.shadow.normalBias = 0.02;
  const extent = Math.max(1, size);
  Object.assign(light.shadow.camera, { left: -extent, right: extent, top: extent, bottom: -extent, near: 0.1, far: extent * 8 });
  light.shadow.camera.updateProjectionMatrix();
  return light;
}

export function AnimationPreview({
  filePath,
  skeletonPath = "",
  skeletalMeshPath = "",
  className,
  emptyLabel,
  playLabel,
  pauseLabel,
  failedLabel,
  missingMeshLabel,
  onMotionCapture,
  captureOnly = false,
  onCaptureFinished,
  motionDetailsHost,
  language = "zh"
}: AnimationPreviewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const playingRef = useRef(true);
  const onMotionCaptureRef = useRef(onMotionCapture);
  onMotionCaptureRef.current = onMotionCapture;
  const onCaptureFinishedRef = useRef(onCaptureFinished);
  onCaptureFinishedRef.current = onCaptureFinished;
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const [playing, setPlaying] = useState(true);
  const [clipName, setClipName] = useState("");
  const [missingMesh, setMissingMesh] = useState(false);
  const [rootMotionEnabled, setRootMotionEnabled] = useState(true);
  const rootMotionEnabledRef = useRef(true);
  const [motion, setMotion] = useState<{ analysis: RootMotionAnalysis | null; duration: number } | null>(null);
  const [motionTime, setMotionTime] = useState(0);
  const seekRef = useRef<((time: number) => void) | null>(null);
  const motionDetailsRef = useRef(motionDetailsHost);
  motionDetailsRef.current = motionDetailsHost;
  const toggleRootMotion = () => {
    rootMotionEnabledRef.current = !rootMotionEnabledRef.current;
    setRootMotionEnabled(rootMotionEnabledRef.current);
  };

  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  useEffect(() => {
    const host = hostRef.current;
    const animationSource = String(filePath || "").trim();
    const meshSource = String(skeletalMeshPath || "").trim();
    const skeletonSource = String(skeletonPath || "").trim();
    if (!host) {
      return;
    }
    if (!animationSource) {
      setStatus("idle");
      setClipName("");
      setMissingMesh(false);
      return;
    }

    let cancelled = false;
    const abort = new AbortController();
    let disposeLoaded: (() => void) | null = null;
    setStatus("loading");
    setPlaying(true);
    playingRef.current = true;
    setClipName("");
    setMissingMesh(false);
    setMotion(null);
    setMotionTime(0);
    setRootMotionEnabled(true);
    rootMotionEnabledRef.current = true;

    void (async () => {
      try {
        const signal = captureOnly ? abort.signal : undefined;
        const animationObject = await loadFbx(animationSource, signal);
        if (cancelled || !host.isConnected) {
          disposeObject(animationObject);
          return;
        }
        const visualSource = captureOnly && countRenderableMeshes(animationObject) > 0 ? "" : meshSource || skeletonSource;
        let visual: THREE.Group;
        try {
          visual = visualSource ? await loadFbx(visualSource, signal) : animationObject;
        } catch (error) {
          disposeObject(animationObject);
          throw error;
        }
        if (cancelled || !host.isConnected) {
          if (visual !== animationObject) disposeObject(visual);
          disposeObject(animationObject);
          return;
        }
        applyFbxDisplayScale(visual);
        if (visual !== animationObject) {
          applyFbxDisplayScale(animationObject);
        }
        const mannequin = applyMannequinMaterial(visual);

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(DETAIL_BACKGROUND);
        scene.add(new THREE.HemisphereLight(0xffffff, 0x9a9a9a, 1.25));
        const stage = new THREE.Group();
        stage.add(visual);
        scene.add(stage);

        const meshCount = countRenderableMeshes(visual);
        const clips = (animationObject.animations || []).length > 0
          ? animationObject.animations
          : (visual.animations || []);
        if (captureOnly && !clips.length) {
          if (visual !== animationObject) disposeObject(animationObject);
          disposeObject(visual);
          onCaptureFinishedRef.current?.();
          return;
        }
        const helper = meshCount === 0 ? new THREE.SkeletonHelper(visual) : null;
        if (helper) {
          scene.add(helper);
        }
        setMissingMesh(meshCount === 0);

        alignClipSpace(visual, animationObject, clips[0]);
        const mixer = clips.length > 0 ? new THREE.AnimationMixer(visual) : null;
        const action = mixer && clips[0] ? mixer.clipAction(clips[0]) : null;
        const clipDuration = clips[0]?.duration || 0;
        const bodyBone = mixer && clipDuration > 0 ? findBodyBone(visual, clips[0]) : null;
        if (action) {
          action.reset().play();
          setClipName(String(clips[0].name || "").trim());
        }
        const bounds = sampleClipBounds(mixer, visual, stage, bodyBone, clipDuration);
        const rootBone = clips[0] ? findRootMotionBone(visual, clips[0]) : null;
        const rootAnalysis = mixer && action && rootBone && clipDuration > 0
          ? analyzeRootMotion(mixer, action, rootBone, visual) : null;
        // Sample in the displayed coordinate system (including FBX unit scale
        // and rig alignment), before stage/camera compensation.
        const rootStart = rootBone?.getWorldPosition(new THREE.Vector3()) || new THREE.Vector3();
        setMotion({ analysis: rootAnalysis, duration: clipDuration });
        seekRef.current = time => {
          if (!mixer || !action) return;
          playingRef.current = false;
          setPlaying(false);
          // LoopRepeat wraps the end; keep scrubbing on its final pose.
          mixer.setTime(Math.min(time, Math.max(0, clipDuration - 1e-6)));
          setMotionTime(time);
        };
        const characterSize = bounds.inPlace.getSize(new THREE.Vector3());
        const characterCenter = bounds.inPlace.getCenter(new THREE.Vector3());
        const groundY = bounds.inPlace.min.y;
        // The detail view starts the clip at the origin and keeps its root motion.
        stage.position.set(-bounds.start.x, 0, -bounds.start.z);
        stage.updateMatrixWorld(true);

        const width = Math.max(1, host.clientWidth);
        const height = Math.max(1, host.clientHeight);
        const camera = new THREE.PerspectiveCamera(35, width / height, 0.05, 200);
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
        renderer.setPixelRatio(captureOnly ? 1 : Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(width, height, false);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFShadowMap;
        host.replaceChildren(renderer.domElement);

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.enablePan = true;
        const viewCenter = fitCamera(camera, bounds, 0.72);
        controls.target.copy(viewCenter);
        controls.update();

        const footprint = Math.max(characterSize.x, characterSize.y, characterSize.z, 0.5);
        const floor = new THREE.GridHelper(footprint * 24, 48, 0xc4c4c4, 0xe2e2e2);
        floor.position.y = groundY;
        scene.add(floor);
        const shadowPlane = new THREE.Mesh(
          new THREE.CircleGeometry(footprint * 1.6, 48),
          new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.22 })
        );
        shadowPlane.rotation.x = -Math.PI / 2;
        shadowPlane.position.y = groundY + footprint * 0.001;
        shadowPlane.receiveShadow = true;
        scene.add(shadowPlane);
        const key = createShadowLight(footprint * 1.7);
        const lightOffset = new THREE.Vector3(1.6, 4.2, 2.4).multiplyScalar(footprint);
        scene.add(key, key.target);
        const placeLight = (focus: THREE.Vector3) => {
          key.position.copy(focus).add(lightOffset);
          key.target.position.copy(focus);
          key.target.updateMatrixWorld();
          shadowPlane.position.x = focus.x;
          shadowPlane.position.z = focus.z;
          shadowPlane.updateMatrixWorld();
        };

        const origin = new THREE.Vector3();
        const boneOffset = () => horizontal(bodyBone, origin.copy(stage.position));
        const focus = new THREE.Vector3();
        const followTarget = new THREE.Vector3();
        const followDelta = new THREE.Vector3();
        const rootDelta = new THREE.Vector3();
        let lastMotionUpdate = 0;
        let frameId: number | undefined;
        let lastFrameTime: number | undefined;
        let recording: AbortController | null = null;
        let captureAfterFrames = meshCount > 0 && onMotionCaptureRef.current ? 8 : 0;
        const captureDurationMs = Math.min(4000, Math.max(900, (clipDuration || 1.2) * 1000));
        // Card previews are recorded in place on a separate canvas, so the
        // detail view keeps its root motion without flicker.
        let capture: { renderer: THREE.WebGLRenderer; camera: THREE.PerspectiveCamera; time: number } | null = null;
        const startCapture = () => {
          const captureCanvas = document.createElement("canvas");
          Object.assign(captureCanvas.style, { position: "fixed", left: "-10000px", top: "0", pointerEvents: "none" });
          const captureRenderer = new THREE.WebGLRenderer({ canvas: captureCanvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
          captureRenderer.setPixelRatio(1);
          captureRenderer.setSize(CAPTURE_WIDTH, CAPTURE_HEIGHT, false);
          captureRenderer.outputColorSpace = THREE.SRGBColorSpace;
          captureRenderer.shadowMap.enabled = true;
          captureRenderer.shadowMap.type = THREE.PCFShadowMap;
          const captureCamera = new THREE.PerspectiveCamera(30, CAPTURE_WIDTH / CAPTURE_HEIGHT, 0.05, 200);
          fitCamera(captureCamera, bounds, 0.92);
          capture = { renderer: captureRenderer, camera: captureCamera, time: 0 };
          document.body.appendChild(captureCanvas);
          return captureCanvas;
        };
        const renderCapture = (delta: number) => {
          if (!capture) return;
          const detailTime = action?.time ?? 0;
          if (mixer && action && clipDuration > 0) {
            action.time = capture.time;
            mixer.update(0);
            capture.time = (capture.time + delta) % clipDuration;
          }
          const detailStage = stage.position.clone();
          const offset = boneOffset();
          stage.position.set(-offset.x, 0, -offset.z);
          stage.updateMatrixWorld(true);
          placeLight(focus.set(characterCenter.x, groundY, characterCenter.z));
          floor.visible = false;
          scene.background = new THREE.Color(CARD_BACKGROUND);
          capture.renderer.render(scene, capture.camera);
          scene.background = new THREE.Color(DETAIL_BACKGROUND);
          floor.visible = true;
          stage.position.copy(detailStage);
          if (mixer && action) {
            action.time = detailTime;
            mixer.update(0);
          }
          stage.updateMatrixWorld(true);
        };
        const resize = () => {
          if (!host.isConnected || !isWindowForeground()) return;
          const nextWidth = Math.max(1, host.clientWidth);
          const nextHeight = Math.max(1, host.clientHeight);
          camera.aspect = nextWidth / nextHeight;
          camera.updateProjectionMatrix();
          renderer.setSize(nextWidth, nextHeight, false);
        };
        const observer = new ResizeObserver(resize);
        const tick = (now: number) => {
          frameId = undefined;
          if (cancelled || !isWindowForeground()) return;
          const delta = lastFrameTime === undefined ? 0 : (now - lastFrameTime) / 1000;
          lastFrameTime = now;
          if (mixer && playingRef.current) {
            mixer.update(delta);
          }
          visual.updateMatrixWorld(true);
          if (rootBone && rootAnalysis) {
            rootBone.getWorldPosition(rootDelta).sub(stage.position).sub(rootStart);
            stage.position.set(-bounds.start.x, 0, -bounds.start.z);
            if (!rootMotionEnabledRef.current) stage.position.sub(rootDelta);
            stage.updateMatrixWorld(true);
          }
          if (motionDetailsRef.current && now - lastMotionUpdate >= 100) {
            setMotionTime(action?.time || 0);
            lastMotionUpdate = now;
          }
          const offset = boneOffset().add(stage.position);
          followTarget.set(offset.x + viewCenter.x, viewCenter.y, offset.z + viewCenter.z);
          followDelta.subVectors(followTarget, controls.target);
          controls.target.add(followDelta);
          camera.position.add(followDelta);
          controls.update();
          renderCapture(delta);
          placeLight(focus.set(followTarget.x, groundY, followTarget.z));
          renderer.render(scene, camera);
          if (captureAfterFrames > 0 && !recording) {
            captureAfterFrames -= 1;
            if (captureAfterFrames === 0 && onMotionCaptureRef.current) {
              const notify = onMotionCaptureRef.current;
              const controller = new AbortController();
              void notify(async () => {
                if (cancelled || !isWindowForeground()) return null;
                recording = controller;
                let canvas: HTMLCanvasElement | undefined;
                try {
                  canvas = startCapture();
                  const blob = await recordCanvasToWebm(canvas, captureDurationMs, controller.signal);
                  return !cancelled && !controller.signal.aborted && blob.size > 0 ? blob : null;
                } catch (error) {
                  if (controller.signal.aborted) return null;
                  throw error;
                } finally {
                  capture?.renderer.dispose();
                  capture?.renderer.forceContextLoss();
                  capture = null;
                  canvas?.remove();
                  recording = null;
                }
              }).catch(() => void 0).finally(() => {
                if (!cancelled && !controller.signal.aborted && captureOnly) onCaptureFinishedRef.current?.();
              });
            }
          }
          frameId = window.requestAnimationFrame(tick);
        };

        const syncActivity = () => {
          if (isWindowForeground()) {
            if (frameId === undefined) {
              resize();
              lastFrameTime = undefined;
              frameId = window.requestAnimationFrame(tick);
            }
          } else {
            if (frameId !== undefined) window.cancelAnimationFrame(frameId);
            frameId = undefined;
            if (recording) {
              recording.abort();
              captureAfterFrames = 8;
            }
          }
        };
        observer.observe(host);
        const unsubscribeActivity = subscribeToWindowForeground(syncActivity);
        syncActivity();
        setStatus("ready");

        disposeLoaded = () => {
          unsubscribeActivity();
          recording?.abort();
          seekRef.current = null;
          observer.disconnect();
          floor.geometry.dispose();
          (floor.material as THREE.Material).dispose();
          shadowPlane.geometry.dispose();
          shadowPlane.material.dispose();
          key.shadow.map?.dispose();
          if (frameId !== undefined) window.cancelAnimationFrame(frameId);
          mixer?.stopAllAction();
          mixer?.uncacheRoot(visual);
          controls.dispose();
          renderer.dispose();
          if (captureOnly) renderer.forceContextLoss();
          renderer.domElement.remove();
          helper?.geometry.dispose();
          if (visual !== animationObject) {
            disposeObject(animationObject);
          }
          disposeObject(visual);
          mannequin.dispose();
        };
      } catch {
        if (!cancelled) {
          setStatus("failed");
          setClipName("");
          setMissingMesh(false);
          if (captureOnly) onCaptureFinishedRef.current?.();
        }
      }
    })();

    return () => {
      cancelled = true;
      abort.abort();
      disposeLoaded?.();
      host.replaceChildren();
    };
  }, [filePath, skeletonPath, skeletalMeshPath, captureOnly]);

  if (captureOnly) return <div className="animation-cover-capture" aria-hidden="true">
    <div ref={hostRef} className="animation-preview-stage" />
  </div>;

  const showCanvas = Boolean(filePath) && status !== "failed";
  const currentMotion = motion?.analysis ? rootMotionAt(motion.analysis, motionTime) : null;

  return (
    <><div className={`animation-preview${className ? ` ${className}` : ""}`}>
      <div ref={hostRef} className="animation-preview-stage" hidden={!showCanvas} />
      {!filePath && emptyLabel ? <div className="animation-preview-empty">{emptyLabel}</div> : null}
      {filePath && status === "loading" && <div className="preview-shimmer" />}
      {filePath && status === "failed" && <div className="animation-preview-empty">{failedLabel}</div>}
      {status === "ready" && missingMesh && (
        <div className="animation-preview-empty animation-preview-missing-mesh">{missingMeshLabel}</div>
      )}
      {status === "ready" && (
        <div className="animation-preview-toolbar">
          <button
            type="button"
            className="animation-preview-toggle"
            onClick={() => setPlaying((prev) => !prev)}
            title={playing ? pauseLabel : playLabel}
            aria-label={playing ? pauseLabel : playLabel}
          >
            {playing ? "❚❚" : "▶"}
          </button>
          {!motionDetailsHost && clipName ? <span className="animation-preview-clip">{clipName}</span> : null}
          {motionDetailsHost && currentMotion && <span className="animation-root-readout">{language === "en" ? "Displacement" : "位移"} {currentMotion.displacement.toFixed(2)} m · {language === "en" ? "Speed" : "速度"} {currentMotion.speed.toFixed(2)} m/s</span>}
        </div>
      )}
    </div>
    {motionDetailsHost && status === "ready" && motion && createPortal(<AnimationMotionPanel
      analysis={motion.analysis} duration={motion.duration} time={motionTime} enabled={rootMotionEnabled}
      language={language} onToggle={toggleRootMotion} onSeek={time => seekRef.current?.(time)}
    />, motionDetailsHost)}</>
  );
}
